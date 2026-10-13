import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getProductRoot, getProjectRoot } from "../../../boot/run-system/run-system.paths.js";
import {
  compareBonniReleaseVersion,
} from "../../../update-release/semver.js";

const SOURCE_SCHEMA = "bonni.local-source-update/v1";
const SOURCE_PAYLOAD_LAYOUT = "content-addressed-delta-v1";
const SOURCE_REPAIR_PAYLOAD_LAYOUT = "content-addressed-repair-v1";
const LEGACY_SOURCE_PAYLOAD_LAYOUT = "tree-full-v1";
const REQUEST_SCHEMA = "bonni.local-source-update-request/v2";
const SOURCE_STATUS = "UNPUBLISHED_TEST_UPDATE";
const SOURCE_CHANNEL = "development";
const MANIFEST_NAME = "bonni-source-update.json";
const MONITOR_ACCESS_FILE = "monitor-access.json";
const QUEUE_CLAIM_FILE = "request.queue-claim.json";
const QUEUE_CLAIM_SCHEMA = "bonni.local-source-update-queue-claim/v1";
const QUEUE_CLAIM_HMAC_DOMAIN = "bonni.local-source-update-queue-claim-hmac/v1";
const MONITOR_TOKEN_DERIVATION_DOMAIN = "bonni.local-source-update-monitor-token/v1";
// Source-Manifeste binden jede verwaltete Datei einzeln und sind bei einem
// vollständigen Core/Kontor-Stand bereits größer als typische Release-Metadaten.
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ENTRIES = 20_000;
const HEARTBEAT_MAX_AGE_MS = 15_000;
const MONITOR_ACCESS_LIFETIME_MS = 60 * 60_000;
const MAXIMUM_TIMESTAMP_FUTURE_SKEW_MS = 24 * 60 * 60_000;

type VersionPair = {
  coreVersion: string;
  kontorAppVersion: string;
};

type LocalSourceReleaseNotes = {
  title: string;
  summary: string;
  changes: Array<{
    type: "security" | "fix" | "improvement" | "information";
    title: string;
    detail: string;
  }>;
};

type CompletedUpdateMetadata = {
  createdAt: string | null;
  from: VersionPair;
  to: VersionPair;
  components: Array<{ key: string; path: string; mode: "managed" }>;
  counts: { files: number; inventory: number; delete: number };
  repair: boolean;
};

type LocalSourceManifest = {
  schemaVersion: typeof SOURCE_SCHEMA;
  status: typeof SOURCE_STATUS;
  channel: typeof SOURCE_CHANNEL;
  updateId: string;
  createdAt: string;
  payloadLayout: typeof SOURCE_PAYLOAD_LAYOUT | typeof SOURCE_REPAIR_PAYLOAD_LAYOUT | typeof LEGACY_SOURCE_PAYLOAD_LAYOUT;
  requires: { updateId: string; manifestSha256: string } | null;
  releaseNotes: LocalSourceReleaseNotes | null;
  from: VersionPair;
  to: VersionPair;
  components: Array<{ key: string; path: string; mode: "managed" }>;
  files: Array<{ path: string; sizeBytes: number; sha256: string; expectedPreviousSha256: string | null }>;
  delete: Array<{ path: string; expectedSha256: string; reason: string }>;
};

type SupervisorHeartbeat = {
  schemaVersion?: string;
  version?: string;
  instanceId?: string;
  pid?: number;
  available?: boolean;
  state?: string;
  updatedAt?: string;
  message?: string;
  monitor?: {
    schemaVersion?: string;
    available?: boolean;
    origin?: string | null;
    bind?: string;
    port?: number | null;
  };
};

type SupervisorProgress = {
  schemaVersion?: string;
  requestId?: string;
  updateId?: string;
  manifestSha256?: string;
  status?: string;
  phase?: string;
  message?: string;
  error?: string;
  errorCode?: string;
  updatedAt?: string;
  steps?: Array<{ key?: string; label?: string; status?: string; detail?: string }>;
};

type LocalSourceState =
  | "disabled"
  | "none"
  | "available"
  | "already-installed"
  | "in-progress"
  | "completed"
  | "failed"
  | "invalid"
  | "id-collision"
  | "multiple-packages"
  | "recovery-required";

type LocalSourceStatus = {
  enabled: boolean;
  state: LocalSourceState;
  updateAvailable: boolean;
  updateId: string | null;
  manifestSha256: string | null;
  from: VersionPair | null;
  to: VersionPair | null;
  components: Array<{ key: string; path: string }>;
  counts: { files: number; inventory: number; delete: number };
  repair: boolean;
  testOnly: true;
  message: string;
  errorCode: string | null;
  requiredPredecessor: {
    updateId: string;
    manifestSha256: string;
    coreVersion: string;
    kontorAppVersion: string;
  } | null;
  runner: Awaited<ReturnType<typeof readSupervisorStatus>>;
  progress: SupervisorProgress | null;
  releaseNotes?: LocalSourceReleaseNotes | null;
};

function visibleComponents(
  components: Array<{ key: string; path: string; mode?: "managed" }>,
  from: VersionPair,
  to: VersionPair,
) {
  return components
    .filter((component) => (
      component.key !== "app.kontorapp"
      || from.kontorAppVersion !== to.kontorAppVersion
    ))
    .map(({ key, path: componentPath }) => ({ key, path: componentPath }));
}

function predecessorLabel(updateId: string) {
  const number = updateId.match(/(?:^|-)([0-9]{2})$/u)?.[1];
  return number ? `Update ${number}` : `Update ${updateId}`;
}

function sourceUpdatesEnabled() {
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") return false;
  return String(process.env.BONNI_LOCAL_SOURCE_UPDATES || "true").trim().toLowerCase() !== "false";
}

function stateRoot() {
  return path.join(getProductRoot(), "SYSTEM", ".bonni-source-update");
}

function controlRoot() {
  return path.join(stateRoot(), "control-center");
}

