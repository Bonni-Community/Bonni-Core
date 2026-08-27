import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const serviceFile = new URL(
  "../src/system/routes/control-api/update-center/local-source-deployment.service.ts",
  import.meta.url,
);
const lifecyclePolicyFile = new URL(
  "../src/system/routes/control-api/update-center/local-source-lifecycle-policy.ts",
  import.meta.url,
);
const HOLD_MS = 14 * 24 * 60 * 60_000;

async function exists(target) {
  return fs.lstat(target).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function importService(hooks) {
  const hookName = `__bonniLifecycleTest${crypto.randomBytes(8).toString("hex")}`;
  const policySource = await fs.readFile(lifecyclePolicyFile, "utf8");
  const policyJavascript = stripTypeScriptTypes(policySource, { mode: "transform" });
  const policy = await import(
    `data:text/javascript;base64,${Buffer.from(policyJavascript).toString("base64")}#${hookName}-policy`
  );
  globalThis[hookName] = {
    ...hooks,
    localSourceVersionRequiresLifecycle: policy.localSourceVersionRequiresLifecycle,
  };
  let source = await fs.readFile(serviceFile, "utf8");
  source = source
    .replace(
      'import { getProjectRoot } from "../../../boot/run-system/run-system.paths.js";',
      `const getProjectRoot = () => globalThis[${JSON.stringify(hookName)}].projectRoot;`,
    )
    .replace(
      'import { createSystemBackup, validateSystemBackup } from "../backup/index.js";',
      [
        `const createSystemBackup = (...args) => globalThis[${JSON.stringify(hookName)}].createSystemBackup(...args);`,
        `const validateSystemBackup = (...args) => globalThis[${JSON.stringify(hookName)}].validateSystemBackup(...args);`,
      ].join("\n"),
    )
    .replace(
      'import { queueLocalSourceUpdate } from "./local-source-inbox.service.js";',
      `const queueLocalSourceUpdate = (...args) => globalThis[${JSON.stringify(hookName)}].queueLocalSourceUpdate(...args);`,
    )
    .replace(
      'import { localSourceVersionRequiresLifecycle } from "./local-source-lifecycle-policy.js";',
      `const localSourceVersionRequiresLifecycle = (...args) => globalThis[${JSON.stringify(hookName)}].localSourceVersionRequiresLifecycle(...args);`,
    );
  const javascript = stripTypeScriptTypes(source, { mode: "transform" });
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${hookName}`);
}

async function createFixture(t, overrides = {}) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-lifecycle-coordination-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const stateRoot = path.join(projectRoot, "SYSTEM", ".bonni-source-update");
  const inbox = path.join(projectRoot, "UPDATE", "inbox");
  const holdId = "local-hold-test-0001";
  const rollbackUpdateId = "u-test-rollback-0001";
  const packageRoot = path.join(stateRoot, "deployment-holds", holdId, "package");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(inbox, { recursive: true });
  const manifest = Buffer.from(`${JSON.stringify({ updateId: rollbackUpdateId, files: [], delete: [] }, null, 2)}\n`);
  await fs.writeFile(path.join(packageRoot, "bonni-source-update.json"), manifest);
  const rollbackManifestSha256 = crypto.createHash("sha256").update(manifest).digest("hex");
  const activatedAtMs = Date.now() - 60_000;
  const lifecycle = {
    schemaVersion: "bonni.local-source-deployment-lifecycle/v1",
    protocol: "bonni-deployment-lifecycle/1",
    mode: "local-source",
    status: "holding",
    state: "holding",
    generation: 1,
    holdId,
    holdDays: 14,
    activatedAt: new Date(activatedAtMs).toISOString(),
    holdUntil: new Date(activatedAtMs + HOLD_MS).toISOString(),
    previousVersion: "0.1.19+a",
    targetVersion: "0.1.19+b",
    activeVersion: "0.1.19+b",
    sourceUpdateId: "u-test-forward-0001",
    sourceManifestSha256: "a".repeat(64),
    rollbackUpdateId,
    rollbackManifestSha256,
    holdPath: `deployment-holds/${holdId}`,
    blocksUpdates: true,
    followUpdatesBlocked: true,
    canFinalize: true,
    canRollback: true,
    blockReason: "Funktionsprüfung läuft.",
    ...overrides.lifecycle,
  };
  const lifecycleSource = `${JSON.stringify(lifecycle, null, 2)}\n`;
  const lifecycleSha256 = crypto.createHash("sha256").update(lifecycleSource).digest("hex");
  await fs.writeFile(path.join(stateRoot, "deployment-lifecycle.json"), lifecycleSource);
  await fs.writeFile(path.join(stateRoot, "active-manifest.json"), `${JSON.stringify({
    updateId: lifecycle.sourceUpdateId,
    manifestSha256: lifecycle.sourceManifestSha256,
    versions: { coreVersion: lifecycle.targetVersion, kontorAppVersion: "0.19.3" },
  }, null, 2)}\n`);

  const queueLocalSourceUpdate = overrides.queueLocalSourceUpdate || (async (identity) => {
    const controlRoot = path.join(stateRoot, "control-center");
    await fs.mkdir(controlRoot, { recursive: true });
    await fs.writeFile(path.join(controlRoot, "request.json"), `${JSON.stringify(identity)}\n`);
    return { ok: true, accepted: true, requestId: "rollback-request-test-0001" };
  });
  const hooks = {
    projectRoot,
    createSystemBackup: overrides.createSystemBackup || (async () => ({
      ok: true,
      backup: { id: "backup-test-0001" },
    })),
    validateSystemBackup: overrides.validateSystemBackup || (async () => ({
      ok: true,
      id: "backup-test-0001",
      backup: {
        id: "backup-test-0001",
        reason: `before-local-source-rollback:${rollbackUpdateId}:${rollbackManifestSha256}`,
      },
    })),
    queueLocalSourceUpdate,
  };
  return {
    projectRoot,
    stateRoot,
    inbox,
    packageRoot,
    lifecycle,
    lifecycleSha256,
    rollbackManifestSha256,
    hooks,
  };
}

test("finalize and rollback share one exclusive lock and stale proof cannot win", async (t) => {
  let enterBackup;
  let releaseBackup;
  const backupEntered = new Promise((resolve) => { enterBackup = resolve; });
  const backupRelease = new Promise((resolve) => { releaseBackup = resolve; });
  const fixture = await createFixture(t, {
    createSystemBackup: async () => {
      enterBackup();
      await backupRelease;
      return { ok: true, backup: { id: "backup-test-0001" } };
    },
  });
  const service = await importService(fixture.hooks);
  const proof = { holdId: fixture.lifecycle.holdId, generation: fixture.lifecycle.generation };

  const rollback = service.rollbackLocalSourceDeploymentLifecycle(proof);
  await backupEntered;
  let finalizeSettled = false;
  const finalize = service.finalizeLocalSourceDeploymentLifecycle(proof)
    .finally(() => { finalizeSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(finalizeSettled, false, "finalize must wait for the rollback lock");

  releaseBackup();
  const rollbackResult = await rollback;
  assert.equal(rollbackResult.ok, true);
  await assert.rejects(finalize, /LOCAL_DEPLOYMENT_LIFECYCLE_PROOF_MISMATCH/u);
  const persisted = JSON.parse(await fs.readFile(path.join(fixture.stateRoot, "deployment-lifecycle.json"), "utf8"));
  assert.equal(persisted.status, "rolling-back");
  assert.equal(persisted.generation, 2);
  assert.equal(await exists(path.join(fixture.stateRoot, "rollback-intent.json")), false);
});

test("a crash during staging is reconciled without publishing an inbox package", async (t) => {
  const fixture = await createFixture(t);
  const intentId = "rollback-staging-test-0001";
  const stagingRoot = path.join(fixture.stateRoot, "rollback-staging", intentId);
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(path.join(stagingRoot, "partial.bin"), "partial");
  const now = new Date().toISOString();
  await fs.writeFile(path.join(fixture.stateRoot, "rollback-intent.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-deployment-rollback-intent/v1",
    intentId,
    phase: "staging",
    holdId: fixture.lifecycle.holdId,
    lifecycleGeneration: 1,
    lifecycleSha256: fixture.lifecycleSha256,
    rollbackUpdateId: fixture.lifecycle.rollbackUpdateId,
    rollbackManifestSha256: fixture.rollbackManifestSha256,
    backupId: "backup-test-0001",
    createdAt: now,
    updatedAt: now,
  }, null, 2)}\n`);
  const service = await importService(fixture.hooks);

  const status = await service.getLocalSourceDeploymentLifecycle();
  assert.equal(status.status, "holding");
  assert.equal(await exists(stagingRoot), false);
  assert.equal(await exists(path.join(fixture.stateRoot, "rollback-intent.json")), false);
  assert.deepEqual(await fs.readdir(fixture.inbox), []);
});

