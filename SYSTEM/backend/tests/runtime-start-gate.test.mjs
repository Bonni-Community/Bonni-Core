import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bootGateTerminalIsSafe } from "../ops/update-runner/boot-gate-policy.mjs";
import {
  acquireDockerRuntimeActivation,
  acquireDockerRuntimeDeactivationIntent,
  acquireLocalHostBackendRuntimeLease,
  assertDockerRuntimeActivationInactive,
  assertNoLiveLocalSourceRuntime,
  releaseDockerRuntimeActivation,
  releaseDockerRuntimeDeactivationIntent,
} from "../scripts/runtime/runtime-mode-exclusion.mjs";

const run = promisify(execFile);
const repositoryRoot = path.resolve(".");

async function runtimeFixture({ failGate = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-gate-"));
  const projectRoot = path.join(root, "project");
  const backendRoot = path.join(projectRoot, "System", "backend");
  const runtimeRoot = path.join(projectRoot, "runtime");
  const runSystemRoot = path.join(projectRoot, "run_system");
  const fakeBin = path.join(root, "bin");
  const logPath = path.join(root, "docker.log");
  const environmentPath = path.join(backendRoot, ".env");
  await fs.mkdir(backendRoot, { recursive: true });
  await fs.mkdir(runSystemRoot, { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(environmentPath, [
    "COMPOSE_PROJECT_NAME=bonni_gate",
    "BONNI_ACTIVE_IMAGE_TAG=bonni_gate-system:active",
    "BONNI_EMERGENCY_IMAGE_TAG=bonni_gate-system:emergency",
    "BONNI_ROLLBACK_IMAGE_TAG=bonni_gate-system:rollback",
    `MASTER_KEY=${"m".repeat(48)}`,
    `JWT_SECRET=${"j".repeat(48)}`,
    `POSTGRES_PASSWORD=${"p".repeat(32)}`,
    `SANDBOX_PASSWORD=${"s".repeat(24)}`,
    "",
  ].join("\n"), { mode: 0o600 });
  const dockerPath = path.join(fakeBin, "docker");
  await fs.writeFile(dockerPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$BONNI_FAKE_DOCKER_LOG"
case "$1:$2" in
  volume:inspect) exit 1 ;;
  volume:ls)
    if [ "$BONNI_FAKE_VOLUME_LIST_PRESENT" = "true" ]; then printf '%s\n' bonni_gate_postgres_data; fi
    exit 0
    ;;
  image:inspect) exit 0 ;;
esac
case " $* " in
  *" stop "*)
    if [ "$BONNI_FAKE_STOP_FAIL" = "true" ]; then exit 45; fi
    ;;
  *" --status running "*)
    if [ "$BONNI_FAKE_STATUS_PROBE_FAIL" = "true" ]; then exit 42; fi
    ;;
  *" --boot-gate "*)
    if [ "$BONNI_FAKE_GATE_FAIL" = "true" ]; then exit 41; fi
    ;;
  *" --runtime-deactivation-gate "*)
    count=0
    if [ -f "$BONNI_FAKE_DEACTIVATION_GATE_COUNT" ]; then count="$(cat "$BONNI_FAKE_DEACTIVATION_GATE_COUNT")"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$BONNI_FAKE_DEACTIVATION_GATE_COUNT"
    if [ "$BONNI_FAKE_DEACTIVATION_GATE_FAIL" = "true" ]; then exit 43; fi
    if [ -n "$BONNI_FAKE_DEACTIVATION_GATE_FAIL_AT" ] && [ "$count" = "$BONNI_FAKE_DEACTIVATION_GATE_FAIL_AT" ]; then exit 43; fi
    ;;
  *" up -d --wait --wait-timeout "*" update-runner "*)
    if [ "$BONNI_FAKE_RUNNER_DAEMON_FAIL" = "true" ]; then exit 44; fi
    ;;
