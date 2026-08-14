import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bootGateTerminalIsSafe } from "../ops/update-runner/boot-gate-policy.mjs";

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
  image:inspect) exit 0 ;;
esac
case " $* " in
  *" --boot-gate "*)
    if [ "$BONNI_FAKE_GATE_FAIL" = "true" ]; then exit 41; fi
    ;;
esac
exit 0
`, { mode: 0o700 });

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BONNI_FAKE_DOCKER_LOG: logPath,
    BONNI_FAKE_GATE_FAIL: failGate ? "true" : "false",
    BONNI_HOST_PROJECT_ROOT: projectRoot,
    BONNI_HOST_RUNTIME_ROOT: runtimeRoot,
    BONNI_HOST_RUN_SYSTEM_ROOT: runSystemRoot,
    BONNI_RUNTIME_ENV_FILE: environmentPath,
  };
  return {
    root,
    backendRoot,
    logPath,
    env,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
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

test("runtime boot keeps application slots closed until one-shot recovery succeeds", async (t) => {
  const fixture = await runtimeFixture();
  t.after(fixture.cleanup);
  await run("bash", [
    path.join(repositoryRoot, "scripts/runtime/start-runtime.sh"),
    fixture.backendRoot,
  ], { cwd: repositoryRoot, env: fixture.env });
  const lines = (await fs.readFile(fixture.logPath, "utf8")).trim().split("\n");

  const stopIndex = commandIndex(lines, (line) => line.includes(" stop runtime-proxy backend-active backend-emergency update-runner"));
  const transportCloseIndex = commandIndex(lines, (line) => line.includes("update-runner --network-transport-gate=close"));
  const gateIndex = commandIndex(lines, (line) => line.includes(" run --rm --no-deps -e BONNI_UPDATE_BOOT_RECOVERY=true update-runner --once --boot-gate"));
  const activeIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 backend-active"));
  const emergencyIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 backend-emergency"));
  const proxyIndex = commandIndex(lines, (line) => line.includes(" up -d --wait --wait-timeout 180 runtime-proxy"));
  const transportOpenIndex = commandIndex(lines, (line) => line.includes("update-runner --network-transport-gate=open"));
  const daemonIndex = commandIndex(lines, (line) => line.endsWith(" up -d update-runner"));

  assert.ok(stopIndex >= 0 && stopIndex < transportCloseIndex && transportCloseIndex < gateIndex);
  assert.ok(gateIndex < activeIndex && activeIndex < emergencyIndex);
  assert.ok(emergencyIndex < proxyIndex && proxyIndex < transportOpenIndex && transportOpenIndex < daemonIndex);
  assert.ok(lines.slice(0, gateIndex).every((line) => !/ up .*\b(backend-active|backend-emergency|runtime-proxy)\b/.test(line)));
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
});