function inboxRoot() {
  return path.join(getProductRoot(), "UPDATE", "inbox");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type MonitorTokenBinding = {
  requestId: string;
  updateId: string;
  manifestSha256: string;
  supervisorInstanceId: string;
};

function monitorTokenSecret(environment: NodeJS.ProcessEnv = process.env) {
  const secret = String(environment.JWT_SECRET || environment.MASTER_KEY || "");
  if (secret.length < 32 || secret.includes("\u0000")) {
    throw new Error("LOCAL_SOURCE_MONITOR_TOKEN_SECRET_MISSING");
  }
  return secret;
}

export function deriveLocalSourceMonitorToken(
  binding: MonitorTokenBinding,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    !isPlainObject(binding)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(binding.requestId || ""))
    || !validUpdateId(binding.updateId)
    || !/^[a-f0-9]{64}$/u.test(String(binding.manifestSha256 || ""))
    || typeof binding.supervisorInstanceId !== "string"
    || binding.supervisorInstanceId.length < 16
    || binding.supervisorInstanceId.length > 255
    || /[\u0000-\u001f\u007f]/u.test(binding.supervisorInstanceId)
  ) throw new Error("LOCAL_SOURCE_MONITOR_TOKEN_BINDING_INVALID");
  const payload = [
    MONITOR_TOKEN_DERIVATION_DOMAIN,
    binding.requestId,
    binding.updateId,
    binding.manifestSha256,
    binding.supervisorInstanceId,
  ].join("\u0000");
  return crypto.createHmac("sha256", monitorTokenSecret(environment)).update(payload, "utf8").digest("hex");
}

function validCoreVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    compareBonniReleaseVersion(value, value);
    return true;
  } catch {
    return false;
  }
}

function validAppVersion(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 128) return false;
  try {
    compareBonniReleaseVersion(value, value);
    return true;
  } catch {
    return false;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validUpdateId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value);
}

function validManifestPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\\")
    && !value.startsWith("/")
    && !value.includes(":")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function parseVersionPair(value: unknown): VersionPair | null {
  if (!isPlainObject(value) || !validCoreVersion(value.coreVersion) || !validAppVersion(value.kontorAppVersion)) return null;
  return { coreVersion: value.coreVersion, kontorAppVersion: value.kontorAppVersion };
}

function releaseText(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new Error(`LOCAL_SOURCE_RELEASE_NOTES_INVALID:${label}`);
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < minimum || length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`LOCAL_SOURCE_RELEASE_NOTES_INVALID:${label}`);
  }
  return normalized;
}

function parseReleaseNotes(value: unknown): LocalSourceReleaseNotes | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new Error("LOCAL_SOURCE_RELEASE_NOTES_INVALID");
  if (Object.keys(value).some((key) => !["title", "summary", "changes"].includes(key))) {
    throw new Error("LOCAL_SOURCE_RELEASE_NOTES_INVALID:unknown-field");
  }
  if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > 12) {
    throw new Error("LOCAL_SOURCE_RELEASE_NOTES_INVALID:changes");
  }
  const changes = value.changes.map((entry, index) => {
    if (!isPlainObject(entry)
      || Object.keys(entry).some((key) => !["type", "title", "detail"].includes(key))
      || !["security", "fix", "improvement", "information"].includes(String(entry.type))) {
      throw new Error(`LOCAL_SOURCE_RELEASE_NOTES_INVALID:changes.${index}`);
    }
    return {
      type: entry.type as LocalSourceReleaseNotes["changes"][number]["type"],
      title: releaseText(entry.title, `changes.${index}.title`, 3, 100),
      detail: releaseText(entry.detail, `changes.${index}.detail`, 3, 320),
    };
  });
  return {
    title: releaseText(value.title, "title", 3, 100),
    summary: releaseText(value.summary, "summary", 3, 480),
    changes,
  };
}

function parseLocalSourceManifest(value: unknown): LocalSourceManifest {
  if (!isPlainObject(value)) throw new Error("LOCAL_SOURCE_MANIFEST_INVALID");
  if (value.schemaVersion !== SOURCE_SCHEMA) throw new Error("LOCAL_SOURCE_SCHEMA_UNSUPPORTED");
  if (value.status !== SOURCE_STATUS || value.channel !== SOURCE_CHANNEL) throw new Error("LOCAL_SOURCE_NOT_DEVELOPMENT_PACKAGE");
  if (!validUpdateId(value.updateId)) throw new Error("LOCAL_SOURCE_UPDATE_ID_INVALID");
  if (!canonicalTimestamp(value.createdAt)) throw new Error("LOCAL_SOURCE_TIMESTAMP_INVALID");
  if (Date.parse(value.createdAt) > Date.now() + MAXIMUM_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new Error("LOCAL_SOURCE_TIMESTAMP_IN_FUTURE");
  }
  const payloadLayout = value.payloadLayout === undefined
    ? LEGACY_SOURCE_PAYLOAD_LAYOUT
    : value.payloadLayout;
  if (
    payloadLayout !== SOURCE_PAYLOAD_LAYOUT
    && payloadLayout !== SOURCE_REPAIR_PAYLOAD_LAYOUT
    && payloadLayout !== LEGACY_SOURCE_PAYLOAD_LAYOUT
  ) {
    throw new Error("LOCAL_SOURCE_PAYLOAD_LAYOUT_UNSUPPORTED");
  }
  let requires: LocalSourceManifest["requires"] = null;
  if (value.requires !== null && value.requires !== undefined) {
    if (
      !isPlainObject(value.requires)
      || !validUpdateId(value.requires.updateId)
      || typeof value.requires.manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.requires.manifestSha256)
    ) throw new Error("LOCAL_SOURCE_REQUIRED_PREDECESSOR_INVALID");
    requires = {
      updateId: value.requires.updateId,
      manifestSha256: value.requires.manifestSha256,
    };
  }
  const from = parseVersionPair(value.from);
  const to = parseVersionPair(value.to);
  const releaseNotes = parseReleaseNotes(value.releaseNotes);
  if (!from || !to) throw new Error("LOCAL_SOURCE_VERSION_INVALID");
  if (!Array.isArray(value.components) || !value.components.length || value.components.length > 3) {
    throw new Error("LOCAL_SOURCE_COMPONENTS_INVALID");
  }
  if (!Array.isArray(value.files) || !Array.isArray(value.delete)) throw new Error("LOCAL_SOURCE_FILE_LIST_INVALID");
  if (value.files.length + value.delete.length > MAXIMUM_ENTRIES) throw new Error("LOCAL_SOURCE_FILE_LIST_TOO_LARGE");

  const components = value.components.map((entry) => {
    if (!isPlainObject(entry)
      || typeof entry.key !== "string"
      || !validManifestPath(entry.path)
      || entry.mode !== "managed") throw new Error("LOCAL_SOURCE_COMPONENT_INVALID");
    return { key: entry.key, path: entry.path, mode: "managed" as const };
  });
  const files = value.files.map((entry) => {
    if (!isPlainObject(entry)
      || !validManifestPath(entry.path)
      || !Number.isSafeInteger(entry.sizeBytes)
      || Number(entry.sizeBytes) < 0
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error("LOCAL_SOURCE_FILE_INVALID");
    if (!Object.hasOwn(entry, "expectedPreviousSha256")) throw new Error("LOCAL_SOURCE_PREVIOUS_HASH_REQUIRED");
    const previous = entry.expectedPreviousSha256;
    if (previous !== null && (typeof previous !== "string" || !/^[a-f0-9]{64}$/u.test(previous))) {
      throw new Error("LOCAL_SOURCE_PREVIOUS_HASH_INVALID");
    }
    return {
      path: entry.path,
      sizeBytes: Number(entry.sizeBytes),
      sha256: entry.sha256,
      expectedPreviousSha256: previous as string | null,
    };
  });
  const deletions = value.delete.map((entry) => {
    if (!isPlainObject(entry)
      || !validManifestPath(entry.path)
      || typeof entry.expectedSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.expectedSha256)
      || typeof entry.reason !== "string"
      || !entry.reason.trim()
      || entry.reason.length > 240) throw new Error("LOCAL_SOURCE_DELETE_INVALID");
    return { path: entry.path, expectedSha256: entry.expectedSha256, reason: entry.reason.trim() };
  });
  return {
    schemaVersion: SOURCE_SCHEMA,
    status: SOURCE_STATUS,
    channel: SOURCE_CHANNEL,
    updateId: value.updateId,
    createdAt: value.createdAt,
    payloadLayout,
    requires,
    releaseNotes,
    from,
    to,
    components,
    files,
    delete: deletions,
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseCompletedUpdateMetadata(value: unknown): CompletedUpdateMetadata | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || Object.keys(value).some((key) => ![
    "createdAt",
    "from",
    "to",
    "components",
    "counts",
    "repair",
  ].includes(key))) throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
  let createdAt: string | null = null;
  if (value.createdAt !== undefined) {
    if (!canonicalTimestamp(value.createdAt)) {
      throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
    }
    createdAt = value.createdAt;
  }
  const from = parseVersionPair(value.from);
  const to = parseVersionPair(value.to);
  if (!from || !to || !Array.isArray(value.components) || !value.components.length || value.components.length > 3) {
    throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
  }
  const components = value.components.map((entry) => {
    if (
      !isPlainObject(entry)
      || Object.keys(entry).some((key) => !["key", "path", "mode"].includes(key))
      || typeof entry.key !== "string"
      || !entry.key.trim()
      || entry.key.length > 80
      || !validManifestPath(entry.path)
      || entry.mode !== "managed"
    ) throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
    return { key: entry.key, path: entry.path, mode: "managed" as const };
  });
  if (
    !isPlainObject(value.counts)
    || Object.keys(value.counts).some((key) => !["files", "inventory", "delete"].includes(key))
  ) throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
  const counts = {
    files: Number(value.counts.files),
    inventory: Number(value.counts.inventory),
    delete: Number(value.counts.delete),
  };
  if (
    !Object.values(counts).every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= MAXIMUM_ENTRIES)
    || counts.files > counts.inventory
    || typeof value.repair !== "boolean"
  ) throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
  return { createdAt, from, to, components, counts, repair: value.repair };
}

