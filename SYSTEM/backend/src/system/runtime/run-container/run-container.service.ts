import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getProjectRoot, getRunSystemSystemRoot } from "../../boot/run-system/index.js";
import { prisma } from "../../../core/database/prisma.js";
import { listModuleManifests } from "../../../platform/module-manager/manifests/index.js";
import { getRuntimeJsonFallbackStatus } from "../index.js";
import type {
  BuildRunContainerCandidateOptions,
  PublicRuntimeIdentity,
  RunContainerSlot,
  RunContainerStatus,
  RuntimeIdentity,
  RuntimeIdentityBase,
} from "./run-container.types.js";

const CURRENT_FILE = "current.json";
const IDENTITY_FILE = "runtime.json";
const MODULES_FILE = "installed-runtime.json";
const RUNCONTAINER_FILE = "runcontainer.stc";


type RuntimeJson = RuntimeIdentity & {
  slot?: RunContainerSlot;
  state?: string;
  runtimeSource?: string;
  fallbackSource?: string;
  databaseState?: string;
  lastHealthyAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type InstalledRuntimeJson = {
  slot: RunContainerSlot;
  state: string;
  updatedAt: string;
  source: string;
  modules: unknown[];
  [key: string]: unknown;
};

function runContainerRoot() {
  return process.env.RUNCONTAINER_ROOT
    ? path.resolve(process.env.RUNCONTAINER_ROOT)
    : getRunSystemSystemRoot();
}

function slotPath(slot: RunContainerSlot) {
  return path.join(runContainerRoot(), slot);
}

function identityPath(slot: RunContainerSlot) {
  return path.join(slotPath(slot), IDENTITY_FILE);
}

function modulesPath(slot: RunContainerSlot) {
  return path.join(slotPath(slot), MODULES_FILE);
}

function currentPath() {
  return path.join(runContainerRoot(), CURRENT_FILE);
}
function runContainerFilePath(slot: RunContainerSlot) {
  return path.join(slotPath(slot), RUNCONTAINER_FILE);
}

function encodeRunContainerEnvelope(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value, null, 2), "utf8").toString("base64url");
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  return `STUEBERLAPP_RUNCONTAINER_V1\n${payload}\n${checksum}\n`;
}

async function writeRunContainerFile(slot: RunContainerSlot, identity: RuntimeIdentity, modules: unknown) {
  await fs.writeFile(
    runContainerFilePath(slot),
    encodeRunContainerEnvelope({
      slot,
      createdAt: new Date().toISOString(),
      identity,
      modules,
      note: "Lokaler RunContainer. State-Key ist intern und wird nicht im System angezeigt.",
    }),
    "utf8",
  );
}


async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(file: string, value: unknown) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}


function identityOnly(value: RuntimeJson | RuntimeIdentity | null): RuntimeIdentity | null {
  if (!value?.createdAt || !value.systemVersion || !value.schemaVersion || typeof value.userCount !== "number" || !value.stateKey) {
    return null;
  }

  return {
    createdAt: value.createdAt,
    systemVersion: value.systemVersion,
    schemaVersion: value.schemaVersion,
    userCount: value.userCount,
    stateKey: value.stateKey,
  };
}

function runtimeJsonForSlot(slot: RunContainerSlot, identity: RuntimeIdentity, existing?: Partial<RuntimeJson> | null): RuntimeJson {
  const now = new Date().toISOString();
  return {
    ...(existing ?? {}),
    ...identity,
    slot,
    state: typeof existing?.state === "string" ? existing.state : "healthy",
    runtimeSource: typeof existing?.runtimeSource === "string" ? existing.runtimeSource : "database",
    fallbackSource: typeof existing?.fallbackSource === "string" ? existing.fallbackSource : "json",
    databaseState: typeof existing?.databaseState === "string" ? existing.databaseState : "ok",
    lastHealthyAt: typeof existing?.lastHealthyAt === "string" ? existing.lastHealthyAt : now,
    updatedAt: now,
  };
}

function installedRuntimeJsonForSlot(
  slot: RunContainerSlot,
  modules: unknown,
  existing?: Partial<InstalledRuntimeJson> | null,
): InstalledRuntimeJson {
  const now = new Date().toISOString();
  const moduleList = Array.isArray(modules)
    ? modules
    : Array.isArray((modules as { modules?: unknown[] } | null)?.modules)
      ? ((modules as { modules: unknown[] }).modules)
      : [];

  return {
    ...(existing ?? {}),
    slot,
    state: typeof existing?.state === "string" ? existing.state : "healthy",
    updatedAt: now,
    source: typeof existing?.source === "string" ? existing.source : "database",
    modules: moduleList,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function publicIdentity(identity: RuntimeIdentity): PublicRuntimeIdentity {
  const { stateKey: _stateKey, ...visible } = identity;
  return visible;
}

function computeStateKey(base: RuntimeIdentityBase) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(base))
    .digest("hex");
}