esac
exit 0
`, { mode: 0o700 });

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BONNI_FAKE_DOCKER_LOG: logPath,
    BONNI_FAKE_GATE_FAIL: failGate ? "true" : "false",
    BONNI_FAKE_STATUS_PROBE_FAIL: "false",
    BONNI_FAKE_DEACTIVATION_GATE_FAIL: "false",
    BONNI_FAKE_DEACTIVATION_GATE_FAIL_AT: "",
    BONNI_FAKE_DEACTIVATION_GATE_COUNT: path.join(root, "deactivation-gate.count"),
    BONNI_FAKE_RUNNER_DAEMON_FAIL: "false",
    BONNI_FAKE_STOP_FAIL: "false",
    BONNI_FAKE_VOLUME_LIST_PRESENT: "false",
    BONNI_INSTALLATION_MONITOR_PORT: "52198",
    BACKEND_PORT: "52000",
    LOCAL_AUTH_PORT: "52001",
    BACKEND_EMERGENCY_DIRECT_PORT: "52199",
    BACKEND_EMERGENCY_LOCAL_AUTH_PORT: "52002",
    BONNI_HOST_PROJECT_ROOT: projectRoot,
    BONNI_HOST_RUNTIME_ROOT: runtimeRoot,
    BONNI_HOST_RUN_SYSTEM_ROOT: runSystemRoot,
    BONNI_RUNTIME_ENV_FILE: environmentPath,
  };
  return {
    root,
    projectRoot,
    backendRoot,
    logPath,
    env,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function controlRoot(productRoot) {
  return path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
}

function commandIndex(lines, predicate) {
  return lines.findIndex((line) => predicate(line));
}

test("boot gate accepts only provably pre-production failures", () => {
  const safeFlags = {
    activePromoteStarted: false,
    activeOverlayCommitted: false,
    proxyGated: false,
    rollbackImagePinned: true,
    canonicalActiveRestoredAfterLoad: true,
  };
  assert.equal(bootGateTerminalIsSafe({
    ok: false,
    processed: true,
    result: { status: "failed", flags: safeFlags, rollback: { attempted: false } },
  }), true);
  assert.equal(bootGateTerminalIsSafe({
    ok: false,
    processed: true,
    result: { status: "failed", flags: { ...safeFlags, activePromoteStarted: true }, rollback: { attempted: false } },
  }), false);
  assert.equal(bootGateTerminalIsSafe({
    ok: false,
    processed: true,
    result: { status: "failed", flags: { ...safeFlags, canonicalActiveRestoredAfterLoad: false }, rollback: { attempted: false } },
  }), false);
  assert.equal(bootGateTerminalIsSafe({
    ok: false,
    processed: true,
    result: { status: "failed", rollback: { attempted: false } },
  }), false);
});

test("Docker build contexts and COPY sources use the canonical case-sensitive SYSTEM tree", async () => {
  const relativeFiles = [
    "Dockerfile",
    "Dockerfile.dockerignore",
    "docker-compose.runtime.yml",
    "scripts/runtime/start-runtime.sh",
    "ops/runtime/proxy/Dockerfile",
    "ops/runtime/proxy/Dockerfile.dockerignore",
    "ops/update-runner/Dockerfile",
    "ops/update-runner/Dockerfile.dockerignore",
  ];
  const sources = await Promise.all(relativeFiles.map(async (relativePath) => ({
    relativePath,
    source: await fs.readFile(path.join(repositoryRoot, relativePath), "utf8"),
  })));
  for (const { relativePath, source } of sources) {
    assert.doesNotMatch(source, /(^|[^A-Za-z])System\//mu, relativePath);
  }
  const runtimeDockerfile = sources.find(({ relativePath }) => relativePath === "Dockerfile").source;
  assert.match(runtimeDockerfile, /COPY SYSTEM\/backend\/package\*\.json/u);
  assert.match(runtimeDockerfile, /AS frontend-build[\s\S]*COPY SYSTEM\/frontend\/package\*\.json[\s\S]*RUN npm ci[\s\S]*RUN npm run build/u);
  assert.match(runtimeDockerfile, /COPY --from=frontend-build \/app\/SYSTEM\/frontend\/dist \.\/public\/system/u);
  assert.match(
    runtimeDockerfile,
    /AS backend-build[\s\S]*COPY SYSTEM\/backend\/scripts\/runtime \.\/scripts\/runtime[\s\S]*RUN npm run build/u,
    "backend-build muss den Runtime-Guard bereits vor dem TypeScript-Build enthalten",
  );
  assert.match(runtimeDockerfile, /prebuilt-frontend\.mjs --write public\/system/u);
  assert.doesNotMatch(runtimeDockerfile, /COPY SYSTEM\/backend\/public/u);
  assert.match(sources.find(({ relativePath }) => relativePath === "ops/runtime/proxy/Dockerfile").source,
    /COPY SYSTEM\/backend\/ops\/runtime\/nginx\/default\.conf\.template/u);
  assert.match(sources.find(({ relativePath }) => relativePath === "ops/update-runner/Dockerfile").source,
    /COPY SYSTEM\/backend\/src\/system\/update-runner/u);
  await Promise.all([
    "../../SYSTEM/backend/Dockerfile",
    "../../SYSTEM/backend/ops/runtime/proxy/Dockerfile",
    "../../SYSTEM/backend/ops/update-runner/Dockerfile",
  ].map((relativePath) => fs.stat(path.resolve(repositoryRoot, relativePath))));
});

test("Docker runtime activation has exact ownership and blocks a simultaneous local Supervisor start", async (t) => {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-mode-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  const common = {
    productRoot,
    ownerPid: process.pid,
    probePort: async () => false,
  };
  const receipt = await acquireDockerRuntimeActivation(common);
  await assert.rejects(
    acquireDockerRuntimeActivation(common),
    /DOCKER_RUNTIME_ACTIVATION_ALREADY_RUNNING/u,
  );
  await assert.rejects(
    assertDockerRuntimeActivationInactive({ productRoot }),
    /DOCKER_RUNTIME_ACTIVATION_IN_PROGRESS/u,
  );
  assert.equal(await releaseDockerRuntimeActivation({
    productRoot,
    ownerPid: process.pid,
    token: "x".repeat(43),
  }), false);
  assert.ok(await fs.stat(path.join(controlRoot(productRoot), "docker-runtime-activation.json")));
  assert.equal(await releaseDockerRuntimeActivation({
    productRoot,
    ownerPid: process.pid,
    token: receipt.token,
  }), true);
  await assert.rejects(
    fs.stat(path.join(controlRoot(productRoot), "docker-runtime-activation.json")),
    /ENOENT/u,
  );

  await fs.writeFile(
    path.join(controlRoot(productRoot), "docker-runtime-activation.json"),
    `${JSON.stringify({
      schemaVersion: "bonni.docker-runtime-activation/v1",
      pid: 999_991,
      token: "z".repeat(43),
      startedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    acquireDockerRuntimeActivation({
      ...common,
      isPidAlive: (pid) => pid === process.pid,
    }),
    /DOCKER_RUNTIME_ACTIVATION_STALE/u,
  );
  assert.equal(await releaseDockerRuntimeActivation({
    productRoot,
    ownerPid: 999_991,
    token: "z".repeat(43),
  }), true);
});

