import fs from "node:fs/promises";
import path from "node:path";

import { prisma } from "../../core/database/prisma.js";
import { getRunSystemSystemRoot } from "../boot/run-system/index.js";

const RUNTIME_FILE = "runtime.json";
const INSTALLED_RUNTIME_FILE = "installed-runtime.json";
const DEFAULT_DATABASE_PROBE_TIMEOUT_MS = 2_000;

type JsonRecord = Record<string, unknown>;

type RuntimeSlot = "active" | "candidate" | "emergency";

export type RuntimeJsonFallbackStatus = {
  ok: boolean;
  mode: "database" | "json" | "auto";
  slot: RuntimeSlot;
  active: boolean;
  state: "database" | "notlauf" | "unavailable";
  reason: string | null;
  runtimeSource: "database" | "json";
  fallbackSource: "json";
  database: {
    ok: boolean;
    required: boolean;
    checkedAt: string;
    error: string | null;
  };
  json: {
    ok: boolean;
    slot: RuntimeSlot;
    runtimePath: string;
    installedRuntimePath: string;
    runtimeAvailable: boolean;
    installedRuntimeAvailable: boolean;
  };
  restrictions: {
    writes: "database-required" | "limited-json-queue";
    allowed: string[];
    blocked: string[];
  };
};

function systemRoot() {
  return process.env.RUNCONTAINER_ROOT
    ? path.resolve(process.env.RUNCONTAINER_ROOT)
    : getRunSystemSystemRoot();
}

function slotPath(slot: RuntimeSlot) {
  return path.join(systemRoot(), slot);
}

export function resolveRuntimeJsonSlot(): RuntimeSlot {
  const role = String(process.env.SYSTEM_SLOT_ROLE ?? "active").trim().toLowerCase();
  const name = String(process.env.SYSTEM_SLOT_NAME ?? "").trim().toLowerCase();

  if (role === "emergency" || name.includes("emergency")) {
    return "emergency";
  }

  if (role === "candidate" || name.includes("candidate")) {
    return "candidate";
  }

  return "active";
}

export function runtimeJsonPath(slot: RuntimeSlot = "active") {
  return path.join(slotPath(slot), RUNTIME_FILE);
}

export function installedRuntimeJsonPath(slot: RuntimeSlot = "active") {
  return path.join(slotPath(slot), INSTALLED_RUNTIME_FILE);
}

async function readJson<T = JsonRecord>(file: string): Promise<T | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as T : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function normalizeRuntimeSourceMode() {
  const raw = String(
    process.env.SYSTEM_RUNTIME_SOURCE ??
    process.env.RUNTIME_SOURCE ??
    process.env.NOTLAUF_RUNTIME_SOURCE ??
    "auto",
  ).trim().toLowerCase();

  if (["json", "file", "fallback", "notlauf", "emergency"].includes(raw)) {
    return "json" as const;
  }

  if (["database", "db", "postgres", "postgresql"].includes(raw)) {
    return "database" as const;
  }

  return "auto" as const;
}

function databaseRequired() {
  return normalizeRuntimeSourceMode() === "database";
}

function timeoutMs() {
  const value = Number(process.env.RUNTIME_DATABASE_PROBE_TIMEOUT_MS ?? DEFAULT_DATABASE_PROBE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DATABASE_PROBE_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function probeRuntimeDatabase() {
  const checkedAt = new Date().toISOString();
  try {
    const delegate = prisma as unknown as { $queryRawUnsafe<T = unknown>(query: string): Promise<T> };
    await withTimeout(delegate.$queryRawUnsafe("SELECT 1"), timeoutMs(), "runtime database probe");
    return { ok: true, checkedAt, error: null as string | null };
  } catch (error) {
    return { ok: false, checkedAt, error: errorMessage(error) };
  }
}

export async function readRuntimeJson(slot: RuntimeSlot = "active") {
  return readJson<JsonRecord>(runtimeJsonPath(slot));
}

export async function readInstalledRuntimeJson(slot: RuntimeSlot = "active") {
  return readJson<JsonRecord>(installedRuntimeJsonPath(slot));
}

export function installedRuntimeModules(installedRuntime: unknown): JsonRecord[] {
  if (Array.isArray(installedRuntime)) {
    return installedRuntime.filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
  }

  const modules = (installedRuntime as { modules?: unknown[] } | null)?.modules;
  return Array.isArray(modules)
    ? modules.filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

export async function getRuntimeJsonFallbackStatus(): Promise<RuntimeJsonFallbackStatus> {
  const mode = normalizeRuntimeSourceMode();
  const slot = resolveRuntimeJsonSlot();
  const [database, runtime, installedRuntime] = await Promise.all([
    probeRuntimeDatabase(),
    readRuntimeJson(slot),
    readInstalledRuntimeJson(slot),
  ]);

  const runtimeAvailable = Boolean(runtime);
  const installedRuntimeAvailable = Boolean(installedRuntime);
  const jsonOk = runtimeAvailable && installedRuntimeAvailable;
  const forcedJson = mode === "json";
  const forcedDatabase = mode === "database";
  const active = forcedJson || (!forcedDatabase && !database.ok && jsonOk);
  const ok = database.ok || (active && jsonOk && !databaseRequired());

  return {
    ok,
    mode,
    slot,
    active,
    state: database.ok && !forcedJson ? "database" : active && jsonOk ? "notlauf" : "unavailable",
    reason: active
      ? forcedJson
        ? "RUNTIME_SOURCE_JSON_FORCED"
        : "DATABASE_UNAVAILABLE_USING_RUNTIME_JSON"
      : database.ok
        ? null
        : "DATABASE_UNAVAILABLE_AND_RUNTIME_JSON_NOT_READY",
    runtimeSource: active ? "json" : "database",
    fallbackSource: "json",
    database: {
      ...database,
      required: databaseRequired(),
    },
    json: {
      ok: jsonOk,
      slot,
      runtimePath: runtimeJsonPath(slot),
      installedRuntimePath: installedRuntimeJsonPath(slot),
      runtimeAvailable,
      installedRuntimeAvailable,
    },
    restrictions: {
      writes: active ? "limited-json-queue" : "database-required",
      allowed: active
        ? [
            "Systemstatus lesen",
            "Installierte Fachmodule lesen",
            "operative Notlaufdaten vorbereiten",
            "Bestellungen als spätere Abgleichdaten vormerken",
          ]
        : [
            "voller Datenbankbetrieb",
            "Fachmodul-Installation",
            "Rechnungen",
            "Geldtransfers",
          ],
      blocked: active
        ? [
            "Rechnungen erstellen oder finalisieren",
            "Kassenabschluss buchen",
            "Geldtransfer ausführen",
            "Fachmodule installieren oder entfernen",
            "Datenbank-Migrationen ausführen",
          ]
        : [],
    },
  };
}

export async function shouldUseRuntimeJsonFallback() {
  return (await getRuntimeJsonFallbackStatus()).active;
}

export async function assertDatabaseRuntimeRequired(action: string) {
  const status = await getRuntimeJsonFallbackStatus();
  if (status.active || !status.database.ok) {
    const error = new Error(`DATABASE_REQUIRED:${action}`);
    (error as Error & { status?: number; details?: RuntimeJsonFallbackStatus }).status = 503;
    (error as Error & { status?: number; details?: RuntimeJsonFallbackStatus }).details = status;
    throw error;
  }
}