async function readCompletedDetails(progress: SupervisorProgress | null) {
  if (
    !progress
    || !["completed", "failed"].includes(String(progress.status || ""))
    || !validUpdateId(progress.updateId)
    || typeof progress.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(progress.manifestSha256)
  ) return null;

  try {
    const receiptFile = path.join(stateRoot(), "history", `${progress.updateId}.json`);
    const state = await fs.lstat(receiptFile);
    if (
      !state.isFile()
      || state.isSymbolicLink()
      || state.nlink > 1
      || state.size <= 0
      || state.size > MAXIMUM_MANIFEST_BYTES
    ) return null;
    const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")) as unknown;
    if (
      !isPlainObject(receipt)
      || Object.keys(receipt).some((key) => ![
        "schemaVersion",
        "updateId",
        "manifestSha256",
        "completedAt",
        "versions",
        "components",
        "files",
        "releaseNotes",
        "updateMetadata",
        "status",
      ].includes(key))
      || receipt.schemaVersion !== SOURCE_SCHEMA
      || receipt.status !== "COMPLETED"
      || receipt.updateId !== progress.updateId
      || receipt.manifestSha256 !== progress.manifestSha256
      || typeof receipt.completedAt !== "string"
      || !Number.isFinite(Date.parse(receipt.completedAt))
    ) return null;
    const metadata = parseCompletedUpdateMetadata(receipt.updateMetadata);
    const receiptVersions = parseVersionPair(receipt.versions);
    if (!receiptVersions || (metadata && (
      receiptVersions.coreVersion !== metadata.to.coreVersion
      || (managesKontor(metadata.components)
        && receiptVersions.kontorAppVersion !== metadata.to.kontorAppVersion)))) return null;
    return {
      releaseNotes: parseReleaseNotes(receipt.releaseNotes),
      metadata,
    };
  } catch {
    return null;
  }
}

async function applyCompletedDetails(result: LocalSourceStatus, progress: SupervisorProgress | null) {
  const details = await readCompletedDetails(progress);
  if (!details) return result;
  result.releaseNotes = details.releaseNotes;
  if (details.metadata) {
    result.from = details.metadata.from;
    result.to = details.metadata.to;
    result.components = visibleComponents(
      details.metadata.components,
      details.metadata.from,
      details.metadata.to,
    );
    result.counts = details.metadata.counts;
    result.repair = details.metadata.repair;
  }
  return result;
}

async function completedProgressAfterSupervisorFailure(
  runner: Awaited<ReturnType<typeof readSupervisorStatus>>,
) {
  const progress = runner.progress;
  if (progressState(progress) !== "failed") return null;
  const details = await readCompletedDetails(progress);
  if (!details?.metadata) return null;
  const installedCore = await installedCoreVersion();
  if (installedCore !== details.metadata.to.coreVersion) return null;
  if (managesKontor(details.metadata.components)) {
    const installedKontor = await installedKontorVersion();
    if (installedKontor !== details.metadata.to.kontorAppVersion) return null;
  }
  return {
    ...progress,
    status: "completed",
    phase: "return",
    message: "Aktualisierung erfolgreich abgeschlossen.",
    error: undefined,
    errorCode: undefined,
    updatedAt: new Date().toISOString(),
    steps: Array.isArray(progress?.steps)
      ? progress.steps.map((step) => ({ ...step, status: "completed" }))
      : progress?.steps,
  } satisfies SupervisorProgress;
}

