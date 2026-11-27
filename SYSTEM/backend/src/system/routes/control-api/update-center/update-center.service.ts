import {loadUpdateSettings, parseUpdateSettings, scheduledOccurrence, automaticInstallAuthorized, type UpdateSettings} from "./update-schedule.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { createReadStream, existsSync, statfsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { getInstalledModulesCompatibilityForCoreVersion } from "../../../../platform/module-manager/compatibility/index.js";
import { getProductRoot } from "../../../boot/run-system/run-system.paths.js";
import {
  assertReleaseArtifactIdentity,
  assertSecureReleaseHttpsUrl,
  assertSecureReleaseRedirect,
  compareBonniReleaseVersion,
  compareStrictSemVer,
  loadEd25519SpkiPublicKeyFile,
  parseReleaseManifest,
  resolveSecureLocalReleaseArtifact,
  signLifecycleCommand,
  signUpdateRunnerRequest,
  verifyReleaseManifest,
  type ReleaseManifest,
} from "../../../update-release/index.js";
import { getSystemRuntimeConfig } from "../../../runtime/runtime.config.js";
import {
  createSystemBackup,
  getSystemBackupOverview,
  validateSystemBackup,
} from "../backup/index.js";
import { getOfficialCoreReleaseSource, getCoreReleaseAllowedOrigins } from "./github-release-source.js";
import {
  getLocalSourceUpdateStatus,
  queueLocalSourceUpdate,
} from "./local-source-inbox.service.js";
import {
  finalizeExpiredLocalSourceDeploymentLifecycle,
  finalizeLocalSourceDeploymentLifecycle,
  getLocalSourceDeploymentLifecycle,
  isLocalSourceDeploymentLifecycleExpected,
  rollbackLocalSourceDeploymentLifecycle,
} from "./local-source-deployment.service.js";
import { resolveLocalSourceDeploymentLifecycle } from "./local-source-lifecycle-policy.js";

export { resolveLocalSourceDeploymentLifecycle } from "./local-source-lifecycle-policy.js";

type UpdateStepStatus = "pending" | "running" | "completed" | "failed" | "waiting";
type UpdateWorkflowStatus = "running" | "ready" | "installing" | "completed" | "rolling-back" | "rolled-back" | "failed";

type UpdateStep = {
  key: string;
  label: string;
  status: UpdateStepStatus;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
};

type UpdateWorkflow = {
  id: string;
  status: UpdateWorkflowStatus;
  currentVersion: string;
  targetVersion: string;
  createdAt: string;
  updatedAt: string;
  progressPercent: number;
  downloadedBytes: number;
  totalBytes: number | null;
  artifactPath?: string;
  backupId?: string;
  runnerRequestId?: string;
  automaticRevision?: number;
  message?: string;
  error?: string;
  steps: UpdateStep[];
};


type SelectedRelease = {
  manifest: ReleaseManifest;
  sourceLocation: string;
  manifestFile?: string;
};

type RunnerHeartbeat = {
  version?: string;
  runnerVersion?: string;
  updatedAt?: string;
  state?: string;
  status?: string;
  available?: boolean;
  message?: string;
};

type RunnerProgress = {
  requestId?: string;
  workflowId?: string;
  status?: string;
  phase?: string;
  message?: string;
  error?: string;
  updatedAt?: string;
  steps?: Array<{ key?: string; status?: string; detail?: string }> | Record<string, { status?: string; detail?: string } | string>;
};

export type DeploymentLifecycleStatus = {
  protocol: "bonni-deployment-lifecycle/1";
  schemaVersion: 1;
  generation: number;
  state: "idle" | "holding" | "finalizing" | "finalized";
  holdId?: string;
  workflowId?: string;
  previousVersion?: string;
  targetVersion?: string;
  holdDays?: number;
  activatedAt?: string;
  holdUntil?: string;
  finalizeReason?: string | null;
  finalizeRequestedAt?: string | null;
  finalizedAt?: string | null;
  observedHoldMs: number;
  autoFinalizeBlocked: boolean;
  blockReason?: string | null;
  blocksUpdates: boolean;
  canFinalize: boolean;
  mode: "single-active-fail-closed-hold";
  updatedAt: string;
};

const UPDATE_RUNNER_PROTOCOL_VERSION = "0.5.0";
const MAXIMUM_MANIFEST_BYTES = 256 * 1024;
const RUNNER_HEARTBEAT_MAX_AGE_MS = 20_000;

const STEP_DEFINITIONS = [
  ["preflight", "Voraussetzungen prüfen"],
  ["store", "Store-Freigabe prüfen"],
  ["download", "Updatepaket herunterladen"],
  ["signature", "Signatur und Prüfsumme prüfen"],
  ["backup-database", "Datenbank sichern"],
  ["backup-configuration", "Einstellungen sichern"],
  ["backup-storage", "Dateien sichern"],
  ["backup-verify", "Sicherungen prüfen"],
  ["candidate", "Separates Installationsbackend starten"],
  ["health", "Installation und neue Core-Version prüfen"],
  ["switch", "Dauerhaft auf neue Version umschalten"],
] as const;

let activePreparation: Promise<void> | null = null;
let lastProgressWrite = 0;
let automaticCycleRunning = false;
let automaticCycleTimer: NodeJS.Timeout | null = null;

