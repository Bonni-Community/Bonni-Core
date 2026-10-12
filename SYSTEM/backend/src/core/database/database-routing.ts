import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";

export const databaseTargets = ["normal", "redundant"] as const;
export type DatabaseTarget = (typeof databaseTargets)[number];

export const databaseRoutingModes = ["normal", "redundant", "both"] as const;
export type DatabaseRoutingMode = (typeof databaseRoutingModes)[number];

type TargetFailure = {
  target: DatabaseTarget;
  operation: string;
  code: string;
  message: string;
  at: string;
};

type FullSyncRecord = {
  source: DatabaseTarget;
  target: DatabaseTarget;
  completedAt: string;
};

type FullSyncMaintenance = {
  source: DatabaseTarget;
  target: DatabaseTarget;
  startedAt: string;
  owner: string;
};

type RoutingFile = {
  version: 1;
  mode: DatabaseRoutingMode;
  jsonEmergencyEnabled?: boolean;
  normalUrlEncrypted: string;
  redundantUrlEncrypted: string;
  updatedAt: string;
  lastFullSync: FullSyncRecord | null;
};

type RoutingRuntime = {
  initialized: boolean;
  mode: DatabaseRoutingMode;
  jsonEmergencyEnabled: boolean;
  urls: Record<DatabaseTarget, string>;
  revision: number;
  fileStamp: string;
  lastFailure: TargetFailure | null;
  lastFullSync: FullSyncRecord | null;
  maintenance: FullSyncMaintenance | null;
};

const ROUTING_FILE_VERSION = 1;
const ROUTING_FILE_AAD = "bonni-core:database-routing:v1";
const ROUTING_FILE_NAME = "database-routing.json";
const FULL_SYNC_LOCK_FILE_NAME = "database-full-sync.lock";
const FULL_SYNC_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

const runtime: RoutingRuntime = {
  initialized: false,
  mode: "normal",
  jsonEmergencyEnabled: true,
  urls: {
    normal: env.SERVER_DATABASE_URL || env.DATABASE_URL,
    redundant: "",
  },
  revision: 0,
  fileStamp: "",
  lastFailure: null,
  lastFullSync: null,
  maintenance: null,
};

function routingFilePath() {
  return path.join(path.resolve(env.BONNI_RUNTIME_STATE_ROOT), "system", ROUTING_FILE_NAME);
}

function fullSyncLockPath() {
  return path.join(path.resolve(env.BONNI_RUNTIME_STATE_ROOT), "system", FULL_SYNC_LOCK_FILE_NAME);
}

function routingKey() {
  return createHash("sha256")
    .update(env.MASTER_KEY, "utf8")
    .update(ROUTING_FILE_AAD, "utf8")
    .digest();
}

