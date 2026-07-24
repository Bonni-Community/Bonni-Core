import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { assertReleaseArchiveTags } from "./archive-tags.mjs";
import { validateImageReference, validateTrustedName, validateUpdateRunnerRequest } from "./contract.mjs";
import { ensureDirectory, readJson, readJsonIfExists, resolveExistingFileInside, writeJsonAtomic, writeTextAtomic } from "./io.mjs";
import {
  closeNetworkTransportGate,
  openNetworkTransportGate,
} from "./network-transport-gate.mjs";
import { verifyBackup, verifySignedRelease } from "./release-verifier.mjs";
import { authenticateUpdateRunnerRequest, verifyUpdateRunnerRequestAuth } from "./request-auth.mjs";
import { verifyCutoverRestoreResult, verifyCutoverSnapshot } from "./snapshot-verifier.mjs";

export const UPDATE_RUNNER_VERSION = "0.2.1";
const SERVICES = Object.freeze({
  databaseCandidate: "db-candidate",
  candidateBootstrap: "candidate-bootstrap",
  candidateMigrator: "candidate-migrator",
  active: "backend-active",
  emergency: "backend-emergency",
  candidate: "backend-candidate",
  proxy: "runtime-proxy",
  productionMigrator: "database-migrator",
  snapshotCreate: "update-snapshot-create",
  snapshotRestore: "update-snapshot-restore",
});
const CANDIDATE_VOLUMES = Object.freeze([
  "candidate_postgres_data",
  "candidate_storage",
  "candidate_run_system",
  "candidate_logs",
]);
const TRANSACTION_FENCE_PHASES = new Set([
  "closing",
  "closed",
  "snapshotting",
  "snapshot-ready",
  "promoting",
  "commit-decided",
  "rollback-restoring",
  "rollback-decided",
  "runtime-releasing",
]);

function nowIso(clock) { return clock().toISOString(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function requestDigest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function nonceDigest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function step(key, label) { return { key, label, status: "pending" }; }

function initialProgress(request, clock) {
  const timestamp = nowIso(clock);
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    workflowId: request.workflowId,
    currentVersion: request.currentVersion,
    targetVersion: request.targetVersion,
    status: "running",
    phase: "accepted",
    message: "Update-Request wurde vom externen Runner übernommen.",
    createdAt: timestamp,
    claimedAt: timestamp,
    updatedAt: timestamp,
    requestDigest: requestDigest(request),
    nonceDigest: nonceDigest(request.nonce),
    flags: {
      releaseVerified: false,
      backupVerified: false,
      rollbackImagePinned: false,
      canonicalActiveRestoredAfterLoad: false,
      artifactLoaded: false,
      candidateResourcesStarted: false,
      candidateHealthy: false,
      writeFenceStarted: false,
      writeFenceActive: false,
      dataSnapshotComplete: false,
      proxyGated: false,
      activePromoteStarted: false,
      productionMigrationComplete: false,
      activeOverlayCommitted: false,
      activePromoted: false,
      dataCommitDecided: false,
      dataRestoreComplete: false,
      rollbackCommitDecided: false,
      proxyReleased: false,
      writeFenceReleased: false,
    },
    rollback: { attempted: false, ok: null, error: null },
    steps: [
      step("candidate", "Candidate-System starten"),
      step("health", "Systemprüfung durchführen"),
      step("switch", "Auf neue Version umschalten"),
    ],
  };
}

function findStep(progress, key) {
  const value = progress.steps.find((entry) => entry.key === key);
  if (!value) throw new Error(`Unbekannter Fortschrittsschritt: ${key}`);
  return value;
}

function healthMatches(status, role, version) {
  return Boolean(
    status?.ok === true
    && status?.state === "ready"
    && status?.runtime?.slotRole === role
    && status?.runtime?.version === version
    && status?.database?.ready === true,
  );
}

function imageReference(release) {
  return `${release.artifact.imageIdentity.repository}@${release.artifact.imageIdentity.digest}`;
}

function imageVersionTag(release) {
  return `${release.artifact.imageIdentity.repository}:${release.version}`;
}

function expectedRollbackImageTag(project) {
  return validateImageReference(`${project}-system:rollback`, "Projektgescopter Rollback-Tag");
}

function assertRollbackTagConfiguration(config) {
  if (!config.project) throw new Error("COMPOSE_PROJECT_NAME fehlt für den Rollback-Scope.");
  const expectedActive = validateImageReference(`${config.project}-system:active`, "Projektgescopter Active-Tag");
  if (config.canonicalActiveImage !== expectedActive) {
    throw new Error(`BONNI_ACTIVE_IMAGE_TAG muss exakt projektgescopt sein: ${expectedActive}`);
  }
  const expected = expectedRollbackImageTag(config.project);
  if (!config.rollbackImageTag || config.rollbackImageTag !== expected) {
    throw new Error(`BONNI_ROLLBACK_IMAGE_TAG muss exakt projektgescopt sein: ${expected}`);
  }
  if (config.rollbackImageTag === config.canonicalActiveImage) {
    throw new Error("Rollback- und Active-Image-Tag müssen verschieden sein.");
  }
}

function trustedKeyCount(keys) {
  if (keys instanceof Map) return keys.size;
  return keys && typeof keys === "object" ? Object.keys(keys).length : 0;
}

export function createUpdateRunnerConfig(env = process.env) {
  const projectRoot = path.resolve(env.BONNI_HOST_PROJECT_ROOT || "/project");
  const configuredUpdateRoot = env.BONNI_UPDATE_STORAGE_ROOT ? path.resolve(env.BONNI_UPDATE_STORAGE_ROOT) : null;
  const storageRoot = path.resolve(
    env.BONNI_STORAGE_ROOT
      || (configuredUpdateRoot ? path.join(configuredUpdateRoot, "..", "..") : path.join(projectRoot, "runtime", "storage")),
  );
  const updateCenterRoot = configuredUpdateRoot || path.join(storageRoot, "system", "update-center");
  const ipcRoot = path.resolve(
    env.BONNI_UPDATE_RUNNER_STATE_ROOT
      || env.BONNI_RUNNER_STATE_ROOT
      || path.join(storageRoot, "system", "update-runner"),
  );
  const expectedNetworkTransportGatePath = path.join(ipcRoot, "network-transport-gate.json");
  const networkTransportGatePath = path.resolve(
    env.BONNI_NETWORK_TRANSPORT_GATE_FILE || expectedNetworkTransportGatePath,
  );
  if (networkTransportGatePath !== expectedNetworkTransportGatePath) {
    throw new Error("BONNI_NETWORK_TRANSPORT_GATE_FILE muss im gemeinsamen Runner-IPC liegen.");
  }
  const privateRoot = path.resolve(
    env.BONNI_UPDATE_RUNNER_PRIVATE_STATE_ROOT
      || path.join(projectRoot, "runtime", "update-runner-private"),
  );
  const runtimeEnvironmentPath = env.BONNI_RUNTIME_ENV_FILE
    ? path.resolve(env.BONNI_RUNTIME_ENV_FILE)
    : null;
  const activeEnvironmentPath = path.resolve(
    env.BONNI_ACTIVE_RELEASE_ENV_FILE
      || path.join(privateRoot, "active-release.env"),
  );
  const expectedTransactionFencePath = path.join(path.dirname(activeEnvironmentPath), "update-transaction-fence.json");
  const transactionFencePath = path.resolve(
    env.BONNI_UPDATE_TRANSACTION_FENCE_FILE || expectedTransactionFencePath,
  );
  if (transactionFencePath !== expectedTransactionFencePath) {
    throw new Error("BONNI_UPDATE_TRANSACTION_FENCE_FILE muss neben dem privaten Active-Overlay liegen.");
  }
  const rollbackSnapshotRoot = path.resolve(
    env.BONNI_UPDATE_ROLLBACK_SNAPSHOT_ROOT || path.join(privateRoot, "rollback-snapshots"),
  );
  const rollbackResultRoot = path.resolve(
    env.BONNI_UPDATE_ROLLBACK_RESULT_ROOT || path.join(privateRoot, "rollback-results"),
  );
  for (const forbidden of [storageRoot, updateCenterRoot, ipcRoot]) {
    for (const controlledRoot of [rollbackSnapshotRoot, rollbackResultRoot]) {
      const relative = path.relative(forbidden, controlledRoot);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        throw new Error("Rollback-Snapshot und -Ergebnisse müssen außerhalb des Produktions-/IPC-Speichers liegen.");
      }
    }
  }
  if (rollbackResultRoot === rollbackSnapshotRoot) {
    throw new Error("Snapshot- und Restore-Ergebniswurzel müssen getrennt sein.");
  }
  const composeFile = path.join(projectRoot, "System", "backend", "docker-compose.runtime.yml");
  const project = env.COMPOSE_PROJECT_NAME ? validateTrustedName(env.COMPOSE_PROJECT_NAME, "COMPOSE_PROJECT_NAME") : null;
  const canonicalActiveImage = validateImageReference(
    env.BONNI_ACTIVE_IMAGE_TAG || (project ? `${project}-system:active` : ""),
    "BONNI_ACTIVE_IMAGE_TAG",
  );
  const rollbackImageTag = env.BONNI_ROLLBACK_IMAGE_TAG
    ? validateImageReference(env.BONNI_ROLLBACK_IMAGE_TAG, "BONNI_ROLLBACK_IMAGE_TAG")
    : null;
  return {
    projectRoot,
    storageRoot,
    updateCenterRoot,
    runnerRoot: ipcRoot,
    ipcRoot,
    privateRoot,
    requestsRoot: path.join(ipcRoot, "requests"),
    progressRoot: path.join(ipcRoot, "progress"),
    resultsRoot: path.join(ipcRoot, "results"),
    heartbeatPath: path.join(ipcRoot, "heartbeat.json"),
    networkTransportGatePath,
    claimedRoot: path.join(privateRoot, "claimed"),
    journalRoot: path.join(privateRoot, "journal"),
    nonceRoot: path.join(privateRoot, "nonces"),
    stagingRoot: path.join(privateRoot, "staging"),
    runtimeEnvironmentPath,
    activeEnvironmentPath,
    transactionFencePath,
    rollbackSnapshotRoot,
    rollbackResultRoot,
    lockPath: path.join(privateRoot, "runner.lock"),
    composeFile,
    canonicalActiveImage,
    rollbackImageTag,
    project,
    hostname: env.HOSTNAME || null,
    runnerVersion: env.BONNI_UPDATE_RUNNER_VERSION || UPDATE_RUNNER_VERSION,
    bootRecovery: env.BONNI_UPDATE_BOOT_RECOVERY === "true",
    healthAttempts: Math.max(3, Number(env.BONNI_UPDATE_HEALTH_ATTEMPTS || 30)),
    healthRequiredSuccesses: 3,
    healthIntervalMs: Math.max(0, Number(env.BONNI_UPDATE_HEALTH_INTERVAL_MS || 2_000)),
    composeWaitSeconds: Math.max(30, Number(env.BONNI_UPDATE_COMPOSE_WAIT_SECONDS || 180)),
    staleLockMs: Math.max(60_000, Number(env.BONNI_UPDATE_RUNNER_STALE_LOCK_MS || 45 * 60_000)),
  };
}