function maximumUpdateBytes() {
  const configured = Number(process.env.BONNI_UPDATE_MAX_BYTES || 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 2 * 1024 * 1024 * 1024;
}

function storageRoot() {
  if (process.env.BONNI_STORAGE_ROOT) return path.resolve(process.env.BONNI_STORAGE_ROOT);
  const productBackendRoot = path.join(getProductRoot(), "SYSTEM", "backend");
  const legacySiblingStorage = path.resolve(productBackendRoot, "../storage");
  return existsSync(legacySiblingStorage)
    ? legacySiblingStorage
    : path.join(productBackendRoot, "storage");
}

function updateCenterRoot() {
  return process.env.BONNI_UPDATE_STATE_ROOT
    ? path.resolve(process.env.BONNI_UPDATE_STATE_ROOT)
    : path.join(storageRoot(), "system", "update-center");
}

function updateRunnerRoot() {
  return process.env.BONNI_UPDATE_RUNNER_STATE_ROOT
    ? path.resolve(process.env.BONNI_UPDATE_RUNNER_STATE_ROOT)
    : path.join(storageRoot(), "system", "update-runner");
}

function localReleaseRoot() {
  return process.env.BONNI_UPDATE_LOCAL_ROOT
    ? path.resolve(process.env.BONNI_UPDATE_LOCAL_ROOT)
    : path.join(getProductRoot(), "SYSTEM", "backend", "updates", "bonni-core");
}

function statePath() {
  return path.join(updateCenterRoot(), "state.json");
}

function settingsPath() {
  return path.join(updateCenterRoot(), "settings.json");
}

function cachedManifestPath() {
  return path.join(updateCenterRoot(), "available-manifest.json");
}

function localManifestPaths() {
  if (process.env.BONNI_UPDATE_MANIFEST_FILE) return [path.resolve(process.env.BONNI_UPDATE_MANIFEST_FILE)];
  const root = localReleaseRoot();
  const label = process.platform === "linux"
    ? ({ x64: "AMD64", arm64: "ARM64", arm: "ARMv7" } as Record<string, string>)[process.arch]
    : undefined;
  return label ? [path.join(root, `manifest-offline-${label}.json`)] : [];
}

function runnerHeartbeatPath() {
  return path.join(updateRunnerRoot(), "heartbeat.json");
}

function runnerProgressPath(workflowId: string) {
  return path.join(updateRunnerRoot(), "progress", `${workflowId}.json`);
}

function runnerLifecycleStatusPath() {
  return path.join(updateRunnerRoot(), "deployment-lifecycle.json");
}

function runnerLifecycleRequestRoot() {
  return path.join(updateRunnerRoot(), "requests", "lifecycle");
}

function updateRequestSecretPath() {
  return path.resolve(process.env.BONNI_UPDATE_REQUEST_SECRET_FILE || "/run/secrets/bonni-update/request.key");
}

async function loadUpdateRequestSecret() {
  const secretPath = updateRequestSecretPath();
  for (const forbidden of [storageRoot(), updateCenterRoot(), updateRunnerRoot()]) {
    const relative = path.relative(forbidden, secretPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("Das lokale Update-Secret darf nicht im gemeinsam beschreibbaren Storage liegen.");
    }
  }
  const stat = await fs.stat(secretPath);
  if (!stat.isFile() || stat.size < 32 || stat.size > 4_096) throw new Error("Das lokale Update-Secret fehlt oder ist ungültig.");
  if ((stat.mode & 0o077) !== 0) throw new Error("Das lokale Update-Secret besitzt zu offene Dateirechte.");
  return fs.readFile(secretPath);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readDeploymentLifecycleStatus(): Promise<DeploymentLifecycleStatus> {
  const value = await readJson<DeploymentLifecycleStatus>(runnerLifecycleStatusPath());
  if (!value) {
    throw Object.assign(new Error("Der Docker-Deployment-Lifecycle ist für diese Installation nicht eingerichtet."), {
      code: "RUNNER_DEPLOYMENT_LIFECYCLE_ABSENT",
    });
  }
  const timestamp = (input: unknown) => typeof input === "string" && Number.isFinite(Date.parse(input));
  if (value.protocol !== "bonni-deployment-lifecycle/1"
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !["idle", "holding", "finalizing", "finalized"].includes(value.state)
    || typeof value.blocksUpdates !== "boolean"
    || typeof value.canFinalize !== "boolean"
    || !Number.isSafeInteger(value.observedHoldMs) || value.observedHoldMs < 0
    || typeof value.autoFinalizeBlocked !== "boolean"
    || value.mode !== "single-active-fail-closed-hold"
    || !timestamp(value.updatedAt)
    || (value.state !== "idle" && (
      typeof value.holdId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.holdId)
      || !Number.isSafeInteger(value.holdDays) || Number(value.holdDays) < 1
      || value.holdDays !== 14
      || !timestamp(value.holdUntil)
    ))) {
    throw Object.assign(new Error("Der sichere Deployment-Lifecycle-Status ist ungültig."), {
      code: "RUNNER_DEPLOYMENT_LIFECYCLE_INVALID",
    });
  }
  if (value.blocksUpdates !== !["idle", "finalized"].includes(value.state)
    || value.canFinalize !== (value.state === "holding")) {
    throw Object.assign(new Error("Der Deployment-Lifecycle-Status ist widersprüchlich."), {
      code: "RUNNER_DEPLOYMENT_LIFECYCLE_INVALID",
    });
  }
  return value;
}

function configuredAllowedOrigins() {
  return getCoreReleaseAllowedOrigins();
}

async function resolvedAddresses(url: URL) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) return [url.hostname];
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function validateHttpsUrl(value: string, allowedOrigins?: readonly string[]) {
  const preliminary = assertSecureReleaseHttpsUrl(value, { allowedOrigins });
  return assertSecureReleaseHttpsUrl(value, {
    allowedOrigins,
    resolvedAddresses: await resolvedAddresses(preliminary),
  });
}

async function fetchHttpsWithSafeRedirects(value: string, options: { timeoutMs: number; allowedOrigins?: readonly string[] }) {
  let current = await validateHttpsUrl(value, options.allowedOrigins);
  const firstOrigin = current.origin;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    if (redirect === 3) throw new Error("Updatequelle enthält zu viele Weiterleitungen.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Updatequelle meldet eine Weiterleitung ohne Ziel.");
    const next = new URL(location, current).toString();
    const preliminary = assertSecureReleaseRedirect(current.toString(), next, { allowedOrigins: options.allowedOrigins || [firstOrigin] });
    current = assertSecureReleaseRedirect(current.toString(), next, {
      allowedOrigins: options.allowedOrigins || [firstOrigin],
      resolvedAddresses: await resolvedAddresses(preliminary),
    });
  }
  throw new Error("Updatequelle konnte nicht geladen werden.");
}

async function readResponseBytesLimited(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error("Updatequelle lieferte keinen Inhalt.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("RESPONSE_SIZE_LIMIT_EXCEEDED").catch(() => undefined);
        throw new Error("Update-Manifest ist zu groß.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function trustedReleaseKeys(manifest: ReleaseManifest) {
  if (!manifest.signature) return undefined;
  if (manifest.buildAuthorization) {
    // GitHub artifacts are signed by a scoped build key. Trust stays with the
    // enrolled issuers in the same configured key store used by the runner.
    const { loadTrustedReleaseKeys } = await import("../../../../../src/system/update-runner/trusted-keys.mjs");
    return loadTrustedReleaseKeys(process.env, getProductRoot());
  }
  const keyId = manifest.signature.keyId;
  const keyDirectory = String(process.env.BONNI_UPDATE_TRUSTED_KEYS_DIR || "").trim();
  const keyPath = keyDirectory
    ? path.join(path.resolve(keyDirectory), `${keyId}.pem`)
    : process.env.BONNI_UPDATE_PUBLIC_KEY_PATH
      ? path.resolve(process.env.BONNI_UPDATE_PUBLIC_KEY_PATH)
      : path.resolve(process.cwd(), "config", "update", "public-key.pem");
  if (!existsSync(keyPath)) throw new Error(`Vertrauensschlüssel ${keyId} fehlt.`);
  return { [keyId]: await loadEd25519SpkiPublicKeyFile(keyPath) };
}

async function verifyManifest(value: unknown) {
  const manifest = parseReleaseManifest(value);
  const verification = verifyReleaseManifest(manifest, {
    trustedKeys: await trustedReleaseKeys(manifest),
    expectedProduct: "bonni-core",
    expectedChannel: "stable",
    runnerVersion: UPDATE_RUNNER_PROTOCOL_VERSION,
    nodeEnv: process.env.NODE_ENV,
    allowUnsignedDevelopment: String(process.env.BONNI_ALLOW_UNSIGNED_UPDATES || "").toLowerCase() === "true",
  });
  const platform = verification.manifest.artifact.imageIdentity.platform;
  const architecture = process.arch === "x64" ? "amd64" : process.arch;
  if (process.platform !== platform.os || architecture !== platform.architecture
    || (architecture === "arm" && platform.variant !== "v7")) {
    throw new Error("UPDATE_PLATFORM_MISMATCH");
  }
  return verification.manifest;
}

async function loadLocalOrCachedManifest(): Promise<SelectedRelease | null> {
  const candidates = [
    ...localManifestPaths().map(file => ({ manifestFile: file, sourceLocation: file, local: true })),
    {
      manifestFile: cachedManifestPath(),
      sourceLocation: String(process.env.BONNI_UPDATE_MANIFEST_URL || "").trim() || "",
      local: false,
    },
  ];
  const loaded: SelectedRelease[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.local) {
        const state = await fs.lstat(candidate.manifestFile);
        if (!state.isFile() || state.isSymbolicLink() || state.size > MAXIMUM_MANIFEST_BYTES) continue;
      }
      const value = await readJson<unknown>(candidate.manifestFile);
      if (!value) continue;
      const manifest = await verifyManifest(value);
      if (candidate.local) {
        if (manifest.artifact.source.kind !== "local") continue;
        await resolveSecureLocalReleaseArtifact({
          manifestFile: candidate.manifestFile,
          artifactPath: manifest.artifact.source.path,
          allowedRoot: localReleaseRoot(),
        });
      }
      if (!candidate.local && manifest.artifact.source.kind !== "https") continue;
      const sourceLocation = candidate.sourceLocation
        || (manifest.artifact.source.kind === "https" ? manifest.artifact.source.url : candidate.manifestFile);
      loaded.push({ manifest, sourceLocation, manifestFile: candidate.manifestFile });
    } catch {
      // Ein beschädigtes oder abgelaufenes Manifest verdeckt keinen anderen gültigen Eingang.
    }
  }
  return loaded.sort((left, right) => compareBonniReleaseVersion(right.manifest.version, left.manifest.version))[0] || null;
}

