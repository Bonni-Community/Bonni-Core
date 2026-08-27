import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DockerCli,
  UpdateRunner,
  assertReleaseArchiveTags,
  bonniReleaseImageTag,
  canonicalReleasePayload,
  compareBonniReleaseVersion,
  createUpdateRunnerConfig,
  discoverComposeProject,
  signLifecycleCommand,
  signUpdateRunnerRequest,
  validateUpdateRunnerRequest,
} from "../src/system/update-runner/index.mjs";
import { loadTrustedReleaseKeys } from "../src/system/update-runner/trusted-keys.mjs";
import {
  createCutoverSnapshot,
  restoreCutoverSnapshot,
  snapshotDirectory,
} from "../scripts/backup/update-cutover-snapshot-lib.mjs";
import {
  acquireDockerRuntimeActivation,
  acquireDockerRuntimeDeactivationIntent,
  releaseDockerRuntimeActivation,
  releaseDockerRuntimeDeactivationIntent,
} from "../scripts/runtime/runtime-mode-exclusion.mjs";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const OLD_IMAGE = `sha256:${"a".repeat(64)}`;
const OCI_DIGEST = `sha256:${"b".repeat(64)}`;
const NEW_IMAGE = `sha256:${"c".repeat(64)}`;
const REPOSITORY = "registry.example/bonni/core";
const REQUEST_SECRET = Buffer.from("unit-test-request-hmac-secret-32-bytes-minimum");