async function sha256File(file: string) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function assertRealDirectory(directory: string) {
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("LOCAL_SOURCE_UNSAFE_DIRECTORY");
  const real = await fs.realpath(directory);
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(real) !== normalize(directory)) throw new Error("LOCAL_SOURCE_DIRECTORY_ALIAS");
}

async function readManifestFile(file: string) {
  const state = await fs.lstat(file);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) throw new Error("LOCAL_SOURCE_UNSAFE_MANIFEST");
  if (state.size <= 0 || state.size > MAXIMUM_MANIFEST_BYTES) throw new Error("LOCAL_SOURCE_MANIFEST_SIZE_INVALID");
  const raw = await fs.readFile(file, "utf8");
  const manifest = parseLocalSourceManifest(JSON.parse(raw));
  return { manifest, manifestSha256: crypto.createHash("sha256").update(raw).digest("hex") };
}

function managesKontor(components: Array<{ path: string }>) {
  return components.some((component) => component.path === "SYSTEM/app/kontorapp");
}

async function installedCoreVersion() {
  const core = await readJson<{ version?: string }>(
    path.join(getProjectRoot(), "SYSTEM", "backend", "package.json"),
  );
  return validCoreVersion(core?.version) ? core.version : "0.0.0";
}

async function installedKontorVersion() {
  const kontor = await readJson<{ version?: string }>(
    path.join(getProjectRoot(), "SYSTEM", "app", "kontorapp", "package.json"),
  );
  return validAppVersion(kontor?.version) ? kontor.version : "0.0.0";
}

async function readSupervisorStatus() {
  const [heartbeat, progress] = await Promise.all([
    readJson<SupervisorHeartbeat>(path.join(controlRoot(), "heartbeat.json")).catch(() => null),
    readJson<SupervisorProgress>(path.join(controlRoot(), "status.json")).catch(() => null),
  ]);
  const timestamp = heartbeat?.updatedAt ? Date.parse(heartbeat.updatedAt) : Number.NaN;
  const ageMs = Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
  const fresh = ageMs >= -5 * 60_000 && ageMs <= HEARTBEAT_MAX_AGE_MS;
  const available = Boolean(
    fresh
    && heartbeat?.available !== false
    && heartbeat?.state !== "error"
    && typeof heartbeat?.instanceId === "string"
    && heartbeat.instanceId.length >= 16,
  );
  let monitorOrigin: string | null = null;
  try {
    const candidate = new URL(String(heartbeat?.monitor?.origin || ""));
    if (
      candidate.protocol === "http:"
      && candidate.hostname === "127.0.0.1"
      && /^[0-9]{1,5}$/u.test(candidate.port)
      && Number(candidate.port) >= 1
      && Number(candidate.port) <= 65_535
      && candidate.username === ""
      && candidate.password === ""
      && candidate.pathname === "/"
      && !candidate.search
      && !candidate.hash
      && heartbeat?.monitor?.available === true
    ) monitorOrigin = candidate.origin;
  } catch {
    monitorOrigin = null;
  }
  return {
    available,
    mode: "local-source-supervisor",
    version: heartbeat?.version || null,
    instanceId: available ? heartbeat?.instanceId || null : null,
    state: heartbeat?.state || "offline",
    updatedAt: heartbeat?.updatedAt || null,
    reason: available ? null : heartbeat?.message || "Der lokale Update-Supervisor ist nicht erreichbar.",
    monitor: {
      available: Boolean(available && monitorOrigin),
      origin: monitorOrigin,
    },
    progress,
  };
}

function emptyStatus(
  state: LocalSourceState,
  message: string,
  runner: Awaited<ReturnType<typeof readSupervisorStatus>>,
  errorCode: string | null = null,
): LocalSourceStatus {
  const progress = ["in-progress", "completed", "failed"].includes(state)
    ? runner.progress
    : null;
  return {
    enabled: state !== "disabled",
    state,
    updateAvailable: false,
    updateId: null,
    manifestSha256: null,
    from: null,
    to: null,
    components: [],
    counts: { files: 0, inventory: 0, delete: 0 },
    repair: false,
    testOnly: true,
    message,
    errorCode,
    requiredPredecessor: null,
    runner: progress === runner.progress ? runner : { ...runner, progress: null },
    progress,
  };
}

function progressState(progress: SupervisorProgress | null): LocalSourceState | null {
  if (!progress?.status) return null;
  if ([
    "queued",
    "stopping",
    "installing",
    "restarting",
    "running",
    "awaiting-confirmation",
    "awaiting-retry",
    "commit-pending",
    "committing",
  ].includes(progress.status)) return "in-progress";
  if (progress.status === "completed") return "completed";
  if (progress.status === "failed") return "failed";
  return null;
}