async function fetchRemoteManifest(): Promise<SelectedRelease | null> {
  const source = String(process.env.BONNI_UPDATE_MANIFEST_URL || "").trim();
  if (!source) return null;
  const configuredOrigins = configuredAllowedOrigins();
  const initial = await validateHttpsUrl(source, configuredOrigins.length ? configuredOrigins : undefined);
  const allowedOrigins = configuredOrigins.length ? configuredOrigins : [initial.origin];
  const { response, finalUrl } = await fetchHttpsWithSafeRedirects(source, { timeoutMs: 15_000, allowedOrigins });
  if (!response.ok) throw new Error(`Updatequelle antwortet mit HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAXIMUM_MANIFEST_BYTES) throw new Error("Update-Manifest ist zu groß.");
  const bytes = await readResponseBytesLimited(response, MAXIMUM_MANIFEST_BYTES);
  const manifest = await verifyManifest(JSON.parse(bytes.toString("utf8")));
  if (manifest.artifact.source.kind !== "https") throw new Error("Entfernte Manifeste dürfen keine lokalen Pakete referenzieren.");
  await validateHttpsUrl(manifest.artifact.source.url, allowedOrigins);
  await writeJson(cachedManifestPath(), manifest);
  return { manifest, sourceLocation: finalUrl.toString(), manifestFile: cachedManifestPath() };
}

async function loadSettings(): Promise<UpdateSettings> {
  return loadUpdateSettings(await readJson<Partial<UpdateSettings>>(settingsPath()));
}
let settingsWrite: Promise<unknown> = Promise.resolve();
export function updateCoreUpdateSettings(input: Partial<UpdateSettings>) {
  const result = settingsWrite.then(async () => {
    const current = await loadSettings();
    const settings = parseUpdateSettings(input, current);
    settings.revision = current.revision + 1;
    await writeJson(settingsPath(), settings);
    return { ok: true, settings };
  });
  settingsWrite = result.catch(() => undefined);
  return result;
}

function createWorkflow(currentVersion: string, manifest: ReleaseManifest): UpdateWorkflow {
  const now = new Date().toISOString();
  return {
    id: `update-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    status: "running",
    currentVersion,
    targetVersion: manifest.version,
    createdAt: now,
    updatedAt: now,
    progressPercent: 0,
    downloadedBytes: 0,
    totalBytes: manifest.artifact.sizeBytes,
    steps: STEP_DEFINITIONS.map(([key, label]) => ({ key, label, status: "pending" })),
  };
}

async function saveWorkflow(workflow: UpdateWorkflow) {
  workflow.updatedAt = new Date().toISOString();
  await writeJson(statePath(), workflow);
}

function findStep(workflow: UpdateWorkflow, key: string) {
  const step = workflow.steps.find((candidate) => candidate.key === key);
  if (!step) throw new Error(`Unbekannter Update-Schritt: ${key}`);
  return step;
}

async function updateStep(workflow: UpdateWorkflow, key: string, status: UpdateStepStatus, detail?: string) {
  const step = findStep(workflow, key);
  step.status = status;
  if (status === "running") {
    if (!step.startedAt) step.startedAt = new Date().toISOString();
    delete step.finishedAt;
  }
  if (["completed", "failed", "waiting"].includes(status)) step.finishedAt = new Date().toISOString();
  if (detail) step.detail = detail;
  await saveWorkflow(workflow);
}

function artifactTarget(manifest: ReleaseManifest) {
  return path.join(updateCenterRoot(), "downloads", `bonni-core-${manifest.version}.bonni`);
}

async function updateDownloadProgress(workflow: UpdateWorkflow, downloadedBytes: number, totalBytes: number) {
  workflow.downloadedBytes = downloadedBytes;
  workflow.totalBytes = totalBytes;
  workflow.progressPercent = Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
  const now = Date.now();
  if (now - lastProgressWrite >= 250 || workflow.progressPercent === 100) {
    lastProgressWrite = now;
    await saveWorkflow(workflow);
  }
}