test("runtime exclusion uses heartbeat, PID receipts and loopback ports fail closed", async (t) => {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-evidence-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  const stateRoot = controlRoot(productRoot);
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, "heartbeat.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update-heartbeat/v1",
    version: "1.1.1",
    instanceId: "live-supervisor",
    pid: process.pid,
    available: true,
    state: "idle",
    updatedAt: new Date().toISOString(),
    monitor: { available: true, origin: "http://127.0.0.1:4198" },
  })}\n`);
  await assert.rejects(
    assertNoLiveLocalSourceRuntime({ productRoot, probePort: async () => false }),
    /LOCAL_SOURCE_RUNTIME_ACTIVE/u,
  );

  await fs.rm(path.join(stateRoot, "heartbeat.json"));
  await fs.writeFile(path.join(stateRoot, "core-child.json"), `${JSON.stringify({
    pid: 999_991,
    supervisorInstanceId: "stale-supervisor",
    startedAt: new Date().toISOString(),
  })}\n`);
  await assert.rejects(
    assertNoLiveLocalSourceRuntime({
      productRoot,
      isPidAlive: () => false,
      probePort: async (port) => port === 4_000,
    }),
    /LOCAL_SOURCE_RUNTIME_CORE_PORT_ACTIVE:4000/u,
  );
  await fs.rm(path.join(stateRoot, "core-child.json"));
  await assert.rejects(
    assertNoLiveLocalSourceRuntime({
      productRoot,
      isPidAlive: () => false,
      probePort: async (port) => port === 4_198,
    }),
    /LOCAL_SOURCE_RUNTIME_MONITOR_PORT_ACTIVE:4198/u,
  );
});

test("first runtime activation probes legacy Core ports and incomplete local transactions fail closed", async (t) => {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-first-gate-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  const common = {
    productRoot,
    ownerPid: process.pid,
    isPidAlive: (pid) => pid === process.pid,
  };
  await assert.rejects(
    acquireDockerRuntimeActivation({
      ...common,
      probePort: async (port) => port === 4_000,
    }),
    /LOCAL_SOURCE_RUNTIME_CORE_PORT_ACTIVE:4000/u,
  );
  await assert.rejects(
    fs.lstat(path.join(controlRoot(productRoot), "docker-runtime-activation.json")),
    /ENOENT/u,
  );

  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  await fs.mkdir(stateRoot, { recursive: true });
  for (const [relative, kind] of [
    ["pending-update.json", "file"],
    ["control-center/request.json", "file"],
    ["control-center/request.processing.json", "file"],
    ["../../UPDATE/.bonni-work/work-001", "directory"],
  ]) {
    const target = path.resolve(stateRoot, relative);
    if (kind === "directory") await fs.mkdir(target, { recursive: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "{}\n");
    }
    await assert.rejects(
      acquireDockerRuntimeActivation({ ...common, probePort: async () => false }),
      /LOCAL_SOURCE_UPDATE_INCOMPLETE/u,
    );
    await fs.rm(target, { recursive: true, force: true });
  }

  await fs.mkdir(controlRoot(productRoot), { recursive: true });
  await fs.writeFile(path.join(controlRoot(productRoot), "update-command.lock"), `${JSON.stringify({
    pid: 999_991,
    ownerToken: "a".repeat(64),
    createdAt: new Date().toISOString(),
  })}\n`);
  await assert.rejects(
    acquireDockerRuntimeActivation({ ...common, probePort: async () => false }),
    /LOCAL_SOURCE_UPDATE_COMMAND_PRESENT:stale/u,
  );
});

test("a host backend lifetime lease and Docker activation are mutually exclusive and stale is fail closed", async (t) => {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-host-runtime-lease-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  let ownerAlive = true;
  const lease = await acquireLocalHostBackendRuntimeLease({
    productRoot,
    entry: "dev",
    ownerPid: 999_991,
    isPidAlive: (pid) => pid === 999_991 && ownerAlive,
    probePort: async () => false,
  });
  await assert.rejects(
    acquireDockerRuntimeActivation({
      productRoot,
      ownerPid: process.pid,
      isPidAlive: (pid) => pid === process.pid || (pid === 999_991 && ownerAlive),
      probePort: async () => false,
    }),
    /LOCAL_HOST_BACKEND_RUNTIME_ACTIVE/u,
  );
  ownerAlive = false;
  await assert.rejects(
    acquireDockerRuntimeActivation({
      productRoot,
      ownerPid: process.pid,
      isPidAlive: (pid) => pid === process.pid,
      probePort: async () => false,
    }),
    /LOCAL_HOST_BACKEND_RUNTIME_STALE/u,
  );
  await assert.rejects(
    acquireLocalHostBackendRuntimeLease({
      productRoot,
      entry: "dev-run",
      ownerPid: process.pid,
      isPidAlive: (pid) => pid === process.pid,
      probePort: async () => false,
    }),
    /LOCAL_HOST_BACKEND_RUNTIME_STALE/u,
  );
  // The deliberately stale receipt remains; releasing through the old owner
  // object is still exact and is used only to clean this isolated test fixture.
  await lease.release();
});

test("runtime:start rejects a live host Supervisor before host-state or Docker mutation", async (t) => {
  const fixture = await runtimeFixture();
  t.after(fixture.cleanup);
  const stateRoot = controlRoot(fixture.projectRoot);
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, "supervisor.lock.json"), `${JSON.stringify({
    pid: process.pid,
    instanceId: "host-development-supervisor",
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), fixture.backendRoot], {
      cwd: repositoryRoot,
      env: fixture.env,
    }),
    /LOCAL_SOURCE_RUNTIME_ACTIVE/u,
  );
  const dockerLog = await fs.readFile(fixture.logPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  assert.equal(dockerLog, "");
  await assert.rejects(
    fs.stat(path.join(fixture.root, "project", "runtime", "update-runner", "active")),
    /ENOENT/u,
  );
});

