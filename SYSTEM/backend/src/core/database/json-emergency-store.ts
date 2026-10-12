import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import { isDataDomain, type DataDomain } from "./data-domains.js";

const STORE_VERSION = 1;
const STORE_FILE_NAME = "json-emergency.enc.json";
const STORE_LOCK_FILE_NAME = "json-emergency.lock";
const STORE_AAD = "bonni-core:json-emergency:v1";
const MAX_QUEUE_ENTRIES = 10_000;
const MAX_IDENTITY_ENTRIES = 250;
const IDENTITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const IDENTITY_REFRESH_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 20;

type StoredEmergencyWrite = {
  id: string;
  queuedAt: string;
  dataDomain?: DataDomain;
  modelProperty: string;
  operation: string;
  args: unknown;
  attempts: number;
  lastError: string | null;
};

type StoredEmergencyIdentity = {
  accountId: string;
  cachedAt: string;
  fingerprint: string;
  payload: unknown;
};

type EmergencyStoreState = {
  version: 1;
  active: boolean;
  updatedAt: string;
  entries: StoredEmergencyWrite[];
  identities: Record<string, StoredEmergencyIdentity>;
  lastQueuedAt: string | null;
  lastDatabaseRecoveredAt: string | null;
  lastReplayAt: string | null;
  lastReplayTarget: string | null;
  lastError: string | null;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type JsonEmergencyWrite = {
  id: string;
  queuedAt: string;
  dataDomain: DataDomain;
  modelProperty: string;
  operation: string;
  args: unknown[];
  attempts: number;
  lastError: string | null;
};

export type JsonEmergencyStatus = {
  active: boolean;
  pendingCount: number;
  lastQueuedAt: string | null;
  lastDatabaseRecoveredAt: string | null;
  lastReplayAt: string | null;
  lastReplayTarget: string | null;
  lastError: string | null;
  encrypted: true;
  fileName: string;
};

let emergencyActiveHint: boolean | null = null;
const identityWriteCache = new Map<string, { fingerprint: string; writtenAt: number }>();

function emergencyRoot() {
  return path.join(path.resolve(env.BONNI_RUNTIME_STATE_ROOT), "system");
}

export function jsonEmergencyStorePath() {
  return path.join(emergencyRoot(), STORE_FILE_NAME);
}

function jsonEmergencyLockPath() {
  return path.join(emergencyRoot(), STORE_LOCK_FILE_NAME);
}

function defaultState(): EmergencyStoreState {
  return {
    version: STORE_VERSION,
    active: false,
    updatedAt: new Date().toISOString(),
    entries: [],
    identities: {},
    lastQueuedAt: null,
    lastDatabaseRecoveredAt: null,
    lastReplayAt: null,
    lastReplayTarget: null,
    lastError: null,
  };
}

function encryptionKey() {
  return createHash("sha256")
    .update(env.MASTER_KEY, "utf8")
    .update(STORE_AAD, "utf8")
    .digest();
}

function encryptState(state: EmergencyStoreState): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(STORE_AAD, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return {
    version: STORE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptState(envelope: EncryptedEnvelope): EmergencyStoreState {
  if (
    envelope?.version !== STORE_VERSION
    || envelope?.algorithm !== "aes-256-gcm"
    || !envelope.iv
    || !envelope.authTag
    || !envelope.ciphertext
  ) {
    throw new Error("JSON_EMERGENCY_STORE_FORMAT_INVALID");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(STORE_AAD, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as Partial<EmergencyStoreState>;
  if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error("JSON_EMERGENCY_STORE_CONTENT_INVALID");
  }
  return {
    ...defaultState(),
    ...parsed,
    version: STORE_VERSION,
    entries: parsed.entries as StoredEmergencyWrite[],
    identities: parsed.identities && typeof parsed.identities === "object"
      ? parsed.identities as Record<string, StoredEmergencyIdentity>
      : {},
  };
}

async function readStateUnlocked() {
  try {
    const envelope = JSON.parse(
      await fs.readFile(jsonEmergencyStorePath(), "utf8"),
    ) as EncryptedEnvelope;
    return decryptState(envelope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw Object.assign(new Error("JSON_EMERGENCY_STORE_UNREADABLE"), {
      code: "JSON_EMERGENCY_STORE_UNREADABLE",
      cause: error,
    });
  }
}

async function writeStateUnlocked(state: EmergencyStoreState) {
  await fs.mkdir(emergencyRoot(), { recursive: true, mode: 0o700 });
  const file = jsonEmergencyStorePath();
  const temporaryFile = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const nextState: EmergencyStoreState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(temporaryFile, `${JSON.stringify(encryptState(nextState), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryFile, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStoreLock() {
  await fs.mkdir(emergencyRoot(), { recursive: true, mode: 0o700 });
  const lockFile = jsonEmergencyLockPath();
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      return await fs.open(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stats = await fs.stat(lockFile);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockFile);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await wait(LOCK_RETRY_MS);
    }
  }
  throw Object.assign(new Error("JSON_EMERGENCY_STORE_LOCK_TIMEOUT"), {
    code: "JSON_EMERGENCY_STORE_LOCK_TIMEOUT",
    statusCode: 503,
  });
}

async function withStoreLock<T>(operation: () => Promise<T>) {
  const handle = await acquireStoreLock();
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(jsonEmergencyLockPath()).catch(() => undefined);
  }
}

function encodeValue(value: unknown, parents = new WeakSet<object>()): unknown {
  if (value === undefined) return { $bonniType: "undefined" };
  if (typeof value === "bigint") return { $bonniType: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { $bonniType: "number", value: String(value) };
  }
  if (value instanceof Date) return { $bonniType: "date", value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $bonniType: "buffer", value: value.toString("base64") };
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error("JSON_EMERGENCY_VALUE_NOT_SERIALIZABLE");
  }
  if (!value || typeof value !== "object") return value;
  if (parents.has(value)) throw new Error("JSON_EMERGENCY_CYCLIC_VALUE");
  parents.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => encodeValue(entry, parents));
    const objectValue = value as Record<string, unknown> & { constructor?: { name?: string } };
    if (objectValue.constructor?.name === "Decimal" && "toString" in objectValue) {
      return { $bonniType: "decimal", value: String(value) };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeValue(entry, parents)]),
    );
  } finally {
    parents.delete(value);
  }
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.$bonniType === "undefined") return undefined;
  if (record.$bonniType === "bigint") return BigInt(String(record.value));
  if (record.$bonniType === "date") return new Date(String(record.value));
  if (record.$bonniType === "buffer") return Buffer.from(String(record.value), "base64");
  if (record.$bonniType === "decimal") return String(record.value);
  if (record.$bonniType === "number") {
    if (record.value === "Infinity") return Infinity;
    if (record.value === "-Infinity") return -Infinity;
    return Number.NaN;
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeValue(entry)]));
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "JSON_EMERGENCY_FAILED");
  return message
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, "$1***$3")
    .slice(0, 500);
}

function pruneIdentities(state: EmergencyStoreState) {
  const cutoff = Date.now() - IDENTITY_MAX_AGE_MS;
  const identities = Object.values(state.identities)
    .filter((entry) => new Date(entry.cachedAt).getTime() >= cutoff)
    .sort((left, right) => right.cachedAt.localeCompare(left.cachedAt))
    .slice(0, MAX_IDENTITY_ENTRIES);
  state.identities = Object.fromEntries(identities.map((entry) => [entry.accountId, entry]));
}

function publicStatus(state: EmergencyStoreState): JsonEmergencyStatus {
  emergencyActiveHint = state.active;
  return {
    active: state.active,
    pendingCount: state.entries.length,
    lastQueuedAt: state.lastQueuedAt,
    lastDatabaseRecoveredAt: state.lastDatabaseRecoveredAt,
    lastReplayAt: state.lastReplayAt,
    lastReplayTarget: state.lastReplayTarget,
    lastError: state.lastError,
    encrypted: true,
    fileName: STORE_FILE_NAME,
  };
}

export async function getJsonEmergencyStatus() {
  return publicStatus(await readStateUnlocked());
}

export async function enqueueJsonEmergencyWrite(input: {
  dataDomain?: DataDomain;
  modelProperty: string;
  operation: string;
  args: unknown[];
  databaseError?: unknown;
}) {
  return withStoreLock(async () => {
    const state = await readStateUnlocked();
    if (state.entries.length >= MAX_QUEUE_ENTRIES) {
      throw Object.assign(new Error("JSON_EMERGENCY_QUEUE_LIMIT_REACHED"), {
        code: "JSON_EMERGENCY_QUEUE_LIMIT_REACHED",
        statusCode: 507,
      });
    }
    const queuedAt = new Date().toISOString();
    const entry: StoredEmergencyWrite = {
      id: randomUUID(),
      queuedAt,
      dataDomain: input.dataDomain || "core",
      modelProperty: input.modelProperty,
      operation: input.operation,
      args: encodeValue(input.args),
      attempts: 0,
      lastError: input.databaseError ? safeErrorMessage(input.databaseError) : null,
    };
    state.entries.push(entry);
    state.active = true;
    state.lastQueuedAt = queuedAt;
    state.lastError = entry.lastError;
    emergencyActiveHint = true;
    await writeStateUnlocked(state);
    return {
      id: entry.id,
      queuedAt,
      status: publicStatus(state),
    };
  });
}

export async function listJsonEmergencyWrites(): Promise<JsonEmergencyWrite[]> {
  const state = await readStateUnlocked();
  return state.entries.map((entry) => ({
    ...entry,
    dataDomain: isDataDomain(entry.dataDomain) ? entry.dataDomain : "core",
    args: decodeValue(entry.args) as unknown[],
  }));
}

export async function acknowledgeJsonEmergencyWrite(id: string, target: string) {
  return withStoreLock(async () => {
    const state = await readStateUnlocked();
    state.entries = state.entries.filter((entry) => entry.id !== id);
    state.lastReplayAt = new Date().toISOString();
    state.lastReplayTarget = target;
    state.lastError = null;
    await writeStateUnlocked(state);
    return publicStatus(state);
  });
}

export async function recordJsonEmergencyReplayFailure(id: string, target: string, error: unknown) {
  return withStoreLock(async () => {
    const state = await readStateUnlocked();
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (entry) {
      entry.attempts += 1;
      entry.lastError = safeErrorMessage(error);
    }
    state.lastReplayAt = new Date().toISOString();
    state.lastReplayTarget = target;
    state.lastError = safeErrorMessage(error);
    await writeStateUnlocked(state);
    return publicStatus(state);
  });
}

export async function markJsonEmergencyDatabaseRecovered() {
  if (emergencyActiveHint === false) return null;
  return withStoreLock(async () => {
    const state = await readStateUnlocked();
    if (!state.active) {
      emergencyActiveHint = false;
      return publicStatus(state);
    }
    state.active = false;
    state.lastDatabaseRecoveredAt = new Date().toISOString();
    emergencyActiveHint = false;
    await writeStateUnlocked(state);
    return publicStatus(state);
  });
}

export async function cacheJsonEmergencyIdentity(accountId: string, payload: unknown) {
  const encodedPayload = encodeValue(payload);
  const fingerprint = createHash("sha256").update(JSON.stringify(encodedPayload)).digest("hex");
  const cached = identityWriteCache.get(accountId);
  if (cached?.fingerprint === fingerprint && Date.now() - cached.writtenAt < IDENTITY_REFRESH_MS) {
    return;
  }

  await withStoreLock(async () => {
    const state = await readStateUnlocked();
    const existing = state.identities[accountId];
    const existingAge = existing ? Date.now() - new Date(existing.cachedAt).getTime() : Infinity;
    if (existing?.fingerprint === fingerprint && existingAge < IDENTITY_REFRESH_MS) return;
    state.identities[accountId] = {
      accountId,
      cachedAt: new Date().toISOString(),
      fingerprint,
      payload: encodedPayload,
    };
    pruneIdentities(state);
    await writeStateUnlocked(state);
  });

  identityWriteCache.set(accountId, { fingerprint, writtenAt: Date.now() });
}

export async function getJsonEmergencyIdentity<T = unknown>(accountId: string): Promise<T | null> {
  const state = await readStateUnlocked();
  pruneIdentities(state);
  const identity = state.identities[accountId];
  return identity ? decodeValue(identity.payload) as T : null;
}