export class UpdateRunner {
  constructor({ config, docker, trustedKeys, requestSecret, clock = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.config = config;
    this.docker = docker;
    this.trustedKeys = trustedKeys;
    this.trustedKeyCount = trustedKeyCount(trustedKeys);
    this.requestSecret = requestSecret;
    this.clock = clock;
    this.sleep = sleep;
    this.lockHandle = null;
    this.lockToken = null;
    this.currentRequestId = null;
    this.lastHeartbeat = { status: "idle", message: "Update-Runner ist bereit." };
  }

  async initialize() {
    assertRollbackTagConfiguration(this.config);
    await Promise.all([
      ensureDirectory(this.config.requestsRoot),
      ensureDirectory(this.config.progressRoot),
      ensureDirectory(this.config.resultsRoot),
      ensureDirectory(this.config.claimedRoot),
      ensureDirectory(this.config.journalRoot),
      ensureDirectory(this.config.nonceRoot),
      ensureDirectory(this.config.stagingRoot),
    ]);
    const activeEnvironmentExists = await fs.lstat(this.config.activeEnvironmentPath)
      .then((stat) => stat.isFile() && !stat.isSymbolicLink())
      .catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
    if (!activeEnvironmentExists) {
      await fs.writeFile(
        this.config.activeEnvironmentPath,
        "# Vom Bonni-Update-Runner verwaltetes Active-Overlay.\n",
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
    const activeEnvironmentStat = await fs.lstat(this.config.activeEnvironmentPath);
    if (!activeEnvironmentStat.isFile() || activeEnvironmentStat.isSymbolicLink() || (activeEnvironmentStat.mode & 0o077) !== 0) {
      throw new Error("Private Active-Overlay-Umgebungsdatei ist nicht sicher.");
    }
    await this.heartbeat("idle", "Update-Runner ist bereit.");
  }

  async closeNetworkTransport(_reason = "update-cutover") {
    await closeNetworkTransportGate(this.config.networkTransportGatePath);
  }

  async openNetworkTransport(reason = "runtime-confirmed") {
    const fencePresent = await fs.lstat(this.config.transactionFencePath)
      .then(() => true)
      .catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
    if (fencePresent) throw new Error("NETWORK_TRANSPORT_GATE_TRANSACTION_FENCE_PRESENT");
    await openNetworkTransportGate(this.config.networkTransportGatePath, {
      clock: this.clock,
      reason,
      runnerVersion: this.config.runnerVersion,
    });
  }

  async heartbeat(status, message) {
    const configured = this.trustedKeyCount > 0;
    const effectiveStatus = configured ? status : "unconfigured";
    const effectiveMessage = configured
      ? message
      : "Kein Release-Vertrauensschlüssel konfiguriert; Installationen sind gesperrt.";
    this.lastHeartbeat = { status: effectiveStatus, message: effectiveMessage };
    await writeJsonAtomic(this.config.heartbeatPath, {
      schemaVersion: 1,
      available: configured,
      runnerVersion: this.config.runnerVersion,
      version: this.config.runnerVersion,
      status: effectiveStatus,
      state: effectiveStatus,
      trustedKeyCount: this.trustedKeyCount,
      project: this.config.project,
      requestId: this.currentRequestId,
      message: effectiveMessage,
      updatedAt: nowIso(this.clock),
    });
    if (this.lockHandle) await this.lockHandle.utimes(this.clock(), this.clock()).catch(() => undefined);
  }

  async acquireLock() {
    await ensureDirectory(path.dirname(this.config.lockPath));
    for (let attempt = 0; attempt < 4 && !this.lockHandle; attempt += 1) {
      try {
        this.lockHandle = await fs.open(this.config.lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let stat;
        try { stat = await fs.stat(this.config.lockPath); } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (this.config.bootRecovery) {
          const running = await this.docker.runningServiceContainers(["update-runner"]);
          const own = String(this.config.hostname || "");
          const others = running.filter((container) => !(own && (container.startsWith(own) || own.startsWith(container))));
          if (others.length) return false;
        } else if (this.clock().getTime() - stat.mtimeMs <= this.config.staleLockMs) return false;
        const stale = `${this.config.lockPath}.stale-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        try { await fs.rename(this.config.lockPath, stale); } catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw renameError;
        }
      }
    }
    if (!this.lockHandle) return false;
    this.lockToken = crypto.randomBytes(24).toString("base64url");
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken, acquiredAt: nowIso(this.clock) }));
    return true;
  }

  async releaseLock() {
    if (!this.lockHandle) return;
    const token = this.lockToken;
    await this.lockHandle.close().catch(() => undefined);
    this.lockHandle = null;
    this.lockToken = null;
    const owner = await readJsonIfExists(this.config.lockPath).catch(() => null);
    if (owner?.token === token) await fs.unlink(this.config.lockPath).catch(() => undefined);
  }

  progressPath(requestId) { return path.join(this.config.progressRoot, `${requestId}.json`); }
  journalPath(requestId) { return path.join(this.config.journalRoot, `${requestId}.json`); }
  claimedPath(requestId) { return path.join(this.config.claimedRoot, `${requestId}.request.json`); }
  resultPath(requestId) { return path.join(this.config.resultsRoot, `${requestId}.json`); }

  async saveProgress(progress, phase, message) {
    progress.phase = phase;
    progress.message = message;
    progress.updatedAt = nowIso(this.clock);
    await writeJsonAtomic(this.journalPath(progress.requestId), progress);
    await writeJsonAtomic(this.progressPath(progress.workflowId), progress);
    await this.heartbeat("busy", message);
  }

  async stepStatus(progress, key, status, detail) {
    const current = findStep(progress, key);
    current.status = status;
    if (status === "running" && !current.startedAt) current.startedAt = nowIso(this.clock);
    if (["completed", "failed", "waiting"].includes(status)) current.finishedAt = nowIso(this.clock);
    if (detail) current.detail = detail;
    await this.saveProgress(progress, progress.phase, progress.message);
  }

  async claimedRequests() {
    const names = (await fs.readdir(this.config.claimedRoot)).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}\.request\.json$/.test(name)).sort();
    return names;
  }

  async claimNextRequest() {
    const claimed = await this.claimedRequests();
    if (claimed.length) {
      const marker = await readJsonIfExists(this.config.transactionFencePath).catch(() => null);
      const preferred = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(String(marker?.requestId || ""))
        ? `${marker.requestId}.request.json`
        : null;
      return path.join(this.config.claimedRoot, preferred && claimed.includes(preferred) ? preferred : claimed[0]);
    }
    const names = (await fs.readdir(this.config.requestsRoot)).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp")).sort();
    for (const name of names) {
      const queuedPath = path.join(this.config.requestsRoot, name);
      let request;
      let authenticatedRequest;
      try {
        const raw = await readJson(queuedPath);
        authenticatedRequest = authenticateUpdateRunnerRequest(raw, this.requestSecret, { now: this.clock(), allowExpired: true });
        if (`${authenticatedRequest.requestId}.json` !== name) throw new Error("Request-Dateiname und requestId stimmen nicht überein.");
        const nonceFile = path.join(this.config.nonceRoot, `nonce-${nonceDigest(authenticatedRequest.nonce)}.used`);
        const nonceHandle = await fs.open(nonceFile, "wx", 0o600).catch((error) => {
          if (error?.code === "EEXIST") throw new Error("NONCE_REPLAY_DETECTED");
          throw error;
        });
        await nonceHandle.writeFile(`${authenticatedRequest.requestId}\n`);
        await nonceHandle.close();
        request = validateUpdateRunnerRequest(authenticatedRequest, { now: this.clock() });
        const claimedPath = this.claimedPath(request.requestId);
        await fs.copyFile(queuedPath, claimedPath, fsConstants.COPYFILE_EXCL);
        const claimedRequest = await readJson(claimedPath);
        if (requestDigest(claimedRequest) !== requestDigest(await readJson(queuedPath))) {
          await fs.unlink(claimedPath).catch(() => undefined);
          throw new Error("Request änderte sich während der atomaren Übernahme.");
        }
        await fs.unlink(queuedPath);
        const progress = initialProgress(request, this.clock);
        await writeJsonAtomic(this.journalPath(request.requestId), progress);
        await writeJsonAtomic(this.progressPath(request.workflowId), progress);
        return claimedPath;
      } catch (error) {
        if (authenticatedRequest) {
          const failed = {
            schemaVersion: 1,
            requestId: authenticatedRequest.requestId,
            workflowId: authenticatedRequest.workflowId,
            currentVersion: authenticatedRequest.currentVersion,
            targetVersion: authenticatedRequest.targetVersion,
            status: "failed",
            phase: "rejected",
            message: `Update-Request abgelehnt: ${errorMessage(error)}`,
            error: errorMessage(error),
            createdAt: nowIso(this.clock),
            updatedAt: nowIso(this.clock),
            steps: [
              { key: "candidate", label: "Candidate-System starten", status: "failed", detail: errorMessage(error) },
              { key: "health", label: "Systemprüfung durchführen", status: "pending" },
              { key: "switch", label: "Auf neue Version umschalten", status: "pending" },
            ],
          };
          await writeJsonAtomic(this.progressPath(authenticatedRequest.workflowId), failed);
          await writeJsonAtomic(this.resultPath(authenticatedRequest.requestId), { ...failed, finishedAt: nowIso(this.clock) });
          await fs.unlink(queuedPath).catch(() => undefined);
          continue;
        }
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
        const rejectedId = `rejected-${crypto.createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
        await writeJsonAtomic(this.resultPath(rejectedId), {
          schemaVersion: 1, requestId: rejectedId, status: "rejected", sourceFile: safeName,
          message: errorMessage(error), finishedAt: nowIso(this.clock),
        });
        await fs.unlink(queuedPath).catch(() => undefined);
      }
    }
    return null;
  }

  async recoverMissingJournal(claimedFile, rawRequest) {
    const stat = await fs.stat(claimedFile);
    const claimedAt = new Date(stat.mtimeMs);
    const request = verifyUpdateRunnerRequestAuth(rawRequest, this.requestSecret, { now: claimedAt });
    const progress = initialProgress(request, () => claimedAt);
    progress.message = "Privates Runner-Journal wurde aus dem authentifizierten Claim wiederhergestellt.";
    await writeJsonAtomic(this.journalPath(request.requestId), progress);
    await writeJsonAtomic(this.progressPath(request.workflowId), progress);
    return progress;
  }

  async waitForHealth(probe, role, version, label) {
    let consecutive = 0;
    let lastError = "Keine Antwort";
    for (let attempt = 1; attempt <= this.config.healthAttempts; attempt += 1) {
      try {
        const status = await probe();
        if (healthMatches(status, role, version)) {
          consecutive += 1;
          if (consecutive >= this.config.healthRequiredSuccesses) return status;
        } else {
          consecutive = 0;
          lastError = `${label}: Rolle, Version, Datenbank oder Status stimmt nicht.`;
        }
      } catch (error) {
        consecutive = 0;
        lastError = errorMessage(error);
      }
      if (attempt < this.config.healthAttempts) await this.sleep(this.config.healthIntervalMs);
    }
    throw new Error(`${label} wurde nicht dreimal fehlerfrei bestätigt: ${lastError}`);
  }

  async waitForRoleHealth(probe, role, label) {
    let consecutive = 0;
    let lastError = "Keine Antwort";
    for (let attempt = 1; attempt <= this.config.healthAttempts; attempt += 1) {
      try {
        const status = await probe();
        if (status?.ok === true
          && status?.state === "ready"
          && status?.runtime?.slotRole === role
          && status?.database?.ready === true) {
          consecutive += 1;
          if (consecutive >= this.config.healthRequiredSuccesses) return status;
        } else {
          consecutive = 0;
          lastError = `${label}: Rolle, Datenbank oder Status stimmt nicht.`;
        }
      } catch (error) {
        consecutive = 0;
        lastError = errorMessage(error);
      }
      if (attempt < this.config.healthAttempts) await this.sleep(this.config.healthIntervalMs);
    }
    throw new Error(`${label} wurde nicht dreimal fehlerfrei bestätigt: ${lastError}`);
  }

  async stageArtifact(request, sourcePath) {
    const finalPath = path.join(this.config.stagingRoot, `${request.requestId}.oci`);
    const temporary = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.copyFile(sourcePath, temporary, fsConstants.COPYFILE_EXCL);
      await fs.chmod(temporary, 0o600);
      await verifySignedRelease({
        release: request.release,
        artifactPath: temporary,
        trustedKeys: this.trustedKeys,
        runnerVersion: this.config.runnerVersion,
        now: this.clock(),
      });
      await fs.rename(temporary, finalPath);
      return finalPath;
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async pinRollbackImage(progress) {
    if (!/^sha256:[a-f0-9]{64}$/.test(progress.oldImageId || "")) {
      throw new Error("Alte Image-ID für den projektgescopten Rollback-Pin fehlt.");
    }
    await this.docker.tagImage(progress.oldImageId, this.config.rollbackImageTag);
    const pinnedImageId = await this.docker.imageId(this.config.rollbackImageTag);
    if (pinnedImageId !== progress.oldImageId) throw new Error("ROLLBACK_IMAGE_PIN_ID_MISMATCH");
    progress.flags.rollbackImagePinned = true;
    progress.rollbackPin = {
      tag: this.config.rollbackImageTag,
      imageId: progress.oldImageId,
      retention: "until-next-update",
      retained: true,
      pinnedAt: progress.rollbackPin?.pinnedAt || nowIso(this.clock),
    };
    await this.saveProgress(
      progress,
      "rollback-image-pinned",
      "Bisheriges Active-Image ist unter dem projektgescopten Rollback-Tag fixiert.",
    );
  }

  async restoreCanonicalActiveToRollback(progress, phase = "active-tag-restored") {
    await this.pinRollbackImage(progress);
    await this.docker.tagImage(this.config.rollbackImageTag, this.config.canonicalActiveImage);
    const activeImageId = await this.docker.imageId(this.config.canonicalActiveImage);
    if (activeImageId !== progress.oldImageId) throw new Error("CANONICAL_ACTIVE_TAG_RESTORE_MISMATCH");
    progress.flags.canonicalActiveRestoredAfterLoad = true;
    await this.saveProgress(
      progress,
      phase,
      "Kanonischer Active-Tag zeigt nach der Archivprüfung wieder auf das bisherige Image.",
    );
  }

  async verifyArchiveTags(request, archivePath, progress) {
    const tags = await this.docker.archiveImageTags(archivePath);
    assertReleaseArchiveTags(
      { repository: request.release.artifact.imageIdentity.repository, version: request.targetVersion },
      tags,
      { forbiddenTags: [this.config.canonicalActiveImage, this.config.rollbackImageTag] },
    );
    progress.archiveTags = [...tags];
    await this.saveProgress(
      progress,
      "archive-tags-verified",
      "Docker-Archiv enthält keine Active-, Rollback- oder unerwarteten Image-Tags.",
    );
  }

  async persistActiveRelease(request, imageId, version = request.targetVersion) {
    const activeEnvironment = `SYSTEM_IMAGE=${this.config.canonicalActiveImage}\nSYSTEM_VERSION=${version}\n`;
    await writeTextAtomic(this.config.activeEnvironmentPath, activeEnvironment);
  }

  snapshotEnvironment(request) {
    return {
      BONNI_UPDATE_SNAPSHOT_ID: request.requestId,
      BONNI_UPDATE_SNAPSHOT_WORKFLOW_ID: request.workflowId,
      BONNI_UPDATE_SNAPSHOT_BACKUP_ID: request.backupId,
      BONNI_UPDATE_SNAPSHOT_CURRENT_VERSION: request.currentVersion,
    };
  }

  snapshotVerificationOptions(request) {
    return {
      snapshotBase: this.config.rollbackSnapshotRoot,
      snapshotId: request.requestId,
      workflowId: request.workflowId,
      backupId: request.backupId,
      currentVersion: request.currentVersion,
    };
  }

  async readTransactionFence(request, { required = false } = {}) {
    let stat;
    try {
      stat = await fs.lstat(this.config.transactionFencePath);
    } catch (error) {
      if (error?.code === "ENOENT" && !required) return null;
      if (error?.code === "ENOENT") throw new Error("UPDATE_TRANSACTION_FENCE_MISSING");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024) {
      throw new Error("UPDATE_TRANSACTION_FENCE_INVALID");
    }
    const fence = await readJson(this.config.transactionFencePath);
    const allowed = new Set([
      "schemaVersion", "requestId", "workflowId", "currentVersion", "targetVersion",
      "snapshotId", "phase", "decision", "createdAt", "updatedAt",
    ]);
    if (!fence || typeof fence !== "object" || Array.isArray(fence)
      || Object.keys(fence).some((key) => !allowed.has(key))
      || fence.schemaVersion !== 1
      || fence.requestId !== request.requestId
      || fence.workflowId !== request.workflowId
      || fence.currentVersion !== request.currentVersion
      || fence.targetVersion !== request.targetVersion
      || fence.snapshotId !== request.requestId
      || !TRANSACTION_FENCE_PHASES.has(fence.phase)
      || ![null, "target", "rollback"].includes(fence.decision)
      || !Number.isFinite(Date.parse(fence.createdAt))
      || !Number.isFinite(Date.parse(fence.updatedAt))) {
      throw new Error("UPDATE_TRANSACTION_FENCE_INVALID");
    }
    return fence;
  }

  async writeTransactionFence(request, phase) {
    if (!TRANSACTION_FENCE_PHASES.has(phase)) throw new Error("UPDATE_TRANSACTION_FENCE_PHASE_INVALID");
    const existing = await this.readTransactionFence(request).catch((error) => {
      if (error?.message === "UPDATE_TRANSACTION_FENCE_MISSING") return null;
      throw error;
    });
    const timestamp = nowIso(this.clock);
    const requestedDecision = phase === "commit-decided"
      ? "target"
      : phase === "rollback-decided" ? "rollback" : null;
    if (requestedDecision && existing?.decision && existing.decision !== requestedDecision) {
      throw new Error("UPDATE_TRANSACTION_FENCE_DECISION_CONFLICT");
    }
    const decision = requestedDecision || existing?.decision || null;
    if (phase === "runtime-releasing" && !decision) throw new Error("UPDATE_TRANSACTION_FENCE_DECISION_MISSING");
    await writeJsonAtomic(this.config.transactionFencePath, {
      schemaVersion: 1,
      requestId: request.requestId,
      workflowId: request.workflowId,
      currentVersion: request.currentVersion,
      targetVersion: request.targetVersion,
      snapshotId: request.requestId,
      phase,
      decision,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
  }

  async reconcileTransactionDecision(request, progress) {
    const fence = await this.readTransactionFence(request);
    if (!fence) return null;
    if (fence.decision === "target") {
      if (progress.flags.rollbackCommitDecided) throw new Error("UPDATE_TRANSACTION_DECISION_CONFLICT");
      if (!progress.flags.dataCommitDecided) {
        progress.flags.dataCommitDecided = true;
        await this.saveProgress(progress, "commit-decision-recovered", "Ziel-Commit wurde aus dem dauerhaften Transaktionszaun wiederhergestellt.");
      }
    } else if (fence.decision === "rollback") {
      if (progress.flags.dataCommitDecided) throw new Error("UPDATE_TRANSACTION_DECISION_CONFLICT");
      if (!progress.flags.rollbackCommitDecided) {
        progress.flags.rollbackCommitDecided = true;
        await this.saveProgress(progress, "rollback-decision-recovered", "Rollback-Commit wurde aus dem dauerhaften Transaktionszaun wiederhergestellt.");
      }
    } else if (progress.flags.dataCommitDecided || progress.flags.rollbackCommitDecided) {
      throw new Error("UPDATE_TRANSACTION_DECISION_MISSING_FROM_FENCE");
    }
    return fence;
  }

  async removeTransactionFence(request, progress) {
    const existing = await this.readTransactionFence(request);
    progress.flags.writeFenceReleased = true;
    await this.saveProgress(progress, "fence-release-ready", "Transaktionsentscheidung ist dauerhaft; der Startzaun darf entfernt werden.");
    if (existing) {
      await fs.unlink(this.config.transactionFencePath);
      const directory = await fs.open(path.dirname(this.config.transactionFencePath), "r");
      await directory.sync();
      await directory.close();
    }
  }

  async assertProductionWritersStopped() {
    const services = [
      SERVICES.proxy,
      SERVICES.active,
      SERVICES.emergency,
      SERVICES.productionMigrator,
      SERVICES.snapshotCreate,
      SERVICES.snapshotRestore,
    ];
    const running = await this.docker.runningServiceContainers(services);
    if (running.length) throw new Error(`UPDATE_WRITE_FENCE_NOT_CLOSED:${running.join(",")}`);
  }

  async stopProductionServices() {
    await this.closeNetworkTransport("production-services-stopping");
    await this.docker.compose(["stop", SERVICES.proxy], { timeoutMs: 120_000 });
    await this.docker.compose([
      "stop", SERVICES.active, SERVICES.emergency,
    ], { timeoutMs: 120_000 });
    await this.docker.compose([
      "--profile", "update", "stop",
      SERVICES.productionMigrator, SERVICES.snapshotCreate, SERVICES.snapshotRestore,
    ], { timeoutMs: 120_000 });
    await this.docker.stopRunningServiceContainers([
      SERVICES.proxy, SERVICES.active, SERVICES.emergency,
      SERVICES.productionMigrator, SERVICES.snapshotCreate, SERVICES.snapshotRestore,
    ]);
    await this.assertProductionWritersStopped();
  }

  async closeProductionWriters(request, progress) {
    await this.closeNetworkTransport("update-write-fence");
    if (!progress.flags.writeFenceStarted) {
      progress.flags.writeFenceStarted = true;
      await this.saveProgress(progress, "fence-intent", "Persistenter Schreibzaun wird vor jeder Produktionsunterbrechung aktiviert.");
    }
    await this.reconcileTransactionDecision(request, progress);
    const phase = progress.flags.dataCommitDecided
      ? "commit-decided"
      : progress.flags.rollbackCommitDecided ? "rollback-decided" : "closing";
    await this.writeTransactionFence(request, phase);
    await this.docker.compose(["stop", SERVICES.proxy], { timeoutMs: 120_000 });
    progress.flags.proxyGated = true;
    progress.flags.proxyReleased = false;
    await this.saveProgress(progress, "proxy-stopped", "Öffentlicher Proxy ist für den atomaren Cutover geschlossen.");
    await this.docker.compose(["stop", SERVICES.active, SERVICES.emergency], { timeoutMs: 120_000 });
    await this.docker.compose([
      "--profile", "update", "stop", SERVICES.productionMigrator, SERVICES.snapshotCreate, SERVICES.snapshotRestore,
    ], { timeoutMs: 120_000 });
    await this.docker.stopRunningServiceContainers([
      SERVICES.proxy, SERVICES.active, SERVICES.emergency,
      SERVICES.productionMigrator, SERVICES.snapshotCreate, SERVICES.snapshotRestore,
    ]);
    await this.assertProductionWritersStopped();
    progress.flags.writeFenceActive = true;
    await this.writeTransactionFence(request, phase === "closing" ? "closed" : phase);
    await this.saveProgress(progress, "write-fence-closed", "Proxy, Active, Emergency und alle Produktionsschreiber sind nachweislich gestoppt.");
  }

  async createCutoverDataSnapshot(request, progress) {
    await this.readTransactionFence(request, { required: true });
    await this.assertProductionWritersStopped();
    await this.writeTransactionFence(request, "snapshotting");
    await this.saveProgress(progress, "cutover-snapshot", "Konsistenter Cutover-Snapshot von PostgreSQL, Storage und Run-System wird erstellt.");
    await this.docker.compose([
      "--profile", "update", "run", "--rm", "--no-deps", SERVICES.snapshotCreate,
    ], { env: this.snapshotEnvironment(request), timeoutMs: 60 * 60_000 });
    const verified = await verifyCutoverSnapshot(this.snapshotVerificationOptions(request));
    progress.cutoverSnapshot = {
      id: request.requestId,
      manifestSha256: verified.manifestSha256,
      verifiedAt: nowIso(this.clock),
    };
    progress.flags.dataSnapshotComplete = true;
    await this.writeTransactionFence(request, "snapshot-ready");
    await this.saveProgress(progress, "cutover-snapshot-ready", "Finaler Produktionssnapshot wurde unabhängig geprüft und versiegelt.");
  }

  async restoreCutoverDataSnapshot(request, progress) {
    if (!progress.flags.dataSnapshotComplete || !progress.cutoverSnapshot?.manifestSha256) {
      throw new Error("CUTOVER_SNAPSHOT_NOT_COMMITTED_IN_JOURNAL");
    }
    await this.readTransactionFence(request, { required: true });
    await this.assertProductionWritersStopped();
    const before = await verifyCutoverSnapshot(this.snapshotVerificationOptions(request));
    if (before.manifestSha256 !== progress.cutoverSnapshot.manifestSha256) {
      throw new Error("CUTOVER_SNAPSHOT_JOURNAL_HASH_MISMATCH");
    }
    if (!progress.restoreAttemptId) {
      progress.restoreAttemptId = `restore-${crypto.randomBytes(24).toString("hex")}`;
      await this.saveProgress(progress, "restore-attempt-committed", "Eindeutiger Restore-Versuch wurde vor dem Schreibzugriff dauerhaft festgelegt.");
    }
    await this.writeTransactionFence(request, "rollback-restoring");
    await this.saveProgress(progress, "data-restore", "PostgreSQL, Storage und Run-System werden unter geschlossenem Schreibzaun wiederhergestellt.");
    await this.docker.compose([
      "--profile", "update", "run", "--rm", "--no-deps", SERVICES.snapshotRestore,
    ], {
      env: {
        ...this.snapshotEnvironment(request),
        BONNI_UPDATE_RESTORE_ATTEMPT_ID: progress.restoreAttemptId,
      },
      timeoutMs: 60 * 60_000,
    });
    const restored = await verifyCutoverRestoreResult({
      ...this.snapshotVerificationOptions(request),
      resultBase: this.config.rollbackResultRoot,
      restoreAttemptId: progress.restoreAttemptId,
    });
    if (restored.manifestSha256 !== progress.cutoverSnapshot.manifestSha256) {
      throw new Error("CUTOVER_RESTORE_JOURNAL_HASH_MISMATCH");
    }
    progress.flags.dataRestoreComplete = true;
    progress.cutoverRestore = {
      snapshotId: request.requestId,
      manifestSha256: restored.manifestSha256,
      verifiedAt: nowIso(this.clock),
    };
    await this.saveProgress(progress, "data-restored", "Alle drei Produktionsdatenebenen wurden vollständig wiederhergestellt und geprüft.");
  }

  async startCanonicalActive(version) {
    await this.docker.compose([
      "up", "-d", "--no-deps", "--force-recreate", "--no-build", SERVICES.active,
    ], { env: { SYSTEM_IMAGE: this.config.canonicalActiveImage, SYSTEM_VERSION: version } });
  }

  async startEmergency() {
    await this.docker.compose([
      "up", "-d", "--wait", "--wait-timeout", String(this.config.composeWaitSeconds),
      "--no-deps", "--force-recreate", "--no-build", SERVICES.emergency,
    ]);
    await this.waitForRoleHealth(
      () => this.docker.health(SERVICES.emergency),
      "emergency",
      "Emergency direkt",
    );
  }

  async releaseRuntimeAfterDecision(request, progress, version) {
    await this.writeTransactionFence(request, "runtime-releasing");
    await this.startEmergency();
    await this.routeProxyToActive(progress, version);
    await this.removeTransactionFence(request, progress);
    if (!this.config.bootRecovery) {
      await this.openNetworkTransport("update-runtime-confirmed");
    }
  }

  async routeProxyToEmergency(progress) {
    await this.docker.compose([
      "up", "-d", "--no-deps", "--force-recreate", SERVICES.proxy,
    ], {
      env: {
        ACTIVE_BACKEND: SERVICES.emergency,
        ACTIVE_BACKEND_PORT: "4000",
        EMERGENCY_BACKEND: SERVICES.emergency,
        EMERGENCY_BACKEND_PORT: "4000",
      },
    });
    await this.waitForRoleHealth(
      () => this.docker.proxyHealth(SERVICES.emergency, "emergency"),
      "emergency",
      "Emergency über Proxy",
    );
    progress.flags.proxyGated = true;
    progress.flags.proxyReleased = false;
    await this.saveProgress(progress, "proxy-gated", "Öffentlicher Proxy wurde vor der Active-Mutation auf Emergency festgelegt.");
  }

  async routeProxyToActive(progress, version) {
    await this.docker.compose([
      "up", "-d", "--no-deps", "--force-recreate", SERVICES.proxy,
    ], {
      env: {
        ACTIVE_BACKEND: SERVICES.active,
        ACTIVE_BACKEND_PORT: "4000",
        EMERGENCY_BACKEND: SERVICES.emergency,
        EMERGENCY_BACKEND_PORT: "4000",
      },
    });
    await this.waitForHealth(
      () => this.docker.proxyHealth(SERVICES.active, "active"),
      "active",
      version,
      "Active über Proxy",
    );
    progress.flags.proxyReleased = true;
    await this.saveProgress(progress, "proxy-released", "Öffentlicher Proxy liefert den bestätigten Active aus.");
  }

  async commitActiveOverlay(request, progress, imageId, version) {
    await this.persistActiveRelease(request, imageId, version);
    progress.flags.activeOverlayCommitted = true;
    progress.activeOverlay = { imageId, version, committedAt: nowIso(this.clock) };
    await this.saveProgress(
      progress,
      "active-overlay-committed",
      `Persistenter Active-Start wurde vor dem Containerstart auf ${version} festgelegt.`,
    );
  }

  composeEnvironment(request) {
    return {
      CANDIDATE_SYSTEM_IMAGE: imageVersionTag(request.release),
      CANDIDATE_SYSTEM_VERSION: request.targetVersion,
      BONNI_UPDATE_BACKUP_ID: request.backupId,
    };
  }

  async stopCandidate(request) {
    const errors = [];
    await this.docker.compose([
      "--profile", "update", "stop", SERVICES.candidate, SERVICES.databaseCandidate,
    ], { env: this.composeEnvironment(request), timeoutMs: 120_000 }).catch((error) => errors.push(errorMessage(error)));
    await this.docker.compose([
      "--profile", "update", "rm", "-f", "-s",
      SERVICES.candidate, SERVICES.databaseCandidate, SERVICES.candidateBootstrap, SERVICES.candidateMigrator,
    ], { env: this.composeEnvironment(request), timeoutMs: 120_000 }).catch((error) => errors.push(errorMessage(error)));
    for (const logicalName of CANDIDATE_VOLUMES) {
      const volume = `${this.config.project}_${logicalName}`;
      await this.docker.removeDisposableVolume(volume, this.config.project, logicalName)
        .catch((error) => errors.push(errorMessage(error)));
    }
    return { ok: errors.length === 0, errors };
  }

  async finishRecoveredPromotion(request, progress) {
    if (!progress.flags.activePromoteStarted) return false;
    await this.closeProductionWriters(request, progress);
    await this.reconcileTransactionDecision(request, progress);
    if (!progress.flags.dataCommitDecided) {
      await this.rollback(request, progress, new Error("Unterbrochener Cutover wird vor der dauerhaften Commit-Grenze zurückgerollt."));
      return true;
    }
    if (!progress.flags.candidateHealthy || !/^sha256:[a-f0-9]{64}$/.test(progress.newImageId || "")) {
      throw new Error("COMMITTED_TARGET_RECOVERY_JOURNAL_INVALID");
    }
    await this.pinRollbackImage(progress);
    await this.docker.tagImage(progress.newImageId, this.config.canonicalActiveImage);
    if (await this.docker.imageId(this.config.canonicalActiveImage) !== progress.newImageId) {
      throw new Error("RECOVERED_ACTIVE_TAG_ID_MISMATCH");
    }
    await this.commitActiveOverlay(request, progress, progress.newImageId, request.targetVersion);
    await this.startCanonicalActive(request.targetVersion);
    await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.targetVersion, "Wiederaufgenommener Active");
    progress.flags.activePromoted = true;
    await this.saveProgress(progress, "active-healthy", "Dauerhaft entschiedener Active ist nach Wiederanlauf vollständig bestätigt.");
    await this.releaseRuntimeAfterDecision(request, progress, request.targetVersion);
    if (progress.flags.candidateResourcesStarted) progress.cleanup = await this.stopCandidate(request);
    progress.status = "completed";
    await this.stepStatus(progress, "candidate", "completed", "Candidate war vor dem Wiederanlauf geprüft.");
    await this.stepStatus(progress, "health", "completed", "Zielversion nach dem Wiederanlauf bestätigt.");
    await this.stepStatus(progress, "switch", "completed", "Dauerhaft entschiedene Promotion sicher abgeschlossen.");
    await this.saveProgress(progress, "completed", `Bonni Core ${request.targetVersion} wurde nach Wiederanlauf erfolgreich bestätigt.`);
    return true;
  }

  async rollback(request, progress, originalError) {
    progress.rollback.attempted = true;
    progress.status = "rolling-back";
    await this.saveProgress(progress, "rollback", `Rückkehr auf ${request.currentVersion} wird durchgeführt.`);
    try {
      if (progress.flags.dataCommitDecided) throw new Error("ROLLBACK_AFTER_TARGET_COMMIT_FORBIDDEN");
      await this.closeProductionWriters(request, progress);
      if (!progress.oldImageId) throw new Error("Alte Image-ID für Rollback fehlt.");
      if (progress.flags.activePromoteStarted && !progress.flags.rollbackCommitDecided) {
        await this.restoreCutoverDataSnapshot(request, progress);
      }
      await this.pinRollbackImage(progress);
      await this.docker.tagImage(this.config.rollbackImageTag, this.config.canonicalActiveImage);
      if (await this.docker.imageId(this.config.canonicalActiveImage) !== progress.oldImageId) {
        throw new Error("ROLLBACK_CANONICAL_ACTIVE_TAG_MISMATCH");
      }
      await this.commitActiveOverlay(request, progress, progress.oldImageId, request.currentVersion);
      if (!progress.flags.rollbackCommitDecided) {
        await this.writeTransactionFence(request, "rollback-decided");
        progress.flags.rollbackCommitDecided = true;
        await this.saveProgress(progress, "rollback-decided", "Wiederhergestellter Altstand wurde als dauerhafte Transaktionsentscheidung festgelegt.");
      }
      await this.startCanonicalActive(request.currentVersion);
      await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.currentVersion, "Rollback-Active");
      await this.releaseRuntimeAfterDecision(request, progress, request.currentVersion);
      progress.rollback.ok = true;
      progress.status = "rolled-back";
      progress.error = errorMessage(originalError);
      await this.stepStatus(progress, "switch", "failed", progress.error);
      await this.saveProgress(progress, "rolled-back", `Update zurückgerollt: ${progress.error}`);
    } catch (rollbackError) {
      if (progress.flags.rollbackCommitDecided && progress.flags.writeFenceReleased) {
        progress.rollback.ok = true;
        progress.rollback.error = null;
        progress.status = "rolled-back";
        progress.error = errorMessage(originalError);
        progress.cleanup = { warning: `Rollback war bereits freigegeben; Abschlussfehler: ${errorMessage(rollbackError)}` };
        await this.saveProgress(progress, "rolled-back-with-cleanup-warning", "Altstand läuft; nur eine nachgelagerte Abschlussarbeit ist fehlgeschlagen.");
      } else {
        progress.rollback.ok = false;
        progress.rollback.error = errorMessage(rollbackError);
        progress.status = "failed";
        progress.error = `${errorMessage(originalError)}; Rollback fehlgeschlagen: ${progress.rollback.error}`;
        await this.saveProgress(progress, "rollback-failed", progress.error);
      }
    }
    progress.cleanup = { ...(progress.cleanup || {}), ...await this.stopCandidate(request) };
    await this.saveProgress(progress, progress.phase, progress.message);
  }

  async executeRequest(rawRequest, existingProgress = null) {
    const claimedAt = existingProgress?.claimedAt ? new Date(existingProgress.claimedAt) : this.clock();
    if (!Number.isFinite(claimedAt.getTime())) throw new Error("Runner-Journal enthält keine gültige claimedAt-Zeit.");
    const request = verifyUpdateRunnerRequestAuth(rawRequest, this.requestSecret, {
      now: claimedAt,
      futureToleranceMs: 5 * 60_000,
    });
    const digest = requestDigest(request);
    const progress = existingProgress || initialProgress(request, this.clock);
    if (progress.requestDigest !== digest) throw new Error("Verarbeiteter Update-Request wurde nachträglich verändert.");
    this.currentRequestId = request.requestId;
    await this.saveProgress(progress, progress.phase || "accepted", progress.message || "Update wird verarbeitet.");

    try {
      const fencePresent = await fs.lstat(this.config.transactionFencePath)
        .then(() => true)
        .catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
      if (fencePresent) {
        // Even a corrupt or foreign marker closes traffic before parsing. Its
        // mere presence means no application writer may remain reachable.
        await this.stopProductionServices();
        progress.flags.proxyGated = true;
        progress.flags.proxyReleased = false;
        progress.flags.writeFenceActive = true;
        await this.saveProgress(progress, "fence-recovery-closed", "Vorhandener Transaktionszaun hat alle Produktionsschreiber geschlossen.");
        await this.reconcileTransactionDecision(request, progress);
      } else if (progress.flags.writeFenceStarted) {
        await this.closeProductionWriters(request, progress);
      }
      if (!progress.flags.activePromoteStarted && (fencePresent || progress.flags.writeFenceStarted)) {
        await this.rollback(request, progress, new Error("Unterbrochener Cutover vor der ersten Produktionsmutation wird sicher abgebrochen."));
        return progress;
      }
      const artifact = await resolveExistingFileInside(this.config.updateCenterRoot, request.artifactRelativePath);
      await verifySignedRelease({
        release: request.release,
        artifactPath: artifact.path,
        trustedKeys: this.trustedKeys,
        runnerVersion: this.config.runnerVersion,
        now: this.clock(),
      });
      if (request.release.artifact.type !== "oci-image-archive") {
        throw new Error("BONNI_RELEASE_BUNDLE_NOT_SUPPORTED_BY_RUNNER");
      }
      progress.flags.releaseVerified = true;
      await this.saveProgress(progress, "release-verified", "Release-Signatur und Artefakt wurden erneut geprüft.");

      await verifyBackup({ storageRoot: this.config.storageRoot, backupId: request.backupId });
      progress.flags.backupVerified = true;
      await this.saveProgress(progress, "backup-verified", "Rückkehrpunkt wurde unmittelbar vor dem Update geprüft.");

      if (!progress.oldImageId && !progress.flags.activePromoteStarted) {
        const activeContainer = await this.docker.serviceContainer(SERVICES.active);
        progress.oldImageId = await this.docker.containerImageId(activeContainer);
        await this.saveProgress(progress, "active-snapshotted", "Aktive Image-ID für Rollback wurde gesichert.");
      }
      if (progress.flags.activePromoteStarted && !progress.oldImageId) {
        throw new Error("Privates Recovery-Journal enthält keine alte Image-ID.");
      }

      if (progress.oldImageId) {
        await this.pinRollbackImage(progress);
        if (!progress.flags.activePromoteStarted) {
          await this.restoreCanonicalActiveToRollback(progress, "preflight-active-tag-restored");
        }
      }
      if (!progress.flags.activePromoteStarted) {
        // In boot mode the old container is intentionally stopped. Restore its
        // pinned canonical tag first; only then may that already-confirmed
        // version be recreated for the ordinary preflight health check.
        if (this.config.bootRecovery) await this.startCanonicalActive(request.currentVersion);
        await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.currentVersion, "Bisheriger Active");
        await this.saveProgress(progress, "current-active-verified", "Laufender Active entspricht exakt der Request-Ausgangsversion.");
      }
      if (await this.finishRecoveredPromotion(request, progress)) return progress;

      const stagedArtifactPath = await this.stageArtifact(request, artifact.path);
      progress.stagedArtifactPath = stagedArtifactPath;
      await this.saveProgress(progress, "artifact-staged", "Geprüftes Artefakt wurde in den exklusiven Runner-Speicher kopiert.");
      await this.verifyArchiveTags(request, stagedArtifactPath, progress);
      await this.restoreCanonicalActiveToRollback(progress, "preload-active-tag-verified");
      progress.flags.canonicalActiveRestoredAfterLoad = false;
      await this.saveProgress(progress, "artifact-loading", "Geprüftes Docker-Archiv wird geladen; Active bleibt am Rollback-Pin verankert.");
      try {
        await this.docker.loadImage(stagedArtifactPath);
        progress.flags.artifactLoaded = true;
      } finally {
        await this.restoreCanonicalActiveToRollback(progress, "postload-active-tag-restored");
      }
      const signedReference = imageReference(request.release);
      const loaded = await this.docker.imageIdentity(imageVersionTag(request.release));
      const expected = request.release.artifact.imageIdentity;
      if ((loaded.repoDigests.length > 0 && !loaded.repoDigests.includes(signedReference))
        || loaded.os !== expected.platform.os
        || loaded.architecture !== expected.platform.architecture
        || (loaded.variant || null) !== (expected.platform.variant || null)) {
        throw new Error("RELEASE_IMAGE_IDENTITY_MISMATCH");
      }
      progress.newImageId = loaded.id;
      await this.saveProgress(progress, "loaded-image-verified", "Geladenes Image entspricht Digest und Plattform des signierten Releases.");
      await this.stepStatus(progress, "candidate", "running", "Isolierte Candidate-Datenbank und -Dateien werden vorbereitet.");
      await this.saveProgress(progress, "candidate-database", "Isolierte Candidate-Datenbank wird gestartet.");
      const candidateEnv = this.composeEnvironment(request);
      progress.flags.candidateResourcesStarted = true;
      await this.saveProgress(progress, "candidate-resources-starting", "Disposable Candidate-Ressourcen werden angelegt.");
      await this.docker.compose([
        "--profile", "update", "up", "-d", "--wait", "--wait-timeout", String(this.config.composeWaitSeconds), SERVICES.databaseCandidate,
      ], { env: candidateEnv });
      await this.saveProgress(progress, "candidate-database-ready", "Isolierte Candidate-Datenbank ist bereit.");
      await this.docker.compose([
        "--profile", "update", "run", "--rm", "--no-deps", SERVICES.candidateBootstrap,
      ], { env: candidateEnv });
      await this.docker.compose([
        "--profile", "update", "run", "--rm", "--no-deps", SERVICES.candidateMigrator,
      ], { env: candidateEnv });
      await this.docker.compose([
        "--profile", "update", "up", "-d", "--no-deps", "--force-recreate", "--no-build", SERVICES.candidate,
      ], { env: candidateEnv });
      await this.stepStatus(progress, "candidate", "completed", "Candidate nutzt eine eigene Datenbank und ein eigenes Storage-Volume.");

      await this.stepStatus(progress, "health", "running", "Candidate muss dreimal vollständig bereit sein.");
      await this.saveProgress(progress, "candidate-health", "Candidate wird dreifach geprüft.");
      await this.waitForHealth(
        () => this.docker.health(SERVICES.candidate, "http://127.0.0.1:4000/api/health/update-probe"),
        "candidate",
        request.targetVersion,
        "Candidate",
      );
      progress.flags.candidateHealthy = true;
      await this.stepStatus(progress, "health", "completed", "Rolle, Zielversion und Datenbank dreimal bestätigt.");

      await this.closeProductionWriters(request, progress);
      await this.createCutoverDataSnapshot(request, progress);
      await this.stepStatus(progress, "switch", "running", "Produktionsdaten sind versiegelt; Migration und Active-Wechsel erfolgen ohne erreichbaren Schreiber.");
      progress.flags.activePromoteStarted = true;
      await this.saveProgress(progress, "production-mutation-intent", "Produktionsmutation wurde vor Migration und Containerstart dauerhaft im Journal markiert.");
      await this.writeTransactionFence(request, "promoting");
      if (request.release.migration.required) {
        await this.docker.compose([
          "--profile", "update", "run", "--rm", "--no-deps", SERVICES.productionMigrator,
        ], { env: candidateEnv, timeoutMs: 30 * 60_000 });
        progress.flags.productionMigrationComplete = true;
        await this.saveProgress(progress, "production-migrated", "Getestete, rückwärtskompatible Produktionsmigration wurde unter geschlossenem Schreibzaun ausgeführt.");
      }
      await this.saveProgress(progress, "promote-active", "Signiertes Image wird auf den kanonischen Active-Tag übernommen.");
      await this.docker.tagImage(progress.newImageId, this.config.canonicalActiveImage);
      if (await this.docker.imageId(this.config.canonicalActiveImage) !== progress.newImageId) {
        throw new Error("PROMOTED_ACTIVE_TAG_ID_MISMATCH");
      }
      await this.commitActiveOverlay(request, progress, progress.newImageId, request.targetVersion);
      await this.startCanonicalActive(request.targetVersion);
      await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.targetVersion, "Neuer Active");
      progress.flags.activePromoted = true;
      await this.saveProgress(progress, "active-healthy", "Neuer Active ist vollständig bereit.");

      await this.writeTransactionFence(request, "commit-decided");
      progress.flags.dataCommitDecided = true;
      await this.saveProgress(progress, "commit-decided", "Gesunder Zielstand wurde als dauerhafte Commit-Entscheidung festgelegt.");
      await this.releaseRuntimeAfterDecision(request, progress, request.targetVersion);
      progress.cleanup = await this.stopCandidate(request);
      progress.status = "completed";
      await this.stepStatus(progress, "switch", "completed", "Kanonischer Active und Proxy liefern die Zielversion aus.");
      await this.saveProgress(progress, "completed", `Bonni Core ${request.targetVersion} wurde erfolgreich installiert.`);
      return progress;
    } catch (error) {
      const activeStep = progress.steps.find((entry) => entry.status === "running");
      if (activeStep && activeStep.key !== "switch") await this.stepStatus(progress, activeStep.key, "failed", errorMessage(error));
      await this.reconcileTransactionDecision(request, progress).catch(() => undefined);
      if (progress.flags.dataCommitDecided) {
        if (progress.flags.writeFenceReleased) {
          progress.status = "completed";
          progress.cleanup = {
            ...(progress.cleanup || {}),
            warning: `Commit war bereits freigegeben; nachgelagerter Abschlussfehler: ${errorMessage(error)}`,
          };
          await this.saveProgress(progress, "completed-with-cleanup-warning", "Zielstand läuft; nur eine nachgelagerte Abschlussarbeit ist fehlgeschlagen.");
        } else {
          await this.stopProductionServices().catch(() => undefined);
          progress.status = "failed";
          progress.error = `${errorMessage(error)}; Ziel-Commit ist dauerhaft und darf nicht auf alte Daten zurückgesetzt werden.`;
          await this.saveProgress(progress, "committed-recovery-failed", progress.error);
        }
      } else if (progress.flags.activePromoteStarted || progress.flags.writeFenceStarted) {
        await this.rollback(request, progress, error);
      } else {
        let failure = errorMessage(error);
        if (progress.flags.rollbackImagePinned) {
          try {
            await this.restoreCanonicalActiveToRollback(progress, "failed-active-tag-restored");
          } catch (restoreError) {
            failure = `${failure}; Active-Tag-Wiederherstellung fehlgeschlagen: ${errorMessage(restoreError)}`;
          }
        }
        if (progress.flags.candidateResourcesStarted) progress.cleanup = await this.stopCandidate(request);
        progress.status = "failed";
        progress.error = failure;
        await this.saveProgress(progress, "failed", `Update angehalten: ${progress.error}`);
      }
      return progress;
    }
  }

  async quarantineClaimedFile(claimedFile, rawRequest, error) {
    const fromName = path.basename(claimedFile).replace(/\.request\.json$/, "");
    const requestId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(String(rawRequest?.requestId || ""))
      ? rawRequest.requestId
      : fromName;
    const workflowId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(String(rawRequest?.workflowId || ""))
      ? rawRequest.workflowId
      : requestId;
    const message = `Privater Claim wurde sicher quarantänisiert: ${errorMessage(error)}`;
    const failed = {
      schemaVersion: 1,
      requestId,
      workflowId,
      status: "failed",
      phase: "claim-quarantined",
      message,
      error: errorMessage(error),
      updatedAt: nowIso(this.clock),
      steps: [
        { key: "candidate", label: "Candidate-System starten", status: "failed", detail: errorMessage(error) },
        { key: "health", label: "Systemprüfung durchführen", status: "pending" },
        { key: "switch", label: "Auf neue Version umschalten", status: "pending" },
      ],
    };
    await writeJsonAtomic(this.journalPath(requestId), failed);
    await writeJsonAtomic(this.progressPath(workflowId), failed);
    await writeJsonAtomic(this.resultPath(requestId), { ...failed, finishedAt: nowIso(this.clock) });
    await fs.rename(claimedFile, `${claimedFile}.failed-${Date.now()}`).catch(() => fs.unlink(claimedFile).catch(() => undefined));
    await this.heartbeat("error", message);
    return { ok: false, processed: true, result: failed };
  }

  async processNext() {
    await this.initialize();
    if (!await this.acquireLock()) return { ok: false, busy: true };
    const heartbeatTimer = setInterval(() => {
      void this.heartbeat(this.lastHeartbeat.status, this.lastHeartbeat.message).catch(() => undefined);
    }, 5_000);
    heartbeatTimer.unref();
    try {
      const claimedFile = await this.claimNextRequest();
      if (!claimedFile) {
        await this.heartbeat("idle", "Keine Update-Anfrage wartet.");
        return { ok: true, processed: false };
      }
      let rawRequest;
      let requestId;
      let progress;
      try {
        rawRequest = await readJson(claimedFile);
        requestId = rawRequest.requestId;
        progress = await readJsonIfExists(this.journalPath(requestId));
        if (!progress) progress = await this.recoverMissingJournal(claimedFile, rawRequest);
      } catch (error) {
        return this.quarantineClaimedFile(claimedFile, rawRequest, error);
      }
      let final;
      try {
        final = await this.executeRequest(rawRequest, progress);
      } catch (error) {
        final = {
          ...progress,
          status: "failed",
          phase: "runner-failed",
          error: errorMessage(error),
          message: `Runner konnte den authentifizierten Claim nicht fortsetzen: ${errorMessage(error)}`,
          updatedAt: nowIso(this.clock),
        };
        await writeJsonAtomic(this.journalPath(requestId), final);
        await writeJsonAtomic(this.progressPath(rawRequest.workflowId), final);
      }
      await writeJsonAtomic(this.resultPath(requestId), {
        schemaVersion: 1,
        requestId,
        workflowId: rawRequest.workflowId,
        status: final.status,
        currentVersion: rawRequest.currentVersion,
        targetVersion: rawRequest.targetVersion,
        message: final.message,
        error: final.error || null,
        rollback: final.rollback,
        cleanup: final.cleanup || null,
        steps: final.steps,
        finishedAt: nowIso(this.clock),
      });
      const fenceRemaining = await fs.lstat(this.config.transactionFencePath)
        .then(() => true)
        .catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
      const transactionResolved = !fenceRemaining
        && (!final.flags?.writeFenceStarted || final.flags?.writeFenceReleased === true);
      if (transactionResolved) {
        await fs.unlink(claimedFile).catch(() => undefined);
        await fs.unlink(path.join(this.config.requestsRoot, `${requestId}.json`)).catch(() => undefined);
        if (final.stagedArtifactPath) await fs.unlink(final.stagedArtifactPath).catch(() => undefined);
      }
      this.currentRequestId = null;
      await this.heartbeat(final.status === "completed" ? "idle" : "error", final.message);
      return { ok: final.status === "completed", processed: true, result: final };
    } finally {
      clearInterval(heartbeatTimer);
      await this.releaseLock();
    }
  }
}