export async function getLocalSourceUpdateStatus(): Promise<LocalSourceStatus> {
  const runner = await readSupervisorStatus();
  if (!sourceUpdatesEnabled()) {
    const durable = await inspectDurableMonitorState(runner).catch(() => null);
    if (durable?.request) {
      const progress = runner.progress?.requestId === durable.request.requestId
        && runner.progress.updateId === durable.request.updateId
        && runner.progress.manifestSha256 === durable.request.manifestSha256
        ? runner.progress
        : null;
      const state = progressState(progress) || "in-progress";
      const status = emptyStatus(
        state,
        progress?.message || "Diese Bonni-Core-Aktualisierung wird bereits verarbeitet.",
        progress === runner.progress ? runner : { ...runner, progress: null },
        progress?.errorCode || null,
      );
      status.enabled = true;
      status.updateId = durable.request.updateId;
      status.manifestSha256 = durable.request.manifestSha256;
      return status;
    }
    return emptyStatus("disabled", "Neue lokale Source-Updates sind im Produktionsmodus deaktiviert.", runner);
  }

  const inbox = inboxRoot();
  const inboxState = await fs.lstat(inbox).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!inboxState) {
    const completedProgress = await completedProgressAfterSupervisorFailure(runner);
    if (completedProgress) {
      const completedRunner = { ...runner, progress: completedProgress };
      const result = emptyStatus(
        "completed",
        completedProgress.message || "Lokale Aktualisierung abgeschlossen.",
        completedRunner,
      );
      result.updateId = completedProgress.updateId || null;
      result.manifestSha256 = completedProgress.manifestSha256 || null;
      return applyCompletedDetails(result, completedProgress);
    }
    const state = progressState(runner.progress);
    if (state && state !== "in-progress") {
      const result = emptyStatus(state, runner.progress?.message || "Lokale Aktualisierung abgeschlossen.", runner, runner.progress?.errorCode || null);
      result.updateId = runner.progress?.updateId || null;
      result.manifestSha256 = runner.progress?.manifestSha256 || null;
      return applyCompletedDetails(result, runner.progress);
    }
    return emptyStatus("none", "Im UPDATE-Ordner liegt keine lokale Aktualisierung bereit.", runner);
  }

  try {
    await assertRealDirectory(inbox);
    const entries = await fs.readdir(inbox, { withFileTypes: true });
    const packages: Array<{ directory: string; manifestFile: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(inbox, entry.name);
      const manifestFile = path.join(directory, MANIFEST_NAME);
      const manifestState = await fs.lstat(manifestFile).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (manifestState) packages.push({ directory, manifestFile });
    }
    if (!packages.length) {
      const completedProgress = await completedProgressAfterSupervisorFailure(runner);
      if (completedProgress) {
        const completedRunner = { ...runner, progress: completedProgress };
        const result = emptyStatus(
          "completed",
          completedProgress.message || "Lokale Aktualisierung abgeschlossen.",
          completedRunner,
        );
        result.updateId = completedProgress.updateId || null;
        result.manifestSha256 = completedProgress.manifestSha256 || null;
        return applyCompletedDetails(result, completedProgress);
      }
      const state = progressState(runner.progress);
      if (state) {
        const result = emptyStatus(state, runner.progress?.message || "Lokale Aktualisierung wird verarbeitet.", runner, runner.progress?.errorCode || null);
        result.updateId = runner.progress?.updateId || null;
        result.manifestSha256 = runner.progress?.manifestSha256 || null;
        return applyCompletedDetails(result, runner.progress);
      }
      return emptyStatus("none", "Im UPDATE-Ordner liegt keine lokale Aktualisierung bereit.", runner);
    }
    if (packages.length > 1) {
      return emptyStatus("multiple-packages", "Es liegt mehr als eine lokale Aktualisierung bereit.", runner, "LOCAL_SOURCE_MULTIPLE_PACKAGES");
    }

    const candidate = packages[0];
    await assertRealDirectory(candidate.directory);
    const { manifest, manifestSha256 } = await readManifestFile(candidate.manifestFile);
    if (path.basename(candidate.directory) !== manifest.updateId) throw new Error("LOCAL_SOURCE_DIRECTORY_ID_MISMATCH");

    const updatesKontor = managesKontor(manifest.components);
    const [installedCore, installedKontor, pending, history, active, lock] = await Promise.all([
      installedCoreVersion(),
      updatesKontor ? installedKontorVersion() : Promise.resolve(null),
      readJson<{ updateId?: string; phase?: string }>(path.join(stateRoot(), "pending-update.json")).catch(() => null),
      readJson<{ status?: string; manifestSha256?: string }>(path.join(stateRoot(), "history", `${manifest.updateId}.json`)).catch(() => null),
      readJson<{ updateId?: string; manifestSha256?: string }>(path.join(stateRoot(), "active-manifest.json")).catch(() => null),
      fs.lstat(path.join(stateRoot(), "update-command.lock")).then(() => true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }),
    ]);

    let state: LocalSourceState = "available";
    let message = "Lokale Testaktualisierung ist bereit.";
    let errorCode: string | null = null;
    let requiredPredecessor: LocalSourceStatus["requiredPredecessor"] = null;
    if (history) {
      if (history.status === "COMPLETED" && history.manifestSha256 === manifestSha256) {
        state = "already-installed";
        message = "Diese lokale Aktualisierung wurde bereits vollständig installiert.";
      } else {
        state = "id-collision";
        message = "Diese Update-ID wurde bereits mit einem anderen Inhalt verwendet.";
        errorCode = "LOCAL_SOURCE_UPDATE_ID_COLLISION";
      }
    } else if (pending) {
      state = pending.updateId === manifest.updateId ? "in-progress" : "recovery-required";
      message = pending.updateId === manifest.updateId
        ? "Diese Aktualisierung wird bereits verarbeitet."
        : "Eine frühere Aktualisierung muss zuerst wiederhergestellt werden.";
      errorCode = pending.updateId === manifest.updateId ? null : "LOCAL_SOURCE_RECOVERY_REQUIRED";
    } else if (lock) {
      state = "in-progress";
      message = "Der lokale Update-Supervisor verarbeitet eine Aktualisierung.";
    } else if (
      manifest.requires
      && (
        active?.updateId !== manifest.requires.updateId
        || active?.manifestSha256 !== manifest.requires.manifestSha256
      )
    ) {
      state = "invalid";
      requiredPredecessor = {
        updateId: manifest.requires.updateId,
        manifestSha256: manifest.requires.manifestSha256,
        coreVersion: manifest.from.coreVersion,
        kontorAppVersion: manifest.from.kontorAppVersion,
      };
      message = `${predecessorLabel(manifest.requires.updateId)} fehlt: Der erforderliche Zwischenstand Bonni Core ${manifest.from.coreVersion} (${manifest.requires.updateId}) wurde noch nicht vollständig abgeschlossen.`;
      errorCode = "LOCAL_SOURCE_REQUIRED_PREDECESSOR_MISSING";
    } else if (
      installedCore !== manifest.from.coreVersion
      || (updatesKontor && installedKontor !== manifest.from.kontorAppVersion)
    ) {
      state = "invalid";
      message = "Die Aktualisierung passt nicht zum installierten Bonni-Core-Stand.";
      errorCode = "LOCAL_SOURCE_FROM_VERSION_MISMATCH";
    }

    const matchingProgress = runner.progress?.updateId === manifest.updateId
      && runner.progress?.manifestSha256 === manifestSha256
      ? runner.progress
      : null;
    const packageStateAllowsProgress = ["available", "already-installed", "in-progress", "completed", "failed"].includes(state);
    const displayedProgress = packageStateAllowsProgress ? matchingProgress : null;
    const liveProgressState = progressState(displayedProgress);
    if (liveProgressState === "in-progress" || liveProgressState === "failed") {
      state = liveProgressState;
      message = displayedProgress?.message || message;
      errorCode = displayedProgress?.errorCode || errorCode;
      requiredPredecessor = null;
    }
    const packageRunner = displayedProgress === runner.progress
      ? runner
      : { ...runner, progress: null };

    return {
      enabled: true,
      state,
      updateAvailable: state === "available" || state === "failed",
      updateId: manifest.updateId,
      manifestSha256,
      from: manifest.from,
      to: manifest.to,
      components: visibleComponents(manifest.components, manifest.from, manifest.to),
      counts: {
        files: manifest.payloadLayout === SOURCE_PAYLOAD_LAYOUT
          ? manifest.files.filter((entry) => entry.expectedPreviousSha256 !== entry.sha256).length
          : manifest.files.length,
        inventory: manifest.files.length,
        delete: manifest.delete.length,
      },
      repair: manifest.payloadLayout === SOURCE_REPAIR_PAYLOAD_LAYOUT,
      testOnly: true,
      message,
      errorCode,
      requiredPredecessor,
      runner: packageRunner,
      progress: displayedProgress,
      releaseNotes: manifest.releaseNotes,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "LOCAL_SOURCE_SCAN_FAILED";
    return emptyStatus("invalid", "Das lokale Updatepaket ist ungültig oder unsicher.", runner, code);
  }
}