test("runtime boot keeps application slots closed until one-shot recovery succeeds", async (t) => {
  const fixture = await runtimeFixture();
  t.after(fixture.cleanup);
  await run("bash", [
    path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"),
    fixture.backendRoot,
  ], { cwd: repositoryRoot, env: fixture.env });
  const lines = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n");

  const stopIndex = commandIndex(lines, (line) => line.includes(" stop ")
    && line.includes("runtime-proxy") && line.includes("backend-active")
    && line.includes("backend-emergency") && line.includes("update-runner"));
  const transportCloseIndex = commandIndex(lines, (line) => line.includes("update-runner --network-transport-gate=close"));
  const gateIndex = commandIndex(lines, (line) => line.includes(" run --rm --no-deps -e BONNI_UPDATE_BOOT_RECOVERY=true update-runner --once --boot-gate"));
  const activeIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 backend-active"));
  const emergencyIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 backend-emergency"));
  const proxyIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 runtime-proxy"));
  const transportOpenIndex = commandIndex(lines, (line) => line.includes("update-runner --network-transport-gate=open"));
  const daemonIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 update-runner"));

  assert.ok(stopIndex >= 0 && stopIndex < transportCloseIndex && transportCloseIndex < gateIndex);
  assert.ok(gateIndex < activeIndex && activeIndex < emergencyIndex);
  assert.ok(emergencyIndex < proxyIndex && proxyIndex < transportOpenIndex && transportOpenIndex < daemonIndex);
  assert.ok(lines.slice(0, gateIndex).every((line) => !/ up .*\b(backend-active|backend-emergency|runtime-proxy)\b/.test(line)));

  const activationPath = path.join(controlRoot(fixture.projectRoot), "docker-runtime-activation.json");
  assert.ok(await fs.stat(activationPath), "erfolgreicher Runtime-Start muss den Modus-Latch behalten");
  await assert.rejects(
    assertDockerRuntimeActivationInactive({ productRoot: fixture.projectRoot }),
    /DOCKER_RUNTIME_ACTIVATION_STALE/u,
  );

  fixture.env.BONNI_FAKE_STATUS_PROBE_FAIL = "true";
  await assert.rejects(
    run("bash", [
      path.join(repositoryRoot, "scripts/runtime/stop-runtime.sh"),
      fixture.backendRoot,
    ], { cwd: repositoryRoot, env: fixture.env }),
    /Update-Runner-Status ist nicht zuverlässig lesbar/u,
  );
  assert.ok(await fs.stat(activationPath), "ein unbestätigter Stopp darf den Modus-Latch nicht entfernen");
  fixture.env.BONNI_FAKE_STATUS_PROBE_FAIL = "false";

  fixture.env.BONNI_FAKE_DEACTIVATION_GATE_FAIL = "true";
  await assert.rejects(
    run("bash", [
      path.join(repositoryRoot, "scripts/runtime/stop-runtime.sh"),
      fixture.backendRoot,
    ], { cwd: repositoryRoot, env: fixture.env }),
    (error) => error?.code === 43,
  );
  assert.ok(await fs.stat(activationPath), "ein privates Gate darf bei Hold/Claim den Modus-Latch nicht entfernen");
  fixture.env.BONNI_FAKE_DEACTIVATION_GATE_FAIL = "false";

  const transactionFence = path.join(fixture.env.BONNI_HOST_RUNTIME_ROOT, "update-runner", "active", "update-transaction-fence.json");
  await fs.writeFile(transactionFence, "{}\n");
  await assert.rejects(
    run("bash", [path.join(repositoryRoot, "scripts/runtime/stop-runtime.sh"), fixture.backendRoot], {
      cwd: repositoryRoot,
      env: fixture.env,
    }),
    /Update-Transaktionszaun ist vorhanden/u,
  );
  assert.ok(await fs.stat(activationPath));
  await fs.rm(transactionFence);
  const logBeforeSuccessfulStop = (await fs.readFile(fixture.logPath, "utf8")).split("\n").length;
  await run("bash", [
    path.join(repositoryRoot, "scripts/runtime/stop-runtime.sh"),
    fixture.backendRoot,
  ], { cwd: repositoryRoot, env: fixture.env });
  await assert.rejects(fs.stat(activationPath), /ENOENT/u);
  const stopLines = (await fs.readFile(fixture.logPath, "utf8")).split("\n").slice(logBeforeSuccessfulStop - 1);
  assert.equal(
    stopLines.filter((line) => line.includes("--runtime-deactivation-gate")).length,
    3,
    "runtime:stop muss nach dem Stopp aller API-Produzenten ein drittes Privatstatus-Gate ausführen",
  );
});