async function getSystemVersion() {
  const manifest = await readJson<{ version?: string }>(path.join(getProjectRoot(), "System", "system.manifest.json"));
  if (manifest?.version) {
    return manifest.version;
  }

  const packageJson = await readJson<{ version?: string }>(path.join(process.cwd(), "package.json"));
  return packageJson?.version ?? "0.0.0-dev";
}

async function countUsersFromDatabase(existingUserCount = 0): Promise<number> {
  try {
    const delegate = (prisma as unknown as { account?: { count(): Promise<number> } }).account;
    if (!delegate?.count) {
      return existingUserCount;
    }
    return await delegate.count();
  } catch {
    return existingUserCount;
  }
}

async function readDatabaseIdentity(): Promise<RuntimeIdentity | null> {
  try {
    const delegate = (prisma as unknown as {
      systemRuntimeIdentity?: {
        findUnique(args: unknown): Promise<RuntimeIdentity | null>;
      };
    }).systemRuntimeIdentity;

    if (!delegate?.findUnique) {
      return null;
    }

    return await delegate.findUnique({ where: { id: "singleton" } });
  } catch {
    return null;
  }
}

async function writeDatabaseIdentity(identity: RuntimeIdentity) {
  try {
    const delegate = (prisma as unknown as {
      systemRuntimeIdentity?: {
        upsert(args: unknown): Promise<RuntimeIdentity>;
      };
    }).systemRuntimeIdentity;

    if (!delegate?.upsert) {
      return false;
    }

    await delegate.upsert({
      where: { id: "singleton" },
      update: identity,
      create: { id: "singleton", ...identity },
    });
    return true;
  } catch {
    return false;
  }
}

function identitiesMatch(left: RuntimeIdentity | null, right: RuntimeIdentity | null) {
  if (!left || !right) {
    return null;
  }

  return left.stateKey === right.stateKey;
}

async function readSlotRuntime(slot: RunContainerSlot) {
  return readJson<RuntimeJson>(identityPath(slot));
}

async function readSlotIdentity(slot: RunContainerSlot) {
  return identityOnly(await readSlotRuntime(slot));
}

async function writeSlotRuntime(slot: RunContainerSlot, identity: RuntimeIdentity, existing?: Partial<RuntimeJson> | null) {
  const runtime = runtimeJsonForSlot(slot, identity, existing);
  await writeJson(identityPath(slot), runtime);
  return runtime;
}

async function readInstalledRuntime(slot: RunContainerSlot) {
  return readJson<InstalledRuntimeJson | unknown[]>(modulesPath(slot));
}

async function writeInstalledRuntime(slot: RunContainerSlot, modules: unknown, existing?: Partial<InstalledRuntimeJson> | null) {
  const installedRuntime = installedRuntimeJsonForSlot(slot, modules, existing);
  await writeJson(modulesPath(slot), installedRuntime);
  return installedRuntime;
}

async function createIdentity(existing?: RuntimeIdentity | null): Promise<RuntimeIdentity> {
  const base: RuntimeIdentityBase = {
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    systemVersion: await getSystemVersion(),
    schemaVersion: process.env.SYSTEM_SCHEMA_VERSION ?? existing?.schemaVersion ?? "development",
    userCount: await countUsersFromDatabase(existing?.userCount ?? 0),
  };

  return {
    ...base,
    stateKey: computeStateKey(base),
  };
}