function encryptSecret(value: string) {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", routingKey(), iv);
  cipher.setAAD(Buffer.from(ROUTING_FILE_AAD, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value: string) {
  if (!value) return "";
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) {
    throw new Error("DATABASE_ROUTING_SECRET_CORRUPT");
  }
  const decipher = createDecipheriv("aes-256-gcm", routingKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(Buffer.from(ROUTING_FILE_AAD, "utf8"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function normalizeMode(value: unknown): DatabaseRoutingMode {
  return value === "redundant" || value === "both" ? value : "normal";
}

function validateConnectionUrl(value: string, target: DatabaseTarget) {
  if (!value) {
    if (target === "normal") throw new Error("NORMAL_DATABASE_URL_MISSING");
    return "";
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${target.toUpperCase()}_DATABASE_URL_INVALID`);
  }
  if (!parsed.protocol.startsWith("postgres")) {
    throw new Error(`${target.toUpperCase()}_DATABASE_MUST_BE_POSTGRESQL`);
  }
  return value;
}

function routingFileStamp(filePath = routingFilePath()) {
  const stats = statSync(filePath, { bigint: true });
  return `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`;
}

function applyRoutingFile(parsed: Partial<RoutingFile>) {
  if (parsed.version !== ROUTING_FILE_VERSION) {
    throw new Error("DATABASE_ROUTING_FILE_VERSION_UNSUPPORTED");
  }

  let mode = normalizeMode(parsed.mode);
  const jsonEmergencyEnabled = parsed.jsonEmergencyEnabled !== false;
  const normalUrl = validateConnectionUrl(
    decryptSecret(String(parsed.normalUrlEncrypted || "")) || env.SERVER_DATABASE_URL || env.DATABASE_URL,
    "normal",
  );
  const redundantUrl = validateConnectionUrl(
    decryptSecret(String(parsed.redundantUrlEncrypted || "")),
    "redundant",
  );
  if ((mode === "redundant" || mode === "both") && !redundantUrl) mode = "normal";

  const changed = mode !== runtime.mode
    || jsonEmergencyEnabled !== runtime.jsonEmergencyEnabled
    || normalUrl !== runtime.urls.normal
    || redundantUrl !== runtime.urls.redundant
    || JSON.stringify(parsed.lastFullSync || null) !== JSON.stringify(runtime.lastFullSync);
  runtime.mode = mode;
  runtime.jsonEmergencyEnabled = jsonEmergencyEnabled;
  runtime.urls = { normal: normalUrl, redundant: redundantUrl };
  runtime.lastFullSync = parsed.lastFullSync || null;
  runtime.initialized = true;
  if (changed) runtime.revision += 1;
}

function recordRoutingLoadFailure(operation: string, error: unknown) {
  runtime.lastFailure = {
    target: "normal",
    operation,
    code: error instanceof Error ? error.message : "DATABASE_ROUTING_LOAD_FAILED",
    message: "Die lokale Datenbank-Routingkonfiguration konnte nicht geladen werden.",
    at: new Date().toISOString(),
  };
}

function refreshDatabaseRoutingFromDisk(force = false) {
  const filePath = routingFilePath();
  try {
    const nextStamp = routingFileStamp(filePath);
    if (!force && runtime.fileStamp === nextStamp) return;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RoutingFile>;
    applyRoutingFile(parsed);
    runtime.fileStamp = nextStamp;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      recordRoutingLoadFailure("routing-refresh", error);
    }
  }
}

function parseFullSyncMaintenance(value: unknown): FullSyncMaintenance {
  const parsed = value && typeof value === "object" ? value as Partial<FullSyncMaintenance> : {};
  if (
    (parsed.source !== "normal" && parsed.source !== "redundant")
    || (parsed.target !== "normal" && parsed.target !== "redundant")
    || parsed.source === parsed.target
    || !parsed.startedAt
    || !parsed.owner
  ) {
    throw Object.assign(new Error("DATABASE_FULL_SYNC_LOCK_INVALID"), {
      statusCode: 423,
      code: "DATABASE_FULL_SYNC_LOCK_INVALID",
    });
  }
  return parsed as FullSyncMaintenance;
}

function readFullSyncMaintenance() {
  const lockPath = fullSyncLockPath();
  try {
    const maintenance = parseFullSyncMaintenance(JSON.parse(readFileSync(lockPath, "utf8")));
    const startedAt = new Date(maintenance.startedAt).getTime();
    if (Number.isFinite(startedAt) && Date.now() - startedAt > FULL_SYNC_LOCK_STALE_MS) {
      unlinkSync(lockPath);
      runtime.maintenance = null;
      return null;
    }
    runtime.maintenance = maintenance;
    return maintenance;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      runtime.maintenance = null;
      return null;
    }
    throw error;
  }
}

function refreshFullSyncMaintenance() {
  try {
    return readFullSyncMaintenance();
  } catch (error) {
    recordRoutingLoadFailure("full-sync-lock", error);
    throw error;
  }
}

async function persistRoutingFile() {
  const filePath = routingFilePath();
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload: RoutingFile = {
    version: ROUTING_FILE_VERSION,
    mode: runtime.mode,
    jsonEmergencyEnabled: runtime.jsonEmergencyEnabled,
    normalUrlEncrypted: encryptSecret(runtime.urls.normal),
    redundantUrlEncrypted: encryptSecret(runtime.urls.redundant),
    updatedAt: new Date().toISOString(),
    lastFullSync: runtime.lastFullSync,
  };

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  runtime.fileStamp = routingFileStamp(filePath);
}

export async function initializeDatabaseRouting() {
  if (runtime.initialized) return getDatabaseRoutingStatus();
  runtime.initialized = true;
  refreshDatabaseRoutingFromDisk(true);
  try {
    refreshFullSyncMaintenance();
  } catch {
    // Ein beschädigter Lock wird im Status gemeldet und blockiert Schreibvorgänge.
  }
  return getDatabaseRoutingStatus();
}

export async function configureDatabaseRouting(input: {
  mode?: DatabaseRoutingMode;
  jsonEmergencyEnabled?: boolean;
  normalUrl?: string;
  redundantUrl?: string;
  persist?: boolean;
}) {
  refreshDatabaseRoutingFromDisk();
  const mode = normalizeMode(input.mode ?? runtime.mode);
  const jsonEmergencyEnabled = input.jsonEmergencyEnabled ?? runtime.jsonEmergencyEnabled;
  const normalUrl = validateConnectionUrl(input.normalUrl ?? runtime.urls.normal, "normal");
  const redundantUrl = validateConnectionUrl(input.redundantUrl ?? runtime.urls.redundant, "redundant");

  if ((mode === "redundant" || mode === "both") && !redundantUrl) {
    throw Object.assign(new Error("REDUNDANT_DATABASE_NOT_CONFIGURED"), { statusCode: 409 });
  }

  const changed = mode !== runtime.mode
    || jsonEmergencyEnabled !== runtime.jsonEmergencyEnabled
    || normalUrl !== runtime.urls.normal
    || redundantUrl !== runtime.urls.redundant;
  runtime.mode = mode;
  runtime.jsonEmergencyEnabled = jsonEmergencyEnabled;
  runtime.urls = { normal: normalUrl, redundant: redundantUrl };
  runtime.initialized = true;
  if (changed) runtime.revision += 1;

  if (input.persist !== false) await persistRoutingFile();
  return getDatabaseRoutingStatus();
}

export function getDatabaseTargetConnectionString(target: DatabaseTarget) {
  refreshDatabaseRoutingFromDisk();
  const value = runtime.urls[target];
  if (!value) {
    throw Object.assign(new Error(`${target.toUpperCase()}_DATABASE_NOT_CONFIGURED`), { statusCode: 409 });
  }
  return value;
}

export function getDatabaseReadOrder(): DatabaseTarget[] {
  refreshDatabaseRoutingFromDisk();
  const maintenance = refreshFullSyncMaintenance();
  if (maintenance) return [maintenance.source];
  if (runtime.mode === "redundant") return ["redundant"];
  return runtime.mode === "both" ? ["normal", "redundant"] : ["normal"];
}

export function getDatabaseWriteOrder(): DatabaseTarget[] {
  refreshDatabaseRoutingFromDisk();
  if (refreshFullSyncMaintenance()) {
    throw Object.assign(new Error("DATABASE_FULL_SYNC_IN_PROGRESS"), {
      statusCode: 423,
      code: "DATABASE_FULL_SYNC_IN_PROGRESS",
    });
  }
  if (runtime.mode === "redundant") return ["redundant"];
  return runtime.mode === "both" ? ["normal", "redundant"] : ["normal"];
}

export function isDatabaseConnectionFailure(error: unknown) {
  const codes = new Set<string>();
  const messages: string[] = [];
  let current = error as ({ code?: unknown; message?: unknown; cause?: unknown } | null);
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code) codes.add(String(current.code).toUpperCase());
    if (current.message) messages.push(String(current.message).toUpperCase());
    current = current.cause && typeof current.cause === "object"
      ? current.cause as { code?: unknown; message?: unknown; cause?: unknown }
      : null;
  }
  const connectionCodes = [
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ETIMEDOUT",
    "P1001",
    "P1002",
    "P1000",
    "P1017",
    "28P01",
    "28000",
    "3D000",
    "57P01",
    "57P02",
    "57P03",
  ];
  if ([...codes].some((code) => connectionCodes.includes(code) || code.startsWith("08"))) return true;
  const message = messages.join(" ");
  return [
    "CAN'T REACH DATABASE SERVER",
    "CONNECTION REFUSED",
    "CONNECTION TERMINATED",
    "DATABASE NOT REACHABLE",
    "FAILED TO CONNECT",
    "PASSWORD AUTHENTICATION FAILED",
    "DATABASE DOES NOT EXIST",
    "SERVER CLOSED THE CONNECTION",
    "THE SERVER DOES NOT SUPPORT SSL CONNECTIONS",
    "ERROR OPENING A TLS CONNECTION",
  ].some((part) => message.includes(part));
}

export function isDatabaseAuthorizationFailure(error: unknown) {
  const codes = new Set<string>();
  const messages: string[] = [];
  let current = error as ({ code?: unknown; message?: unknown; cause?: unknown } | null);
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code) codes.add(String(current.code).toUpperCase());
    if (current.message) messages.push(String(current.message).toUpperCase());
    current = current.cause && typeof current.cause === "object"
      ? current.cause as { code?: unknown; message?: unknown; cause?: unknown }
      : null;
  }

  if (codes.has("42501")) return true;
  const message = messages.join(" ");
  return message.includes("42501")
    || message.includes("PERMISSION DENIED FOR SCHEMA")
    || message.includes("KEINE BERECHTIGUNG FÜR SCHEMA");
}

export function recordDatabaseTargetSuccess(target: DatabaseTarget) {
  if (runtime.lastFailure?.target === target) runtime.lastFailure = null;
}

function safeDatabaseErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    "$1***$3",
  );
}

export function recordDatabaseTargetFailure(target: DatabaseTarget, operation: string, error: unknown) {
  runtime.lastFailure = {
    target,
    operation,
    code: String((error as { code?: unknown } | null)?.code || "DATABASE_OPERATION_FAILED"),
    message: safeDatabaseErrorMessage(error),
    at: new Date().toISOString(),
  };
}

export function beginDatabaseFullSync(source: DatabaseTarget, target: DatabaseTarget) {
  if (source === target) throw new Error("DATABASE_SYNC_SOURCE_EQUALS_TARGET");
  refreshDatabaseRoutingFromDisk();
  if (refreshFullSyncMaintenance()) {
    throw Object.assign(new Error("DATABASE_FULL_SYNC_ALREADY_RUNNING"), {
      statusCode: 409,
      code: "DATABASE_FULL_SYNC_ALREADY_RUNNING",
    });
  }

  const maintenance: FullSyncMaintenance = {
    source,
    target,
    startedAt: new Date().toISOString(),
    owner: `${process.pid}-${randomBytes(12).toString("hex")}`,
  };
  const lockPath = fullSyncLockPath();
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(lockPath, `${JSON.stringify(maintenance, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw Object.assign(new Error("DATABASE_FULL_SYNC_ALREADY_RUNNING"), {
        statusCode: 409,
        code: "DATABASE_FULL_SYNC_ALREADY_RUNNING",
      });
    }
    throw error;
  }
  runtime.maintenance = maintenance;
}

export async function finishDatabaseFullSync(source: DatabaseTarget, target: DatabaseTarget, succeeded: boolean) {
  const owner = runtime.maintenance?.owner;
  const activeMaintenance = readFullSyncMaintenance();
  if (
    activeMaintenance
    && owner
    && activeMaintenance.owner === owner
    && activeMaintenance.source === source
    && activeMaintenance.target === target
  ) {
    unlinkSync(fullSyncLockPath());
  }
  runtime.maintenance = null;
  if (succeeded) {
    refreshDatabaseRoutingFromDisk();
    runtime.lastFullSync = { source, target, completedAt: new Date().toISOString() };
    runtime.lastFailure = null;
    await persistRoutingFile();
  }
}

export function getDatabaseRoutingStatus() {
  refreshDatabaseRoutingFromDisk();
  try {
    refreshFullSyncMaintenance();
  } catch {
    // Status bleibt lesbar; Schreiboperationen werfen den konkreten Lock-Fehler.
  }
  return {
    mode: runtime.mode,
    writeTargets: {
      normal: runtime.mode === "normal" || runtime.mode === "both",
      redundant: runtime.mode === "redundant" || runtime.mode === "both",
    },
    primary: runtime.mode === "redundant" ? "redundant" as const : "normal" as const,
    configured: {
      normal: Boolean(runtime.urls.normal),
      redundant: Boolean(runtime.urls.redundant),
    },
    jsonEmergency: {
      enabled: runtime.jsonEmergencyEnabled,
    },
    revision: runtime.revision,
    degraded: Boolean(runtime.lastFailure),
    lastFailure: runtime.lastFailure,
    lastFullSync: runtime.lastFullSync,
    maintenance: runtime.maintenance
      ? {
          source: runtime.maintenance.source,
          target: runtime.maintenance.target,
          startedAt: runtime.maintenance.startedAt,
        }
      : null,
    policy: "normal-primary-redundant-best-effort-json-emergency-manual-replay" as const,
  };
}