test("runner trust loader rejects private and non-Ed25519 PEM files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runner-keys-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const directory = path.join(root, "trusted");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "release.pem"), publicKey.export({ type: "spki", format: "pem" }));
  const loaded = await loadTrustedReleaseKeys({ BONNI_UPDATE_TRUSTED_KEYS_DIR: directory }, root);
  assert.match(loaded.release, /BEGIN PUBLIC KEY/);

  await fs.writeFile(path.join(directory, "private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  await assert.rejects(
    () => loadTrustedReleaseKeys({ BONNI_UPDATE_TRUSTED_KEYS_DIR: directory }, root),
    /ED25519_SPKI_PUBLIC_KEY/,
  );

  await fs.unlink(path.join(directory, "private.pem"));
  const { publicKey: rsaPublicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.writeFile(path.join(directory, "rsa.pem"), rsaPublicKey.export({ type: "spki", format: "pem" }));
  await assert.rejects(
    () => loadTrustedReleaseKeys({ BONNI_UPDATE_TRUSTED_KEYS_DIR: directory }, root),
    /ED25519_SPKI_PUBLIC_KEY/,
  );
});

function health(role, version, overrides = {}) {
  return {
    ok: true,
    state: "ready",
    runtime: { slotRole: role, version },
    database: { ready: true },
    ...overrides,
  };
}

class FakeDocker {
  constructor(options = {}) {
    this.options = options;
    this.commands = [];
    this.activeVersion = "0.1.10";
    this.proxyTarget = "backend-active";
    this.candidateHealthCalls = 0;
    this.activeHealthCalls = 0;
    this.emergencyHealthCalls = 0;
    this.proxyHealthCalls = 0;
    this.activeOverlayAtStarts = [];
    this.imageTags = new Map([
      ["bonni_test-system:active", OLD_IMAGE],
      ["bonni_test-system:emergency", OLD_IMAGE],
    ]);
    this.leaseAbortSignal = null;
  }

  setLeaseAbortSignal(signal) { this.leaseAbortSignal = signal; }

  record(operation, value) { this.commands.push({ operation, ...value }); }

  async compose(args, options = {}) {
    this.record("compose", { args: [...args], env: { ...(options.env || {}) } });
    if (this.options.blockCompose && args.includes(this.options.blockCompose)) {
      this.options.onBlocked?.();
      await new Promise((resolve, reject) => {
        const signal = this.leaseAbortSignal;
        if (signal?.aborted) {
          reject(new Error("fake compose aborted by lease loss"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("fake compose aborted by lease loss")), { once: true });
        this.options.releaseBlocked = resolve;
      });
    }
    if (this.options.failCandidateStart && args.includes("backend-candidate")) throw new Error("fake candidate start failed");
    if (args.includes("runtime-proxy")) this.proxyTarget = options.env?.ACTIVE_BACKEND || this.proxyTarget;
    if (args.includes("backend-active") && args.includes("--force-recreate")) {
      if (this.options.activeOverlayPath) {
        this.activeOverlayAtStarts.push(await fs.readFile(this.options.activeOverlayPath, "utf8"));
      }
      if (this.options.beforeActiveStart) await this.options.beforeActiveStart(options.env);
      this.activeVersion = options.env?.SYSTEM_VERSION || this.activeVersion;
    }
    if (args.includes("run") && args.includes("update-snapshot-create")) {
      if (this.options.failSnapshotCreate) throw new Error("fake cutover snapshot failed");
      await createCutoverSnapshot({
        snapshotBase: this.options.snapshotConfig.rollbackSnapshotRoot,
        snapshotId: options.env.BONNI_UPDATE_SNAPSHOT_ID,
        workflowId: options.env.BONNI_UPDATE_SNAPSHOT_WORKFLOW_ID,
        backupId: options.env.BONNI_UPDATE_SNAPSHOT_BACKUP_ID,
        currentVersion: options.env.BONNI_UPDATE_SNAPSHOT_CURRENT_VERSION,
        sourceStorage: this.options.snapshotStorage,
        sourceRunSystem: this.options.snapshotRunSystem,
        dumpDatabase: async (target) => fs.writeFile(target, "PGDMP\0fake-consistent-production-database"),
      });
    }
    if (args.includes("run") && args.includes("update-snapshot-restore")) {
      if (this.options.failSnapshotRestore) throw new Error("fake cutover restore failed");
      await restoreCutoverSnapshot({
        snapshotBase: this.options.snapshotConfig.rollbackSnapshotRoot,
        resultBase: this.options.snapshotConfig.rollbackResultRoot,
        snapshotId: options.env.BONNI_UPDATE_SNAPSHOT_ID,
        workflowId: options.env.BONNI_UPDATE_SNAPSHOT_WORKFLOW_ID,
        backupId: options.env.BONNI_UPDATE_SNAPSHOT_BACKUP_ID,
        currentVersion: options.env.BONNI_UPDATE_SNAPSHOT_CURRENT_VERSION,
        restoreAttemptId: options.env.BONNI_UPDATE_RESTORE_ATTEMPT_ID,
        targetStorage: this.options.snapshotStorage,
        targetRunSystem: this.options.snapshotRunSystem,
        allowedTargetStorage: this.options.snapshotStorage,
        allowedTargetRunSystem: this.options.snapshotRunSystem,
        restoreDatabase: async () => undefined,
      });
    }
    if (args.includes("run") && args.includes("update-snapshot-cleanup")) {
      if (this.options.failSnapshotCleanup) throw new Error("fake snapshot cleanup failed");
      await fs.rm(snapshotDirectory(
        this.options.snapshotConfig.rollbackSnapshotRoot,
        options.env.BONNI_UPDATE_SNAPSHOT_ID,
      ), { recursive: true, force: true });
      await fs.rm(path.join(
        this.options.snapshotConfig.rollbackResultRoot,
        `${options.env.BONNI_UPDATE_SNAPSHOT_ID}.json`,
      ), { force: true });
    }
    if (args.includes("backend-emergency")
      && args.includes("--force-recreate")
      && this.options.activeDiesDuringEmergencyFinalize) {
      this.options.activeDead = true;
    }
    return { stdout: "", stderr: "", code: 0 };
  }

  async runningServiceContainers(services) {
    this.record("runningServiceContainers", { services: [...services] });
    return this.options.runningWriters || [];
  }

  async stopRunningServiceContainers(services) {
    this.record("stopRunningServiceContainers", { services: [...services] });
    if (this.options.failWriterStop) throw new Error("fake writer stop failed");
    return [];
  }

  async serviceContainer(service) {
    this.record("serviceContainer", { service });
    return `${service}-container-1`;
  }

  async containerImageId(container) {
    this.record("containerImageId", { container });
    if (container.startsWith("backend-emergency-")) return this.imageTags.get("bonni_test-system:emergency");
    return this.imageTags.get("bonni_test-system:active");
  }

  async loadImage(archive) {
    this.record("loadImage", { archive });
    if (this.options.loadMutatesActiveTag) this.imageTags.set("bonni_test-system:active", NEW_IMAGE);
  }

  async archiveImageTags(archive) {
    this.record("archiveImageTags", { archive });
    return this.options.archiveTags || [`${REPOSITORY}:0.1.11`];
  }

  async imageIdentity(reference) {
    this.record("imageIdentity", { reference });
    return {
      id: NEW_IMAGE,
      repoDigests: [`${REPOSITORY}@${OCI_DIGEST}`],
      os: "linux",
      architecture: "amd64",
      variant: undefined,
    };
  }

  async tagImage(imageId, target) {
    this.record("tagImage", { imageId, target });
    const resolved = imageId.startsWith("sha256:") ? imageId : this.imageTags.get(imageId);
    if (!resolved) throw new Error(`fake image reference missing: ${imageId}`);
    this.imageTags.set(target, resolved);
  }

  async imageId(reference) {
    this.record("imageId", { reference });
    const resolved = reference.startsWith("sha256:") ? reference : this.imageTags.get(reference);
    if (!resolved) throw new Error(`fake image reference missing: ${reference}`);
    return resolved;
  }

  async removeDisposableVolume(volume, expectedProject, expectedLogicalName) {
    this.record("removeDisposableVolume", { volume, expectedProject, expectedLogicalName });
    return true;
  }

  async health(service, url) {
    this.record("health", { service, url });
    if (service === "backend-candidate") {
      this.candidateHealthCalls += 1;
      return health("candidate", this.options.wrongCandidateVersion ? "0.1.99" : "0.1.11");
    }
    if (service === "backend-emergency") {
      this.emergencyHealthCalls += 1;
      return health("emergency", this.options.emergencyVersion || "0.1.9");
    }
    this.activeHealthCalls += 1;
    if (this.options.failPromotedActiveHealth && this.activeVersion === "0.1.11") {
      return health("active", this.activeVersion, { state: "unready", database: { ready: false } });
    }
    if (this.options.activeDead) {
      return health("active", this.activeVersion, { state: "unready", database: { ready: false } });
    }
    return health("active", this.activeVersion);
  }

  async proxyHealth(fromService, role) {
    this.record("proxyHealth", { target: this.proxyTarget, fromService, role });
    this.proxyHealthCalls += 1;
    if (this.proxyTarget === "backend-candidate") return health("candidate", "0.1.11");
    if (this.proxyTarget === "backend-emergency") return health("emergency", this.options.emergencyVersion || "0.1.9");
    return health("active", this.activeVersion);
  }
}

function assertNoDockerMutation(docker) {
  assert.ok(docker.commands.every((entry) => entry.operation === "runningServiceContainers"));
}

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-update-runner-"));
  const storageRoot = path.join(root, "runtime", "storage");
  const runSystemRoot = path.join(root, "run_system");
  const updateRoot = path.join(storageRoot, "system", "update-center");
  const artifactRelativePath = "downloads/bonni-core-0.1.11.bonni";
  const artifactPath = path.join(updateRoot, artifactRelativePath);
  const artifact = Buffer.from("fake but cryptographically identified OCI image archive");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.mkdir(path.join(runSystemRoot, "system"), { recursive: true });
  await fs.writeFile(path.join(runSystemRoot, "system", "runtime.json"), "{\"state\":\"old\"}\n");
  await fs.writeFile(artifactPath, artifact);

  const backupId = "backup-unit-runner-001";
  const backupRoot = path.join(storageRoot, "system", "backups", backupId);
  const dump = Buffer.from("verified PostgreSQL custom dump fixture");
  await fs.mkdir(path.join(backupRoot, "database"), { recursive: true });
  await fs.writeFile(path.join(backupRoot, "database", "database.dump"), dump);
  await fs.writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: backupId,
    status: "completed",
    files: [{
      path: "database/database.dump",
      sizeBytes: dump.length,
      sha256: crypto.createHash("sha256").update(dump).digest("hex"),
    }],
  }, null, 2)}\n`);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const releasePayload = {
    schemaVersion: 2,
    product: "bonni-core",
    channel: "stable",
    version: "0.1.11",
    artifact: {
      type: "oci-image-archive",
      sizeBytes: artifact.length,
      sha256: crypto.createHash("sha256").update(artifact).digest("hex"),
      source: { kind: "local", path: "bonni-core-0.1.11.bonni" },
      imageIdentity: {
        repository: REPOSITORY,
        digest: OCI_DIGEST,
        platform: { os: "linux", architecture: "amd64" },
      },
    },
    migration: options.migration || {
      required: false,
      strategy: "none",
      fromSchemaVersion: "1.0.0",
      toSchemaVersion: "1.0.0",
      backwardCompatible: true,
    },
    issuedAt: "2026-07-22T11:00:00Z",
    expiresAt: "2026-07-23T11:00:00Z",
    minimumRunnerVersion: "0.1.0",
  };
  const release = {
    ...releasePayload,
    signature: {
      algorithm: "Ed25519",
      keyId: "test-release-key",
      value: crypto.sign(null, canonicalReleasePayload(releasePayload), privateKey).toString("base64"),
    },
  };
  const unsignedRequest = {
    schemaVersion: 1,
    requestId: options.requestId || "request-0001",
    workflowId: "workflow-0001",
    action: "install",
    product: "bonni-core",
    currentVersion: "0.1.10",
    targetVersion: "0.1.11",
    artifactRelativePath,
    backupId,
    issuedAt: "2026-07-22T11:30:00Z",
    expiresAt: "2026-07-22T13:30:00Z",
    nonce: options.nonce || "A".repeat(32),
    release,
  };
  const request = signUpdateRunnerRequest(unsignedRequest, REQUEST_SECRET, { now: NOW });
  const config = createUpdateRunnerConfig({
    BONNI_HOST_PROJECT_ROOT: root,
    BONNI_STORAGE_ROOT: storageRoot,
    COMPOSE_PROJECT_NAME: "bonni_test",
    BONNI_ACTIVE_IMAGE_TAG: "bonni_test-system:active",
    BONNI_ROLLBACK_IMAGE_TAG: "bonni_test-system:rollback",
    BONNI_UPDATE_HEALTH_ATTEMPTS: "3",
    BONNI_UPDATE_HEALTH_INTERVAL_MS: "0",
    BONNI_UPDATE_COMPOSE_WAIT_SECONDS: "30",
  });
  config.healthAttempts = 3;
  config.healthIntervalMs = 0;
  const requestFile = path.join(config.requestsRoot, `${request.requestId}.json`);
  await fs.mkdir(config.requestsRoot, { recursive: true });
  await fs.writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  return {
    root,
    storageRoot,
    runSystemRoot,
    artifactPath,
    request,
    release,
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    config,
    requestFile,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function runnerFor(workspace, docker, clock = () => new Date(NOW), monotonicClock = () => 0) {
  docker.options.snapshotConfig = workspace.config;
  docker.options.snapshotStorage = workspace.storageRoot;
  docker.options.snapshotRunSystem = workspace.runSystemRoot;
  return new UpdateRunner({
    config: workspace.config,
    docker,
    trustedKeys: { "test-release-key": workspace.publicKey },
    requestSecret: REQUEST_SECRET,
    clock,
    monotonicClock,
    sleep: async () => undefined,
  });
}

async function enableRuntimeDeactivation(workspace) {
  const activation = await acquireDockerRuntimeActivation({
    productRoot: workspace.root,
    ownerPid: 999_991,
    isPidAlive: () => false,
    probePort: async () => false,
  });
  const intent = await acquireDockerRuntimeDeactivationIntent({
    productRoot: workspace.root,
    ownerPid: process.pid,
    isPidAlive: (pid) => pid === process.pid,
  });
  return async () => {
    await releaseDockerRuntimeDeactivationIntent({
      productRoot: workspace.root,
      ownerPid: process.pid,
      token: intent.token,
    });
    await releaseDockerRuntimeActivation({
      productRoot: workspace.root,
      ownerPid: 999_991,
      token: activation.token,
    });
  };
}

function deploymentLifecycle(workspace, state = "holding") {
  return {
    protocol: "bonni-deployment-lifecycle/1",
    schemaVersion: 1,
    generation: 1,
    state,
    holdId: workspace.request.requestId,
    workflowId: workspace.request.workflowId,
    previousVersion: workspace.request.currentVersion,
    targetVersion: workspace.request.targetVersion,
    previousImageId: OLD_IMAGE,
    targetImageId: NEW_IMAGE,
    rollbackImageTag: workspace.config.rollbackImageTag,
    emergencyImageTag: workspace.config.emergencyImageTag,
    holdDays: 14,
    activatedAt: NOW.toISOString(),
    holdUntil: new Date(NOW.getTime() + 14 * 24 * 60 * 60_000).toISOString(),
    observedHoldMs: 0,
    lastObservedAt: NOW.toISOString(),
    clockAnomalyAt: null,
    clockAnomalyCode: null,
    finalizeReason: state === "finalized" ? "runtime-deactivation" : null,
    finalizeRequestedAt: null,
    finalizedAt: state === "finalized" ? NOW.toISOString() : null,
    updatedAt: NOW.toISOString(),
    mode: "single-active-fail-closed-hold",
  };
}

async function prepareRecoveryCutover(workspace, progress, { phase = "promoting", decision = null } = {}) {
  const snapshot = await createCutoverSnapshot({
    snapshotBase: workspace.config.rollbackSnapshotRoot,
    snapshotId: workspace.request.requestId,
    workflowId: workspace.request.workflowId,
    backupId: workspace.request.backupId,
    currentVersion: workspace.request.currentVersion,
    sourceStorage: workspace.storageRoot,
    sourceRunSystem: workspace.runSystemRoot,
    dumpDatabase: async (target) => fs.writeFile(target, "PGDMP\0recovery-cutover-database"),
  });
  progress.flags.writeFenceStarted = true;
  progress.flags.writeFenceActive = true;
  progress.flags.dataSnapshotComplete = true;
  progress.flags.activePromoteStarted = true;
  progress.flags.dataCommitDecided = decision === "target";
  progress.flags.rollbackCommitDecided = decision === "rollback";
  progress.cutoverSnapshot = {
    id: workspace.request.requestId,
    manifestSha256: snapshot.manifestSha256,
    verifiedAt: NOW.toISOString(),
  };
  await fs.writeFile(
    path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`),
    `${JSON.stringify(progress, null, 2)}\n`,
  );
  await fs.mkdir(path.dirname(workspace.config.transactionFencePath), { recursive: true });
  await fs.writeFile(workspace.config.transactionFencePath, `${JSON.stringify({
    schemaVersion: 1,
    requestId: workspace.request.requestId,
    workflowId: workspace.request.workflowId,
    currentVersion: workspace.request.currentVersion,
    targetVersion: workspace.request.targetVersion,
    snapshotId: workspace.request.requestId,
    phase,
    decision,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }, null, 2)}\n`);
  if (decision === "target") {
    await fs.writeFile(workspace.config.lifecycleStatePath, `${JSON.stringify({
      protocol: "bonni-deployment-lifecycle/1",
      schemaVersion: 1,
      generation: 1,
      state: "holding",
      holdId: workspace.request.requestId,
      workflowId: workspace.request.workflowId,
      previousVersion: workspace.request.currentVersion,
      targetVersion: workspace.request.targetVersion,
      previousImageId: OLD_IMAGE,
      targetImageId: NEW_IMAGE,
      rollbackImageTag: workspace.config.rollbackImageTag,
      emergencyImageTag: workspace.config.emergencyImageTag,
      holdDays: 14,
      activatedAt: NOW.toISOString(),
      holdUntil: new Date(NOW.getTime() + 14 * 24 * 60 * 60_000).toISOString(),
      observedHoldMs: 0,
      lastObservedAt: NOW.toISOString(),
      clockAnomalyAt: null,
      clockAnomalyCode: null,
      finalizeReason: null,
      finalizeRequestedAt: null,
      finalizedAt: null,
      updatedAt: NOW.toISOString(),
      mode: "single-active-fail-closed-hold",
    }, null, 2)}\n`);
  }
}