test("runtime:stop retains the latch when the final post-producer private gate finds new work", async (t) => {
  const fixture = await runtimeFixture();
  t.after(fixture.cleanup);
  await run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), fixture.backendRoot], {
    cwd: repositoryRoot,
    env: fixture.env,
  });
  fixture.env.BONNI_FAKE_DEACTIVATION_GATE_FAIL_AT = "3";
  await assert.rejects(
    run("bash", [path.join(repositoryRoot, "scripts/runtime/stop-runtime.sh"), fixture.backendRoot], {
      cwd: repositoryRoot,
      env: fixture.env,
    }),
    (error) => error?.code === 43,
  );
  assert.ok(await fs.stat(path.join(controlRoot(fixture.projectRoot), "docker-runtime-activation.json")));
});

test("runtime:stop resumes a crash after activation removal while the deactivation intent stayed", async (t) => {
  const fixture = await runtimeFixture();
  t.after(fixture.cleanup);
  await run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), fixture.backendRoot], {
    cwd: repositoryRoot,
    env: fixture.env,
  });
  const intent = await acquireDockerRuntimeDeactivationIntent({
    productRoot: fixture.projectRoot,
    ownerPid: 999_991,
    isPidAlive: () => false,
  });
  assert.deepEqual(await (await import("../scripts/runtime/runtime-mode-exclusion.mjs")).deactivateDockerRuntimeMode({
    productRoot: fixture.projectRoot,
    deactivationOwnerPid: 999_991,
    deactivationToken: intent.token,
    isPidAlive: () => false,
    probePort: async () => false,
  }), { ok: true, removed: true });
  await assert.rejects(
    assertDockerRuntimeActivationInactive({ productRoot: fixture.projectRoot, isPidAlive: () => false }),
    /DOCKER_RUNTIME_DEACTIVATION_STALE/u,
  );
  await run("bash", [path.join(repositoryRoot, "scripts/runtime/stop-runtime.sh"), fixture.backendRoot], {
    cwd: repositoryRoot,
    env: fixture.env,
  });
  await assert.rejects(
    fs.stat(path.join(controlRoot(fixture.projectRoot), "docker-runtime-deactivation.json")),
    /ENOENT/u,
  );
});