async function ensureControlRoot() {
  await fs.mkdir(controlRoot(), { recursive: true, mode: 0o700 });
  await assertRealDirectory(stateRoot());
  await assertRealDirectory(controlRoot());
}

async function writeJsonExclusive(file: string, value: unknown) {
  await ensureControlRoot();
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function exactObjectKeys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000");
}

type PersistedInstallRequest = MonitorTokenBinding & {
  schemaVersion: typeof REQUEST_SCHEMA;
  action: "install";
  monitorTokenSha256: string;
  issuedAt: string;
  expiresAt: string;
};

type PersistedMonitorAccess = {
  requestId: string;
  updateId: string;
  manifestSha256: string;
  monitorTokenSha256: string;
  expiresAt: string;
};

type QueueClaim = {
  schemaVersion: typeof QUEUE_CLAIM_SCHEMA;
  requestId: string;
  updateId: string;
  manifestSha256: string;
  monitorTokenSha256: string;
  supervisorInstanceId: string;
  issuedAt: string;
  requestExpiresAt: string;
  accessExpiresAt: string;
  ownerPid: number;
  ownerNonce: string;
  createdAt: string;
  signature: string;
};

function parsePersistedRequest(value: unknown): PersistedInstallRequest | null {
  if (!isPlainObject(value) || !exactObjectKeys(value, [
    "schemaVersion", "requestId", "action", "updateId", "manifestSha256",
    "monitorTokenSha256", "supervisorInstanceId", "issuedAt", "expiresAt",
  ])) return null;
  if (
    value.schemaVersion !== REQUEST_SCHEMA
    || value.action !== "install"
    || typeof value.requestId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.requestId)
    || !validUpdateId(value.updateId)
    || typeof value.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.manifestSha256)
    || typeof value.monitorTokenSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.monitorTokenSha256)
    || typeof value.supervisorInstanceId !== "string"
    || value.supervisorInstanceId.length < 16
    || value.supervisorInstanceId.length > 255
    || /[\u0000-\u001f\u007f]/u.test(value.supervisorInstanceId)
    || typeof value.issuedAt !== "string"
    || !Number.isFinite(Date.parse(value.issuedAt))
    || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt))
  ) return null;
  return value as PersistedInstallRequest;
}

function parsePersistedAccess(value: unknown): PersistedMonitorAccess | null {
  if (!isPlainObject(value) || !exactObjectKeys(value, [
    "requestId", "updateId", "manifestSha256", "monitorTokenSha256", "expiresAt",
  ])) return null;
  if (
    typeof value.requestId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.requestId)
    || !validUpdateId(value.updateId)
    || typeof value.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.manifestSha256)
    || typeof value.monitorTokenSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.monitorTokenSha256)
    || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt))
  ) return null;
  return value as PersistedMonitorAccess;
}

function sameMonitorIdentity(
  left: Pick<PersistedInstallRequest, "requestId" | "updateId" | "manifestSha256" | "monitorTokenSha256">,
  right: Pick<PersistedMonitorAccess, "requestId" | "updateId" | "manifestSha256" | "monitorTokenSha256">,
) {
  return left.requestId === right.requestId
    && left.updateId === right.updateId
    && left.manifestSha256 === right.manifestSha256
    && left.monitorTokenSha256 === right.monitorTokenSha256;
}

async function inspectDurableMonitorState(
  suppliedRunner?: Awaited<ReturnType<typeof readSupervisorStatus>>,
) {
  const runner = suppliedRunner || await readSupervisorStatus();
  const [queuedRaw, processingRaw, accessRaw] = await Promise.all([
    readJson<unknown>(path.join(controlRoot(), "request.json")),
    readJson<unknown>(path.join(controlRoot(), "request.processing.json")),
    readJson<unknown>(path.join(controlRoot(), MONITOR_ACCESS_FILE)),
  ]);
  if (queuedRaw && processingRaw) throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");
  const rawRequest = queuedRaw || processingRaw;
  const request = rawRequest ? parsePersistedRequest(rawRequest) : null;
  const access = accessRaw ? parsePersistedAccess(accessRaw) : null;
  if ((rawRequest && !request) || (accessRaw && !access)) {
    throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");
  }
  if (request && access && !sameMonitorIdentity(request, access)) {
    throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");
  }
  if (queuedRaw && request && (
    request.supervisorInstanceId !== runner.instanceId
    || Date.parse(request.expiresAt) <= Date.now()
  )) throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");
  return { request, access, queued: Boolean(queuedRaw), processing: Boolean(processingRaw) };
}

function queueClaimPayload(claim: Omit<QueueClaim, "signature">) {
  return [
    QUEUE_CLAIM_HMAC_DOMAIN,
    claim.schemaVersion,
    claim.requestId,
    claim.updateId,
    claim.manifestSha256,
    claim.monitorTokenSha256,
    claim.supervisorInstanceId,
    claim.issuedAt,
    claim.requestExpiresAt,
    claim.accessExpiresAt,
    String(claim.ownerPid),
    claim.ownerNonce,
    claim.createdAt,
  ].join("\u0000");
}

function signQueueClaim(claim: Omit<QueueClaim, "signature">) {
  return crypto.createHmac("sha256", monitorTokenSecret()).update(queueClaimPayload(claim), "utf8").digest("hex");
}