test("runtime deactivation gate is locked, comprehensive and fail closed", async (t) => {
  const workspace = await fixture();
  const releaseMode = await enableRuntimeDeactivation(workspace);
  t.after(async () => {
    await releaseMode();
    await workspace.cleanup();
  });
  const docker = new FakeDocker();
  const runner = runnerFor(workspace, docker);
  await runner.initialize();

  await assert.rejects(
    runner.assertRuntimeDeactivationSafe(),
    /UPDATE_RUNNER_DEACTIVATION_QUEUED_REQUEST/u,
  );
  await fs.unlink(workspace.requestFile);

  const claim = path.join(workspace.config.claimedRoot, `${workspace.request.requestId}.request.json`);
  await fs.writeFile(claim, `${JSON.stringify(workspace.request)}\n`);
  await assert.rejects(
    runner.assertRuntimeDeactivationSafe(),
    /UPDATE_RUNNER_DEACTIVATION_OPEN_CLAIM/u,
  );
  await fs.unlink(claim);

  const journal = path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`);
  await fs.writeFile(journal, `${JSON.stringify({ status: "running" })}\n`);
  await assert.rejects(
    runner.assertRuntimeDeactivationSafe(),
    /UPDATE_RUNNER_DEACTIVATION_JOURNAL_OPEN/u,
  );
  await fs.writeFile(journal, `${JSON.stringify({ status: "completed" })}\n`);

  await fs.writeFile(workspace.config.transactionFencePath, "{}\n");
  await assert.rejects(
    runner.assertRuntimeDeactivationSafe(),
    /UPDATE_RUNNER_DEACTIVATION_TRANSACTION_FENCE_PRESENT/u,
  );
  await fs.unlink(workspace.config.transactionFencePath);

  await fs.writeFile(
    workspace.config.lifecycleStatePath,
    `${JSON.stringify(deploymentLifecycle(workspace, "holding"), null, 2)}\n`,
  );
  await assert.rejects(
    runner.assertRuntimeDeactivationSafe(),
    /UPDATE_RUNNER_DEACTIVATION_LIFECYCLE_HOLDING/u,
  );
  await fs.writeFile(
    workspace.config.lifecycleStatePath,
    `${JSON.stringify(deploymentLifecycle(workspace, "finalized"), null, 2)}\n`,
  );

  assert.deepEqual(await runner.assertRuntimeDeactivationSafe(), {
    ok: true,
    lifecycleState: "finalized",
  });
  assert.ok(docker.commands.some((entry) => entry.operation === "runningServiceContainers"
    && entry.services.includes("backend-candidate")
    && entry.services.includes("update-snapshot-restore")));
});

test("runtime deactivation intent quiesces processNext before claiming a queued release", async (t) => {
  const workspace = await fixture({ requestId: "request-deactivation-0002" });
  const releaseMode = await enableRuntimeDeactivation(workspace);
  t.after(async () => {
    await releaseMode();
    await workspace.cleanup();
  });
  const docker = new FakeDocker();
  const result = await runnerFor(workspace, docker).processNext();
  assert.deepEqual(result, { ok: false, processed: false, deactivating: true });
  assert.ok(await fs.stat(workspace.requestFile));
  assert.equal(docker.commands.length, 0);
});

test("runner installs a signed OCI release through isolated candidate and canonical active", async (t) => {
  const workspace = await fixture();
  t.after(workspace.cleanup);
  const docker = new FakeDocker({
    loadMutatesActiveTag: true,
    activeOverlayPath: workspace.config.activeEnvironmentPath,
    beforeActiveStart: async () => {
      await assert.rejects(fs.stat(workspace.config.networkTransportGatePath), /ENOENT/);
    },
  });
  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, true);
  assert.equal(result.result.status, "completed");
  assert.equal(docker.candidateHealthCalls, 3);
  assert.equal(docker.activeHealthCalls, 6);
  assert.equal(docker.proxyHealthCalls, 3);
  assert.equal(docker.proxyTarget, "backend-active");
  assert.equal(docker.activeVersion, "0.1.11");
  assert.ok(docker.commands.some((entry) => entry.operation === "compose" && entry.args.includes("db-candidate")));
  assert.ok(docker.commands.some((entry) => entry.operation === "compose" && entry.args.includes("candidate-bootstrap")));
  assert.ok(docker.commands.some((entry) => entry.operation === "tagImage" && entry.imageId === NEW_IMAGE));
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), OLD_IMAGE);
  assert.equal(docker.imageTags.get(workspace.config.canonicalActiveImage), NEW_IMAGE);
  const loadIndex = docker.commands.findIndex((entry) => entry.operation === "loadImage");
  const rollbackPinIndex = docker.commands.findIndex((entry) => entry.operation === "tagImage"
    && entry.imageId === OLD_IMAGE && entry.target === workspace.config.rollbackImageTag);
  const restoredAfterLoadIndex = docker.commands.findIndex((entry, index) => index > loadIndex
    && entry.operation === "tagImage" && entry.imageId === workspace.config.rollbackImageTag
    && entry.target === workspace.config.canonicalActiveImage);
  const promoteIndex = docker.commands.findIndex((entry) => entry.operation === "tagImage"
    && entry.imageId === NEW_IMAGE && entry.target === workspace.config.canonicalActiveImage);
  const proxyStopIndex = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args[0] === "stop" && entry.args.includes("runtime-proxy"));
  const writersVerifiedIndex = docker.commands.findIndex((entry) => entry.operation === "runningServiceContainers"
    && entry.services.includes("backend-active") && entry.services.includes("backend-emergency"));
  const snapshotIndex = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args.includes("run") && entry.args.includes("update-snapshot-create"));
  const activeStartIndex = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args.includes("backend-active") && entry.args.includes("--force-recreate"));
  const emergencyStartIndex = docker.commands.findIndex((entry, index) => index > activeStartIndex
    && entry.operation === "compose" && entry.args.includes("backend-emergency") && entry.args.includes("up"));
  const activeReleaseIndex = docker.commands.findIndex((entry, index) => index > activeStartIndex
    && entry.operation === "compose" && entry.args.includes("runtime-proxy")
    && entry.env.ACTIVE_BACKEND === "backend-active");
  assert.ok(rollbackPinIndex >= 0 && rollbackPinIndex < loadIndex);
  assert.ok(restoredAfterLoadIndex > loadIndex && restoredAfterLoadIndex < promoteIndex);
  assert.ok(proxyStopIndex >= 0 && writersVerifiedIndex > proxyStopIndex);
  assert.ok(snapshotIndex > writersVerifiedIndex && snapshotIndex < promoteIndex);
  assert.ok(activeStartIndex > promoteIndex && emergencyStartIndex > activeStartIndex && activeReleaseIndex > emergencyStartIndex);
  assert.deepEqual(docker.activeOverlayAtStarts, [
    "SYSTEM_IMAGE=bonni_test-system:active\nSYSTEM_VERSION=0.1.11\n",
  ]);
  assert.ok(docker.commands.filter((entry) => entry.operation === "health" && entry.service === "backend-candidate")
    .every((entry) => entry.url?.endsWith("/api/health/update-probe")));
  assert.ok(docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("run") && entry.args.includes("candidate-migrator")));
  const loaded = docker.commands.find((entry) => entry.operation === "loadImage");
  assert.ok(loaded.archive.startsWith(workspace.config.stagingRoot));
  assert.notEqual(loaded.archive, workspace.artifactPath);
  assert.ok(!docker.commands.some((entry) => entry.args?.includes("--publish") || entry.args?.includes("-P")));
  const deletedVolumes = docker.commands.filter((entry) => entry.operation === "removeDisposableVolume");
  assert.deepEqual(deletedVolumes.map((entry) => entry.expectedLogicalName).sort(), [
    "candidate_logs", "candidate_postgres_data", "candidate_run_system", "candidate_storage",
  ]);
  assert.ok(deletedVolumes.every((entry) => entry.volume.startsWith("bonni_test_candidate_")));

  const persisted = JSON.parse(await fs.readFile(path.join(workspace.config.resultsRoot, `${workspace.request.requestId}.json`), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.deepEqual(persisted.steps.map((entry) => entry.status), ["completed", "completed", "completed"]);
  const heartbeat = JSON.parse(await fs.readFile(workspace.config.heartbeatPath, "utf8"));
  assert.equal(heartbeat.version, "0.3.0");
  assert.equal(heartbeat.runnerVersion, "0.3.0");
  assert.equal(heartbeat.state, "idle");
  assert.equal(heartbeat.status, "idle");
  assert.equal(await fs.readFile(workspace.config.activeEnvironmentPath, "utf8"),
    "SYSTEM_IMAGE=bonni_test-system:active\nSYSTEM_VERSION=0.1.11\n");
  const transportGate = JSON.parse(await fs.readFile(workspace.config.networkTransportGatePath, "utf8"));
  assert.deepEqual(transportGate, {
    protocol: "bonni-update-network-transport-gate/1",
    schemaVersion: 1,
    state: "open",
    openedAt: NOW.toISOString(),
    reason: "update-runtime-confirmed",
    runnerVersion: "0.3.0",
  });
  await assert.rejects(fs.stat(workspace.config.transactionFencePath), /ENOENT/);
});

test("completed deployment creates an exact 14-day hold and blocks a queued follow-up", async (t) => {
  const workspace = await fixture({ requestId: "request-hold-0001", nonce: "V".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  const runner = runnerFor(workspace, docker);
  assert.equal((await runner.processNext()).ok, true);

  const lifecycle = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  assert.equal(lifecycle.state, "holding");
  assert.equal(lifecycle.mode, "single-active-fail-closed-hold");
  assert.equal(lifecycle.holdId, workspace.request.requestId);
  assert.equal(lifecycle.holdDays, 14);
  assert.equal(Date.parse(lifecycle.holdUntil) - Date.parse(lifecycle.activatedAt), 14 * 24 * 60 * 60_000);
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), OLD_IMAGE);

  const queued = path.join(workspace.config.requestsRoot, "future-request-0002.json");
  await fs.writeFile(queued, "{}\n");
  const blocked = await runner.processNext();
  assert.equal(blocked.ok, true);
  assert.equal(blocked.processed, false);
  assert.equal(blocked.lifecycle.blocksUpdates, true);
  assert.equal(await fs.readFile(queued, "utf8"), "{}\n");
});

test("signed developer finalize is idempotent and advances Emergency plus rollback pin", async (t) => {
  const workspace = await fixture({ requestId: "request-finalize-0001", nonce: "W".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  const runner = runnerFor(workspace, docker);
  assert.equal((await runner.processNext()).ok, true);
  const lifecycle = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  const unsigned = {
    schemaVersion: 1,
    commandId: "finalize-command-0001",
    action: "finalize",
    holdId: lifecycle.holdId,
    generation: lifecycle.generation,
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    nonce: "X".repeat(32),
  };
  const command = signLifecycleCommand(unsigned, REQUEST_SECRET, { now: NOW });
  await fs.writeFile(
    path.join(workspace.config.lifecycleRequestsRoot, `${command.commandId}.json`),
    `${JSON.stringify(command, null, 2)}\n`,
  );

  const finalized = await runner.processNext();
  assert.equal(finalized.ok, true);
  assert.equal(finalized.processed, false);
  const state = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  assert.equal(state.state, "finalized");
  assert.equal(state.finalizeReason, "developer-requested");
  assert.equal(docker.imageTags.get(workspace.config.emergencyImageTag), NEW_IMAGE);
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), NEW_IMAGE);
  assert.ok(docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("update-snapshot-cleanup") && entry.args.includes("run")));

  const replay = signLifecycleCommand({ ...unsigned, commandId: "finalize-command-0002", nonce: "Y".repeat(32) }, REQUEST_SECRET, { now: NOW });
  await fs.writeFile(
    path.join(workspace.config.lifecycleRequestsRoot, `${replay.commandId}.json`),
    `${JSON.stringify(replay, null, 2)}\n`,
  );
  await runner.processNext();
  const replayResult = JSON.parse(await fs.readFile(runner.lifecycleCommandResultPath(replay.commandId), "utf8"));
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.idempotent, true);
});

test("finalize preserves rollback pin and snapshot when Active dies during Emergency recreation", async (t) => {
  const workspace = await fixture({ requestId: "request-finalize-race", nonce: "R".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  const runner = runnerFor(workspace, docker);
  assert.equal((await runner.processNext()).ok, true);
  const lifecycle = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  const retainedSnapshotPath = snapshotDirectory(
    workspace.config.rollbackSnapshotRoot,
    workspace.request.requestId,
  );
  assert.ok(docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("update-snapshot-create") && entry.args.includes("run")));
  assert.ok(!docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("update-snapshot-cleanup") && entry.args.includes("run")));
  assert.ok(await fs.stat(retainedSnapshotPath));
  const command = signLifecycleCommand({
    schemaVersion: 1,
    commandId: "finalize-command-active-dies",
    action: "finalize",
    holdId: lifecycle.holdId,
    generation: lifecycle.generation,
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    nonce: "S".repeat(32),
  }, REQUEST_SECRET, { now: NOW });
  await fs.writeFile(
    path.join(workspace.config.lifecycleRequestsRoot, `${command.commandId}.json`),
    `${JSON.stringify(command, null, 2)}\n`,
  );
  docker.options.activeDiesDuringEmergencyFinalize = true;

  const result = await runner.processNext();

  assert.equal(result.ok, true);
  assert.equal(result.processed, false);
  const commandResult = JSON.parse(await fs.readFile(
    runner.lifecycleCommandResultPath(command.commandId),
    "utf8",
  ));
  assert.equal(commandResult.ok, false);
  assert.match(commandResult.error, /Active unmittelbar vor Hold-Freigabe/);
  const retained = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  assert.equal(retained.state, "finalizing");
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), OLD_IMAGE);
  assert.ok(!docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("update-snapshot-cleanup") && entry.args.includes("run")));
  assert.ok(await fs.stat(retainedSnapshotPath));
});

test("expired hold finalizes automatically before accepting another update", async (t) => {
  const workspace = await fixture({ requestId: "request-expiry-0001", nonce: "Z".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  let current = new Date(NOW);
  let monotonicMs = 0;
  const runner = runnerFor(
    workspace,
    docker,
    () => new Date(current),
    () => monotonicMs,
  );
  assert.equal((await runner.processNext()).ok, true);
  // First post-activation pass establishes a process-local monotonic baseline.
  assert.equal((await runner.processNext()).ok, true);
  let result;
  for (let checkpoint = 0; checkpoint < 56; checkpoint += 1) {
    current = new Date(current.getTime() + 6 * 60 * 60_000);
    monotonicMs += 6 * 60 * 60_000;
    result = await runner.processNext();
  }
  assert.equal(result.ok, true);
  const lifecycle = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  assert.equal(lifecycle.state, "finalized");
  assert.equal(lifecycle.finalizeReason, "hold-expired");
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), NEW_IMAGE);
});

test("a fifteen-day wall-clock jump never auto-finalizes or deletes rollback evidence", async (t) => {
  const workspace = await fixture({ requestId: "request-clock-jump-01", nonce: "J".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  let current = new Date(NOW);
  let monotonicMs = 0;
  const runner = runnerFor(
    workspace,
    docker,
    () => new Date(current),
    () => monotonicMs,
  );
  assert.equal((await runner.processNext()).ok, true);
  assert.equal((await runner.processNext()).ok, true);
  current = new Date(current.getTime() + 15 * 24 * 60 * 60_000);

  const result = await runner.processNext();

  assert.equal(result.ok, true);
  assert.equal(result.processed, false);
  const lifecycle = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
  assert.equal(lifecycle.state, "holding");
  assert.equal(lifecycle.clockAnomalyCode, "CLOCK_FORWARD_JUMP");
  assert.equal(lifecycle.observedHoldMs, 0);
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), OLD_IMAGE);
  assert.ok(!docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("update-snapshot-cleanup") && entry.args.includes("run")));
});

test("candidate must report exact version, role, database and ready state three times", async (t) => {
  const workspace = await fixture({ requestId: "request-0002", nonce: "B".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker({ wrongCandidateVersion: true });
  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.equal(result.result.status, "failed");
  assert.equal(docker.candidateHealthCalls, 3);
  assert.equal(docker.proxyTarget, "backend-active");
  assert.ok(!docker.commands.some((entry) => entry.operation === "tagImage"
    && entry.imageId === NEW_IMAGE && entry.target === workspace.config.canonicalActiveImage));
});

test("failed promoted active restores previous image and proxy", async (t) => {
  const workspace = await fixture({ requestId: "request-0003", nonce: "C".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker({ failPromotedActiveHealth: true });
  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.equal(result.result.status, "rolled-back");
  assert.equal(result.result.rollback.ok, true);
  assert.equal(docker.activeVersion, "0.1.10");
  assert.equal(docker.proxyTarget, "backend-active");
  assert.ok(docker.commands.some((entry) => entry.operation === "tagImage" && entry.imageId === OLD_IMAGE));
  await assert.rejects(
    fs.stat(snapshotDirectory(workspace.config.rollbackSnapshotRoot, workspace.request.requestId)),
    /ENOENT/,
  );
  assert.equal(result.result.flags.rollbackSnapshotCleanupComplete, true);
  assert.equal(result.result.flags.rollbackLifecycleClosed, true);
});

test("restore failure leaves every productive service closed and keeps the claim for recovery", async (t) => {
  const workspace = await fixture({ requestId: "request-restore-fail", nonce: "R".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker({ failPromotedActiveHealth: true, failSnapshotRestore: true });

  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.rollback.ok, false);
  assert.match(result.result.rollback.error, /fake cutover restore failed/);
  await fs.stat(workspace.config.transactionFencePath);
  await assert.rejects(fs.stat(workspace.config.networkTransportGatePath), /ENOENT/);
  await fs.stat(path.join(workspace.config.claimedRoot, `${workspace.request.requestId}.request.json`));
  const promotedStart = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args.includes("backend-active") && entry.args.includes("--force-recreate"));
  assert.ok(promotedStart >= 0);
  assert.ok(!docker.commands.slice(promotedStart + 1).some((entry) => entry.operation === "compose"
    && entry.args.includes("backend-active") && entry.args.includes("up")));
  assert.ok(!docker.commands.slice(promotedStart + 1).some((entry) => entry.operation === "compose"
    && entry.args.includes("runtime-proxy") && entry.args.includes("up")));
});

test("rollback keeps its claim until lifecycle closure is durably acknowledged", async (t) => {
  const workspace = await fixture({ requestId: "request-rollback-lifecycle", nonce: "Y".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker({ failPromotedActiveHealth: true });
  const runner = runnerFor(workspace, docker);
  const realClose = runner.closeRollbackLifecycle.bind(runner);
  let failOnce = true;
  runner.closeRollbackLifecycle = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated lifecycle receipt I/O failure");
    }
    return realClose(...args);
  };

  const first = await runner.processNext();
  assert.equal(first.ok, false);
  assert.equal(first.result.flags.rollbackSnapshotCleanupComplete, true);
  assert.equal(first.result.flags.rollbackLifecycleClosed, false);
  await fs.stat(path.join(workspace.config.claimedRoot, `${workspace.request.requestId}.request.json`));

  const recovered = await runner.processNext();
  assert.equal(recovered.result.status, "rolled-back");
  assert.equal(recovered.result.flags.rollbackLifecycleClosed, true);
  await assert.rejects(
    fs.stat(path.join(workspace.config.claimedRoot, `${workspace.request.requestId}.request.json`)),
    /ENOENT/,
  );
});

test("artifact tampering is rejected before the first Docker command", async (t) => {
  const workspace = await fixture({ requestId: "request-0004", nonce: "D".repeat(32) });
  t.after(workspace.cleanup);
  await fs.appendFile(workspace.artifactPath, "tampered");
  const docker = new FakeDocker();
  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.match(result.result.error, /SIZE_MISMATCH|HASH_MISMATCH/);
  assertNoDockerMutation(docker);
});

test("archive carrying the canonical Active tag is rejected before docker image load", async (t) => {
  const workspace = await fixture({ requestId: "request-0011", nonce: "L".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker({ archiveTags: [workspace.config.canonicalActiveImage] });
  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.match(result.result.error, /RELEASE_ARCHIVE_FORBIDDEN_RUNTIME_TAG/);
  assert.ok(!docker.commands.some((entry) => entry.operation === "loadImage"));
  assert.equal(docker.imageTags.get(workspace.config.canonicalActiveImage), OLD_IMAGE);
  assert.equal(docker.imageTags.get(workspace.config.rollbackImageTag), OLD_IMAGE);
});

test("archive requires exactly one signed repository and version tag", () => {
  const identity = { repository: REPOSITORY, version: "0.1.11" };
  assert.throws(() => assertReleaseArchiveTags(identity, []), /RELEASE_ARCHIVE_VERSION_TAG_REQUIRED/);
  assert.throws(() => assertReleaseArchiveTags(identity, [`${REPOSITORY}:latest`]), /RELEASE_ARCHIVE_UNEXPECTED_TAG/);
  assert.equal(assertReleaseArchiveTags(identity, [`${REPOSITORY}:0.1.11`]), true);
});

test("runner uses Bonni build ordering and Docker-safe maintenance tags", () => {
  assert.equal(compareBonniReleaseVersion("0.1.19+c", "0.1.19+d"), -1);
  assert.equal(compareBonniReleaseVersion("0.1.19+a", "0.1.19"), 1);
  assert.equal(compareBonniReleaseVersion("0.1.19+aa", "0.1.19+z"), 1);
  assert.equal(bonniReleaseImageTag("0.1.19+d"), "0.1.19-d");
});

test("runner install contract accepts the next Bonni build and rejects a reverse build", async (t) => {
  const workspace = await fixture({ requestId: "request-build-order-01", nonce: "Q".repeat(32) });
  t.after(workspace.cleanup);

  const forwardDraft = structuredClone(workspace.request);
  forwardDraft.currentVersion = "0.1.19+c";
  forwardDraft.targetVersion = "0.1.19+d";
  forwardDraft.release.version = "0.1.19+d";
  const forward = signUpdateRunnerRequest(forwardDraft, REQUEST_SECRET, { now: NOW });
  const validated = validateUpdateRunnerRequest(forward, { now: NOW });

  assert.equal(validated.currentVersion, "0.1.19+c");
  assert.equal(validated.targetVersion, "0.1.19+d");
  assert.equal(compareBonniReleaseVersion(validated.targetVersion, validated.currentVersion), 1);
  assert.equal(bonniReleaseImageTag(validated.targetVersion), "0.1.19-d");

  const reverse = structuredClone(forward);
  reverse.currentVersion = "0.1.19+d";
  reverse.targetVersion = "0.1.19+c";
  reverse.release.version = "0.1.19+c";
  delete reverse.auth;
  assert.throws(
    () => validateUpdateRunnerRequest(reverse, { now: NOW, requireAuth: false }),
    /Zielversion ist nicht neuer/,
  );
});

test("request HMAC tampering is quarantined before Docker access", async (t) => {
  const workspace = await fixture({ requestId: "request-0008", nonce: "H".repeat(32) });
  t.after(workspace.cleanup);
  workspace.request.nonce = "I".repeat(32);
  await fs.writeFile(workspace.requestFile, `${JSON.stringify(workspace.request, null, 2)}\n`);
  const docker = new FakeDocker();
  const result = await runnerFor(workspace, docker).processNext();
  assert.equal(result.processed, false);
  assertNoDockerMutation(docker);
  const resultNames = await fs.readdir(workspace.config.resultsRoot);
  assert.ok(resultNames.some((name) => name.startsWith("rejected-")));
});

test("request currentVersion must equal the real healthy active version", async (t) => {
  const workspace = await fixture({ requestId: "request-0009", nonce: "J".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  docker.activeVersion = "0.1.9";
  const result = await runnerFor(workspace, docker).processNext();
  assert.equal(result.ok, false);
  assert.match(result.result.error, /Bisheriger Active/);
  assert.ok(!docker.commands.some((entry) => entry.operation === "loadImage"));
});

test("signed backward-compatible expand migration runs online before the production write fence", async (t) => {
  const workspace = await fixture({
    requestId: "request-0005",
    nonce: "E".repeat(32),
    migration: {
      required: true,
      strategy: "expand-contract",
      fromSchemaVersion: "1.0.0",
      toSchemaVersion: "1.1.0",
      backwardCompatible: true,
    },
  });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  const result = await runnerFor(workspace, docker).processNext();
  assert.equal(result.ok, true);
  const migrationIndex = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args.includes("database-migrator") && entry.args.includes("run"));
  const proxyStopIndex = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args[0] === "stop" && entry.args.includes("runtime-proxy"));
  assert.ok(migrationIndex >= 0 && proxyStopIndex > migrationIndex);
});

test("offline migration is rejected before Docker access", async (t) => {
  const workspace = await fixture({
    requestId: "request-offline-0005",
    nonce: "U".repeat(32),
    migration: {
      required: true,
      strategy: "offline",
      fromSchemaVersion: "1.0.0",
      toSchemaVersion: "2.0.0",
      backwardCompatible: false,
    },
  });
  t.after(workspace.cleanup);
  assert.throws(() => validateUpdateRunnerRequest(workspace.request, { now: NOW }), /offline\/contract/);
  const docker = new FakeDocker();
  const result = await runnerFor(workspace, docker).processNext();
  assert.equal(result.processed, false);
  assertNoDockerMutation(docker);
});

test("signed release with backwardCompatible false is rejected before Docker access", async (t) => {
  const workspace = await fixture({ requestId: "request-0012", nonce: "M".repeat(32) });
  t.after(workspace.cleanup);
  workspace.request.release.migration.backwardCompatible = false;
  const { auth: _oldAuth, ...unsignedRejected } = workspace.request;
  workspace.request = signUpdateRunnerRequest(unsignedRejected, REQUEST_SECRET, { now: NOW });
  await fs.writeFile(workspace.requestFile, `${JSON.stringify(workspace.request, null, 2)}\n`);
  const docker = new FakeDocker();

  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.processed, false);
  assertNoDockerMutation(docker);
  const terminal = JSON.parse(await fs.readFile(
    path.join(workspace.config.progressRoot, `${workspace.request.workflowId}.json`), "utf8",
  ));
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error, /rückwärtskompatible expand-contract/);
});

test("existing runner lock prevents concurrent Docker orchestration", async (t) => {
  const workspace = await fixture({ requestId: "request-0006", nonce: "F".repeat(32) });
  t.after(workspace.cleanup);
  await fs.mkdir(path.dirname(workspace.config.lockPath), { recursive: true });
  await fs.writeFile(workspace.config.lockPath, "busy");
  const docker = new FakeDocker();
  const result = await runnerFor(workspace, docker).processNext();
  assert.deepEqual(result, { ok: false, busy: true });
  assertNoDockerMutation(docker);
});

test("a refreshed live runner lease cannot be stolen after the stale threshold", async (t) => {
  const workspace = await fixture({ requestId: "request-lock-lease", nonce: "L".repeat(32) });
  t.after(workspace.cleanup);
  await fs.unlink(workspace.requestFile);
  workspace.config.staleLockMs = 60_000;
  let current = new Date(NOW);
  const first = runnerFor(workspace, new FakeDocker(), () => new Date(current));
  await first.initialize();
  assert.equal(await first.acquireLock(), true);
  current = new Date(current.getTime() + 2 * 60_000);
  await first.refreshLockLease();

  const competingDocker = new FakeDocker();
  const second = runnerFor(workspace, competingDocker, () => new Date(current));
  assert.deepEqual(await second.processNext(), { ok: false, busy: true });
  assert.ok(!competingDocker.commands.some((entry) => entry.operation !== "runningServiceContainers"));
  await first.releaseLock();
});

test("a changed lock token makes the original runner fail closed and preserves the foreign lock", async (t) => {
  const workspace = await fixture({ requestId: "request-lock-token", nonce: "K".repeat(32) });
  t.after(workspace.cleanup);
  await fs.unlink(workspace.requestFile);
  const docker = new FakeDocker();
  const runner = runnerFor(workspace, docker);
  await runner.initialize();
  assert.equal(await runner.acquireLock(), true);
  await fs.writeFile(workspace.config.lockPath, JSON.stringify({
    pid: 999_999,
    hostname: "foreign-runner",
    token: "foreign-lock-token",
    acquiredAt: NOW.toISOString(),
  }));

  await assert.rejects(() => runner.refreshLockLease(), /UPDATE_RUNNER_LOCK_OWNERSHIP_LOST/);
  await assert.rejects(() => runner.docker.compose(["stop", "backend-active"]), /UPDATE_RUNNER_LOCK_OWNERSHIP_LOST/);
  assertNoDockerMutation(docker);
  await runner.releaseLock();
  assert.equal(JSON.parse(await fs.readFile(workspace.config.lockPath, "utf8")).token, "foreign-lock-token");
});

test("lease loss aborts an in-flight Docker operation and a second runner remains blocked", async (t) => {
  const workspace = await fixture({ requestId: "request-lock-abort", nonce: "B".repeat(32) });
  t.after(workspace.cleanup);
  await fs.unlink(workspace.requestFile);
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const firstDocker = new FakeDocker({
    blockCompose: "update-snapshot-restore",
    onBlocked: () => startedResolve(),
  });
  const first = runnerFor(workspace, firstDocker);
  await first.initialize();
  assert.equal(await first.acquireLock(), true);
  const operation = first.docker.compose(["run", "update-snapshot-restore"]);
  await started;
  await fs.unlink(workspace.config.lockPath);
  await fs.writeFile(workspace.config.lockPath, JSON.stringify({ token: "replacement" }));
  await assert.rejects(() => first.refreshLockLease(), /UPDATE_RUNNER_LOCK_OWNERSHIP_LOST/);
  await assert.rejects(() => operation, /UPDATE_RUNNER_LOCK_OWNERSHIP_LOST/);

  await fs.unlink(workspace.config.lockPath);
  const secondDocker = new FakeDocker({ runningWriters: ["first-runner-still-running"] });
  const second = runnerFor(workspace, secondDocker);
  assert.deepEqual(await second.processNext(), { ok: false, busy: true });
  assert.ok(!secondDocker.commands.some((entry) => entry.operation === "compose"));
  await first.releaseLock();
});

test("boot recovery takes over a fresh orphan lock only when no other runner container exists", async (t) => {
  const workspace = await fixture({ requestId: "request-boot-lock", nonce: "Q".repeat(32) });
  t.after(workspace.cleanup);
  await fs.unlink(workspace.requestFile);
  workspace.config.bootRecovery = true;
  workspace.config.hostname = "self-runner-container";
  await fs.mkdir(path.dirname(workspace.config.lockPath), { recursive: true });
  await fs.writeFile(workspace.config.lockPath, "orphaned-by-host-crash");
  const recovered = await runnerFor(workspace, new FakeDocker()).processNext();
  assert.deepEqual(recovered, { ok: true, processed: false });

  await fs.writeFile(workspace.config.lockPath, "not-orphaned");
  const competing = new FakeDocker({ runningWriters: ["different-running-runner"] });
  const blocked = await runnerFor(workspace, competing).processNext();
  assert.deepEqual(blocked, { ok: false, busy: true });
});

test("boot gate defers expired and in-progress hold finalization until Active is healthy", async (t) => {
  for (const [state, suffix] of [["holding", "expired"], ["finalizing", "resume"]]) {
    const workspace = await fixture({
      requestId: `request-boot-hold-${suffix}`,
      nonce: (state === "holding" ? "E" : "I").repeat(32),
    });
    t.after(workspace.cleanup);
    const installedDocker = new FakeDocker();
    assert.equal((await runnerFor(workspace, installedDocker).processNext()).ok, true);
    const lifecycle = JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8"));
    if (state === "finalizing") {
      lifecycle.state = "finalizing";
      lifecycle.finalizeReason = "developer-requested";
      lifecycle.finalizeRequestedAt = NOW.toISOString();
      await fs.writeFile(workspace.config.lifecycleStatePath, `${JSON.stringify(lifecycle, null, 2)}\n`);
    }
    const afterExpiry = new Date(NOW.getTime() + 15 * 24 * 60 * 60_000);
    workspace.config.bootRecovery = true;
    const bootDocker = new FakeDocker();
    const boot = await runnerFor(workspace, bootDocker, () => new Date(afterExpiry)).processNext();
    assert.equal(boot.ok, true);
    assert.equal(boot.processed, false);
    assert.equal(boot.lifecycle.state, state);
    assert.ok(!bootDocker.commands.some((entry) => entry.operation === "tagImage"
      || (entry.operation === "compose" && entry.args.includes("update-snapshot-cleanup"))));

    workspace.config.bootRecovery = false;
    const daemonDocker = new FakeDocker();
    daemonDocker.activeVersion = "0.1.11";
    daemonDocker.imageTags.set(workspace.config.canonicalActiveImage, NEW_IMAGE);
    daemonDocker.imageTags.set(workspace.config.rollbackImageTag, OLD_IMAGE);
    if (state === "holding") {
      const command = signLifecycleCommand({
        schemaVersion: 1,
        commandId: `finalize-after-boot-${suffix}`,
        action: "finalize",
        holdId: lifecycle.holdId,
        generation: lifecycle.generation,
        issuedAt: afterExpiry.toISOString(),
        expiresAt: new Date(afterExpiry.getTime() + 10 * 60_000).toISOString(),
        nonce: "T".repeat(32),
      }, REQUEST_SECRET, { now: afterExpiry });
      await fs.writeFile(
        path.join(workspace.config.lifecycleRequestsRoot, `${command.commandId}.json`),
        `${JSON.stringify(command, null, 2)}\n`,
      );
    }
    const daemon = await runnerFor(workspace, daemonDocker, () => new Date(afterExpiry)).processNext();
    assert.equal(daemon.ok, true);
    assert.equal(JSON.parse(await fs.readFile(workspace.config.lifecycleStatePath, "utf8")).state, "finalized");
    assert.ok(daemonDocker.commands.some((entry) => entry.operation === "compose"
      && entry.args.includes("update-snapshot-cleanup")));
  }
});

test("journal rolls back a promotion interrupted before the durable commit decision", async (t) => {
  const workspace = await fixture({ requestId: "request-0007", nonce: "G".repeat(32) });
  t.after(workspace.cleanup);
  const firstDocker = new FakeDocker();
  const firstRunner = runnerFor(workspace, firstDocker);
  await firstRunner.initialize();
  const claimed = await firstRunner.claimNextRequest();
  const progressPath = path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`);
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  progress.oldImageId = OLD_IMAGE;
  progress.newImageId = NEW_IMAGE;
  progress.flags.candidateResourcesStarted = true;
  progress.flags.candidateHealthy = true;
  progress.flags.proxyMutationStarted = true;
  progress.flags.proxyOnCandidate = true;
  progress.phase = "promote-active";
  await prepareRecoveryCutover(workspace, progress, { phase: "promoting", decision: null });
  assert.ok(claimed.endsWith(".request.json"));

  const recoveredDocker = new FakeDocker();
  recoveredDocker.activeVersion = "0.1.11";
  recoveredDocker.proxyTarget = "backend-active";
  const result = await runnerFor(workspace, recoveredDocker).processNext();
  assert.equal(result.ok, false);
  assert.equal(result.result.status, "rolled-back");
  assert.equal(result.result.rollback.ok, true);
  assert.equal(recoveredDocker.proxyTarget, "backend-active");
  assert.equal(recoveredDocker.activeVersion, "0.1.10");
  assert.ok(recoveredDocker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("run") && entry.args.includes("update-snapshot-restore")));
  assert.ok(!recoveredDocker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("run") && entry.args.includes("candidate-bootstrap")));
});