async function copyStreamToFile(chunks: AsyncIterable<Uint8Array | Buffer>, target: string, workflow: UpdateWorkflow, totalBytes: number) {
  const maximumBytes = maximumUpdateBytes();
  if (totalBytes > maximumBytes) throw new Error("Updatepaket überschreitet die erlaubte Maximalgröße.");
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  const handle = await fs.open(temporary, "wx", 0o600);
  let downloaded = 0;
  try {
    for await (const chunk of chunks) {
      const buffer = Buffer.from(chunk);
      downloaded += buffer.length;
      if (downloaded > totalBytes || downloaded > maximumBytes) throw new Error("Updatepaket ist größer als im signierten Manifest angegeben.");
      await handle.writeFile(buffer);
      await updateDownloadProgress(workflow, downloaded, totalBytes);
    }
    if (downloaded !== totalBytes) throw new Error("Updatepaket ist unvollständig.");
  } catch (error) {
    await handle.close();
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await fs.rename(temporary, target);
}

async function downloadArtifact(selected: SelectedRelease, target: string, workflow: UpdateWorkflow) {
  const { manifest } = selected;
  if (manifest.artifact.source.kind === "local") {
    const source = await resolveSecureLocalReleaseArtifact({
      manifestFile: selected.manifestFile || selected.sourceLocation,
      artifactPath: manifest.artifact.source.path,
      allowedRoot: localReleaseRoot(),
    });
    await copyStreamToFile(createReadStream(source), target, workflow, manifest.artifact.sizeBytes);
    return;
  }

  const manifestUrl = await validateHttpsUrl(selected.sourceLocation, configuredAllowedOrigins().length ? configuredAllowedOrigins() : undefined);
  const allowedOrigins = configuredAllowedOrigins().length ? configuredAllowedOrigins() : [manifestUrl.origin];
  const { response } = await fetchHttpsWithSafeRedirects(manifest.artifact.source.url, {
    timeoutMs: 30 * 60_000,
    allowedOrigins,
  });
  if (!response.ok || !response.body) throw new Error(`Download fehlgeschlagen: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength !== manifest.artifact.sizeBytes) {
    throw new Error("Downloadgröße stimmt nicht mit dem signierten Manifest überein.");
  }
  await copyStreamToFile(
    response.body as unknown as AsyncIterable<Uint8Array>,
    target,
    workflow,
    manifest.artifact.sizeBytes,
  );
}

async function sha256File(file: string) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArtifact(manifest: ReleaseManifest, artifact: string) {
  const stat = await fs.stat(artifact);
  const digest = await sha256File(artifact);
  assertReleaseArtifactIdentity(manifest, { sizeBytes: stat.size, sha256: digest });
  return { digest, sizeBytes: stat.size, signed: Boolean(manifest.signature) };
}

function preflightStorage(manifest: ReleaseManifest) {
  const stats = statfsSync(updateCenterRoot());
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const requiredBytes = Math.max(512 * 1024 * 1024, manifest.artifact.sizeBytes * 3);
  if (freeBytes < requiredBytes) throw new Error("Nicht genügend freier Speicher für Image, Candidate und Rückkehrpunkt.");
  return { freeBytes, requiredBytes };
}

function installationPolicy(manifest: ReleaseManifest | null, runner: Awaited<ReturnType<typeof getRunnerStatus>>) {
  if (process.env.BONNI_DEPLOYMENT_MODE === "unraid-single-container") {
    return { allowed: false, reason: "Dieser Unraid-Einzelcontainer hat keinen Core-Update-Dienst. Core-Images werden über Unraid gewechselt." };
  }
  if (!manifest) return { allowed: false, reason: "Kein gültiges Update-Manifest vorhanden." };
  if (manifest.artifact.type !== "oci-image-archive") {
    return { allowed: false, reason: "Der Runner akzeptiert ausschließlich signierte OCI-Systemimages." };
  }
  const migrationAllowed = manifest.migration.backwardCompatible === true && (
    (!manifest.migration.required && manifest.migration.strategy === "none")
    || (manifest.migration.required && manifest.migration.strategy === "expand-contract")
  );
  if (!(migrationAllowed || (manifest.migration.required && manifest.migration.strategy === "offline" && compareStrictSemVer(manifest.minimumRunnerVersion, "0.4.0") >= 0))) {
    return { allowed: false, reason: "Diese Migrationsart benötigt einen geeigneten Update-Dienst. Wartungsinstallationen benötigen mindestens Version 0.4.0." };
  }
  if (runner.deploymentLifecycle.blocksUpdates) {
    return { allowed: false, reason: `Der vorherige Stand wird bis ${runner.deploymentLifecycle.holdUntil || "zum sicheren Abschluss"} geschützt. Zuerst Hold abschließen.` };
  }
  if (!runner.available) return { allowed: false, reason: runner.reason };
  return { allowed: true, reason: null };
}

async function queueRunnerInstall(workflow: UpdateWorkflow, manifest: ReleaseManifest) {
  if (!automaticInstallAuthorized(await loadSettings(), workflow.automaticRevision)) {
    workflow.status = "ready";
    workflow.message = "Automatik wurde geändert. Das geprüfte Paket bleibt für eine manuelle Installation bereit.";
    await saveWorkflow(workflow);
    return;
  }
  if (!workflow.artifactPath || !workflow.backupId) throw new Error("Updatepaket oder Rückkehrpunkt fehlt.");
  const relative = path.relative(updateCenterRoot(), workflow.artifactPath).replaceAll("\\", "/");
  if (!/^downloads\/bonni-core-[A-Za-z0-9.+-]+\.bonni$/.test(relative)) throw new Error("Updatepaket liegt nicht im freigegebenen Downloadbereich.");
  const now = new Date();
  const unsignedRequest = {
    schemaVersion: 1,
    requestId: workflow.id,
    workflowId: workflow.id,
    action: "install",
    product: "bonni-core",
    currentVersion: workflow.currentVersion,
    targetVersion: workflow.targetVersion,
    artifactRelativePath: relative,
    backupId: workflow.backupId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
    nonce: crypto.randomBytes(32).toString("base64url"),
    release: manifest,
  };
  const request = signUpdateRunnerRequest(unsignedRequest, await loadUpdateRequestSecret());
  await writeJson(path.join(updateRunnerRoot(), "requests", `${workflow.id}.json`), request);
  workflow.runnerRequestId = workflow.id;
  workflow.status = "installing";
  workflow.message = "Der sichere Update-Runner übernimmt Candidate-Prüfung, Umschaltung und Rollback.";
  await updateStep(workflow, "candidate", "waiting", "Auftrag an den isolierten Update-Runner übergeben.");
}

const BACKUP_STEP_BY_COMPONENT: Record<string, string> = {
  database: "backup-database",
  configuration: "backup-configuration",
  storage: "backup-storage",
};

async function createVerifiedUpdateBackup(workflow: UpdateWorkflow, manifest: ReleaseManifest) {
  workflow.backupId = undefined;
  for (const stepKey of Object.values(BACKUP_STEP_BY_COMPONENT)) {
    const step = findStep(workflow, stepKey);
    step.status = "pending";
    delete step.startedAt;
    delete step.finishedAt;
    delete step.detail;
  }
  const verifyStep = findStep(workflow, "backup-verify");
  verifyStep.status = "pending";
  delete verifyStep.startedAt;
  delete verifyStep.finishedAt;
  delete verifyStep.detail;
  await saveWorkflow(workflow);

  const backup = await createSystemBackup({
    reason: `before-update:${manifest.version}`,
    onProgress: async ({ backupId, component, status }) => {
      workflow.backupId = backupId;
      const stepStatus: UpdateStepStatus = status === "failed" ? "failed" : status === "completed" ? "completed" : status === "running" ? "running" : "pending";
      await updateStep(workflow, BACKUP_STEP_BY_COMPONENT[component], stepStatus);
    },
  });
  if (!backup.ok || !backup.backup) throw new Error(backup.message || "Sicherung vor dem Update fehlgeschlagen.");
  workflow.backupId = backup.backup.id;

  await updateStep(workflow, "backup-verify", "running");
  const backupValidation = await validateSystemBackup(backup.backup.id);
  if (!backupValidation.ok) throw new Error("Sicherung konnte nicht vollständig geprüft werden.");
  await updateStep(workflow, "backup-verify", "completed", `${backupValidation.checkedFiles} Dateien geprüft`);
}

async function failWorkflow(workflow: UpdateWorkflow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const runningStep = workflow.steps.find((step) => step.status === "running");
  if (runningStep) {
    runningStep.status = "failed";
    runningStep.detail = message;
    runningStep.finishedAt = new Date().toISOString();
  }
  workflow.status = "failed";
  workflow.error = message;
  workflow.message = `Update angehalten: ${message}`;
  await saveWorkflow(workflow);
}

async function runPreparedInstallation(workflow: UpdateWorkflow, manifest: ReleaseManifest) {
  try {
    workflow.status = "running";
    workflow.message = "Unmittelbar vor der Installation wird ein neuer Rückkehrpunkt erstellt.";
    delete workflow.error;
    await saveWorkflow(workflow);
    await createVerifiedUpdateBackup(workflow, manifest);
    const runner = await getRunnerStatus();
    const policy = installationPolicy(manifest, runner);
    if (!policy.allowed) throw new Error(policy.reason || "Update-Runner ist nicht bereit.");
    await queueRunnerInstall(workflow, manifest);
  } catch (error) {
    await failWorkflow(workflow, error);
  }
}

async function runPreparation(workflow: UpdateWorkflow, selected: SelectedRelease, queueInstall: boolean) {
  const { manifest } = selected;
  try {
    await fs.mkdir(updateCenterRoot(), { recursive: true, mode: 0o700 });
    await updateStep(workflow, "preflight", "running");
    await verifyManifest(manifest);
    const preflight = preflightStorage(manifest);
    if (compareBonniReleaseVersion(manifest.version, workflow.currentVersion) <= 0) throw new Error("Die Zielversion ist nicht neuer als die aktive Version.");
    await updateStep(workflow, "preflight", "completed", `${Math.round(preflight.freeBytes / 1024 / 1024)} MB frei`);

    await updateStep(workflow, "store", "running");
    const compatibility = await getInstalledModulesCompatibilityForCoreVersion(manifest.version);
    if (!compatibility.ok) {
      const packages = compatibility.incompatible.map((module) => module.name || module.key).join(", ");
      throw new Error(`Store verweigert die Freigabe: ${packages}`);
    }
    await updateStep(workflow, "store", "completed", "Alle installierten Erweiterungen sind freigegeben.");

    await updateStep(workflow, "download", "running");
    const target = artifactTarget(manifest);
    await downloadArtifact(selected, target, workflow);
    workflow.artifactPath = target;
    workflow.progressPercent = 100;
    await updateStep(workflow, "download", "completed", "Signiertes OCI-Systemimage vollständig geladen.");

    await updateStep(workflow, "signature", "running");
    const verification = await verifyArtifact(manifest, target);
    await updateStep(workflow, "signature", "completed", verification.signed ? "Release-Signatur, Größe und SHA-256 gültig" : "Lokaler Entwicklungsmodus");

    if (queueInstall) {
      await createVerifiedUpdateBackup(workflow, manifest);
      const runner = await getRunnerStatus();
      const policy = installationPolicy(manifest, runner);
      if (!policy.allowed) throw new Error(policy.reason || "Update-Runner ist nicht bereit.");
      await queueRunnerInstall(workflow, manifest);
    } else {
      for (const stepKey of [...Object.values(BACKUP_STEP_BY_COMPONENT), "backup-verify"]) {
        await updateStep(workflow, stepKey, "waiting", "Wird unmittelbar vor der bestätigten Installation ausgeführt.");
      }
      await updateStep(workflow, "candidate", "waiting", "Paket ist bereit zur bestätigten Installation.");
      workflow.status = "ready";
      workflow.message = "Updatepaket und geprüfter Rückkehrpunkt sind vorbereitet.";
      await saveWorkflow(workflow);
    }
  } catch (error) {
    await failWorkflow(workflow, error);
  }
}

async function getRunnerStatus() {
  const [heartbeat, requestSecretError, lifecycleAttempt] = await Promise.all([
    readJson<RunnerHeartbeat>(runnerHeartbeatPath()).catch(() => null),
    loadUpdateRequestSecret().then(() => null).catch((error) => error instanceof Error ? error.message : String(error)),
    readDeploymentLifecycleStatus()
      .then((value) => ({ value, error: null as string | null, errorCode: null as string | null }))
      .catch((error) => ({
        value: null,
        error: error instanceof Error ? error.message : String(error),
        errorCode: typeof (error as { code?: unknown })?.code === "string"
          ? String((error as { code: string }).code)
          : "RUNNER_DEPLOYMENT_LIFECYCLE_INVALID",
      })),
  ]);
  const lifecycle = lifecycleAttempt.value;
  const lifecycleError = lifecycleAttempt.error;
  const lifecycleAuthority: "verified" | "absent" | "invalid" = lifecycle
    ? "verified"
    : lifecycleAttempt.errorCode === "RUNNER_DEPLOYMENT_LIFECYCLE_ABSENT"
      ? "absent"
      : "invalid";
  const updatedAt = heartbeat?.updatedAt ? Date.parse(heartbeat.updatedAt) : Number.NaN;
  const heartbeatAge = Date.now() - updatedAt;
  const heartbeatFresh = Number.isFinite(updatedAt)
    && heartbeatAge >= -5 * 60_000
    && heartbeatAge <= RUNNER_HEARTBEAT_MAX_AGE_MS;
  const version = heartbeat?.version || heartbeat?.runnerVersion || null;
  const state = heartbeat?.state || heartbeat?.status || "offline";
  let versionCompatible = false;
  try {
    versionCompatible = Boolean(version && compareStrictSemVer(version, UPDATE_RUNNER_PROTOCOL_VERSION) >= 0);
  } catch {
    versionCompatible = false;
  }
  const available = heartbeatFresh && versionCompatible && heartbeat?.available !== false
    && state !== "error" && !requestSecretError && Boolean(lifecycle) && !lifecycleError;
  const deploymentLifecycle = lifecycle || {
    protocol: "bonni-deployment-lifecycle/1" as const,
    schemaVersion: 1 as const,
    generation: 0,
    state: "idle" as const,
    blocksUpdates: true,
    canFinalize: false,
    observedHoldMs: 0,
    autoFinalizeBlocked: true,
    blockReason: lifecycleError || "Der sichere Deployment-Lifecycle-Status ist nicht erreichbar.",
    mode: "single-active-fail-closed-hold" as const,
    updatedAt: new Date(0).toISOString(),
  };
  return {
    available,
    mode: "isolated-docker-runner",
    heartbeatFresh,
    lifecycleAuthority,
    lifecycleError,
    version,
    updatedAt: heartbeat?.updatedAt || null,
    state,
    deploymentLifecycle,
    reason: available
      ? null
      : !heartbeatFresh
        ? "Der sichere Docker-Update-Runner ist nicht erreichbar."
        : requestSecretError
          ? requestSecretError
        : lifecycleError
          ? lifecycleError
        : !versionCompatible
          ? "Der Docker-Update-Runner ist zu alt."
          : heartbeat?.message || `Der Docker-Update-Runner meldet den Zustand ${state}.`,
  };
}

export async function finalizeDeploymentLifecycle(input: { holdId: string; generation: number }) {
  const localLifecycle = await getLocalSourceDeploymentLifecycle();
  if (localLifecycle?.holdId === input.holdId || localLifecycle?.blocksUpdates) {
    const localResult = await finalizeLocalSourceDeploymentLifecycle(input);
    if (localResult) return localResult;
  }
  const runner = await getRunnerStatus();
  const lifecycle = runner.deploymentLifecycle;
  if (lifecycle.state === "finalized"
    && lifecycle.holdId === input.holdId
    && lifecycle.generation === input.generation) {
    return { ok: true, accepted: false, existing: true, deploymentLifecycle: lifecycle };
  }
  if (!runner.available) return { ok: false, error: "RUNNER_NOT_READY", message: runner.reason };
  if (lifecycle.holdId !== input.holdId || lifecycle.generation !== input.generation) {
    return { ok: false, error: "DEPLOYMENT_HOLD_CHANGED", message: "Der angezeigte Hold ist nicht mehr aktuell." };
  }
  if (lifecycle.state === "finalizing") {
    return { ok: true, accepted: false, existing: true, deploymentLifecycle: lifecycle };
  }
  if (lifecycle.state !== "holding" || !lifecycle.canFinalize) {
    return { ok: false, error: "DEPLOYMENT_HOLD_NOT_FINALIZABLE", message: "Es gibt keinen abschließbaren Deployment-Hold." };
  }

  const now = new Date();
  const commandId = `finalize-${now.getTime()}-${crypto.randomBytes(8).toString("hex")}`;
  const command = signLifecycleCommand({
    schemaVersion: 1,
    commandId,
    action: "finalize",
    holdId: input.holdId,
    generation: input.generation,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    nonce: crypto.randomBytes(32).toString("base64url"),
  }, await loadUpdateRequestSecret());
  await writeJson(path.join(runnerLifecycleRequestRoot(), `${commandId}.json`), command);
  return {
    ok: true,
    accepted: true,
    commandId,
    deploymentLifecycle: lifecycle,
  };
}

export async function rollbackDeploymentLifecycle(input: { holdId: string; generation: number }) {
  const localResult = await rollbackLocalSourceDeploymentLifecycle(input);
  if (localResult) return localResult;
  return {
    ok: false,
    error: "DEPLOYMENT_ROLLBACK_NOT_AVAILABLE",
    message: "Für diesen Deployment-Stand ist kein sicherer manueller Rückfall freigegeben.",
  };
}

function normalizeRunnerStepStatus(value: unknown): UpdateStepStatus | null {
  if (["pending", "running", "completed", "failed", "waiting"].includes(String(value))) return String(value) as UpdateStepStatus;
  return null;
}

function mergeRunnerProgress(workflow: UpdateWorkflow | null, progress: RunnerProgress | null) {
  if (!workflow || !progress || (progress.workflowId && progress.workflowId !== workflow.id)) return workflow;
  const merged = structuredClone(workflow);
  const statusMap: Record<string, UpdateWorkflowStatus> = {
    queued: "installing",
    verifying: "installing",
    installing: "installing",
    running: "installing",
    "rolling-back": "rolling-back",
    "rolled-back": "rolled-back",
    completed: "completed",
    failed: "failed",
  };
  if (progress.status && statusMap[progress.status]) merged.status = statusMap[progress.status];
  if (progress.message) merged.message = progress.message;
  if (progress.error) merged.error = progress.error;
  if (progress.updatedAt) merged.updatedAt = progress.updatedAt;

  const runnerSteps = Array.isArray(progress.steps)
    ? progress.steps
    : Object.entries(progress.steps || {}).map(([key, value]) => typeof value === "string" ? { key, status: value } : { key, ...value });
  for (const runnerStep of runnerSteps) {
    const step = merged.steps.find((entry) => entry.key === runnerStep.key);
    const status = normalizeRunnerStepStatus(runnerStep.status);
    if (step && status) {
      step.status = status;
      if (runnerStep.detail) step.detail = runnerStep.detail;
    }
  }
  return merged;
}

export async function checkForCoreUpdate() {
  const localSourceUpdate = await getLocalSourceUpdateStatus();
  const releaseSource = getOfficialCoreReleaseSource();
  const remote = await fetchRemoteManifest().catch((error) => ({ error }));
  if (remote && "error" in remote) {
    const local = await loadLocalOrCachedManifest();
    return {
      ok: Boolean(local) || localSourceUpdate.state !== "invalid",
      checkedAt: new Date().toISOString(),
      warning: remote.error instanceof Error ? remote.error.message : String(remote.error),
      manifest: local?.manifest || null,
      localSourceUpdate,
      releaseSource,
    };
  }
  const selected = remote || await loadLocalOrCachedManifest();
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    manifest: selected?.manifest || null,
    localSourceUpdate,
    releaseSource,
  };
}

export function checkForLocalSourceUpdate() {
  return getLocalSourceUpdateStatus().then((localSourceUpdate) => ({
    ok: localSourceUpdate.state !== "invalid",
    checkedAt: new Date().toISOString(),
    localSourceUpdate,
  }));
}

type LocalSourceInstallDependencies = {
  getStatus: typeof getLocalSourceUpdateStatus;
  queue: typeof queueLocalSourceUpdate;
  createBackup: typeof createSystemBackup;
  validateBackup: typeof validateSystemBackup;
  getDeploymentLifecycle?: () => Promise<{ blocksUpdates: boolean; holdUntil?: string | null } | null>;
};

const localSourceInstallDependencies: LocalSourceInstallDependencies = {
  getStatus: getLocalSourceUpdateStatus,
  queue: queueLocalSourceUpdate,
  createBackup: createSystemBackup,
  validateBackup: validateSystemBackup,
  getDeploymentLifecycle: async () => {
    const [local, localLifecycleExpected, runner] = await Promise.all([
      getLocalSourceDeploymentLifecycle(),
      isLocalSourceDeploymentLifecycleExpected(),
      getRunnerStatus(),
    ]);
    return resolveLocalSourceDeploymentLifecycle(local, runner, { localLifecycleExpected });
  },
};

function localSourceInstallException(
  error: unknown,
  operationError: string,
  fallbackMessage: string,
) {
  const source = error as { code?: unknown; message?: unknown; technicalMessage?: unknown } | null;
  const message = typeof source?.message === "string" && source.message.trim()
    ? source.message.trim()
    : fallbackMessage;
  const rawCode = typeof source?.code === "string"
    ? source.code.trim()
    : message.split(":", 1)[0].trim();
  const causeCode = /^[A-Z][A-Z0-9_]{2,127}$/u.test(rawCode)
    ? rawCode
    : "LOCAL_SOURCE_OPERATION_FAILED";
  const technicalMessage = typeof source?.technicalMessage === "string" && source.technicalMessage.trim()
    ? source.technicalMessage.trim()
    : message;
  return {
    ok: false,
    error: operationError,
    causeCode,
    message: fallbackMessage,
    technicalMessage: technicalMessage.replace(/[\r\n\t]+/gu, " ").slice(0, 500),
  };
}

export async function startLocalSourceUpdateInstallation(
  input: { updateId?: string; manifestSha256?: string },
  dependencies: LocalSourceInstallDependencies = localSourceInstallDependencies,
) {
  const current = await dependencies.getStatus();
  const exactTarget = current.updateId === input.updateId
    && current.manifestSha256 === input.manifestSha256;

  // A repeated request is idempotent only for the exact package receipt. A
  // matching ID alone is insufficient because the inbox content may have been
  // replaced while an earlier request is still visible as in progress.
  if (current.state === "in-progress" && exactTarget) {
    try {
      // Reclaim the exact durable monitor grant. This intentionally skips a
      // second backup, but still proves that this browser can confirm or retry
      // the already running request after a reload.
      return await dependencies.queue(input);
    } catch (error) {
      return localSourceInstallException(
        error,
        "LOCAL_SOURCE_UPDATE_QUEUE_FAILED",
        "Der laufende Updateauftrag konnte nicht sicher wieder aufgenommen werden.",
      );
    }
  }
  const deploymentLifecycle = await dependencies.getDeploymentLifecycle?.();
  if (deploymentLifecycle?.blocksUpdates) {
    return {
      ok: false,
      error: "DEPLOYMENT_HOLD_ACTIVE",
      message: `Der vorherige Stand wird bis ${deploymentLifecycle.holdUntil || "zum sicheren Abschluss"} geschützt. Zuerst Hold abschließen.`,
      deploymentLifecycle,
    };
  }
  if (!current.updateAvailable || !["available", "failed"].includes(current.state)) {
    return {
      ok: false,
      error: current.errorCode || "LOCAL_SOURCE_UPDATE_NOT_AVAILABLE",
      message: current.message,
    };
  }
  if (!exactTarget) {
    return {
      ok: false,
      error: "LOCAL_SOURCE_UPDATE_TARGET_CHANGED",
      message: "Das Updatepaket wurde seit der Anzeige verändert.",
    };
  }
  if (!current.runner.available || !current.runner.instanceId) {
    return {
      ok: false,
      error: "LOCAL_SOURCE_SUPERVISOR_NOT_READY",
      message: current.runner.reason,
    };
  }
  if (!current.runner.monitor?.available || !current.runner.monitor.origin) {
    return {
      ok: false,
      error: "LOCAL_SOURCE_INSTALLATION_MONITOR_NOT_READY",
      message: "Der unabhängige Installationsserver ist nicht erreichbar.",
    };
  }

  // The backup receipt itself records the immutable package identity. The
  // subsequent queue call performs a fresh ID+SHA scan and therefore cannot
  // silently switch to a different package after this proof was created.
  const backupReason = `before-local-source-update:${current.updateId}:${current.manifestSha256}`;
  let backup: Awaited<ReturnType<LocalSourceInstallDependencies["createBackup"]>>;
  try {
    backup = await dependencies.createBackup({ reason: backupReason });
  } catch (error) {
    return localSourceInstallException(
      error,
      "LOCAL_SOURCE_BACKUP_FAILED",
      "Die Sicherung vor der lokalen Aktualisierung konnte nicht gestartet werden.",
    );
  }
  if (!backup.ok || !backup.backup) {
    return {
      ok: false,
      error: "LOCAL_SOURCE_BACKUP_FAILED",
      causeCode: backup.causeCode || backup.error,
      message: backup.message || "Die Sicherung vor der lokalen Aktualisierung ist fehlgeschlagen.",
      technicalMessage: backup.technicalMessage,
    };
  }
  let validation: Awaited<ReturnType<LocalSourceInstallDependencies["validateBackup"]>>;
  try {
    validation = await dependencies.validateBackup(backup.backup.id);
  } catch (error) {
    return localSourceInstallException(
      error,
      "LOCAL_SOURCE_BACKUP_INVALID",
      "Die Sicherung vor der lokalen Aktualisierung konnte nicht vollständig geprüft werden.",
    );
  }
  if (
    !validation.ok
    || validation.id !== backup.backup.id
    || validation.backup?.id !== backup.backup.id
    || validation.backup.reason !== backupReason
  ) {
    return {
      ok: false,
      error: "LOCAL_SOURCE_BACKUP_INVALID",
      message: "Die Sicherung vor der lokalen Aktualisierung konnte nicht vollständig geprüft werden.",
    };
  }
  let queued: Awaited<ReturnType<LocalSourceInstallDependencies["queue"]>>;
  try {
    queued = await dependencies.queue(input);
  } catch (error) {
    return localSourceInstallException(
      error,
      "LOCAL_SOURCE_UPDATE_QUEUE_FAILED",
      "Der geprüfte Updateauftrag konnte nicht an den lokalen Update-Dienst übergeben werden.",
    );
  }
  return queued.ok ? { ...queued, backupId: backup.backup.id } : queued;
}

async function beginPreparationInternal(queueInstall: boolean, targetVersion?: string, automaticRevision?: number) {
  if (activePreparation) return { ok: false, error: "UPDATE_ALREADY_RUNNING" };
  const selected = await loadLocalOrCachedManifest();
  if (!selected) return { ok: false, error: "NO_UPDATE_AVAILABLE" };
  if (targetVersion && targetVersion !== selected.manifest.version) return { ok: false, error: "UPDATE_TARGET_MISMATCH" };
  const currentVersion = getSystemRuntimeConfig().version;
  if (compareBonniReleaseVersion(selected.manifest.version, currentVersion) <= 0) return { ok: false, error: "NO_UPDATE_AVAILABLE" };

  const storedWorkflow = await readJson<UpdateWorkflow>(statePath());
  const existingProgress = storedWorkflow
    ? await readJson<RunnerProgress>(runnerProgressPath(storedWorkflow.id)).catch(() => null)
    : null;
  const existing = mergeRunnerProgress(storedWorkflow, existingProgress);
  if (existing?.targetVersion === selected.manifest.version && existing.status === "installing") {
    return { ok: true, accepted: false, existing: true, workflow: existing };
  }
  if (existing?.targetVersion === selected.manifest.version && existing.status === "ready" && existing.artifactPath) {
    if (queueInstall) {
      const runner = await getRunnerStatus();
      const policy = installationPolicy(selected.manifest, runner);
      if (!policy.allowed) return { ok: false, error: "RUNNER_NOT_READY", message: policy.reason };
      await verifyArtifact(selected.manifest, existing.artifactPath);
      existing.automaticRevision = automaticRevision;
      activePreparation = runPreparedInstallation(existing, selected.manifest).finally(() => { activePreparation = null; });
      return { ok: true, accepted: true, workflow: existing };
    }
    return { ok: true, accepted: false, existing: true, workflow: existing };
  }

  if (queueInstall) {
    const runner = await getRunnerStatus();
    const policy = installationPolicy(selected.manifest, runner);
    if (!policy.allowed) return { ok: false, error: "RUNNER_NOT_READY", message: policy.reason };
  }
  const workflow = createWorkflow(currentVersion, selected.manifest);
  workflow.automaticRevision = automaticRevision;
  await saveWorkflow(workflow);
  activePreparation = runPreparation(workflow, selected, queueInstall).finally(() => { activePreparation = null; });
  return { ok: true, accepted: true, workflow };
}

let preparationStarting = false;
async function beginPreparation(queueInstall: boolean, targetVersion?: string, automaticRevision?: number) {
  if (preparationStarting || activePreparation) return {ok:false,error:"UPDATE_ALREADY_RUNNING"};
  preparationStarting = true;
  try { return await beginPreparationInternal(queueInstall, targetVersion, automaticRevision); }
  finally { preparationStarting = false; }
}

export function startCoreUpdatePreparation() {
  return beginPreparation(false);
}

export function startCoreUpdateInstallation(targetVersion?: string) {
  return beginPreparation(true, targetVersion);
}

export async function getCoreUpdateCenterStatus() {
  const currentVersion = getSystemRuntimeConfig().version;
  const [
    selected,
    storedWorkflow,
    settings,
    backup,
    runner,
    localSourceUpdate,
    localDeploymentLifecycle,
    localLifecycleExpected,
  ] = await Promise.all([
    loadLocalOrCachedManifest(),
    readJson<UpdateWorkflow>(statePath()),
    loadSettings(),
    getSystemBackupOverview(),
    getRunnerStatus(),
    getLocalSourceUpdateStatus(),
    getLocalSourceDeploymentLifecycle(),
    isLocalSourceDeploymentLifecycleExpected(),
  ]);
  const manifest = selected?.manifest || null;
  const releaseComparison = manifest ? compareBonniReleaseVersion(manifest.version, currentVersion) : null;
  const releaseAvailable = releaseComparison !== null && releaseComparison > 0;
  const localSourceAvailable = localSourceUpdate.updateAvailable;
  const available = releaseAvailable || localSourceAvailable;
  const compatibility = releaseAvailable && manifest ? await getInstalledModulesCompatibilityForCoreVersion(manifest.version) : null;
  const progress = storedWorkflow ? await readJson<RunnerProgress>(runnerProgressPath(storedWorkflow.id)).catch(() => null) : null;
  const workflow = mergeRunnerProgress(storedWorkflow, progress);
  const releasePolicy = installationPolicy(manifest, runner);
  const localSourceDeploymentLifecycle = resolveLocalSourceDeploymentLifecycle(
    localDeploymentLifecycle,
    runner,
    { localLifecycleExpected },
  );
  const deploymentLifecycle = localSourceAvailable
    ? localSourceDeploymentLifecycle
    : localDeploymentLifecycle || runner.deploymentLifecycle;
  const localSourceBlocked = Boolean(localSourceDeploymentLifecycle?.blocksUpdates);
  const localSourcePolicy = {
    allowed: localSourceAvailable && localSourceUpdate.runner.available && !localSourceBlocked,
    reason: localSourceAvailable
      ? localSourceBlocked
        ? `Der vorherige Stand wird bis ${localSourceDeploymentLifecycle?.holdUntil || "zum sicheren Abschluss"} geschützt. Zuerst Hold abschließen.`
        : localSourceUpdate.runner.available
        ? null
        : localSourceUpdate.runner.reason
      : localSourceUpdate.errorCode
        ? localSourceUpdate.message
        : null,
  };
  const updateKind = localSourceAvailable ? "local-source" : releaseAvailable ? "release" : null;
  const baseReleaseSource = getOfficialCoreReleaseSource();
  const signedReleaseConnected = Boolean(
    manifest?.signature
    && manifest.artifact.source.kind === "https",
  );
  const releaseSource = {
    ...baseReleaseSource,
    signedCatalogConnected: signedReleaseConnected,
    state: signedReleaseConnected ? "signed-release-connected" as const : baseReleaseSource.state,
  };
  const releasePlan = manifest && releaseComparison !== null && releaseComparison >= 0
    ? {
      currentVersion,
      targetVersion: manifest.version,
      batchInstallationSupported: false,
      packages: [{
        packageId: `bonni-core-${manifest.version}`,
        fromVersion: currentVersion,
        toVersion: manifest.version,
        status: releaseComparison === 0
          ? "installed"
          : workflow?.targetVersion === manifest.version
            ? workflow.status
            : "verified",
      }],
    }
    : null;

  return {
    ok: true,
    area: "core-update",
    checkedAt: new Date().toISOString(),
    currentVersion,
    targetVersion: localSourceAvailable
      ? localSourceUpdate.to?.coreVersion || currentVersion
      : releaseAvailable
        ? manifest?.version
        : null,
    updateAvailable: available,
    updateKind,
    manifest: releaseAvailable ? manifest : null,
    localSourceUpdate,
    compatibility,
    installation: localSourceAvailable ? localSourcePolicy : releasePolicy,
    settings,
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workflow,
    backup: { status: backup.status, latest: backup.latest, restoreRequest: backup.restoreRequest },
    runner: localSourceAvailable ? localSourceUpdate.runner : runner,
    releaseRunner: runner,
    deploymentLifecycle,
    releaseSource,
    // Ein verifiziertes Einzelrelease wird exakt dargestellt. Mehrere
    // aufeinanderfolgende Pakete werden erst nach einem eigenen, atomaren
    // Batch-Vertrag ausgegeben und niemals aus Versionsnamen erfunden.
    releasePlan,
  };
}

type SchedulerState = { lastCheckAt?: string; lastAttemptKey?: string; lastResult?: unknown };
async function runAutomaticUpdateCycle() {
  if (automaticCycleRunning || activePreparation || preparationStarting) return;
  const runtime = getSystemRuntimeConfig();
  if (runtime.slotRole !== "active" || runtime.updateProbeMode) return;
  automaticCycleRunning = true;
  try {
    const settings = await loadSettings();
    if (settings.mode === "off") return;
    await finalizeExpiredLocalSourceDeploymentLifecycle();
    const file = path.join(updateCenterRoot(), "scheduler-state.json");
    const state = await readJson<SchedulerState>(file) || {};
    const now = new Date();
    const occurrence = scheduledOccurrence(settings, now, state.lastAttemptKey);
    const interval = Number(process.env.BONNI_UPDATE_CHECK_INTERVAL_MS || 21600000);
    const checkDue = !Number.isFinite(Date.parse(state.lastCheckAt || ""))
      || now.getTime() - Date.parse(state.lastCheckAt!) >= Math.max(900000, Number.isFinite(interval) ? interval : 21600000);
    if (!occurrence && !checkDue) return;
    // Persist the claim before work so a process restart cannot start a second
    // installation in the same local time slot.
    if (occurrence) state.lastAttemptKey = occurrence;
    state.lastCheckAt = now.toISOString();
    await writeJson(file, state);
    await checkForCoreUpdate();
    if (occurrence && automaticInstallAuthorized(await loadSettings(), settings.revision)) {
      state.lastResult = await beginPreparation(true, undefined, settings.revision);
      await writeJson(file, state);
    }
  } catch (error) {
    await writeJson(path.join(updateCenterRoot(), "scheduler-status.json"), {
      ok:false, checkedAt:new Date().toISOString(),error:error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  } finally { automaticCycleRunning = false; }
}

export function startCoreUpdateScheduler() {
  const runtime = getSystemRuntimeConfig();
  if (runtime.slotRole !== "active" || runtime.updateProbeMode) {
    return { started: false, reason: "NOT_ACTIVE_RUNTIME" };
  }
  if (automaticCycleTimer) return { started: false, reason: "ALREADY_STARTED" };
  const intervalMs = 30_000;
  const configuredInitialDelay = Number(process.env.BONNI_UPDATE_INITIAL_CHECK_DELAY_MS || 0);
  const initialDelay = Number.isFinite(configuredInitialDelay) && configuredInitialDelay >= 1_000
    ? configuredInitialDelay
    : 30_000;
  const first = setTimeout(() => void runAutomaticUpdateCycle(), initialDelay);
  first.unref();
  automaticCycleTimer = setInterval(() => void runAutomaticUpdateCycle(), intervalMs);
  automaticCycleTimer.unref();
  return { started: true, intervalMs };
}