function parseQueueClaim(value: unknown): QueueClaim | null {
  if (!isPlainObject(value) || !exactObjectKeys(value, [
    "schemaVersion", "requestId", "updateId", "manifestSha256", "monitorTokenSha256",
    "supervisorInstanceId", "issuedAt", "requestExpiresAt", "accessExpiresAt",
    "ownerPid", "ownerNonce", "createdAt", "signature",
  ])) return null;
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  if (
    value.schemaVersion !== QUEUE_CLAIM_SCHEMA
    || typeof value.ownerPid !== "number"
    || !Number.isSafeInteger(value.ownerPid)
    || value.ownerPid <= 0
    || typeof value.ownerNonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(value.ownerNonce)
    || typeof value.signature !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.signature)
  ) return null;
  const request = parsePersistedRequest({
    schemaVersion: REQUEST_SCHEMA,
    requestId: value.requestId,
    action: "install",
    updateId: value.updateId,
    manifestSha256: value.manifestSha256,
    monitorTokenSha256: value.monitorTokenSha256,
    supervisorInstanceId: value.supervisorInstanceId,
    issuedAt: value.issuedAt,
    expiresAt: value.requestExpiresAt,
  });
  if (
    !request
    || typeof value.accessExpiresAt !== "string"
    || !Number.isFinite(Date.parse(value.accessExpiresAt))
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) return null;
  const expected = signQueueClaim(unsigned as Omit<QueueClaim, "signature">);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(value.signature))) return null;
  return value as QueueClaim;
}

const liveQueueOwners = new Set<string>();

function processExists(pid: number) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimOwnerIsLive(claim: QueueClaim) {
  return claim.ownerPid === process.pid
    ? liveQueueOwners.has(claim.ownerNonce)
    : processExists(claim.ownerPid);
}

async function removeExactJson(file: string, expected: Record<string, unknown>) {
  const current = await readJson<Record<string, unknown>>(file);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_CHANGED");
  }
  await fs.rm(file);
}

function monitorAccessResponse({
  origin,
  request,
  token,
}: {
  origin: string;
  request: MonitorTokenBinding & { issuedAt: string };
  token: string;
}) {
  return {
    schemaVersion: "bonni.local-source-update-monitor-access/v1",
    origin,
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    token,
    issuedAt: request.issuedAt,
  };
}

async function reclaimExistingMonitorAccess(
  status: LocalSourceStatus,
  input: { updateId?: string; manifestSha256?: string },
) {
  if (
    status.state !== "in-progress"
    || status.updateId !== input.updateId
    || status.manifestSha256 !== input.manifestSha256
  ) return null;
  if (
    !status.runner.available
    || !status.runner.instanceId
    || !status.runner.monitor.available
    || !status.runner.monitor.origin
  ) throw new Error("LOCAL_SOURCE_INSTALLATION_MONITOR_NOT_READY");

  const durable = await inspectDurableMonitorState(status.runner);
  const { request, access } = durable;
  if (
    !request
    || !access
    || request.updateId !== status.updateId
    || request.manifestSha256 !== status.manifestSha256
    || Date.parse(access.expiresAt) <= Date.now()
  ) throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");

  const binding = {
    requestId: request.requestId,
    updateId: request.updateId as string,
    manifestSha256: request.manifestSha256 as string,
    supervisorInstanceId: request.supervisorInstanceId as string,
  };
  const token = deriveLocalSourceMonitorToken(binding);
  const tokenSha256 = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  if (tokenSha256 !== request.monitorTokenSha256) {
    throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_NOT_RECLAIMABLE");
  }
  return {
    ok: true,
    accepted: false,
    existing: true,
    requestId: request.requestId,
    monitor: monitorAccessResponse({
      origin: status.runner.monitor.origin,
      request: { ...binding, issuedAt: request.issuedAt },
      token,
    }),
    localSourceUpdate: status,
  };
}

type QueueCrashHooks = {
  afterClaim?: () => void | Promise<void>;
  afterGrant?: () => void | Promise<void>;
  afterRequest?: () => void | Promise<void>;
};

function requestFromClaim(claim: QueueClaim): PersistedInstallRequest {
  return {
    schemaVersion: REQUEST_SCHEMA,
    requestId: claim.requestId,
    action: "install",
    updateId: claim.updateId,
    manifestSha256: claim.manifestSha256,
    monitorTokenSha256: claim.monitorTokenSha256,
    supervisorInstanceId: claim.supervisorInstanceId,
    issuedAt: claim.issuedAt,
    expiresAt: claim.requestExpiresAt,
  };
}

function accessFromClaim(claim: QueueClaim): PersistedMonitorAccess {
  return {
    requestId: claim.requestId,
    updateId: claim.updateId,
    manifestSha256: claim.manifestSha256,
    monitorTokenSha256: claim.monitorTokenSha256,
    expiresAt: claim.accessExpiresAt,
  };
}

function claimMatchesStatus(claim: QueueClaim, status: LocalSourceStatus) {
  return claim.updateId === status.updateId
    && claim.manifestSha256 === status.manifestSha256
    && claim.supervisorInstanceId === status.runner.instanceId
    && Date.parse(claim.requestExpiresAt) > Date.now()
    && Date.parse(claim.accessExpiresAt) > Date.now();
}

function responseFromClaim(claim: QueueClaim, status: LocalSourceStatus, accepted: boolean) {
  const token = deriveLocalSourceMonitorToken({
    requestId: claim.requestId,
    updateId: claim.updateId,
    manifestSha256: claim.manifestSha256,
    supervisorInstanceId: claim.supervisorInstanceId,
  });
  if (crypto.createHash("sha256").update(token, "utf8").digest("hex") !== claim.monitorTokenSha256) {
    throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_NOT_RECLAIMABLE");
  }
  return {
    ok: true,
    accepted,
    ...(accepted ? {} : { existing: true }),
    requestId: claim.requestId,
    monitor: monitorAccessResponse({
      origin: status.runner.monitor.origin as string,
      request: {
        requestId: claim.requestId,
        updateId: claim.updateId,
        manifestSha256: claim.manifestSha256,
        supervisorInstanceId: claim.supervisorInstanceId,
        issuedAt: claim.issuedAt,
      },
      token,
    }),
    localSourceUpdate: { ...status, state: "in-progress" as const, updateAvailable: false },
  };
}

async function recoverAbandonedQueueClaim(claim: QueueClaim, status: LocalSourceStatus) {
  if (!claimMatchesStatus(claim, status)) throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_TARGET_MISMATCH");
  const durable = await inspectDurableMonitorState(status.runner);
  const request = requestFromClaim(claim);
  const access = accessFromClaim(claim);
  if (durable.request && !sameMonitorIdentity(durable.request, request)) {
    throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_CONFLICT");
  }
  if (durable.access && !sameMonitorIdentity(request, durable.access)) {
    throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_CONFLICT");
  }
  if (!durable.access) await writeJsonExclusive(path.join(controlRoot(), MONITOR_ACCESS_FILE), access);
  if (!durable.request) await writeJsonExclusive(path.join(controlRoot(), "request.json"), request);
  await removeExactJson(path.join(controlRoot(), QUEUE_CLAIM_FILE), claim);
  return responseFromClaim(claim, status, false);
}