test("boot recovery completes a committed target after release expiry using durable claimedAt", async (t) => {
  const workspace = await fixture({ requestId: "request-boot-0001", nonce: "O".repeat(32) });
  t.after(workspace.cleanup);
  const firstRunner = runnerFor(workspace, new FakeDocker());
  await firstRunner.initialize();
  await firstRunner.claimNextRequest();

  const progressPath = path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`);
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  progress.oldImageId = OLD_IMAGE;
  progress.newImageId = NEW_IMAGE;
  progress.flags.candidateResourcesStarted = true;
  progress.flags.candidateHealthy = true;
  progress.phase = "promote-active";
  await prepareRecoveryCutover(workspace, progress, { phase: "commit-decided", decision: "target" });
  await fs.writeFile(workspace.config.networkTransportGatePath, `${JSON.stringify({
    protocol: "bonni-update-network-transport-gate/1",
    schemaVersion: 1,
    state: "open",
    openedAt: NOW.toISOString(),
    reason: "stale-pre-crash-grant",
    runnerVersion: "0.2.0",
  }, null, 2)}\n`);

  workspace.config.bootRecovery = true;
  const observedStarts = [];
  const recoveredDocker = new FakeDocker({
    activeOverlayPath: workspace.config.activeEnvironmentPath,
    beforeActiveStart: async (environment) => {
      const journal = JSON.parse(await fs.readFile(progressPath, "utf8"));
      observedStarts.push({
        environment,
        phase: journal.phase,
        committed: journal.flags.activeOverlayCommitted,
      });
    },
  });
  recoveredDocker.proxyTarget = "stopped";

  const result = await runnerFor(
    workspace,
    recoveredDocker,
    () => new Date("2026-08-22T12:00:00.000Z"),
  ).processNext();

  assert.equal(result.ok, true);
  assert.equal(result.result.status, "completed");
  assert.deepEqual(observedStarts, [{
    environment: { SYSTEM_IMAGE: "bonni_test-system:active", SYSTEM_VERSION: "0.1.11" },
    phase: "active-overlay-committed",
    committed: true,
  }]);
  assert.deepEqual(recoveredDocker.activeOverlayAtStarts, [
    "SYSTEM_IMAGE=bonni_test-system:active\nSYSTEM_VERSION=0.1.11\n",
  ]);
  assert.ok(recoveredDocker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("runtime-proxy")));
  assert.equal(recoveredDocker.proxyHealthCalls, 3);
  await assert.rejects(fs.stat(workspace.config.transactionFencePath), /ENOENT/);
  await assert.rejects(fs.stat(workspace.config.networkTransportGatePath), /ENOENT/);
  assert.ok(!recoveredDocker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("run") && entry.args.includes("update-snapshot-restore")));
});

test("boot recovery aborts a pre-promotion fence without starting Active inside the open transaction", async (t) => {
  const workspace = await fixture({ requestId: "request-prepromote-crash", nonce: "P".repeat(32) });
  t.after(workspace.cleanup);
  const firstRunner = runnerFor(workspace, new FakeDocker());
  await firstRunner.initialize();
  await firstRunner.claimNextRequest();
  const progressPath = path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`);
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  progress.oldImageId = OLD_IMAGE;
  progress.flags.rollbackImagePinned = true;
  progress.flags.candidateResourcesStarted = true;
  progress.flags.candidateHealthy = true;
  progress.flags.writeFenceStarted = true;
  progress.flags.writeFenceActive = true;
  progress.phase = "snapshotting";
  await fs.writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
  await fs.writeFile(workspace.config.transactionFencePath, `${JSON.stringify({
    schemaVersion: 1,
    requestId: workspace.request.requestId,
    workflowId: workspace.request.workflowId,
    currentVersion: workspace.request.currentVersion,
    targetVersion: workspace.request.targetVersion,
    snapshotId: workspace.request.requestId,
    phase: "snapshotting",
    decision: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }, null, 2)}\n`);

  workspace.config.bootRecovery = true;
  const decisionsAtActiveStart = [];
  const docker = new FakeDocker({
    beforeActiveStart: async () => {
      const marker = JSON.parse(await fs.readFile(workspace.config.transactionFencePath, "utf8"));
      decisionsAtActiveStart.push(marker.decision);
    },
  });
  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.equal(result.result.status, "rolled-back");
  assert.deepEqual(decisionsAtActiveStart, ["rollback"]);
  // The old Active may start only as part of rollback; the durable rollback
  // decision is written immediately after its direct health proof and before
  // Emergency/Proxy release.
  const activeStart = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args.includes("backend-active") && entry.args.includes("--force-recreate"));
  const proxyStart = docker.commands.findIndex((entry) => entry.operation === "compose"
    && entry.args.includes("runtime-proxy") && entry.args.includes("up"));
  assert.ok(activeStart >= 0 && proxyStart > activeStart);
  await assert.rejects(fs.stat(workspace.config.transactionFencePath), /ENOENT/);
  assert.ok(!docker.commands.some((entry) => entry.operation === "compose"
    && entry.args.includes("update-snapshot-restore") && entry.args.includes("run")));
});

