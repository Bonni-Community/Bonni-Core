import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCutoverSnapshot,
  restoreCutoverSnapshot,
  verifyCutoverSnapshot as verifySnapshotInImage,
} from "../scripts/backup/update-cutover-snapshot-lib.mjs";
import {
  verifyCutoverRestoreResult,
  verifyCutoverSnapshot as verifySnapshotInRunner,
} from "../src/system/update-runner/snapshot-verifier.mjs";

const SNAPSHOT_ID = "request-cutover-0001";
const WORKFLOW_ID = "workflow-cutover-0001";
const BACKUP_ID = "backup-cutover-0001";
const VERSION = "0.1.11";
const RESTORE_ATTEMPT_ID = "restore-attempt-cutover-0001";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-cutover-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceStorage = path.join(root, "production-storage");
  const sourceRunSystem = path.join(root, "production-run-system");
  const snapshotBase = path.join(root, "private-snapshots");
  const resultBase = path.join(root, "private-restore-results");
  const targetStorage = path.join(root, "restore-storage");
  const targetRunSystem = path.join(root, "restore-run-system");
  await fs.mkdir(path.join(sourceStorage, "media", "nested"), { recursive: true });
  await fs.mkdir(path.join(sourceStorage, "empty"), { recursive: true });
  await fs.mkdir(path.join(sourceRunSystem, "system", "active"), { recursive: true });
  await fs.writeFile(path.join(sourceStorage, "media", "receipt.bin"), Buffer.from([0, 1, 2, 3, 255]));
  await fs.writeFile(path.join(sourceStorage, "media", "nested", "note.txt"), "vor dem Update\n");
  await fs.writeFile(path.join(sourceRunSystem, "system", "active", "runtime.json"), "{\"state\":\"old\"}\n");
  await fs.chmod(path.join(sourceStorage, "media", "nested", "note.txt"), 0o640);
  await fs.mkdir(targetStorage, { recursive: true });
  await fs.mkdir(targetRunSystem, { recursive: true });
  return { root, sourceStorage, sourceRunSystem, snapshotBase, resultBase, targetStorage, targetRunSystem };
}

function metadata(workspace) {
  return {
    snapshotBase: workspace.snapshotBase,
    snapshotId: SNAPSHOT_ID,
    workflowId: WORKFLOW_ID,
    backupId: BACKUP_ID,
    currentVersion: VERSION,
  };
}

test("cutover snapshot captures DB, storage and run_system outside production and is idempotent", async (context) => {
  const workspace = await fixture(context);
  let dumps = 0;
  const options = {
    ...metadata(workspace),
    sourceStorage: workspace.sourceStorage,
    sourceRunSystem: workspace.sourceRunSystem,
    now: new Date("2026-07-22T18:00:00.000Z"),
    dumpDatabase: async (target) => {
      dumps += 1;
      await fs.writeFile(target, "PGDMP\0consistent-database-snapshot");
    },
    validateDatabaseDump: async (target) => assert.match(await fs.readFile(target, "utf8"), /^PGDMP/),
  };

  const created = await createCutoverSnapshot(options);
  assert.equal(created.reused, false);
  assert.equal(dumps, 1);
  assert.equal(created.manifest.backupId, BACKUP_ID);
  assert.ok(created.manifest.files.some((entry) => entry.path === "database/database.dump"));
  assert.ok(created.manifest.files.some((entry) => entry.path === "storage/empty" && entry.kind === "directory"));
  assert.ok(created.manifest.files.some((entry) => entry.path === "run-system/system/active/runtime.json"));
  assert.ok(!created.root.startsWith(workspace.sourceStorage));

  const runnerVerified = await verifySnapshotInRunner(metadata(workspace));
  assert.equal(runnerVerified.manifestSha256, created.manifestSha256);
  const reused = await createCutoverSnapshot(options);
  assert.equal(reused.reused, true);
  assert.equal(dumps, 1);
});

