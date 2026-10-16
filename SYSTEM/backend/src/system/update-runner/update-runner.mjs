import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { assertReleaseArchiveTags } from "./archive-tags.mjs";
import { bonniReleaseImageTag, validateImageReference, validateTrustedName, validateUpdateRunnerRequest } from "./contract.mjs";
import { ensureDirectory, readJson, readJsonIfExists, resolveExistingFileInside, writeJsonAtomic, writeTextAtomic } from "./io.mjs";
import {
  closeNetworkTransportGate,
  openNetworkTransportGate,
} from "./network-transport-gate.mjs";
import { verifyBackup, verifySignedRelease } from "./release-verifier.mjs";
import { authenticateUpdateRunnerRequest, verifyUpdateRunnerRequestAuth } from "./request-auth.mjs";
import { verifyCutoverRestoreResult, verifyCutoverSnapshot } from "./snapshot-verifier.mjs";
import {
  DEPLOYMENT_LIFECYCLE_PROTOCOL,
  verifyLifecycleCommand,
} from "./lifecycle-contract.mjs";
import { readDockerRuntimeDeactivationIntent } from "../../../scripts/runtime/runtime-mode-exclusion.mjs";

export const UPDATE_RUNNER_VERSION = "0.5.0";
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
  snapshotCleanup: "update-snapshot-cleanup",
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
const MAX_HOLD_CLOCK_STEP_MS = 6 * 60 * 60_000;
const MAX_HOLD_CLOCK_BACKWARD_MS = 5 * 60_000;

function nowIso(clock) { return clock().toISOString(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function requestDigest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function nonceDigest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    || (!reverse.startsWith("..") && !path.isAbsolute(reverse));
}

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
      rollbackSnapshotCleanupComplete: false,
      rollbackLifecycleClosed: false,
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
  return `${release.artifact.imageIdentity.repository}:${bonniReleaseImageTag(release.version)}`;
}

function expectedRollbackImageTag(project) {
  return validateImageReference(`${project}-system:rollback`, "Projektgescopter Rollback-Tag");
}