async function listAvailableFeatureModules() {
  try {
    const manifests = await listModuleManifests();
    return manifests
      .filter((manifest) => manifest.kind === "app")
      .map((manifest) => ({
        id: manifest.key,
        name: manifest.name,
        version: manifest.version,
        type: manifest.kind,
        source: manifest.sourcePath || "",
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function ensureRunContainer() {
  await Promise.all([
    ensureDir(slotPath("active")),
    ensureDir(slotPath("candidate")),
    ensureDir(slotPath("emergency")),
    ensureDir(path.join(runContainerRoot(), "history")),
    ensureDir(path.join(runContainerRoot(), "install-queue")),
  ]);

  let active = await readSlotIdentity("active");
  if (!active) {
    active = await createIdentity();
    const activeModules = await listAvailableFeatureModules();
    const activeRuntime = await writeSlotRuntime("active", active);
    const activeInstalledRuntime = await writeInstalledRuntime("active", activeModules);
    await writeRunContainerFile("active", active, { runtime: activeRuntime, installedRuntime: activeInstalledRuntime });
    await writeJson(currentPath(), {
      slot: "active",
      createdAt: active.createdAt,
      systemVersion: active.systemVersion,
      schemaVersion: active.schemaVersion,
      userCount: active.userCount,
    });
    await writeDatabaseIdentity(active);
  }

  return active;
}

export async function getRunContainerStatus(): Promise<RunContainerStatus> {
  await ensureRunContainer();

  const active = await readSlotIdentity("active");
  const [databaseIdentity, runtimeFallback] = await Promise.all([
    readDatabaseIdentity(),
    getRuntimeJsonFallbackStatus(),
  ]);
  const matchesDatabase = identitiesMatch(active, databaseIdentity);
  const ok = matchesDatabase !== false || runtimeFallback.active;

  return {
    ok,
    slot: "active",
    root: runContainerRoot(),
    identity: active ? publicIdentity(active) : undefined,
    databaseIdentity: databaseIdentity ? publicIdentity(databaseIdentity) : null,
    matchesDatabase,
    runtimeFallback,
    message:
      matchesDatabase === false
        ? runtimeFallback.active
          ? "System-Abgleich zur Datenbank fehlgeschlagen. Notlauf über runtime.json und installed-runtime.json ist aktiv."
          : "System-Abgleich fehlgeschlagen. Der lokale RunContainer passt nicht zur Datenbank."
        : runtimeFallback.active
          ? "Datenbank-Abgleich ist nicht verfügbar. Notlauf über runtime.json und installed-runtime.json ist aktiv."
          : "System-Abgleich erfolgreich oder Datenbank-Abgleich noch nicht verfügbar.",
  } as RunContainerStatus & { runtimeFallback: typeof runtimeFallback };
}

export async function assertRunContainerMatchesDatabase() {
  const status = await getRunContainerStatus() as RunContainerStatus & { runtimeFallback?: { active?: boolean } };
  if (status.matchesDatabase === false && !status.runtimeFallback?.active) {
    throw new Error("RUNCONTAINER_DATABASE_MISMATCH");
  }
  return status;
}

export async function buildRunContainerCandidate(options: BuildRunContainerCandidateOptions = {}) {
  await ensureRunContainer();

  const existingCandidate = await readSlotIdentity("candidate");
  const candidate = await createIdentity(existingCandidate);

  const candidateModules = await listAvailableFeatureModules();
  const candidateRuntime = await writeSlotRuntime("candidate", candidate);
  const candidateInstalledRuntime = await writeInstalledRuntime("candidate", candidateModules);
  await writeRunContainerFile("candidate", candidate, { runtime: candidateRuntime, installedRuntime: candidateInstalledRuntime });
  await writeJson(path.join(slotPath("candidate"), "build-info.json"), {
    reason: options.reason ?? "manual",
    requestedBy: options.requestedBy ?? null,
    createdAt: new Date().toISOString(),
    source: "local-vscode-runcontainer",
  });

  return publicIdentity(candidate);
}

export async function promoteCandidateToActive() {
  await ensureRunContainer();

  const candidate = await readSlotIdentity("candidate");
  if (!candidate) {
    throw new Error("RUNCONTAINER_CANDIDATE_NOT_FOUND");
  }

  const active = await readSlotIdentity("active");
  if (active) {
    const activeRuntime = await readSlotRuntime("active");
    const activeInstalledRuntime = await readInstalledRuntime("active");
    const emergencyRuntime = runtimeJsonForSlot("emergency", active, activeRuntime);
    await writeJson(identityPath("emergency"), emergencyRuntime);
    if (activeInstalledRuntime) {
      const emergencyInstalledRuntime = installedRuntimeJsonForSlot("emergency", activeInstalledRuntime);
      await writeJson(modulesPath("emergency"), emergencyInstalledRuntime);
      await writeRunContainerFile("emergency", active, { runtime: emergencyRuntime, installedRuntime: emergencyInstalledRuntime });
    }
  }

  const candidateRuntime = await readSlotRuntime("candidate");
  const candidateInstalledRuntime = await readInstalledRuntime("candidate");
  const activeRuntime = await writeSlotRuntime("active", candidate, candidateRuntime);
  const activeInstalledRuntime = await writeInstalledRuntime("active", candidateInstalledRuntime ?? []);
  await writeRunContainerFile("active", candidate, { runtime: activeRuntime, installedRuntime: activeInstalledRuntime });
  await writeJson(currentPath(), {
    slot: "active",
    createdAt: candidate.createdAt,
    systemVersion: candidate.systemVersion,
    schemaVersion: candidate.schemaVersion,
    userCount: candidate.userCount,
  });

  await writeDatabaseIdentity(candidate);

  return publicIdentity(candidate);
}

export async function getRunContainerDiagnostics() {
  const status = await getRunContainerStatus();
  const availableFeatureModules = await listAvailableFeatureModules();
  const activeInstalledRuntime = await readInstalledRuntime("active");
  const activeModules = Array.isArray(activeInstalledRuntime)
    ? activeInstalledRuntime
    : Array.isArray((activeInstalledRuntime as { modules?: unknown[] } | null)?.modules)
      ? (activeInstalledRuntime as { modules: unknown[] }).modules
      : [];

  return {
    ...status,
    availableFeatureModules,
    activeInstalledRuntime,
    activeModules,
  };
}