test("journal recovery restores an Active tag changed by an interrupted image load", async (t) => {
  const workspace = await fixture({ requestId: "request-0013", nonce: "N".repeat(32) });
  t.after(workspace.cleanup);
  const firstRunner = runnerFor(workspace, new FakeDocker());
  await firstRunner.initialize();
  await firstRunner.claimNextRequest();
  const progressPath = path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`);
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  progress.oldImageId = OLD_IMAGE;
  progress.flags.rollbackImagePinned = true;
  progress.flags.canonicalActiveRestoredAfterLoad = false;
  progress.phase = "artifact-loading";
  await fs.writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);

  const recoveredDocker = new FakeDocker();
  recoveredDocker.imageTags.set(workspace.config.rollbackImageTag, OLD_IMAGE);
  recoveredDocker.imageTags.set(workspace.config.canonicalActiveImage, NEW_IMAGE);
  const result = await runnerFor(workspace, recoveredDocker).processNext();

  assert.equal(result.ok, true);
  const loadIndex = recoveredDocker.commands.findIndex((entry) => entry.operation === "loadImage");
  const restoreIndex = recoveredDocker.commands.findIndex((entry) => entry.operation === "tagImage"
    && entry.imageId === workspace.config.rollbackImageTag
    && entry.target === workspace.config.canonicalActiveImage);
  assert.ok(restoreIndex >= 0 && restoreIndex < loadIndex);
  assert.equal(recoveredDocker.imageTags.get(workspace.config.rollbackImageTag), OLD_IMAGE);
  assert.equal(recoveredDocker.imageTags.get(workspace.config.canonicalActiveImage), NEW_IMAGE);
});

test("a corrupt private claim is quarantined instead of blocking later runner starts", async (t) => {
  const workspace = await fixture({ requestId: "request-0010", nonce: "K".repeat(32) });
  t.after(workspace.cleanup);
  const docker = new FakeDocker();
  const firstRunner = runnerFor(workspace, docker);
  await firstRunner.initialize();
  const claimed = await firstRunner.claimNextRequest();
  await fs.unlink(path.join(workspace.config.journalRoot, `${workspace.request.requestId}.json`));
  await fs.writeFile(claimed, "{invalid-json");

  const result = await runnerFor(workspace, docker).processNext();

  assert.equal(result.ok, false);
  assert.equal(result.processed, true);
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.phase, "claim-quarantined");
  assertNoDockerMutation(docker);
  const remainingClaims = await fs.readdir(workspace.config.claimedRoot);
  assert.ok(!remainingClaims.includes(`${workspace.request.requestId}.request.json`));
  assert.ok(remainingClaims.some((name) => name.startsWith(`${workspace.request.requestId}.request.json.failed-`)));
});

test("Docker CLI supplies fixed argument arrays, ordered env overlays and never requests a shell", async (t) => {
  const calls = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-docker-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const baseEnvironmentFile = path.join(directory, "runtime.env");
  const activeEnvironmentFile = path.join(directory, "active.env");
  await fs.writeFile(baseEnvironmentFile, "MASTER_KEY=base-secret\n", { mode: 0o600 });
  await fs.writeFile(activeEnvironmentFile, "SYSTEM_VERSION=0.1.11\n", { mode: 0o600 });
  const docker = new DockerCli({
    binary: "/trusted/docker",
    composeFile: "/project/SYSTEM/backend/docker-compose.runtime.yml",
    project: "bonni_project",
    baseEnvironmentFile,
    activeEnvironmentFile,
    cwd: "/project/SYSTEM/backend",
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await docker.compose(["up", "-d", "--no-deps", "backend-active"], { env: { SYSTEM_VERSION: "0.1.11" } });
  assert.equal(calls[0].command, "/trusted/docker");
  assert.deepEqual(calls[0].args, [
    "compose", "-p", "bonni_project",
    "--env-file", baseEnvironmentFile,
    "--env-file", activeEnvironmentFile,
    "-f", "/project/SYSTEM/backend/docker-compose.runtime.yml",
    "up", "-d", "--no-deps", "backend-active",
  ]);
  assert.equal(calls[0].options.cwd, "/project/SYSTEM/backend");
  assert.equal(calls[0].options.env.SYSTEM_VERSION, "0.1.11");
});

test("Compose project discovery verifies the configured project against its own container label", async () => {
  const matchingDocker = { run: async () => ({ stdout: "bonni_project" }) };
  assert.equal(await discoverComposeProject({
    docker: matchingDocker, hostname: "runner-container", configuredProject: "bonni_project",
  }), "bonni_project");
  await assert.rejects(
    discoverComposeProject({
      docker: { run: async () => ({ stdout: "other_project" }) },
      hostname: "runner-container",
      configuredProject: "bonni_project",
    }),
    /stimmt nicht/,
  );
});

test("runner config honors separated shared update and private runner roots", () => {
  const config = createUpdateRunnerConfig({
    BONNI_HOST_PROJECT_ROOT: "/project",
    BONNI_UPDATE_STORAGE_ROOT: "/shared/storage/system/update-center",
    BONNI_UPDATE_RUNNER_STATE_ROOT: "/shared/ipc/update-runner",
    BONNI_UPDATE_RUNNER_PRIVATE_STATE_ROOT: "/private/update-runner",
    COMPOSE_PROJECT_NAME: "bonni_project",
  });
  assert.equal(config.storageRoot, "/shared/storage");
  assert.equal(config.updateCenterRoot, "/shared/storage/system/update-center");
  assert.equal(config.ipcRoot, "/shared/ipc/update-runner");
  assert.equal(config.privateRoot, "/private/update-runner");
  assert.equal(config.requestsRoot, "/shared/ipc/update-runner/requests");
  assert.equal(config.journalRoot, "/private/update-runner/journal");
});

test("runner rejects aliased private state and any hold other than exact 14 days", () => {
  assert.throws(() => createUpdateRunnerConfig({
    BONNI_HOST_PROJECT_ROOT: "/project",
    BONNI_STORAGE_ROOT: "/shared/storage",
    BONNI_UPDATE_RUNNER_PRIVATE_STATE_ROOT: "/shared/storage/private",
    COMPOSE_PROJECT_NAME: "bonni_project",
  }), /vollständig von Produktions-Storage und IPC getrennt/);
  assert.throws(() => createUpdateRunnerConfig({
    BONNI_HOST_PROJECT_ROOT: "/project",
    BONNI_STORAGE_ROOT: "/shared/storage",
    BONNI_UPDATE_RUNNER_PRIVATE_STATE_ROOT: "/private/update-runner",
    SYSTEM_EMERGENCY_HOLD_DAYS: "13",
    COMPOSE_PROJECT_NAME: "bonni_project",
  }), /exakt 14/);
});

test("runner rejects a symlink alias from private state into shared IPC", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-private-alias-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, "storage");
  const ipc = path.join(root, "ipc");
  const privateAlias = path.join(root, "private-alias");
  await fs.mkdir(storage, { recursive: true });
  await fs.mkdir(ipc, { recursive: true });
  await fs.symlink(ipc, privateAlias, "dir");
  const config = createUpdateRunnerConfig({
    BONNI_HOST_PROJECT_ROOT: root,
    BONNI_STORAGE_ROOT: storage,
    BONNI_UPDATE_RUNNER_STATE_ROOT: ipc,
    BONNI_UPDATE_RUNNER_PRIVATE_STATE_ROOT: privateAlias,
    COMPOSE_PROJECT_NAME: "bonni_test",
    BONNI_ACTIVE_IMAGE_TAG: "bonni_test-system:active",
    BONNI_ROLLBACK_IMAGE_TAG: "bonni_test-system:rollback",
  });
  const runner = new UpdateRunner({
    config,
    docker: new FakeDocker(),
    trustedKeys: { "test-release-key": "configured" },
    requestSecret: REQUEST_SECRET,
  });
  await assert.rejects(() => runner.initialize(), /echte Verzeichnisse|real nicht/);
});

test("runner refuses cross-instance Active and Rollback tags", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-tag-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const makeRunner = (active, rollback) => new UpdateRunner({
    config: createUpdateRunnerConfig({
      BONNI_HOST_PROJECT_ROOT: root,
      BONNI_STORAGE_ROOT: path.join(root, "storage"),
      COMPOSE_PROJECT_NAME: "bonni_test",
      BONNI_ACTIVE_IMAGE_TAG: active,
      BONNI_ROLLBACK_IMAGE_TAG: rollback,
    }),
    docker: {},
    trustedKeys: { release: "configured" },
    requestSecret: REQUEST_SECRET,
  });
  await assert.rejects(
    makeRunner("other-system:active", "bonni_test-system:rollback").initialize(),
    /BONNI_ACTIVE_IMAGE_TAG muss exakt projektgescopt/,
  );
  await assert.rejects(
    makeRunner("bonni_test-system:active", "other-system:rollback").initialize(),
    /BONNI_ROLLBACK_IMAGE_TAG muss exakt projektgescopt/,
  );
});

test("Docker CLI removes only project-scoped volumes carrying all disposable labels", async () => {
  const calls = [];
  const docker = new DockerCli({
    binary: "docker",
    composeFile: "/project/SYSTEM/backend/docker-compose.runtime.yml",
    project: "bonni_project",
    execute: async (_command, args) => {
      calls.push(args);
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            "org.bonni.runtime.disposable": "true",
            "com.docker.compose.project": "bonni_project",
            "com.docker.compose.volume": "candidate_storage",
          }),
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(await docker.removeDisposableVolume(
    "bonni_project_candidate_storage", "bonni_project", "candidate_storage",
  ), true);
  assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));

  const refusing = new DockerCli({
    binary: "docker",
    composeFile: "/project/SYSTEM/backend/docker-compose.runtime.yml",
    project: "bonni_project",
    execute: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ "org.bonni.runtime.disposable": "false" }) }),
  });
  await assert.rejects(
    refusing.removeDisposableVolume("bonni_project_postgres_data", "bonni_project", "postgres_data"),
    /verweigert/,
  );
});