async function retireExactTerminalAccessOnly(
  durable: Awaited<ReturnType<typeof inspectDurableMonitorState>>,
  runner: Awaited<ReturnType<typeof readSupervisorStatus>>,
) {
  if (durable.request || !durable.access) return false;
  const progress = runner.progress;
  if (
    !progress
    || !["completed", "failed"].includes(String(progress.status || ""))
    || progress.requestId !== durable.access.requestId
    || progress.updateId !== durable.access.updateId
    || progress.manifestSha256 !== durable.access.manifestSha256
  ) throw new Error("LOCAL_SOURCE_FOREIGN_MONITOR_ACCESS_PRESENT");
  await removeExactJson(path.join(controlRoot(), MONITOR_ACCESS_FILE), durable.access);
  return true;
}

export async function queueLocalSourceUpdate(
  input: { updateId?: string; manifestSha256?: string },
  crashHooks: QueueCrashHooks = {},
) {
  const status = await getLocalSourceUpdateStatus();
  if (
    status.state === "in-progress"
    && status.updateId === input.updateId
    && status.manifestSha256 === input.manifestSha256
  ) {
    try {
      const reclaimed = await reclaimExistingMonitorAccess(status, input);
      if (!reclaimed) throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");
      return reclaimed;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? error.message.split(":", 1)[0]
          : "LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID",
        message: "Der laufende Installationsauftrag kann nur in seiner ursprünglichen, sicheren Browsersitzung fortgesetzt werden.",
      };
    }
  }
  if (!status.updateAvailable || !["available", "failed"].includes(status.state)) {
    return { ok: false, error: status.errorCode || "LOCAL_SOURCE_UPDATE_NOT_AVAILABLE", message: status.message };
  }
  if (input.updateId !== status.updateId || input.manifestSha256 !== status.manifestSha256) {
    return { ok: false, error: "LOCAL_SOURCE_UPDATE_TARGET_CHANGED", message: "Das Updatepaket wurde seit der Anzeige verändert." };
  }
  if (!status.runner.available || !status.runner.instanceId) {
    return { ok: false, error: "LOCAL_SOURCE_SUPERVISOR_NOT_READY", message: status.runner.reason };
  }
  if (!status.runner.monitor.available || !status.runner.monitor.origin) {
    return {
      ok: false,
      error: "LOCAL_SOURCE_INSTALLATION_MONITOR_NOT_READY",
      message: "Der unabhängige Installationsserver ist nicht erreichbar.",
    };
  }

  const now = new Date();
  const requestId = `local-source-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const monitorToken = deriveLocalSourceMonitorToken({
    requestId,
    updateId: status.updateId,
    manifestSha256: status.manifestSha256,
    supervisorInstanceId: status.runner.instanceId,
  });
  const monitorTokenSha256 = crypto.createHash("sha256").update(monitorToken, "utf8").digest("hex");
  const unsignedClaim: Omit<QueueClaim, "signature"> = {
    schemaVersion: QUEUE_CLAIM_SCHEMA,
    requestId,
    updateId: status.updateId,
    manifestSha256: status.manifestSha256,
    monitorTokenSha256,
    supervisorInstanceId: status.runner.instanceId,
    issuedAt: now.toISOString(),
    requestExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    accessExpiresAt: new Date(now.getTime() + MONITOR_ACCESS_LIFETIME_MS).toISOString(),
    ownerPid: process.pid,
    ownerNonce: crypto.randomBytes(16).toString("hex"),
    createdAt: now.toISOString(),
  };
  const claim: QueueClaim = { ...unsignedClaim, signature: signQueueClaim(unsignedClaim) };
  const claimFile = path.join(controlRoot(), QUEUE_CLAIM_FILE);
  liveQueueOwners.add(claim.ownerNonce);
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const durable = await inspectDurableMonitorState(status.runner);
      const persistedClaimRaw = await readJson<unknown>(claimFile);
      if (persistedClaimRaw) {
        const persistedClaim = parseQueueClaim(persistedClaimRaw);
        if (!persistedClaim) throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_INVALID");
        if (!claimMatchesStatus(persistedClaim, status)) {
          throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_TARGET_MISMATCH");
        }
        if (!claimOwnerIsLive(persistedClaim)) {
          return recoverAbandonedQueueClaim(persistedClaim, status);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (durable.request) {
        if (
          durable.request.updateId !== status.updateId
          || durable.request.manifestSha256 !== status.manifestSha256
        ) throw new Error("LOCAL_SOURCE_UPDATE_ALREADY_QUEUED");
        const reclaimed = await reclaimExistingMonitorAccess(
          { ...status, state: "in-progress", updateAvailable: false },
          input,
        );
        if (!reclaimed) throw new Error("LOCAL_SOURCE_MONITOR_ACCESS_RECOVERY_INVALID");
        return reclaimed;
      }

      if (durable.access) {
        await retireExactTerminalAccessOnly(durable, await readSupervisorStatus());
        continue;
      }

      try {
        await writeJsonExclusive(claimFile, claim);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await crashHooks.afterClaim?.();
      await writeJsonExclusive(path.join(controlRoot(), MONITOR_ACCESS_FILE), accessFromClaim(claim));
      await crashHooks.afterGrant?.();
      await writeJsonExclusive(path.join(controlRoot(), "request.json"), requestFromClaim(claim));
      await crashHooks.afterRequest?.();
      await removeExactJson(claimFile, claim);
      return responseFromClaim(claim, status, true);
    }
    throw new Error("LOCAL_SOURCE_QUEUE_CLAIM_BUSY");
  } catch (error) {
    const code = error instanceof Error
      ? error.message.split(":", 1)[0]
      : "LOCAL_SOURCE_UPDATE_QUEUE_FAILED";
    return {
      ok: false,
      error: code,
      message: code === "LOCAL_SOURCE_UPDATE_ALREADY_QUEUED"
        ? "Eine andere Aktualisierung wurde bereits angefordert."
        : "Der Updateauftrag konnte nicht sicher eingereiht oder wieder aufgenommen werden.",
    };
  } finally {
    liveQueueOwners.delete(claim.ownerNonce);
  }
}

export const LOCAL_SOURCE_UPDATE_REQUEST_SCHEMA = REQUEST_SCHEMA;