test("early fresh-start failure releases its marker, but stop/ps and daemon failures retain it", async (t) => {
  const early = await runtimeFixture();
  t.after(early.cleanup);
  await fs.appendFile(early.env.BONNI_RUNTIME_ENV_FILE, "COMPOSE_PROJECT_NAME=INVALID!\n");
  await assert.rejects(
    run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), early.backendRoot], {
      cwd: repositoryRoot,
      env: early.env,
    }),
    /COMPOSE_PROJECT_NAME ist ungültig/u,
  );
  await assert.rejects(
    fs.stat(path.join(controlRoot(early.projectRoot), "docker-runtime-activation.json")),
    /ENOENT/u,
  );

  for (const [name, configure, expectedCode] of [
    ["stop", (env) => { env.BONNI_FAKE_STOP_FAIL = "true"; }, 2],
    ["ps", (env) => { env.BONNI_FAKE_STATUS_PROBE_FAIL = "true"; }, 2],
    ["daemon", (env) => { env.BONNI_FAKE_RUNNER_DAEMON_FAIL = "true"; }, 44],
  ]) {
    const fixture = await runtimeFixture();
    t.after(fixture.cleanup);
    configure(fixture.env);
    await assert.rejects(
      run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), fixture.backendRoot], {
        cwd: repositoryRoot,
        env: fixture.env,
      }),
      (error) => error?.code === expectedCode,
      name,
    );
    assert.ok(await fs.stat(path.join(controlRoot(fixture.projectRoot), "docker-runtime-activation.json")), name);
  }
});