test("a published rollback intent is reconciled into an exact queued request", async (t) => {
  const intentId = "rollback-published-test-0001";
  const fixture = await createFixture(t, {
    lifecycle: {
      status: "rolling-back",
      state: "rolling-back",
      generation: 2,
      canFinalize: false,
      canRollback: false,
      rollbackIntentId: intentId,
    },
  });
  const target = path.join(fixture.inbox, fixture.lifecycle.rollbackUpdateId);
  await fs.cp(fixture.packageRoot, target, { recursive: true, errorOnExist: true, force: false });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(fixture.stateRoot, "rollback-intent.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-deployment-rollback-intent/v1",
    intentId,
    phase: "published",
    holdId: fixture.lifecycle.holdId,
    lifecycleGeneration: 1,
    lifecycleSha256: fixture.lifecycleSha256,
    rollbackUpdateId: fixture.lifecycle.rollbackUpdateId,
    rollbackManifestSha256: fixture.rollbackManifestSha256,
    backupId: "backup-test-0001",
    createdAt: now,
    updatedAt: now,
  }, null, 2)}\n`);
  const service = await importService(fixture.hooks);

  const status = await service.getLocalSourceDeploymentLifecycle();
  assert.equal(status.status, "rolling-back");
  const request = JSON.parse(await fs.readFile(path.join(fixture.stateRoot, "control-center", "request.json"), "utf8"));
  assert.equal(request.updateId, fixture.lifecycle.rollbackUpdateId);
  assert.equal(request.manifestSha256, fixture.rollbackManifestSha256);
  assert.equal(await exists(path.join(fixture.stateRoot, "rollback-intent.json")), false);
  assert.equal(await exists(target), true, "the exact queued package remains owned by the supervisor request");
});

test("the supervisor claim window binds request.processing.json by exact update ID and hash", async (t) => {
  const intentId = "rollback-processing-test-0001";
  let queueCalls = 0;
  const fixture = await createFixture(t, {
    lifecycle: {
      status: "rolling-back",
      state: "rolling-back",
      generation: 2,
      canFinalize: false,
      canRollback: false,
      rollbackIntentId: intentId,
    },
    queueLocalSourceUpdate: async () => {
      queueCalls += 1;
      throw new Error("queue must not run after the supervisor claimed the exact request");
    },
  });
  const target = path.join(fixture.inbox, fixture.lifecycle.rollbackUpdateId);
  await fs.cp(fixture.packageRoot, target, { recursive: true, errorOnExist: true, force: false });
  const controlRoot = path.join(fixture.stateRoot, "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  await fs.writeFile(path.join(controlRoot, "request.processing.json"), `${JSON.stringify({
    updateId: fixture.lifecycle.rollbackUpdateId,
    manifestSha256: fixture.rollbackManifestSha256,
  })}\n`);
  const now = new Date().toISOString();
  await fs.writeFile(path.join(fixture.stateRoot, "rollback-intent.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-deployment-rollback-intent/v1",
    intentId,
    phase: "published",
    holdId: fixture.lifecycle.holdId,
    lifecycleGeneration: 1,
    lifecycleSha256: fixture.lifecycleSha256,
    rollbackUpdateId: fixture.lifecycle.rollbackUpdateId,
    rollbackManifestSha256: fixture.rollbackManifestSha256,
    backupId: "backup-test-0001",
    createdAt: now,
    updatedAt: now,
  }, null, 2)}\n`);
  const service = await importService(fixture.hooks);

  const status = await service.getLocalSourceDeploymentLifecycle();
  assert.equal(status.status, "rolling-back");
  assert.equal(queueCalls, 0);
  assert.equal(await exists(path.join(fixture.stateRoot, "rollback-intent.json")), false);
  assert.equal(await exists(target), true, "the claimed package remains owned by request.processing.json");
});

test("digest CAS detects an out-of-band lifecycle replacement before publication", async (t) => {
  let fixture;
  fixture = await createFixture(t, {
    createSystemBackup: async () => {
      const lifecycleFile = path.join(fixture.stateRoot, "deployment-lifecycle.json");
      const replacement = { ...fixture.lifecycle, blockReason: "externally replaced" };
      await fs.writeFile(lifecycleFile, `${JSON.stringify(replacement, null, 2)}\n`);
      return { ok: true, backup: { id: "backup-test-0001" } };
    },
  });
  const service = await importService(fixture.hooks);
  const proof = { holdId: fixture.lifecycle.holdId, generation: 1 };

  await assert.rejects(
    service.rollbackLocalSourceDeploymentLifecycle(proof),
    /LOCAL_DEPLOYMENT_LIFECYCLE_CAS_CONFLICT/u,
  );
  assert.deepEqual(await fs.readdir(fixture.inbox), []);
  assert.equal(await exists(path.join(fixture.stateRoot, "rollback-intent.json")), true);
});