function expectedEmergencyImageTag(project) {
  return validateImageReference(`${project}-system:emergency`, "Projektgescopter Emergency-Tag");
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
  const expectedEmergency = expectedEmergencyImageTag(config.project);
  if (config.emergencyImageTag !== expectedEmergency) {
    throw new Error(`BONNI_EMERGENCY_IMAGE_TAG muss exakt projektgescopt sein: ${expectedEmergency}`);
  }
  if ([config.canonicalActiveImage, config.rollbackImageTag].includes(config.emergencyImageTag)) {
    throw new Error("Active-, Rollback- und Emergency-Image-Tags müssen verschieden sein.");
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
  for (const sharedRoot of [storageRoot, updateCenterRoot, ipcRoot]) {
    if (pathsOverlap(privateRoot, sharedRoot)) {
      throw new Error("Privater Runner-State muss vollständig von Produktions-Storage und IPC getrennt sein.");
    }
  }
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
  const composeFile = path.join(projectRoot, "SYSTEM", "backend", "docker-compose.runtime.yml");
  const project = env.COMPOSE_PROJECT_NAME ? validateTrustedName(env.COMPOSE_PROJECT_NAME, "COMPOSE_PROJECT_NAME") : null;
  const canonicalActiveImage = validateImageReference(
    env.BONNI_ACTIVE_IMAGE_TAG || (project ? `${project}-system:active` : ""),
    "BONNI_ACTIVE_IMAGE_TAG",
  );
  const rollbackImageTag = env.BONNI_ROLLBACK_IMAGE_TAG
    ? validateImageReference(env.BONNI_ROLLBACK_IMAGE_TAG, "BONNI_ROLLBACK_IMAGE_TAG")
    : null;
  const emergencyImageTag = validateImageReference(
    env.BONNI_EMERGENCY_IMAGE_TAG || (project ? `${project}-system:emergency` : ""),
    "BONNI_EMERGENCY_IMAGE_TAG",
  );
  const configuredHoldDays = Number(env.SYSTEM_EMERGENCY_HOLD_DAYS || 14);
  if (configuredHoldDays !== 14) {
    throw new Error("SYSTEM_EMERGENCY_HOLD_DAYS muss für diesen Vertrag exakt 14 sein.");
  }
  return {
    projectRoot,
    storageRoot,
    updateCenterRoot,
    runnerRoot: ipcRoot,
    ipcRoot,
    privateRoot,
    requestsRoot: path.join(ipcRoot, "requests"),
    lifecycleRequestsRoot: path.join(ipcRoot, "requests", "lifecycle"),
    progressRoot: path.join(ipcRoot, "progress"),
    resultsRoot: path.join(ipcRoot, "results"),
    lifecycleStatusPath: path.join(ipcRoot, "deployment-lifecycle.json"),
    heartbeatPath: path.join(ipcRoot, "heartbeat.json"),
    networkTransportGatePath,
    claimedRoot: path.join(privateRoot, "claimed"),
    journalRoot: path.join(privateRoot, "journal"),
    nonceRoot: path.join(privateRoot, "nonces"),
    stagingRoot: path.join(privateRoot, "staging"),
    lifecycleStatePath: path.join(privateRoot, "deployment-lifecycle.json"),
    runtimeEnvironmentPath,
    activeEnvironmentPath,
    transactionFencePath,
    rollbackSnapshotRoot,
    rollbackResultRoot,
    lockPath: path.join(privateRoot, "runner.lock"),
    composeFile,
    canonicalActiveImage,
    rollbackImageTag,
    emergencyImageTag,
    emergencyHoldDays: configuredHoldDays,
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
  constructor({
    config,
    docker,
    trustedKeys,
    requestSecret,
    clock = () => new Date(),
    monotonicClock = () => performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.config = config;
    this.rawDocker = docker;
    this.activeDockerAbortControllers = new Set();
    this.docker = new Proxy(docker, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args) => {
          const guarded = Boolean(this.lockToken || this.lockLeaseError);
          if (guarded) await this.assertLockOwnership();
          const abortController = guarded ? new AbortController() : null;
          if (abortController) {
            this.activeDockerAbortControllers.add(abortController);
            target.setLeaseAbortSignal?.(abortController.signal);
          }
          try {
            const result = await Reflect.apply(value, target, args);
            if (guarded) await this.assertLockOwnership();
            return result;
          } catch (error) {
            if (guarded) await this.assertLockOwnership();
            throw error;
          } finally {
            if (abortController) {
              this.activeDockerAbortControllers.delete(abortController);
              target.setLeaseAbortSignal?.(null);
            }
          }
        };
      },
    });
    this.trustedKeys = trustedKeys;
    this.trustedKeyCount = trustedKeyCount(trustedKeys);
    this.requestSecret = requestSecret;
    this.clock = clock;
    this.monotonicClock = monotonicClock;
    this.lifecycleObservationMonotonic = new Map();
    this.sleep = sleep;
    this.lockHandle = null;
    this.lockToken = null;
    this.lockLeaseError = null;
    this.currentRequestId = null;
    this.lastHeartbeat = { status: "idle", message: "Update-Runner ist bereit." };
  }

  async initialize() {
    assertRollbackTagConfiguration(this.config);
    await Promise.all([
      ensureDirectory(this.config.storageRoot),
      ensureDirectory(this.config.updateCenterRoot),
      ensureDirectory(this.config.ipcRoot),
      ensureDirectory(this.config.privateRoot),
      ensureDirectory(this.config.requestsRoot),
      ensureDirectory(this.config.lifecycleRequestsRoot),
      ensureDirectory(this.config.progressRoot),
      ensureDirectory(this.config.resultsRoot),
      ensureDirectory(this.config.claimedRoot),
      ensureDirectory(this.config.journalRoot),
      ensureDirectory(this.config.nonceRoot),
      ensureDirectory(this.config.stagingRoot),
    ]);
    const trustedRoots = await Promise.all([
      this.config.storageRoot,
      this.config.updateCenterRoot,
      this.config.ipcRoot,
      this.config.privateRoot,
    ].map(async (root) => {
      const direct = await fs.lstat(root);
      if (!direct.isDirectory() || direct.isSymbolicLink()) {
        throw new Error("Runner-State-Wurzeln müssen echte Verzeichnisse sein.");
      }
      const real = await fs.realpath(root);
      const stat = await fs.stat(real);
      return { root, real, dev: String(stat.dev), ino: String(stat.ino) };
    }));
    const privateState = trustedRoots.at(-1);
    for (const shared of trustedRoots.slice(0, -1)) {
      if (pathsOverlap(privateState.real, shared.real)
        || (privateState.dev === shared.dev && privateState.ino === shared.ino)) {
        throw new Error("Privater Runner-State ist real nicht von Produktions-Storage und IPC getrennt.");
      }
    }
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
    await this.publishDeploymentLifecycle();
    await this.heartbeat("idle", "Update-Runner ist bereit.");
  }

  async readDeploymentLifecycle() {
    const lifecycle = await readJsonIfExists(this.config.lifecycleStatePath);
    if (!lifecycle) return null;
    const allowed = [
      "protocol", "schemaVersion", "generation", "state", "holdId", "workflowId",
      "previousVersion", "targetVersion", "previousImageId", "targetImageId",
      "rollbackImageTag", "emergencyImageTag", "holdDays", "activatedAt", "holdUntil",
      "observedHoldMs", "lastObservedAt", "clockAnomalyAt", "clockAnomalyCode",
      "finalizeReason", "finalizeRequestedAt", "finalizedAt", "updatedAt", "mode",
    ];
    const unknown = Object.keys(lifecycle).filter((key) => !allowed.includes(key));
    const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
    const imageId = /^sha256:[a-f0-9]{64}$/;
    const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
    if (unknown.length
      || lifecycle.protocol !== DEPLOYMENT_LIFECYCLE_PROTOCOL
      || lifecycle.schemaVersion !== 1
      || !Number.isSafeInteger(lifecycle.generation) || lifecycle.generation <= 0
      || !["holding", "finalizing", "finalized"].includes(lifecycle.state)
      || !identifier.test(String(lifecycle.holdId || ""))
      || !identifier.test(String(lifecycle.workflowId || ""))
      || !imageId.test(String(lifecycle.previousImageId || ""))
      || !imageId.test(String(lifecycle.targetImageId || ""))
      || lifecycle.rollbackImageTag !== this.config.rollbackImageTag
      || lifecycle.emergencyImageTag !== this.config.emergencyImageTag
      || lifecycle.holdDays !== 14
      || lifecycle.mode !== "single-active-fail-closed-hold"
      || !timestamp(lifecycle.activatedAt) || !timestamp(lifecycle.holdUntil) || !timestamp(lifecycle.updatedAt)
      || Date.parse(lifecycle.holdUntil) - Date.parse(lifecycle.activatedAt) !== 14 * 24 * 60 * 60_000
      || !Number.isSafeInteger(lifecycle.observedHoldMs) || lifecycle.observedHoldMs < 0
      || lifecycle.observedHoldMs > 14 * 24 * 60 * 60_000
      || !timestamp(lifecycle.lastObservedAt)
      || Date.parse(lifecycle.lastObservedAt) < Date.parse(lifecycle.activatedAt) - MAX_HOLD_CLOCK_BACKWARD_MS
      || (lifecycle.clockAnomalyAt !== null && !timestamp(lifecycle.clockAnomalyAt))
      || ![null, "CLOCK_FORWARD_JUMP", "CLOCK_BACKWARD_JUMP"].includes(lifecycle.clockAnomalyCode)
      || ((lifecycle.clockAnomalyAt === null) !== (lifecycle.clockAnomalyCode === null))
      || (lifecycle.finalizeRequestedAt !== null && !timestamp(lifecycle.finalizeRequestedAt))
      || (lifecycle.finalizedAt !== null && !timestamp(lifecycle.finalizedAt))) {
      throw new Error("DEPLOYMENT_LIFECYCLE_STATE_INVALID");
    }
    return lifecycle;
  }

  async writeDeploymentLifecycle(lifecycle) {
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
    lifecycle.updatedAt = nowIso(this.clock);
    await writeJsonAtomic(this.config.lifecycleStatePath, lifecycle);
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
    await this.publishDeploymentLifecycle(lifecycle);
    return lifecycle;
  }

  async publishDeploymentLifecycle(input = undefined) {
    const lifecycle = input === undefined ? await this.readDeploymentLifecycle() : input;
    const status = lifecycle ? {
      protocol: DEPLOYMENT_LIFECYCLE_PROTOCOL,
      schemaVersion: 1,
      generation: lifecycle.generation,
      state: lifecycle.state,
      holdId: lifecycle.holdId,
      workflowId: lifecycle.workflowId,
      previousVersion: lifecycle.previousVersion,
      targetVersion: lifecycle.targetVersion,
      holdDays: lifecycle.holdDays,
      activatedAt: lifecycle.activatedAt,
      holdUntil: lifecycle.holdUntil,
      observedHoldMs: lifecycle.observedHoldMs,
      autoFinalizeBlocked: lifecycle.clockAnomalyCode !== null,
      blockReason: lifecycle.clockAnomalyCode
        ? "Automatischer Abschluss ist wegen einer unplausiblen Systemzeit gesperrt. Ein Administrator kann den Hold nach Prüfung signiert abschließen."
        : null,
      finalizeReason: lifecycle.finalizeReason,
      finalizeRequestedAt: lifecycle.finalizeRequestedAt,
      finalizedAt: lifecycle.finalizedAt,
      blocksUpdates: lifecycle.state !== "finalized",
      canFinalize: lifecycle.state === "holding",
      mode: lifecycle.mode,
      updatedAt: lifecycle.updatedAt,
    } : {
      protocol: DEPLOYMENT_LIFECYCLE_PROTOCOL,
      schemaVersion: 1,
      generation: 0,
      state: "idle",
      blocksUpdates: false,
      canFinalize: false,
      observedHoldMs: 0,
      autoFinalizeBlocked: false,
      blockReason: null,
      mode: "single-active-fail-closed-hold",
      updatedAt: nowIso(this.clock),
    };
    await writeJsonAtomic(this.config.lifecycleStatusPath, status);
    return status;
  }

  async createDeploymentHold(request, progress) {
    const current = await this.readDeploymentLifecycle();
    if (current && current.state !== "finalized") {
      if (current.holdId === request.requestId
        && current.targetImageId === progress.newImageId
        && current.targetVersion === request.targetVersion) return current;
      throw new Error(`UPDATE_HOLD_ACTIVE:${current.holdId}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(progress.oldImageId || "")
      || !/^sha256:[a-f0-9]{64}$/.test(progress.newImageId || "")) {
      throw new Error("DEPLOYMENT_HOLD_IMAGE_ID_MISSING");
    }
    const activatedAt = this.clock();
    const lifecycle = {
      protocol: DEPLOYMENT_LIFECYCLE_PROTOCOL,
      schemaVersion: 1,
      generation: (current?.generation || 0) + 1,
      state: "holding",
      holdId: request.requestId,
      workflowId: request.workflowId,
      previousVersion: request.currentVersion,
      targetVersion: request.targetVersion,
      previousImageId: progress.oldImageId,
      targetImageId: progress.newImageId,
      rollbackImageTag: this.config.rollbackImageTag,
      emergencyImageTag: this.config.emergencyImageTag,
      holdDays: this.config.emergencyHoldDays,
      activatedAt: activatedAt.toISOString(),
      holdUntil: new Date(activatedAt.getTime() + this.config.emergencyHoldDays * 24 * 60 * 60_000).toISOString(),
      observedHoldMs: 0,
      lastObservedAt: activatedAt.toISOString(),
      clockAnomalyAt: null,
      clockAnomalyCode: null,
      finalizeReason: null,
      finalizeRequestedAt: null,
      finalizedAt: null,
      updatedAt: activatedAt.toISOString(),
      mode: "single-active-fail-closed-hold",
    };
    await this.writeDeploymentLifecycle(lifecycle);
    progress.deploymentLifecycle = {
      generation: lifecycle.generation,
      state: lifecycle.state,
      holdId: lifecycle.holdId,
      holdUntil: lifecycle.holdUntil,
    };
    await this.saveProgress(progress, "deployment-hold-created", `Vorheriger Stand bleibt bis ${lifecycle.holdUntil} geschützt.`);
    return lifecycle;
  }

  async abortDeploymentHold(request, reason) {
    const lifecycle = await this.readDeploymentLifecycle();
    if (!lifecycle || lifecycle.holdId !== request.requestId || lifecycle.state === "finalized") return lifecycle;
    lifecycle.state = "finalized";
    lifecycle.finalizeReason = reason;
    lifecycle.finalizeRequestedAt ||= nowIso(this.clock);
    lifecycle.finalizedAt = nowIso(this.clock);
    return this.writeDeploymentLifecycle(lifecycle);
  }

  async closeRollbackLifecycle(request) {
    const lifecycle = await this.abortDeploymentHold(request, "rollback");
    if (lifecycle && (
      lifecycle.holdId !== request.requestId
      || lifecycle.state !== "finalized"
      || lifecycle.finalizeReason !== "rollback"
    )) {
      throw new Error("ROLLBACK_DEPLOYMENT_LIFECYCLE_NOT_CLOSED");
    }
    return lifecycle;
  }

  async observeDeploymentHold(lifecycle) {
    if (!lifecycle || lifecycle.state !== "holding") return lifecycle;
    const now = this.clock();
    const wallDelta = now.getTime() - Date.parse(lifecycle.lastObservedAt);
    const monotonicNow = Number(this.monotonicClock());
    if (!Number.isFinite(monotonicNow) || monotonicNow < 0) {
      throw new Error("DEPLOYMENT_HOLD_MONOTONIC_CLOCK_INVALID");
    }
    const previousMonotonic = this.lifecycleObservationMonotonic.get(lifecycle.holdId);
    this.lifecycleObservationMonotonic.set(lifecycle.holdId, monotonicNow);
    if (previousMonotonic === undefined) return lifecycle;
    const monotonicDelta = monotonicNow - previousMonotonic;
    const drift = wallDelta - monotonicDelta;
    if (monotonicDelta < 0
      || monotonicDelta > MAX_HOLD_CLOCK_STEP_MS
      || drift > MAX_HOLD_CLOCK_BACKWARD_MS
      || drift < -MAX_HOLD_CLOCK_BACKWARD_MS) {
      if (!lifecycle.clockAnomalyCode) {
        lifecycle.clockAnomalyAt = now.toISOString();
        lifecycle.clockAnomalyCode = drift > 0 ? "CLOCK_FORWARD_JUMP" : "CLOCK_BACKWARD_JUMP";
        await this.writeDeploymentLifecycle(lifecycle);
      }
      return lifecycle;
    }
    if (monotonicDelta > 0) {
      lifecycle.observedHoldMs = Math.min(
        14 * 24 * 60 * 60_000,
        lifecycle.observedHoldMs + Math.floor(monotonicDelta),
      );
      lifecycle.lastObservedAt = now.toISOString();
      await this.writeDeploymentLifecycle(lifecycle);
    }
    return lifecycle;
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
    if (this.lockHandle) await this.refreshLockLease();
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
  }

  markLockOwnershipLost(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.lockLeaseError ||= failure;
    for (const controller of this.activeDockerAbortControllers) {
      controller.abort(this.lockLeaseError);
    }
    return this.lockLeaseError;
  }

  async foreignRunnerContainers() {
    const running = await this.rawDocker.runningServiceContainers(["update-runner"]);
    const own = String(this.config.hostname || "");
    return running.filter((container) => !(own && (container.startsWith(own) || own.startsWith(container))));
  }

  async assertLockOwnership() {
    if (this.lockLeaseError) throw this.lockLeaseError;
    if (!this.lockHandle || !this.lockToken) {
      throw this.markLockOwnershipLost(new Error("UPDATE_RUNNER_LOCK_NOT_OWNED"));
    }
    try {
      const [owner, handleStat, pathStat] = await Promise.all([
        readJson(this.config.lockPath),
        this.lockHandle.stat(),
        fs.stat(this.config.lockPath),
      ]);
      if (owner?.token !== this.lockToken
        || handleStat.dev !== pathStat.dev
        || handleStat.ino !== pathStat.ino) {
        throw new Error("UPDATE_RUNNER_LOCK_OWNERSHIP_LOST");
      }
      return owner;
    } catch (error) {
      throw this.markLockOwnershipLost(error);
    }
  }

  async refreshLockLease() {
    await this.assertLockOwnership();
    const now = this.clock();
    try {
      await this.lockHandle.utimes(now, now);
      await this.assertLockOwnership();
    } catch (error) {
      throw this.markLockOwnershipLost(error);
    }
  }

  async lockOwnerIsAlive(owner) {
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0
      && (!owner.hostname || owner.hostname === this.config.hostname)) {
      try {
        process.kill(owner.pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "EPERM") return true;
        if (error?.code !== "ESRCH") throw error;
      }
    }
    return (await this.foreignRunnerContainers()).length > 0;
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
        const expired = this.clock().getTime() - stat.mtimeMs > this.config.staleLockMs;
        if (!this.config.bootRecovery && !expired) return false;
        const owner = await readJsonIfExists(this.config.lockPath).catch(() => null);
        if (await this.lockOwnerIsAlive(owner)) return false;
        const stalePath = `${this.config.lockPath}.stale-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        try { await fs.rename(this.config.lockPath, stalePath); } catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw renameError;
        }
      }
    }
    if (!this.lockHandle) return false;
    // Even a previously missing path is not sufficient singleton evidence:
    // another live runner whose lock was externally removed may still have a
    // long Docker child in flight. Probe twice after wx and before ownership.
    try {
      for (let probe = 0; probe < 2; probe += 1) {
        if ((await this.foreignRunnerContainers()).length) {
          const handleStat = await this.lockHandle.stat().catch(() => null);
          const pathStat = await fs.stat(this.config.lockPath).catch(() => null);
          await this.lockHandle.close().catch(() => undefined);
          this.lockHandle = null;
          if (handleStat && pathStat
            && handleStat.dev === pathStat.dev
            && handleStat.ino === pathStat.ino) {
            await fs.unlink(this.config.lockPath).catch(() => undefined);
          }
          return false;
        }
      }
    } catch (error) {
      // A failed liveness probe must never turn an unverified wx acquisition
      // into ownership. Preserve the fresh lock as a fail-closed diagnostic
      // barrier and release only this process' file descriptor.
      await this.lockHandle.close().catch(() => undefined);
      this.lockHandle = null;
      throw error;
    }
    this.lockToken = crypto.randomBytes(24).toString("base64url");
    this.lockLeaseError = null;
    await this.lockHandle.writeFile(JSON.stringify({
      pid: process.pid,
      hostname: this.config.hostname,
      token: this.lockToken,
      acquiredAt: nowIso(this.clock),
    }));
    await this.lockHandle.sync();
    await this.refreshLockLease();
    return true;
  }

  async releaseLock() {
    if (!this.lockHandle) return;
    const token = this.lockToken;
    await this.lockHandle.close().catch(() => undefined);
    this.lockHandle = null;
    this.lockToken = null;
    this.lockLeaseError = null;
    const owner = await readJsonIfExists(this.config.lockPath).catch(() => null);
    if (owner?.token === token) await fs.unlink(this.config.lockPath).catch(() => undefined);
  }

  progressPath(requestId) { return path.join(this.config.progressRoot, `${requestId}.json`); }
  journalPath(requestId) { return path.join(this.config.journalRoot, `${requestId}.json`); }
  claimedPath(requestId) { return path.join(this.config.claimedRoot, `${requestId}.request.json`); }
  resultPath(requestId) { return path.join(this.config.resultsRoot, `${requestId}.json`); }

  async saveProgress(progress, phase, message) {
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
    progress.phase = phase;
    progress.message = message;
    progress.updatedAt = nowIso(this.clock);
    await writeJsonAtomic(this.journalPath(progress.requestId), progress);
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
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

  async runtimeDeactivationRequested() {
    return Boolean(await readDockerRuntimeDeactivationIntent({
      productRoot: this.config.projectRoot,
    }));
  }

  async assertRuntimeDeactivationSafe() {
    await this.initialize();
    if (!await this.acquireLock()) throw new Error("UPDATE_RUNNER_DEACTIVATION_BUSY");
    try {
      await this.assertLockOwnership();
      if (!await this.runtimeDeactivationRequested()) {
        throw new Error("UPDATE_RUNNER_DEACTIVATION_INTENT_MISSING");
      }

      const fence = await fs.lstat(this.config.transactionFencePath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (fence) throw new Error("UPDATE_RUNNER_DEACTIVATION_TRANSACTION_FENCE_PRESENT");

      const claims = await fs.readdir(this.config.claimedRoot, { withFileTypes: true });
      for (const entry of claims) {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new Error(`UPDATE_RUNNER_DEACTIVATION_CLAIM_STATE_INVALID:${entry.name}`);
        }
        if (/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.request\.json$/u.test(entry.name)) {
          throw new Error(`UPDATE_RUNNER_DEACTIVATION_OPEN_CLAIM:${entry.name}`);
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.request\.json\.failed-[0-9]+$/u.test(entry.name)) {
          throw new Error(`UPDATE_RUNNER_DEACTIVATION_CLAIM_STATE_INVALID:${entry.name}`);
        }
      }

      const queued = await fs.readdir(this.config.requestsRoot, { withFileTypes: true });
      for (const entry of queued) {
        if (entry.name === path.basename(this.config.lifecycleRequestsRoot)
          && entry.isDirectory() && !entry.isSymbolicLink()) continue;
        throw new Error(`UPDATE_RUNNER_DEACTIVATION_QUEUED_REQUEST:${entry.name}`);
      }
      const lifecycleCommands = await fs.readdir(this.config.lifecycleRequestsRoot, { withFileTypes: true });
      if (lifecycleCommands.length) {
        throw new Error(`UPDATE_RUNNER_DEACTIVATION_LIFECYCLE_COMMAND:${lifecycleCommands[0].name}`);
      }

      const terminalJournalStatuses = new Set(["completed", "failed", "rolled-back"]);
      const journals = await fs.readdir(this.config.journalRoot, { withFileTypes: true });
      for (const entry of journals) {
        if (entry.isSymbolicLink() || !entry.isFile()
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.json$/u.test(entry.name)) {
          throw new Error(`UPDATE_RUNNER_DEACTIVATION_JOURNAL_INVALID:${entry.name}`);
        }
        const journal = await readJson(path.join(this.config.journalRoot, entry.name));
        if (!terminalJournalStatuses.has(journal?.status)) {
          throw new Error(`UPDATE_RUNNER_DEACTIVATION_JOURNAL_OPEN:${entry.name}`);
        }
      }

      const staged = await fs.readdir(this.config.stagingRoot, { withFileTypes: true });
      if (staged.length) {
        throw new Error(`UPDATE_RUNNER_DEACTIVATION_STAGING_PRESENT:${staged[0].name}`);
      }

      const lifecycle = await this.readDeploymentLifecycle();
      if (lifecycle && lifecycle.state !== "finalized") {
        throw new Error(`UPDATE_RUNNER_DEACTIVATION_LIFECYCLE_${lifecycle.state.toUpperCase()}`);
      }

      const updateHelpers = await this.rawDocker.runningServiceContainers([
        SERVICES.databaseCandidate,
        SERVICES.candidateBootstrap,
        SERVICES.candidateMigrator,
        SERVICES.candidate,
        SERVICES.productionMigrator,
        SERVICES.snapshotCreate,
        SERVICES.snapshotRestore,
        SERVICES.snapshotCleanup,
      ]);
      if (updateHelpers.length) {
        throw new Error(`UPDATE_RUNNER_DEACTIVATION_HELPER_RUNNING:${updateHelpers[0]}`);
      }
      await this.assertLockOwnership();
      return { ok: true, lifecycleState: lifecycle?.state || null };
    } finally {
      await this.releaseLock();
    }
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

  async stageArtifact(request, sourcePath, acceptedAt) {
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
        // Recovery revalidates signature and artifact bytes, but the signed
        // validity window remains bound to the durable authenticated claim.
        // A crash after commit must not become unrecoverable merely because
        // wall-clock time passed the release expiry while Bonni was down.
        now: acceptedAt,
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
      {
        repository: request.release.artifact.imageIdentity.repository,
        version: request.targetVersion,
        imageTag: bonniReleaseImageTag(request.targetVersion),
      },
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
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
    const activeEnvironment = `SYSTEM_IMAGE=${this.config.canonicalActiveImage}\nSYSTEM_VERSION=${version}\n`;
    await writeTextAtomic(this.config.activeEnvironmentPath, activeEnvironment);
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
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
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
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
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
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
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
    const existing = await this.readTransactionFence(request);
    progress.flags.writeFenceReleased = true;
    await this.saveProgress(progress, "fence-release-ready", "Transaktionsentscheidung ist dauerhaft; der Startzaun darf entfernt werden.");
    if (existing) {
      await fs.unlink(this.config.transactionFencePath);
      const directory = await fs.open(path.dirname(this.config.transactionFencePath), "r");
      await directory.sync();
      await directory.close();
    }
    if (this.lockToken || this.lockLeaseError) await this.assertLockOwnership();
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

  async cleanupCutoverSnapshot(snapshotId) {
    await this.docker.compose([
      "--profile", "update", "run", "--rm", "--no-deps", SERVICES.snapshotCleanup,
    ], {
      env: { BONNI_UPDATE_SNAPSHOT_ID: snapshotId },
      timeoutMs: 10 * 60_000,
    });
  }

  async startCanonicalActive(version, requiredLicensePredecessor = "") {
    const environment = { SYSTEM_IMAGE: this.config.canonicalActiveImage, SYSTEM_VERSION: version };
    if (requiredLicensePredecessor) {
      environment.BONNI_CORE_LICENSE_REQUIRED_PREDECESSOR = requiredLicensePredecessor;
    }
    await this.docker.compose([
      "up", "-d", "--no-deps", "--force-recreate", "--no-build", SERVICES.active,
    ], { env: environment });
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

  async verifyCanonicalActiveTarget(lifecycle, label) {
    await this.waitForHealth(
      () => this.docker.health(SERVICES.active),
      "active",
      lifecycle.targetVersion,
      label,
    );
    const activeContainer = await this.docker.serviceContainer(SERVICES.active);
    const activeImageId = await this.docker.containerImageId(activeContainer);
    if (activeImageId !== lifecycle.targetImageId) {
      throw new Error("DEPLOYMENT_FINALIZE_ACTIVE_IMAGE_MISMATCH");
    }
  }

  async finalizeDeploymentHold({ holdId, generation, reason }) {
    const lifecycle = await this.readDeploymentLifecycle();
    if (!lifecycle) throw new Error("DEPLOYMENT_HOLD_NOT_FOUND");
    if (lifecycle.holdId !== holdId || lifecycle.generation !== generation) {
      throw new Error("DEPLOYMENT_HOLD_GENERATION_MISMATCH");
    }
    if (lifecycle.state === "finalized") return { lifecycle, idempotent: true };

    if (lifecycle.state === "holding") {
      lifecycle.state = "finalizing";
      lifecycle.finalizeReason = reason;
      lifecycle.finalizeRequestedAt = nowIso(this.clock);
      await this.writeDeploymentLifecycle(lifecycle);
    } else if (lifecycle.state !== "finalizing") {
      throw new Error(`DEPLOYMENT_HOLD_STATE_INVALID:${lifecycle.state}`);
    }

    const fencePresent = await fs.lstat(this.config.transactionFencePath)
      .then(() => true)
      .catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
    if (fencePresent) throw new Error("DEPLOYMENT_FINALIZE_TRANSACTION_FENCE_PRESENT");

    await this.verifyCanonicalActiveTarget(lifecycle, "Active vor Hold-Abschluss");

    // Emergency remains on the deliberately delayed image throughout the hold.
    // Only the runner may advance it after re-verifying the productive target.
    await this.docker.tagImage(lifecycle.targetImageId, this.config.emergencyImageTag);
    if (await this.docker.imageId(this.config.emergencyImageTag) !== lifecycle.targetImageId) {
      throw new Error("DEPLOYMENT_FINALIZE_EMERGENCY_TAG_MISMATCH");
    }
    await this.startEmergency();
    const emergencyContainer = await this.docker.serviceContainer(SERVICES.emergency);
    const emergencyImageId = await this.docker.containerImageId(emergencyContainer);
    if (emergencyImageId !== lifecycle.targetImageId) throw new Error("DEPLOYMENT_FINALIZE_EMERGENCY_IMAGE_MISMATCH");

    // Emergency recreation may take minutes. Re-prove the canonical target at
    // the final irreversible boundary so a failure during that window can
    // never advance the rollback pin or delete the only cutover snapshot.
    await this.verifyCanonicalActiveTarget(lifecycle, "Active unmittelbar vor Hold-Freigabe");

    // Advancing the rollback pin releases the previous image without guessing
    // an image name or deleting unrelated Docker data. The exact old image ID
    // stays only if another explicitly managed tag still owns it.
    await this.docker.tagImage(lifecycle.targetImageId, this.config.rollbackImageTag);
    if (await this.docker.imageId(this.config.rollbackImageTag) !== lifecycle.targetImageId) {
      throw new Error("DEPLOYMENT_FINALIZE_ROLLBACK_TAG_MISMATCH");
    }
    await this.cleanupCutoverSnapshot(lifecycle.holdId);

    lifecycle.state = "finalized";
    lifecycle.finalizeReason ||= reason;
    lifecycle.finalizeRequestedAt ||= nowIso(this.clock);
    lifecycle.finalizedAt = nowIso(this.clock);
    await this.writeDeploymentLifecycle(lifecycle);
    return { lifecycle, idempotent: false };
  }

  lifecycleCommandResultPath(commandId) {
    return path.join(this.config.resultsRoot, `lifecycle-${commandId}.json`);
  }

  async processLifecycleCommands() {
    let lifecycle = await this.readDeploymentLifecycle();
    if (lifecycle?.state === "finalizing") {
      await this.finalizeDeploymentHold({
        holdId: lifecycle.holdId,
        generation: lifecycle.generation,
        reason: lifecycle.finalizeReason || "recovery",
      });
      lifecycle = await this.readDeploymentLifecycle();
    } else if (lifecycle?.state === "holding") {
      lifecycle = await this.observeDeploymentHold(lifecycle);
      const fullHoldObserved = lifecycle.observedHoldMs >= 14 * 24 * 60 * 60_000;
      if (!lifecycle.clockAnomalyCode
        && fullHoldObserved
        && this.clock().getTime() >= Date.parse(lifecycle.holdUntil)) {
        await this.finalizeDeploymentHold({
          holdId: lifecycle.holdId,
          generation: lifecycle.generation,
          reason: "hold-expired",
        });
        lifecycle = await this.readDeploymentLifecycle();
      }
    }

    const names = (await fs.readdir(this.config.lifecycleRequestsRoot))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.json$/.test(name))
      .sort();
    for (const name of names) {
      const file = path.join(this.config.lifecycleRequestsRoot, name);
      let commandId = name.slice(0, -5);
      try {
        const command = verifyLifecycleCommand(await readJson(file), this.requestSecret, { now: this.clock() });
        commandId = command.commandId;
        if (`${command.commandId}.json` !== name) throw new Error("Lifecycle-Dateiname und commandId stimmen nicht überein.");
        const result = await this.finalizeDeploymentHold({
          holdId: command.holdId,
          generation: command.generation,
          reason: "developer-requested",
        });
        await writeJsonAtomic(this.lifecycleCommandResultPath(command.commandId), {
          schemaVersion: 1,
          commandId: command.commandId,
          ok: true,
          state: result.lifecycle.state,
          holdId: result.lifecycle.holdId,
          generation: result.lifecycle.generation,
          idempotent: result.idempotent,
          finishedAt: nowIso(this.clock),
        });
      } catch (error) {
        await writeJsonAtomic(this.lifecycleCommandResultPath(commandId), {
          schemaVersion: 1,
          commandId,
          ok: false,
          error: errorMessage(error),
          finishedAt: nowIso(this.clock),
        });
      } finally {
        await fs.unlink(file).catch(() => undefined);
      }
    }
    lifecycle = await this.readDeploymentLifecycle();
    await this.publishDeploymentLifecycle(lifecycle);
    return lifecycle;
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
    await this.startCanonicalActive(request.targetVersion, request.currentVersion);
    await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.targetVersion, "Wiederaufgenommener Active");
    progress.flags.activePromoted = true;
    await this.saveProgress(progress, "active-healthy", "Dauerhaft entschiedener Active ist nach Wiederanlauf vollständig bestätigt.");
    const lifecycle = await this.readDeploymentLifecycle();
    if (!lifecycle
      || lifecycle.holdId !== request.requestId
      || lifecycle.targetImageId !== progress.newImageId
      || lifecycle.targetVersion !== request.targetVersion
      || lifecycle.state === "finalized") {
      throw new Error("COMMITTED_TARGET_DEPLOYMENT_HOLD_MISSING");
    }
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
      await this.cleanupCutoverSnapshot(request.requestId);
      progress.flags.rollbackSnapshotCleanupComplete = true;
      await this.saveProgress(progress, "rollback-snapshot-cleaned", "Request-eigener Cutover-Snapshot wurde nach bestätigtem Rollback sicher entfernt.");
      await this.closeRollbackLifecycle(request);
      progress.flags.rollbackLifecycleClosed = true;
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

    if (progress.flags.rollbackCommitDecided && progress.flags.writeFenceReleased) {
      if (!progress.flags.rollbackSnapshotCleanupComplete) {
        await this.cleanupCutoverSnapshot(request.requestId);
        progress.flags.rollbackSnapshotCleanupComplete = true;
      }
      await this.closeRollbackLifecycle(request);
      progress.flags.rollbackLifecycleClosed = true;
      progress.rollback.attempted = true;
      progress.rollback.ok = true;
      progress.status = "rolled-back";
      await this.saveProgress(progress, "rolled-back-cleanup-complete", "Bestätigter Rollback und request-eigene Snapshot-Bereinigung sind abgeschlossen.");
      return progress;
    }

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
        // Keep the validity decision bound to the authenticated durable claim
        // on both first execution and crash recovery. Signature and bytes are
        // still rechecked on every attempt.
        now: claimedAt,
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

      const stagedArtifactPath = await this.stageArtifact(request, artifact.path, claimedAt);
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
      if ((loaded.id !== expected.digest && !loaded.repoDigests.includes(signedReference))
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

      if (request.release.migration.required && request.release.migration.strategy !== "offline") {
        if (request.release.migration.strategy !== "expand-contract"
          || request.release.migration.backwardCompatible !== true) {
          throw new Error("PRODUCTION_MIGRATION_NOT_ONLINE_EXPAND_CONTRACT");
        }
        await this.saveProgress(progress, "production-expand-migration", "Rückwärtskompatible Expand-Migration läuft, während der bisherige Active online bleibt.");
        await this.docker.compose([
          "--profile", "update", "run", "--rm", "--no-deps", SERVICES.productionMigrator,
        ], { env: candidateEnv, timeoutMs: 30 * 60_000 });
        progress.flags.productionMigrationComplete = true;
        await this.saveProgress(progress, "production-expand-migrated", "Expand-Migration ist abgeschlossen; Contract/Löschungen bleiben bis nach dem Hold verboten.");
        await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.currentVersion, "Bisheriger Active nach Expand-Migration");
      }

      await this.closeProductionWriters(request, progress);
      await this.createCutoverDataSnapshot(request, progress);
      await this.stepStatus(progress, "switch", "running", "Produktionsdaten sind versiegelt; Migration und Active-Wechsel erfolgen ohne erreichbaren Schreiber.");
      progress.flags.activePromoteStarted = true;
      await this.saveProgress(progress, "production-mutation-intent", "Produktionsmutation wurde vor Migration und Containerstart dauerhaft im Journal markiert.");
      await this.writeTransactionFence(request, "promoting");
      if (request.release.migration.required && request.release.migration.strategy === "offline") {
        await this.saveProgress(progress, "production-offline-migration", "Datenbank wird nach Sicherung im Wartungsfenster aktualisiert.");
        await this.docker.compose(["--profile", "update", "run", "--rm", "--no-deps", SERVICES.productionMigrator], { env: candidateEnv, timeoutMs: 30 * 60_000 });
        progress.flags.productionMigrationComplete = true;
        await this.saveProgress(progress, "production-offline-migrated", "Migration abgeschlossen; neue Version wird gestartet.");
      }
      await this.saveProgress(progress, "promote-active", "Signiertes Image wird auf den kanonischen Active-Tag übernommen.");
      await this.docker.tagImage(progress.newImageId, this.config.canonicalActiveImage);
      if (await this.docker.imageId(this.config.canonicalActiveImage) !== progress.newImageId) {
        throw new Error("PROMOTED_ACTIVE_TAG_ID_MISMATCH");
      }
      await this.commitActiveOverlay(request, progress, progress.newImageId, request.targetVersion);
      await this.startCanonicalActive(request.targetVersion, request.currentVersion);
      await this.waitForHealth(() => this.docker.health(SERVICES.active), "active", request.targetVersion, "Neuer Active");
      progress.flags.activePromoted = true;
      await this.saveProgress(progress, "active-healthy", "Neuer Active ist vollständig bereit.");

      await this.createDeploymentHold(request, progress);

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
    if (await this.runtimeDeactivationRequested()) {
      return { ok: false, processed: false, deactivating: true };
    }
    await this.initialize();
    if (!await this.acquireLock()) return { ok: false, busy: true };
    const heartbeatTimer = setInterval(() => {
      void this.heartbeat(this.lastHeartbeat.status, this.lastHeartbeat.message)
        .catch((error) => { this.markLockOwnershipLost(error); });
    }, 5_000);
    heartbeatTimer.unref();
    try {
      // The stop intent can be created after the optimistic pre-check. It is
      // re-read while holding the singleton lock, before lifecycle commands,
      // claims or Docker mutations, so runtime:stop can quiesce the daemon.
      if (await this.runtimeDeactivationRequested()) {
        return { ok: false, processed: false, deactivating: true };
      }
      const claimedBeforeLifecycle = await this.claimedRequests();
      if (claimedBeforeLifecycle.length === 0) {
        let lifecycle;
        try {
          if (this.config.bootRecovery) {
            // Active and Emergency are deliberately down during the boot gate.
            // Hold finalization requires a healthy confirmed Active, so boot
            // only validates/publishes the private state and defers every
            // destructive or administrator-requested finalize command to the
            // normal daemon after Active has passed its startup health gate.
            lifecycle = await this.readDeploymentLifecycle();
            await this.publishDeploymentLifecycle(lifecycle);
          } else {
            lifecycle = await this.processLifecycleCommands();
          }
        } catch (error) {
          await this.heartbeat("error", `Deployment-Hold konnte nicht sicher abgeschlossen werden: ${errorMessage(error)}`);
          return { ok: false, processed: false, lifecycleError: errorMessage(error) };
        }
        if (lifecycle && lifecycle.state !== "finalized") {
          await this.heartbeat("holding", `Vorheriger Stand bleibt bis ${lifecycle.holdUntil} geschützt; Folgeupdates sind gesperrt.`);
          return {
            ok: true,
            processed: false,
            lifecycle: await this.publishDeploymentLifecycle(lifecycle),
          };
        }
      }
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
        await this.assertLockOwnership();
        await writeJsonAtomic(this.journalPath(requestId), final);
        await this.assertLockOwnership();
        await writeJsonAtomic(this.progressPath(rawRequest.workflowId), final);
      }
      await this.assertLockOwnership();
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
      await this.assertLockOwnership();
      const fenceRemaining = await fs.lstat(this.config.transactionFencePath)
        .then(() => true)
        .catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
      const transactionResolved = !fenceRemaining
        && (!final.flags?.writeFenceStarted || final.flags?.writeFenceReleased === true)
        && (!final.flags?.rollbackCommitDecided || (
          final.flags?.rollbackSnapshotCleanupComplete === true
          && final.flags?.rollbackLifecycleClosed === true
        ));
      if (transactionResolved) {
        await this.assertLockOwnership();
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