test("an indeterminate Docker volume inspection blocks before Compose mutation and retains the mode latch", async (t) => {
  const fixture = await runtimeFixture();
  t.after(fixture.cleanup);
  fixture.env.BONNI_FAKE_VOLUME_LIST_PRESENT = "true";
  await assert.rejects(
    run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), fixture.backendRoot], {
      cwd: repositoryRoot,
      env: fixture.env,
    }),
    /wird gelistet, konnte aber nicht geprüft werden/u,
  );
  const lines = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n");
  assert.ok(lines.some((line) => line.startsWith("volume inspect ")));
  assert.ok(lines.some((line) => line.startsWith("volume ls ")));
  assert.ok(lines.every((line) => !line.includes(" compose ") && !line.startsWith("compose ")));
  assert.ok(await fs.stat(path.join(controlRoot(fixture.projectRoot), "docker-runtime-activation.json")));
});

test("a failed boot recovery never starts Active, Emergency, Proxy or runner daemon", async (t) => {
  const fixture = await runtimeFixture({ failGate: true });
  t.after(fixture.cleanup);
  await assert.rejects(
    run("bash", [path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"), fixture.backendRoot], {
      cwd: repositoryRoot,
      env: fixture.env,
    }),
    (error) => error?.code === 41,
  );
  const lines = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n");
  const gateIndex = commandIndex(lines, (line) => line.includes(" --boot-gate"));
  assert.ok(gateIndex >= 0);
  assert.equal(commandIndex(lines, (line) => line.includes("--network-transport-gate=open")), -1);
  assert.ok(lines.slice(gateIndex + 1).every((line) => !/ up .*\b(backend-active|backend-emergency|runtime-proxy|update-runner)\b/.test(line)));
  assert.ok(await fs.stat(path.join(controlRoot(fixture.projectRoot), "docker-runtime-activation.json")));
});