test("rollback restore removes post-snapshot files and restores all three data planes before success", async (context) => {
  const workspace = await fixture(context);
  await createCutoverSnapshot({
    ...metadata(workspace),
    sourceStorage: workspace.sourceStorage,
    sourceRunSystem: workspace.sourceRunSystem,
    dumpDatabase: async (target) => fs.writeFile(target, "PGDMP\0database-before-update"),
  });
  await fs.writeFile(path.join(workspace.targetStorage, "created-by-bad-release.txt"), "must disappear");
  await fs.writeFile(path.join(workspace.targetRunSystem, "created-by-bad-release.json"), "{}\n");
  const databaseCalls = [];

  const restored = await restoreCutoverSnapshot({
    ...metadata(workspace),
    resultBase: workspace.resultBase,
    restoreAttemptId: RESTORE_ATTEMPT_ID,
    targetStorage: workspace.targetStorage,
    targetRunSystem: workspace.targetRunSystem,
    allowedTargetStorage: workspace.targetStorage,
    allowedTargetRunSystem: workspace.targetRunSystem,
    validateDatabaseDump: async (target) => databaseCalls.push(["validate", await fs.readFile(target, "utf8")]),
    restoreDatabase: async (target) => databaseCalls.push(["restore", await fs.readFile(target, "utf8")]),
    now: new Date("2026-07-22T18:05:00.000Z"),
  });

  assert.deepEqual(databaseCalls.map(([operation]) => operation), ["validate", "restore"]);
  assert.equal(await fs.readFile(path.join(workspace.targetStorage, "media", "nested", "note.txt"), "utf8"), "vor dem Update\n");
  assert.equal(await fs.readFile(path.join(workspace.targetRunSystem, "system", "active", "runtime.json"), "utf8"), "{\"state\":\"old\"}\n");
  await assert.rejects(fs.stat(path.join(workspace.targetStorage, "created-by-bad-release.txt")), /ENOENT/);
  await assert.rejects(fs.stat(path.join(workspace.targetRunSystem, "created-by-bad-release.json")), /ENOENT/);
  assert.equal(restored.result.manifestSha256, restored.manifestSha256);
  const runnerResult = await verifyCutoverRestoreResult({
    ...metadata(workspace),
    resultBase: workspace.resultBase,
    restoreAttemptId: RESTORE_ATTEMPT_ID,
  });
  assert.equal(runnerResult.result.ok, true);
  await assert.rejects(
    verifyCutoverRestoreResult({
      ...metadata(workspace),
      resultBase: workspace.resultBase,
      restoreAttemptId: "restore-attempt-cutover-stale",
    }),
    /CUTOVER_RESTORE_RESULT_INVALID/,
  );
});

test("tampered snapshot fails closed before database restore or production deletion", async (context) => {
  const workspace = await fixture(context);
  const created = await createCutoverSnapshot({
    ...metadata(workspace),
    sourceStorage: workspace.sourceStorage,
    sourceRunSystem: workspace.sourceRunSystem,
    dumpDatabase: async (target) => fs.writeFile(target, "PGDMP\0database-before-update"),
  });
  await fs.appendFile(path.join(created.root, "storage", "media", "nested", "note.txt"), "tampered");
  await fs.writeFile(path.join(workspace.targetStorage, "sentinel.txt"), "keep-on-failure");
  let databaseRestored = false;

  await assert.rejects(
    restoreCutoverSnapshot({
      ...metadata(workspace),
      resultBase: workspace.resultBase,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      targetStorage: workspace.targetStorage,
      targetRunSystem: workspace.targetRunSystem,
      allowedTargetStorage: workspace.targetStorage,
      allowedTargetRunSystem: workspace.targetRunSystem,
      restoreDatabase: async () => { databaseRestored = true; },
    }),
    /Snapshot-Prüfung fehlgeschlagen|Inventar/,
  );
  assert.equal(databaseRestored, false);
  assert.equal(await fs.readFile(path.join(workspace.targetStorage, "sentinel.txt"), "utf8"), "keep-on-failure");
  await assert.rejects(verifySnapshotInImage(metadata(workspace)));
  await assert.rejects(verifySnapshotInRunner(metadata(workspace)));
});

test("snapshot creation rejects symlinks instead of silently omitting production data", async (context) => {
  const workspace = await fixture(context);
  await fs.symlink(path.join(workspace.sourceStorage, "media", "receipt.bin"), path.join(workspace.sourceStorage, "media", "receipt-link"));
  await assert.rejects(
    createCutoverSnapshot({
      ...metadata(workspace),
      sourceStorage: workspace.sourceStorage,
      sourceRunSystem: workspace.sourceRunSystem,
      dumpDatabase: async (target) => fs.writeFile(target, "PGDMP\0database-before-update"),
    }),
    /Symbolischer Link/,
  );
});
