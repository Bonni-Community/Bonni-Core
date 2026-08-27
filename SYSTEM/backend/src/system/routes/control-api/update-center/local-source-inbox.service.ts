import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getProjectRoot } from "../../../boot/run-system/run-system.paths.js";

const SOURCE_SCHEMA = "bonni.local-source-update/v1";
const SOURCE_PAYLOAD_LAYOUT = "content-addressed-delta-v1";
const SOURCE_REPAIR_PAYLOAD_LAYOUT = "content-addressed-repair-v1";
const LEGACY_SOURCE_PAYLOAD_LAYOUT = "tree-full-v1";
const REQUEST_SCHEMA = "bonni.local-source-update-request/v2";
const SOURCE_STATUS = "UNPUBLISHED_TEST_UPDATE";
const SOURCE_CHANNEL = "development";
const MANIFEST_NAME = "bonni-source-update.json";
const MONITOR_ACCESS_FILE = "monitor-access.json";
// Source-Manifeste binden jede verwaltete Datei einzeln und sind bei einem
// vollständigen Core/Kontor-Stand bereits größer als typische Release-Metadaten.
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ENTRIES = 20_000;
const HEARTBEAT_MAX_AGE_MS = 15_000;
const MONITOR_ACCESS_LIFETIME_MS = 60 * 60_000;

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
  return path.join(getProjectRoot(), "SYSTEM", ".bonni-source-update");
}

function controlRoot() {
  return path.join(stateRoot(), "control-center");
}

function inboxRoot() {
  return path.join(getProjectRoot(), "UPDATE", "inbox");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
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
  if (!isPlainObject(value) || !validVersion(value.coreVersion) || !validVersion(value.kontorAppVersion)) return null;
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
    "from",
    "to",
    "components",
    "counts",
    "repair",
  ].includes(key))) throw new Error("LOCAL_SOURCE_COMPLETED_METADATA_INVALID");
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
  return { from, to, components, counts, repair: value.repair };
}

async function readCompletedDetails(progress: SupervisorProgress | null) {
  if (
    progress?.status !== "completed"
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
      || receiptVersions.kontorAppVersion !== metadata.to.kontorAppVersion))) return null;
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
  const versions = await installedVersions();
  if (
    versions.coreVersion !== details.metadata.to.coreVersion
    || versions.kontorAppVersion !== details.metadata.to.kontorAppVersion
  ) return null;
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

async function installedVersions(): Promise<VersionPair> {
  const [core, kontor] = await Promise.all([
    readJson<{ version?: string }>(path.join(getProjectRoot(), "SYSTEM", "backend", "package.json")),
    readJson<{ version?: string }>(path.join(getProjectRoot(), "SYSTEM", "app", "kontorapp", "package.json")),
  ]);
  return {
    coreVersion: validVersion(core?.version) ? core.version : "0.0.0",
    kontorAppVersion: validVersion(kontor?.version) ? kontor.version : "0.0.0",
  };
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
  if (["queued", "stopping", "installing", "restarting", "committing", "running"].includes(progress.status)) return "in-progress";
  if (progress.status === "completed") return "completed";
  if (progress.status === "failed") return "failed";
  return null;
}

export async function getLocalSourceUpdateStatus(): Promise<LocalSourceStatus> {
  const runner = await readSupervisorStatus();
  if (!sourceUpdatesEnabled()) {
    return emptyStatus("disabled", "Lokale, unveröffentlichte Source-Updates sind im Produktionsmodus deaktiviert.", runner);
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

    const [versions, pending, history, active, lock] = await Promise.all([
      installedVersions(),
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
      versions.coreVersion !== manifest.from.coreVersion
      || versions.kontorAppVersion !== manifest.from.kontorAppVersion
    ) {
      state = "invalid";
      message = "Die Aktualisierung passt nicht zum installierten Bonni-Core-/Kontor-Stand.";
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

async function writeJsonAtomic(file: string, value: unknown) {
  await ensureControlRoot();
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

export async function queueLocalSourceUpdate(input: { updateId?: string; manifestSha256?: string }) {
  const status = await getLocalSourceUpdateStatus();
  if (
    status.state === "in-progress"
    && status.updateId === input.updateId
    && status.manifestSha256 === input.manifestSha256
  ) {
    return { ok: true, accepted: false, existing: true, localSourceUpdate: status };
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

  const requestFile = path.join(controlRoot(), "request.json");
  const existing = await fs.lstat(requestFile).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing) return { ok: false, error: "LOCAL_SOURCE_UPDATE_ALREADY_QUEUED", message: "Eine Aktualisierung wurde bereits angefordert." };

  const now = new Date();
  const monitorToken = crypto.randomBytes(32).toString("hex");
  const monitorTokenSha256 = crypto.createHash("sha256").update(monitorToken, "utf8").digest("hex");
  const monitorAccessExpiresAt = new Date(now.getTime() + MONITOR_ACCESS_LIFETIME_MS).toISOString();
  const request = {
    schemaVersion: REQUEST_SCHEMA,
    requestId: `local-source-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
    action: "install",
    updateId: status.updateId,
    manifestSha256: status.manifestSha256,
    monitorTokenSha256,
    supervisorInstanceId: status.runner.instanceId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  };
  const monitorAccessFile = path.join(controlRoot(), MONITOR_ACCESS_FILE);
  await writeJsonAtomic(monitorAccessFile, {
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    monitorTokenSha256,
    expiresAt: monitorAccessExpiresAt,
  });
  try {
    await writeJsonAtomic(requestFile, request);
  } catch (error) {
    const persisted = await readJson<{ requestId?: string }>(monitorAccessFile).catch(() => null);
    if (persisted?.requestId === request.requestId) {
      await fs.rm(monitorAccessFile, { force: true }).catch(() => {});
    }
    throw error;
  }
  return {
    ok: true,
    accepted: true,
    requestId: request.requestId,
    monitor: {
      schemaVersion: "bonni.local-source-update-monitor-access/v1",
      origin: status.runner.monitor.origin,
      requestId: request.requestId,
      updateId: status.updateId,
      manifestSha256: status.manifestSha256,
      token: monitorToken,
      issuedAt: now.toISOString(),
    },
    localSourceUpdate: { ...status, state: "in-progress", updateAvailable: false },
  };
}

export const LOCAL_SOURCE_UPDATE_REQUEST_SCHEMA = REQUEST_SCHEMA;
