import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertBootstrapLifecycleGate,
  assertNoActiveDockerHold,
  assertNoActiveLocalSourceHold,
} from "../../../installer/bonni-local-update-bootstrap.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-update-bootstrap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "SYSTEM", "backend"), { recursive: true });
  await fs.writeFile(path.join(root, "SYSTEM", "backend", "package.json"), '{"version":"0.1.19+a"}\n');
  return root;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function localLifecycle(status = "holding") {
  const active = status === "holding" || status === "rolling-back";
  return {
    schemaVersion: "bonni.local-source-deployment-lifecycle/v1",
    protocol: "bonni-deployment-lifecycle/1",
    mode: "local-source",
    status,
    state: status,
    generation: 1,
    holdId: "local-bootstrap-hold-01",
    previousVersion: "0.1.19+a",
    targetVersion: "0.1.19+b",
    blocksUpdates: active,
    followUpdatesBlocked: active,
    canFinalize: status === "holding",
    canRollback: status === "holding",
  };
}

function dockerLifecycle(state = "holding") {
  return {
    protocol: "bonni-deployment-lifecycle/1",
    schemaVersion: 1,
    generation: 3,
    state,
    holdId: state === "idle" ? undefined : "docker-bootstrap-hold-01",
    holdDays: state === "idle" ? undefined : 14,
    holdUntil: state === "idle" ? undefined : "2026-09-05T12:00:00.000Z",
    observedHoldMs: 0,
    autoFinalizeBlocked: state === "holding",
    blocksUpdates: !["idle", "finalized"].includes(state),
    canFinalize: state === "holding",
    mode: "single-active-fail-closed-hold",
    updatedAt: "2026-08-22T12:00:00.000Z",
  };
}

test("Bootstrap akzeptiert einen nicht eingerichteten und unzuständigen Docker-Pfad", { concurrency: false }, async (t) => {
  const root = await fixture(t);
  const runnerRoot = path.join(root, "runner");
  const previous = process.env.BONNI_UPDATE_RUNNER_STATE_ROOT;
  process.env.BONNI_UPDATE_RUNNER_STATE_ROOT = runnerRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.BONNI_UPDATE_RUNNER_STATE_ROOT;
    else process.env.BONNI_UPDATE_RUNNER_STATE_ROOT = previous;
  });

  assert.deepEqual(await assertBootstrapLifecycleGate(root, Date.parse("2026-08-22T12:00:00.000Z")), {
    local: { authority: "absent", blocksUpdates: false },
    docker: { authority: "absent", blocksUpdates: false },
  });
});

test("Bootstrap lehnt einen echten lokalen Hold ohne Änderungen an Statusdateien ab", { concurrency: false }, async (t) => {
  const root = await fixture(t);
  const lifecycleFile = path.join(root, "SYSTEM", ".bonni-source-update", "deployment-lifecycle.json");
  const lifecycle = localLifecycle();
  await writeJson(lifecycleFile, lifecycle);

  await assert.rejects(
    assertNoActiveLocalSourceHold(root),
    (error) => error?.code === "LOCAL_DEPLOYMENT_HOLD_ACTIVE",
  );
  assert.deepEqual(JSON.parse(await fs.readFile(lifecycleFile, "utf8")), lifecycle);
});

test("Bootstrap lehnt echten Docker-Hold, ungültigen Beleg und lebenden Runner ohne Beleg ab", { concurrency: false }, async (t) => {
  const root = await fixture(t);
  const runnerRoot = path.join(root, "runner");
  const backendRoot = path.join(root, "SYSTEM", "backend");
  const previous = process.env.BONNI_UPDATE_RUNNER_STATE_ROOT;
  process.env.BONNI_UPDATE_RUNNER_STATE_ROOT = runnerRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.BONNI_UPDATE_RUNNER_STATE_ROOT;
    else process.env.BONNI_UPDATE_RUNNER_STATE_ROOT = previous;
  });

  await writeJson(path.join(runnerRoot, "deployment-lifecycle.json"), dockerLifecycle("holding"));
  await assert.rejects(
    assertNoActiveDockerHold(backendRoot, Date.parse("2026-08-22T12:00:00.000Z")),
    (error) => error?.code === "RUNNER_DEPLOYMENT_HOLD_ACTIVE",
  );

  await fs.writeFile(path.join(runnerRoot, "deployment-lifecycle.json"), "{invalid\n");
  await assert.rejects(
    assertNoActiveDockerHold(backendRoot, Date.parse("2026-08-22T12:00:00.000Z")),
    (error) => error?.code === "RUNNER_DEPLOYMENT_LIFECYCLE_INVALID",
  );

  await fs.rm(path.join(runnerRoot, "deployment-lifecycle.json"));
  await writeJson(path.join(runnerRoot, "heartbeat.json"), {
    updatedAt: "2026-08-22T12:00:00.000Z",
  });
  await assert.rejects(
    assertNoActiveDockerHold(backendRoot, Date.parse("2026-08-22T12:00:05.000Z")),
    (error) => error?.code === "RUNNER_DEPLOYMENT_LIFECYCLE_MISSING",
  );
});

test("Bootstrap verwendet ausschließlich Backup und lokalen Supervisorauftrag", async () => {
  const [bootstrap, launcher, supervisor] = await Promise.all([
    fs.readFile(new URL("../../../installer/bonni-local-update-bootstrap.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../installer/BONNI-UPDATE-11-BOOTSTRAP-STARTEN.cmd", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/setup/local-source-update-supervisor.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(bootstrap, /createSystemBackup\(\{ reason: backupReason \}\)/u);
  assert.match(bootstrap, /validateSystemBackup\(created\.backup\.id\)/u);
  assert.match(bootstrap, /inbox\.queueLocalSourceUpdate\(\{/u);
  assert.doesNotMatch(bootstrap, /npm run update/u);
  assert.doesNotMatch(bootstrap, /fs\.rm\([^)]*deployment-lifecycle/u);
  assert.match(supervisor, /BONNI_UPDATE_DEFER_FINALIZE: "1"/u);
  assert.match(launcher, /--target "0\.1\.19\+b"/u);
});
