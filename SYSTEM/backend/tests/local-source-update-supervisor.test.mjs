import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  LOCAL_UPDATE_HEARTBEAT_SCHEMA,
  LOCAL_UPDATE_MONITOR_SCHEMA,
  LOCAL_UPDATE_REQUEST_SCHEMA,
  LOCAL_UPDATE_STATUS_SCHEMA,
  LocalSourceUpdateSupervisor,
  assertLocalSourceSupervisorEnabled,
  validateInstallRequest,
  verifyRequestedManifest,
} from "../scripts/setup/local-source-update-supervisor.mjs";
import {
  isProductionEnvironment,
  selectBackendEntry,
} from "../scripts/runtime/start-backend.mjs";
import { shouldRunLocalSourceUpdateGate } from "../scripts/runtime/local-source-update-start-gate.mjs";
import {
  acquireDockerRuntimeActivation,
  acquireDockerRuntimeDeactivationIntent,
  deactivateDockerRuntimeMode,
  releaseDockerRuntimeDeactivationIntent,
  releaseDockerRuntimeActivation,
} from "../scripts/runtime/runtime-mode-exclusion.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = Date.parse("2026-08-21T10:00:00.000Z");
const MONITOR_TOKEN = "1".repeat(64);
const OTHER_MONITOR_TOKEN = "2".repeat(64);
const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestFixture(overrides = {}) {
  return {
    schemaVersion: LOCAL_UPDATE_REQUEST_SCHEMA,
    requestId: "control-center-0001",
    action: "install",
    updateId: "dev-core-0.1.19-0002",
    manifestSha256: "a".repeat(64),
    monitorTokenSha256: sha256(MONITOR_TOKEN),
    supervisorInstanceId: "supervisor-test-instance",
    issuedAt: "2026-08-21T09:59:00.000Z",
    expiresAt: "2026-08-21T10:04:00.000Z",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForFile(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (state?.isFile() && !state.isSymbolicLink()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`TEST_FILE_TIMEOUT:${target}`);
}

async function unusedLoopbackPorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function createHostStartBackendFixture(t, { exitCode = 0, gracefulSignal = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-host-start-backend-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const productRoot = path.join(temporary, "Bonni Core");
  const fixtureBackendRoot = path.join(productRoot, "SYSTEM", "backend");
  const runtimeScripts = path.join(fixtureBackendRoot, "scripts", "runtime");
  const serverEntry = path.join(fixtureBackendRoot, "dist", "system", "server", "run-server.js");
  const observationPath = path.join(temporary, "server-observation.json");
  const shutdownPath = path.join(temporary, "server-shutdown.txt");
  const leasePath = path.join(
    productRoot,
    "SYSTEM",
    ".bonni-source-update",
    "control-center",
    "host-backend-runtime.json",
  );
  const [port, localAuthPort, monitorPort] = await unusedLoopbackPorts(3);
  await fs.mkdir(runtimeScripts, { recursive: true });
  await fs.mkdir(path.dirname(serverEntry), { recursive: true });
  for (const scriptName of ["start-backend.mjs", "runtime-mode-exclusion.mjs"]) {
    await fs.copyFile(
      path.join(backendRoot, "scripts", "runtime", scriptName),
      path.join(runtimeScripts, scriptName),
    );
  }
  await fs.writeFile(serverEntry, [
    'import fs from "node:fs/promises";',
    'import { setTimeout as delay } from "node:timers/promises";',
    `const leasePath = ${JSON.stringify(leasePath)};`,
    "let receipt = null;",
    "for (let attempt = 0; attempt < 100; attempt += 1) {",
    "  receipt = JSON.parse(await fs.readFile(leasePath, \"utf8\"));",
    "  if (receipt.childPid) break;",
    "  await delay(10);",
    "}",
    "if (!receipt?.childPid) throw new Error(\"TEST_CHILD_NOT_BOUND\");",
    ...(gracefulSignal ? [
      "let keepAlive;",
      "process.once(\"SIGTERM\", async () => {",
      "  clearInterval(keepAlive);",
      `  await fs.writeFile(${JSON.stringify(shutdownPath)}, "clean");`,
      "  process.exit(0);",
      "});",
    ] : []),
    `await fs.writeFile(${JSON.stringify(observationPath)}, JSON.stringify({`,
    "  receipt,",
    "  leaseOwnerPid: process.env.BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID,",
    "  leaseToken: process.env.BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN,",
    "}));",
    ...(gracefulSignal ? ["keepAlive = setInterval(() => {}, 1_000);"] : [`process.exitCode = ${exitCode};`]),
    "",
  ].join("\n"));
  return {
    productRoot,
    fixtureBackendRoot,
    startScript: path.join(runtimeScripts, "start-backend.mjs"),
    observationPath,
    shutdownPath,
    leasePath,
    environment: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      LOCAL_AUTH_PORT: String(localAuthPort),
      BONNI_INSTALLATION_MONITOR_PORT: String(monitorPort),
    },
  };
}

async function listenHttpServer(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function monitorRequest(origin, requestId, token = MONITOR_TOKEN, options = {}) {
  const response = await fetch(
    `${origin}/api/local-update/status?requestId=${encodeURIComponent(requestId)}`,
    {
      method: options.method || "GET",
      headers: {
        origin: options.origin || "http://127.0.0.1:5173",
        "x-bonni-update-monitor": token,
      },
    },
  );
  return { response, body: await response.json() };
}

async function createProductFixture(t) {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-supervisor-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  const fixtureBackendRoot = path.join(productRoot, "SYSTEM", "backend");
  await fs.mkdir(path.join(fixtureBackendRoot, "dist", "system", "server"), { recursive: true });
  await fs.mkdir(path.join(fixtureBackendRoot, "scripts", "setup"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureBackendRoot, "dist", "system", "server", "run-server.js"),
    "// test backend\n",
  );
  await fs.writeFile(
    path.join(fixtureBackendRoot, "scripts", "setup", "update-system.mjs"),
    "// test updater\n",
  );
  return { productRoot, fixtureBackendRoot };
}

async function stageManifest(productRoot, updateId) {
  const packageRoot = path.join(productRoot, "UPDATE", "inbox", updateId);
  await fs.mkdir(packageRoot, { recursive: true });
  const source = `${JSON.stringify({
    schemaVersion: "bonni.local-source-update/v1",
    updateId,
  }, null, 2)}\n`;
  const manifestPath = path.join(packageRoot, "bonni-source-update.json");
  await fs.writeFile(manifestPath, source);
  return { manifestPath, manifestSha256: sha256(source) };
}

class FakeBackendChild extends EventEmitter {
  constructor(pid, events, port = 4_317) {
    super();
    this.pid = pid;
    this.events = events;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    setImmediate(() => this.emit("message", { type: "BONNI_BACKEND_READY", port }));
  }

  send(message) {
    this.events.push(["backend-message", message]);
    setImmediate(() => {
      this.emit("message", {
        type: "BONNI_BACKEND_SHUTDOWN_COMPLETE",
        requestId: message.requestId,
      });
      this.exitCode = 0;
      this.connected = false;
      this.emit("exit", 0, null);
    });
    return true;
  }

  kill(signal) {
    this.events.push(["backend-kill", signal]);
    this.signalCode = signal;
    this.connected = false;
    setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

class ResistantBackendChild extends EventEmitter {
  constructor(pid, events, { exitOnSignal = null, port = 4_317 } = {}) {
    super();
    this.pid = pid;
    this.events = events;
    this.exitOnSignal = exitOnSignal;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    setImmediate(() => this.emit("message", { type: "BONNI_BACKEND_READY", port }));
  }

  send(message) {
    this.events.push(["backend-message", message]);
    return true;
  }

  kill(signal) {
    this.events.push(["backend-kill", signal]);
    if (signal === this.exitOnSignal) {
      setImmediate(() => {
        this.signalCode = signal;
        this.connected = false;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

class DelayedShutdownBackendChild extends EventEmitter {
  constructor(pid, events, requested, release, port = 4_317) {
    super();
    this.pid = pid;
    this.events = events;
    this.requested = requested;
    this.release = release;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    setImmediate(() => this.emit("message", { type: "BONNI_BACKEND_READY", port }));
  }

  send(message) {
    this.events.push(["backend-message", message]);
    this.requested.resolve();
    void this.release.promise.then(() => {
      this.emit("message", {
        type: "BONNI_BACKEND_SHUTDOWN_COMPLETE",
        requestId: message.requestId,
      });
      this.exitCode = 0;
      this.connected = false;
      this.emit("exit", 0, null);
    });
    return true;
  }

  kill(signal) {
    this.events.push(["backend-kill", signal]);
    return true;
  }
}

test("Control-Center-Aufträge sind kurzlebig, instanzgebunden und haben keine Befehlsfelder", () => {
  const request = requestFixture();
  assert.deepEqual(
    validateInstallRequest(request, {
      instanceId: "supervisor-test-instance",
      now: FIXED_NOW,
    }),
    request,
  );

  assert.throws(
    () => validateInstallRequest({ ...request, command: "rm" }, {
      instanceId: "supervisor-test-instance",
      now: FIXED_NOW,
    }),
    /SUPERVISOR_UNKNOWN_FIELD/u,
  );
  assert.throws(
    () => validateInstallRequest(request, {
      instanceId: "another-supervisor",
      now: FIXED_NOW,
    }),
    /SUPERVISOR_INSTANCE_MISMATCH/u,
  );
  assert.throws(
    () => validateInstallRequest({ ...request, monitorTokenSha256: "not-a-sha256" }, {
      instanceId: "supervisor-test-instance",
      now: FIXED_NOW,
    }),
    /SUPERVISOR_MONITOR_TOKEN_HASH_INVALID/u,
  );
  assert.throws(
    () => validateInstallRequest({
      ...request,
      expiresAt: "2026-08-21T09:59:59.000Z",
    }, {
      instanceId: "supervisor-test-instance",
      now: FIXED_NOW,
    }),
    /SUPERVISOR_REQUEST_EXPIRED/u,
  );
});

test("Supervisor bindet die Freigabe erneut an Update-ID und Manifest-SHA", async (t) => {
  const { productRoot } = await createProductFixture(t);
  const updateId = "manifest-proof-0001";
  const staged = await stageManifest(productRoot, updateId);
  const request = requestFixture({
    updateId,
    manifestSha256: staged.manifestSha256,
  });

  await assert.doesNotReject(verifyRequestedManifest({ productRoot, request }));
  await fs.appendFile(staged.manifestPath, " ");
  await assert.rejects(
    verifyRequestedManifest({ productRoot, request }),
    /SUPERVISOR_MANIFEST_CHANGED/u,
  );
});

test("Supervisor stoppt per IPC, aktualisiert separat und bestätigt den Backend-Neustart", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "supervised-install-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  const reportedPhases = [];
  let nextPid = 4_200;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-test-instance",
    now: () => FIXED_NOW,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    forkBackend(serverScript, args, options) {
      events.push(["backend-start", serverScript, args, options.stdio]);
      return new FakeBackendChild(nextPid += 1, events);
    },
    async runUpdate(executable, args, options) {
      events.push(["update", executable, args, options.env]);
    },
    async probeBackend({ attempt, url }) {
      events.push(["health", attempt, url]);
      return { ok: true };
    },
    backendHealthIntervalMs: 0,
  });
  const writeStatus = supervisor.writeStatus.bind(supervisor);
  supervisor.writeStatus = async (value) => {
    if (value.request?.requestId) reportedPhases.push(value.phase);
    return writeStatus(value);
  };
  t.after(() => supervisor.stop("test"));

  const started = await supervisor.start();
  assert.equal(started.instanceId, "supervisor-test-instance");
  assert.match(started.installationMonitorOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);

  const request = requestFixture({
    updateId,
    manifestSha256: staged.manifestSha256,
  });
  const controlRoot = path.join(
    productRoot,
    "SYSTEM",
    ".bonni-source-update",
    "control-center",
  );
  await fs.writeFile(
    path.join(controlRoot, "request.json"),
    `${JSON.stringify(request)}\n`,
  );

  assert.equal(await supervisor.pollOnce(), true);
  assert.equal(events.filter(([event]) => event === "backend-start").length, 2);
  const updateEvents = events.filter(([event]) => event === "update");
  assert.equal(updateEvents.length, 3);
  assert.deepEqual(updateEvents.map((entry) => entry[2].at(-1)), [
    "--preflight",
    supervisor.updateScript,
    "--finalize",
  ]);
  const updateEnvironment = updateEvents[1]?.[3];
  assert.equal(updateEnvironment.BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_ID, updateId);
  assert.equal(
    updateEnvironment.BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_MANIFEST_SHA256,
    staged.manifestSha256,
  );
  assert.equal(updateEnvironment.BONNI_UPDATE_DEFER_FINALIZE, "1");
  assert.deepEqual(events.filter(([event]) => event === "health").map((entry) => entry[1]), [1, 2, 3]);
  assert.equal(
    events.find(([event]) => event === "health")?.[2],
    "http://127.0.0.1:4317/api/health/local-update-ready",
  );
  assert.deepEqual(
    events.find(([event]) => event === "backend-message")?.[1],
    {
      type: "BONNI_SUPERVISOR_SHUTDOWN",
      reason: "local-source-update",
      requestId: request.requestId,
    },
  );

  const heartbeat = JSON.parse(await fs.readFile(path.join(controlRoot, "heartbeat.json"), "utf8"));
  const status = JSON.parse(await fs.readFile(path.join(controlRoot, "status.json"), "utf8"));
  assert.equal(heartbeat.schemaVersion, LOCAL_UPDATE_HEARTBEAT_SCHEMA);
  assert.equal(heartbeat.state, "idle");
  assert.equal(heartbeat.monitor.schemaVersion, LOCAL_UPDATE_MONITOR_SCHEMA);
  assert.equal(heartbeat.monitor.available, true);
  assert.equal(heartbeat.monitor.origin, started.installationMonitorOrigin);
  assert.equal(status.schemaVersion, LOCAL_UPDATE_STATUS_SCHEMA);
  assert.equal(status.status, "completed");
  assert.equal(status.updateId, updateId);
  assert.deepEqual(reportedPhases, [
    "validate",
    "handoff",
    "stop",
    "install",
    "restart",
    "health",
    "return",
    "complete",
  ]);
  assert.deepEqual(status.steps.map((step) => step.key), [
    "validate",
    "handoff",
    "stop",
    "install",
    "restart",
    "health",
    "return",
  ]);
  assert.equal(status.steps.every((step) => step.status === "completed"), true);
  const coreReceiptSource = await fs.readFile(supervisor.coreChildReceiptPath, "utf8");
  const coreReceipt = JSON.parse(coreReceiptSource);
  assert.deepEqual(Object.keys(coreReceipt).sort(), ["pid", "startedAt", "supervisorInstanceId"]);
  assert.equal(coreReceipt.pid, supervisor.backendChild.pid);
  assert.equal(coreReceipt.supervisorInstanceId, supervisor.instanceId);
  assert.equal((await fs.stat(supervisor.coreChildReceiptPath)).mode & 0o777, 0o600);
  await assert.rejects(fs.lstat(path.join(controlRoot, "request.processing.json")), /ENOENT/u);
});

test("Update startet nicht, wenn das Backend selbst nach SIGKILL keinen Exit bestätigt", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "backend-stop-timeout-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  let child = null;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-stop-timeout",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    backendGracefulTimeoutMs: 5,
    backendTerminateTimeoutMs: 5,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    forkBackend() {
      child = new ResistantBackendChild(4_501, events);
      return child;
    },
    async runUpdate(_executable, args) { events.push(["update", args]); },
    async probeBackend() { throw new Error("Healthcheck darf nicht starten"); },
  });
  t.after(async () => {
    if (supervisor.backendChild === child) {
      child.connected = false;
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    }
    await supervisor.stop("test");
  });
  await supervisor.start();
  const request = requestFixture({
    requestId: "backend-stop-timeout-request",
    updateId,
    manifestSha256: staged.manifestSha256,
    supervisorInstanceId: "supervisor-stop-timeout",
  });
  await fs.writeFile(supervisor.requestPath, `${JSON.stringify(request)}\n`);

  assert.equal(await supervisor.pollOnce(), true);
  assert.deepEqual(
    events.filter(([event]) => event === "update").map(([, args]) => args.at(-1)),
    ["--preflight"],
  );
  assert.deepEqual(
    events.filter(([event]) => event === "backend-kill").map(([, signal]) => signal),
    ["SIGTERM", "SIGKILL"],
  );
  assert.equal(supervisor.backendChild, child, "Lebendes Child darf nicht aus dem Zustand entfernt werden");
  assert.equal(supervisor.backendLifecycle, "stop-failed");
  const status = JSON.parse(await fs.readFile(supervisor.statusPath, "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "stop");
  assert.equal(status.errorCode, "SUPERVISOR_BACKEND_DID_NOT_EXIT");
  const heartbeat = JSON.parse(await fs.readFile(supervisor.heartbeatPath, "utf8"));
  assert.equal(heartbeat.state, "failed");
});

test("erzwungener Child-Exit ohne requestId-gebundene COMPLETE-Quittung bleibt fail-closed", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "backend-stop-unconfirmed-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  let child = null;
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-stop-unconfirmed",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    backendGracefulTimeoutMs: 5,
    backendTerminateTimeoutMs: 5,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    forkBackend() {
      backendStarts += 1;
      child = new ResistantBackendChild(4_601, events, { exitOnSignal: "SIGKILL" });
      return child;
    },
    async runUpdate(_executable, args) { events.push(["update", args]); },
    async probeBackend() { throw new Error("Healthcheck darf nicht starten"); },
  });
  t.after(() => supervisor.stop("test"));
  await supervisor.start();
  const request = requestFixture({
    requestId: "backend-stop-unconfirmed-request",
    updateId,
    manifestSha256: staged.manifestSha256,
    supervisorInstanceId: "supervisor-stop-unconfirmed",
  });
  await fs.writeFile(supervisor.requestPath, `${JSON.stringify(request)}\n`);

  assert.equal(await supervisor.pollOnce(), true);
  assert.equal(backendStarts, 1, "Core darf nach unbestätigtem Stopp nicht neu gestartet werden");
  assert.deepEqual(
    events.filter(([event]) => event === "update").map(([, args]) => args.at(-1)),
    ["--preflight"],
  );
  assert.deepEqual(
    events.filter(([event]) => event === "backend-kill").map(([, signal]) => signal),
    ["SIGTERM", "SIGKILL"],
  );
  assert.equal(supervisor.backendChild, null, "Der tatsächliche SIGKILL-Exit muss erfasst werden");
  assert.equal(supervisor.backendLifecycle, "shutdown-unconfirmed");
  const status = JSON.parse(await fs.readFile(supervisor.statusPath, "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "stop");
  assert.equal(status.errorCode, "SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED");
  const heartbeat = JSON.parse(await fs.readFile(supervisor.heartbeatPath, "utf8"));
  assert.equal(heartbeat.state, "failed");
});

test("Installationsmonitor bleibt bei gestopptem Core erreichbar und bindet Token an den Auftrag", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "monitored-install-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  const installReached = deferred();
  const continueInstall = deferred();
  let nextPid = 6_000;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-test-instance",
    now: () => FIXED_NOW,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    forkBackend() {
      return new FakeBackendChild(nextPid += 1, events);
    },
    async runUpdate(_executable, args) {
      if (args.includes("--preflight") || args.includes("--finalize")) return;
      installReached.resolve();
      await continueInstall.promise;
    },
    async probeBackend() {
      return { ok: true };
    },
    backendHealthIntervalMs: 0,
  });
  t.after(() => {
    continueInstall.resolve();
    return supervisor.stop("test");
  });

  const started = await supervisor.start();
  const monitorOrigin = started.installationMonitorOrigin;
  const healthResponse = await fetch(`${monitorOrigin}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(health, {
    schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
    ok: true,
    role: "installation-server",
    state: "ready",
  });

  const request = requestFixture({
    requestId: "control-center-monitor-0001",
    updateId,
    manifestSha256: staged.manifestSha256,
  });
  await fs.writeFile(
    path.join(supervisor.controlRoot, "request.json"),
    `${JSON.stringify(request)}\n`,
  );

  const processing = supervisor.pollOnce();
  await installReached.promise;
  assert.equal(supervisor.backendChild, null, "Core muss während der Dateiarbeiten gestoppt sein");

  const active = await monitorRequest(monitorOrigin, request.requestId);
  assert.equal(active.response.status, 200);
  assert.equal(active.response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(active.body.schemaVersion, LOCAL_UPDATE_MONITOR_SCHEMA);
  assert.equal(active.body.role, "installation-server");
  assert.equal(active.body.switchTarget, "installation");
  assert.deepEqual(active.body.core, { state: "offline-for-update", available: false });
  assert.equal(active.body.progress.requestId, request.requestId);
  assert.equal(active.body.progress.updateId, updateId);
  assert.equal(active.body.progress.manifestSha256, staged.manifestSha256);
  assert.equal(active.body.progress.phase, "install");
  assert.equal(active.body.progress.status, "installing");
  assert.equal(active.body.terminal, false);

  const wrongToken = await monitorRequest(monitorOrigin, request.requestId, OTHER_MONITOR_TOKEN);
  assert.equal(wrongToken.response.status, 401);
  assert.deepEqual(wrongToken.body, { ok: false, error: "MONITOR_AUTH_INVALID" });

  const otherRequest = requestFixture({
    requestId: "control-center-monitor-0002",
    updateId,
    manifestSha256: staged.manifestSha256,
    monitorTokenSha256: sha256(OTHER_MONITOR_TOKEN),
  });
  supervisor.registerMonitorSession(otherRequest);
  const crossedToken = await monitorRequest(monitorOrigin, otherRequest.requestId, MONITOR_TOKEN);
  assert.equal(crossedToken.response.status, 401);
  assert.deepEqual(crossedToken.body, { ok: false, error: "MONITOR_AUTH_INVALID" });

  const wrongOrigin = await monitorRequest(monitorOrigin, request.requestId, MONITOR_TOKEN, {
    origin: "https://example.invalid",
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.deepEqual(wrongOrigin.body, { ok: false, error: "MONITOR_ORIGIN_FORBIDDEN" });

  await fs.writeFile(supervisor.setupProgressPath, `${JSON.stringify({
    updateId,
    status: "running",
    stage: "database",
    stageIndex: 4,
    stageCount: 12,
    message: "Datenbanken und Schemas werden aktualisiert.",
    updatedAt: "2026-08-21T10:00:01.000Z",
  })}\n`);
  const detailed = await monitorRequest(monitorOrigin, request.requestId);
  assert.equal(detailed.response.status, 200);
  assert.deepEqual(detailed.body.progress.setup, {
    status: "running",
    stage: "database",
    stageIndex: 4,
    stageCount: 12,
    message: "Datenbanken und Schemas werden aktualisiert.",
  });
  assert.equal(
    detailed.body.progress.steps.find((step) => step.key === "install")?.detail,
    "Datenbanken und Schemas werden aktualisiert.",
  );

  continueInstall.resolve();
  assert.equal(await processing, true);

  const completed = await monitorRequest(monitorOrigin, request.requestId);
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.switchTarget, "core");
  assert.deepEqual(completed.body.core, { state: "online", available: true });
  assert.equal(completed.body.progress.phase, "complete");
  assert.equal(completed.body.progress.status, "completed");
  assert.equal(completed.body.terminal, true);
});

test("SIGTERM in der Install-Phase wartet die Mutation unter erreichbarem Monitor vollständig ab", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "signal-during-install-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  const installReached = deferred();
  const continueInstall = deferred();
  let nextPid = 6_500;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-signal-install",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    backendReadyTimeoutMs: 1_000,
    forkBackend() { return new FakeBackendChild(nextPid += 1, events); },
    async runUpdate(_executable, args) {
      events.push(["update", args]);
      if (args.includes("--preflight") || args.includes("--finalize")) return;
      installReached.resolve();
      await continueInstall.promise;
    },
    async probeBackend() { return { ok: true }; },
    backendHealthIntervalMs: 0,
  });
  t.after(() => {
    continueInstall.resolve();
    return supervisor.stop("test");
  });
  const started = await supervisor.start();
  const request = requestFixture({
    requestId: "signal-install-request",
    updateId,
    manifestSha256: staged.manifestSha256,
    supervisorInstanceId: "supervisor-signal-install",
  });
  await fs.writeFile(supervisor.requestPath, `${JSON.stringify(request)}\n`);

  const processing = supervisor.pollOnce();
  await installReached.promise;
  const stopping = supervisor.stop("SIGTERM");
  assert.equal(supervisor.stop("SIGTERM"), stopping, "stop() muss idempotent dieselbe Operation liefern");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(supervisor.activeUpdatePromise, "Updater-Mutation muss bis zum echten Abschluss verfolgt bleiben");

  const duringStop = await monitorRequest(started.installationMonitorOrigin, request.requestId);
  assert.equal(duringStop.response.status, 200);
  assert.equal(duringStop.body.progress.phase, "install");
  assert.equal(duringStop.body.progress.status, "installing");

  continueInstall.resolve();
  assert.equal(await processing, true);
  await stopping;
  assert.equal(supervisor.activeUpdatePromise, null);
  assert.equal(supervisor.activeUpdaterChild, null);
  assert.equal(supervisor.installationMonitorServer, null);
  assert.deepEqual(
    events.filter(([event]) => event === "update").map(([, args]) => args.at(-1)),
    ["--preflight", supervisor.updateScript, "--finalize"],
  );
});

test("SIGTERM in der Stop-Phase serialisiert Backend-Stopp und laufenden Update-Workflow", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "signal-during-stop-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  const stopRequested = deferred();
  const releaseStop = deferred();
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-signal-stop",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    backendReadyTimeoutMs: 1_000,
    forkBackend() {
      backendStarts += 1;
      if (backendStarts === 1) {
        return new DelayedShutdownBackendChild(6_701, events, stopRequested, releaseStop);
      }
      return new FakeBackendChild(6_702, events);
    },
    async runUpdate(_executable, args) { events.push(["update", args]); },
    async probeBackend() { return { ok: true }; },
    backendHealthIntervalMs: 0,
  });
  t.after(() => {
    releaseStop.resolve();
    return supervisor.stop("test");
  });
  const started = await supervisor.start();
  const request = requestFixture({
    requestId: "signal-stop-request",
    updateId,
    manifestSha256: staged.manifestSha256,
    supervisorInstanceId: "supervisor-signal-stop",
  });
  await fs.writeFile(supervisor.requestPath, `${JSON.stringify(request)}\n`);

  const processing = supervisor.pollOnce();
  await stopRequested.promise;
  const firstStopOperation = supervisor.backendStopPromise;
  assert.ok(firstStopOperation);
  const stopping = supervisor.stop("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.backendStopPromise, firstStopOperation);
  assert.equal(
    events.filter(([event]) => event === "backend-message").length,
    1,
    "Während des laufenden Update-Stopps darf kein konkurrierender Shutdown gesendet werden",
  );
  const monitored = await monitorRequest(started.installationMonitorOrigin, request.requestId);
  assert.equal(monitored.body.progress.phase, "stop");

  releaseStop.resolve();
  assert.equal(await processing, true);
  await stopping;
  assert.equal(supervisor.backendStopPromise, null);
  assert.equal(backendStarts, 2);
  assert.equal(events.filter(([event]) => event === "backend-message").length, 2);
});

test("SIGTERM wartet einen bereits gestarteten Unexpected-Exit-Restart und verhindert dessen Fork", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const events = [];
  const restartProbeReached = deferred();
  const releaseRestartProbe = deferred();
  let blockProbe = false;
  let backendStarts = 0;
  let firstChild = null;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-restart-signal-race",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    backendReadyTimeoutMs: 1_000,
    forkBackend() {
      backendStarts += 1;
      const child = new FakeBackendChild(6_800 + backendStarts, events);
      if (!firstChild) firstChild = child;
      return child;
    },
    async probeExistingCore() {
      if (!blockProbe) return false;
      restartProbeReached.resolve();
      await releaseRestartProbe.promise;
      return false;
    },
    async probeBackend() { return { ok: true }; },
  });
  t.after(() => {
    releaseRestartProbe.resolve();
    return supervisor.stop("test");
  });
  await supervisor.start();

  firstChild.exitCode = 1;
  firstChild.connected = false;
  firstChild.emit("exit", 1, null);
  clearTimeout(supervisor.restartTimer);
  supervisor.restartTimer = null;
  if (supervisor.backendReceiptCleanupPromise) {
    await supervisor.backendReceiptCleanupPromise;
  }
  blockProbe = true;
  const restarting = supervisor.startBackend();
  await restartProbeReached.promise;
  assert.equal(supervisor.backendStartPromise, restarting);

  const stopping = supervisor.stop("SIGTERM");
  releaseRestartProbe.resolve();
  await assert.rejects(restarting, /SUPERVISOR_STOPPING/u);
  await stopping;
  assert.equal(backendStarts, 1, "Nach gesetztem stopping darf der verzögerte Restart nicht mehr forken");
  assert.equal(supervisor.backendStartPromise, null);
  assert.equal(supervisor.backendChild, null);
  assert.equal(supervisor.installationMonitorServer, null);
});

test("Monitorzugang und ephemerer Fallback-Port bleiben über einen Supervisor-Neustart gebunden", { concurrency: false }, async (t) => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  let ownsDefaultPort = false;
  try {
    await listenHttpServer(blocker, 4_198);
    ownsDefaultPort = true;
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
  }
  t.after(() => ownsDefaultPort ? closeHttpServer(blocker) : undefined);

  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const events = [];
  let nextPid = 7_000;
  const supervisorOptions = {
    productRoot,
    backendRoot: fixtureBackendRoot,
    now: () => FIXED_NOW,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    backendReadyTimeoutMs: 1_000,
    installationMonitorPort: 0,
    forkBackend() {
      return new FakeBackendChild(nextPid += 1, events);
    },
    async runUpdate() {},
    async probeBackend() { return { ok: true }; },
    backendHealthIntervalMs: 0,
  };
  const first = new LocalSourceUpdateSupervisor({
    ...supervisorOptions,
    instanceId: "supervisor-before-restart",
  });
  const firstStarted = await first.start();
  assert.match(firstStarted.installationMonitorOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.notEqual(new URL(firstStarted.installationMonitorOrigin).port, "4198");
  assert.ok(first.backendChild, "Bonni Core muss trotz belegtem Standardport starten");

  const request = requestFixture({
    requestId: "monitor-restart-0001",
    updateId: "monitor-restart-update-0001",
    manifestSha256: "d".repeat(64),
  });
  const persistedAccess = {
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    monitorTokenSha256: request.monitorTokenSha256,
    expiresAt: new Date(FIXED_NOW + 60 * 60_000).toISOString(),
  };
  await fs.writeFile(first.monitorAccessPath, `${JSON.stringify(persistedAccess, null, 2)}\n`);
  const accessSource = await fs.readFile(first.monitorAccessPath, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(accessSource)).sort(), [
    "expiresAt",
    "manifestSha256",
    "monitorTokenSha256",
    "requestId",
    "updateId",
  ]);
  assert.equal(accessSource.includes(MONITOR_TOKEN), false, "Roh-Token darf nie persistiert werden");
  await fs.writeFile(first.statusPath, `${JSON.stringify({
    schemaVersion: LOCAL_UPDATE_STATUS_SCHEMA,
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    status: "failed",
    phase: "health",
    message: "Bonni Core wird nach einem Fehler weiter geprüft.",
    updatedAt: new Date(FIXED_NOW).toISOString(),
    steps: [],
  })}\n`);
  await assert.rejects(fs.lstat(first.processingPath), /ENOENT/u);
  await first.stop("simulated-restart");

  const second = new LocalSourceUpdateSupervisor({
    ...supervisorOptions,
    instanceId: "supervisor-after-restart",
  });
  t.after(() => second.stop("test"));
  const secondStarted = await second.start();
  assert.equal(
    secondStarted.installationMonitorOrigin,
    firstStarted.installationMonitorOrigin,
    "Der im Browser gespeicherte Loopback-Endpunkt muss nach dem Neustart gleich bleiben",
  );
  assert.ok(second.monitorSessions.has(request.requestId));

  const restored = await monitorRequest(
    secondStarted.installationMonitorOrigin,
    request.requestId,
    MONITOR_TOKEN,
  );
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.progress.status, "failed");
  assert.equal(restored.body.progress.updateId, request.updateId);
  assert.equal(restored.body.switchTarget, "core");
});

test("Recovery ohne processing request bleibt über Receipt an denselben Monitor gebunden", { concurrency: false }, async (t) => {
  const endpointProbe = createServer((_request, response) => response.end("probe"));
  await listenHttpServer(endpointProbe, 0);
  const endpointAddress = endpointProbe.address();
  assert.ok(endpointAddress && typeof endpointAddress !== "string");
  const monitorOrigin = `http://127.0.0.1:${endpointAddress.port}`;
  await closeHttpServer(endpointProbe);

  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const controlRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  const request = requestFixture({
    requestId: "monitor-recovery-0001",
    updateId: "recovery-without-processing-0001",
    manifestSha256: "e".repeat(64),
  });
  await fs.writeFile(path.join(controlRoot, "monitor-access.json"), `${JSON.stringify({
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    monitorTokenSha256: request.monitorTokenSha256,
    expiresAt: new Date(FIXED_NOW + 60 * 60_000).toISOString(),
  }, null, 2)}\n`);
  await fs.writeFile(path.join(controlRoot, "heartbeat.json"), `${JSON.stringify({
    schemaVersion: LOCAL_UPDATE_HEARTBEAT_SCHEMA,
    version: "1.1.1",
    instanceId: "supervisor-before-recovery-crash",
    available: true,
    state: "installing",
    updatedAt: new Date(FIXED_NOW).toISOString(),
    monitor: {
      schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
      available: true,
      origin: monitorOrigin,
      bind: "127.0.0.1",
      port: endpointAddress.port,
    },
  })}\n`);
  const pendingPath = path.join(productRoot, "SYSTEM", ".bonni-source-update", "pending-update.json");
  await fs.writeFile(pendingPath, `${JSON.stringify({
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
  })}\n`);
  await assert.rejects(
    fs.lstat(path.join(controlRoot, "request.processing.json")),
    /ENOENT/u,
  );

  const recoveryReached = deferred();
  const continueRecovery = deferred();
  const operations = [];
  let nextPid = 7_500;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-after-recovery-crash",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    backendReadyTimeoutMs: 1_000,
    forkBackend() {
      return new FakeBackendChild(nextPid += 1, operations);
    },
    async runUpdate(_executable, args, options) {
      operations.push([args, options.env]);
      if (args.includes("--finalize")) return;
      recoveryReached.resolve();
      await continueRecovery.promise;
      await fs.rm(pendingPath, { force: true });
    },
    async probeBackend() { return { ok: true }; },
    backendHealthIntervalMs: 0,
  });
  t.after(() => {
    continueRecovery.resolve();
    return supervisor.stop("test");
  });

  const starting = supervisor.start();
  await recoveryReached.promise;
  const recovering = await monitorRequest(monitorOrigin, request.requestId, MONITOR_TOKEN);
  assert.equal(recovering.response.status, 200);
  assert.equal(recovering.body.progress.status, "installing");
  assert.equal(recovering.body.progress.phase, "recovery");
  assert.equal(recovering.body.progress.requestId, request.requestId);
  assert.equal(recovering.body.progress.updateId, request.updateId);
  assert.equal(recovering.body.progress.manifestSha256, request.manifestSha256);

  continueRecovery.resolve();
  const started = await starting;
  assert.equal(started.installationMonitorOrigin, monitorOrigin);
  const completed = await monitorRequest(monitorOrigin, request.requestId, MONITOR_TOKEN);
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.progress.status, "completed");
  assert.equal(completed.body.progress.phase, "complete");
  assert.equal(completed.body.progress.requestId, request.requestId);
  assert.equal(completed.body.progress.updateId, request.updateId);
  assert.equal(completed.body.progress.manifestSha256, request.manifestSha256);
  assert.equal(completed.body.switchTarget, "core");

  assert.equal(operations.length, 2);
  for (const [, environment] of operations) {
    assert.equal(environment.BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_ID, request.updateId);
    assert.equal(
      environment.BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_MANIFEST_SHA256,
      request.manifestSha256,
    );
  }
  assert.equal(operations[0][1].BONNI_UPDATE_DEFER_FINALIZE, "1");
  assert.equal(operations[1][1].BONNI_UPDATE_DEFER_FINALIZE, undefined);
});

test("belegter Standard-Monitorport bleibt bei aktiver Recovery fail-closed und diagnostizierbar", { concurrency: false }, async (t) => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  let ownsDefaultPort = false;
  try {
    await listenHttpServer(blocker, 4_198);
    ownsDefaultPort = true;
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
  }
  t.after(() => ownsDefaultPort ? closeHttpServer(blocker) : undefined);

  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, "pending-update.json"), "{}\n");
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-active-recovery",
    now: () => FIXED_NOW,
    forkBackend() {
      backendStarts += 1;
      return new FakeBackendChild(8_001, []);
    },
  });

  await assert.rejects(
    supervisor.start(),
    /SUPERVISOR_MONITOR_ENDPOINT_IN_USE_ACTIVE_UPDATE:4198/u,
  );
  assert.equal(backendStarts, 0);
  const heartbeat = JSON.parse(await fs.readFile(supervisor.heartbeatPath, "utf8"));
  assert.equal(heartbeat.available, false);
  assert.equal(heartbeat.state, "failed");
  assert.equal(heartbeat.monitor.available, false);
  assert.equal(heartbeat.monitor.origin, "http://127.0.0.1:4198");
  assert.match(heartbeat.message, /SUPERVISOR_MONITOR_ENDPOINT_IN_USE_ACTIVE_UPDATE/u);
});

test("Port-0-Recovery bindet exakt den alten Heartbeat-Port und wechselt bei Konflikt nicht", { concurrency: false }, async (t) => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  await listenHttpServer(blocker, 0);
  t.after(() => closeHttpServer(blocker));
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  const previousOrigin = `http://127.0.0.1:${address.port}`;

  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const controlRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  const request = requestFixture({
    requestId: "port-zero-recovery-request",
    updateId: "port-zero-recovery-update",
    manifestSha256: "f".repeat(64),
  });
  await fs.writeFile(path.join(controlRoot, "monitor-access.json"), `${JSON.stringify({
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    monitorTokenSha256: request.monitorTokenSha256,
    expiresAt: new Date(FIXED_NOW + 60 * 60_000).toISOString(),
  })}\n`);
  await fs.writeFile(path.join(controlRoot, "heartbeat.json"), `${JSON.stringify({
    schemaVersion: LOCAL_UPDATE_HEARTBEAT_SCHEMA,
    version: "1.1.1",
    instanceId: "port-zero-before-crash",
    available: true,
    state: "installing",
    updatedAt: new Date(FIXED_NOW).toISOString(),
    monitor: {
      schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
      available: true,
      origin: previousOrigin,
      bind: "127.0.0.1",
      port: address.port,
    },
  })}\n`);
  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  await fs.writeFile(path.join(stateRoot, "pending-update.json"), `${JSON.stringify({
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
  })}\n`);
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "port-zero-after-crash",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    forkBackend() {
      backendStarts += 1;
      return new FakeBackendChild(8_101, []);
    },
  });

  await assert.rejects(
    supervisor.start(),
    new RegExp(`SUPERVISOR_MONITOR_ENDPOINT_IN_USE_ACTIVE_UPDATE:${address.port}`, "u"),
  );
  assert.equal(backendStarts, 0);
  const heartbeat = JSON.parse(await fs.readFile(supervisor.heartbeatPath, "utf8"));
  assert.equal(heartbeat.state, "failed");
  assert.equal(heartbeat.monitor.available, false);
  assert.equal(heartbeat.monitor.origin, previousOrigin);
});

test("persistierter Monitorzugang ohne gültigen Endpoint-Receipt startet auch auf Default nicht neu", { concurrency: false }, async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const controlRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  const request = requestFixture({
    requestId: "missing-endpoint-receipt-request",
    updateId: "missing-endpoint-receipt-update",
    manifestSha256: "9".repeat(64),
  });
  await fs.writeFile(path.join(controlRoot, "monitor-access.json"), `${JSON.stringify({
    requestId: request.requestId,
    updateId: request.updateId,
    manifestSha256: request.manifestSha256,
    monitorTokenSha256: request.monitorTokenSha256,
    expiresAt: new Date(FIXED_NOW + 60 * 60_000).toISOString(),
  })}\n`);
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "missing-endpoint-receipt-supervisor",
    now: () => FIXED_NOW,
    forkBackend() {
      backendStarts += 1;
      return new FakeBackendChild(8_201, []);
    },
  });

  await assert.rejects(
    supervisor.start(),
    /SUPERVISOR_MONITOR_ENDPOINT_RECEIPT_REQUIRED_ACTIVE_UPDATE/u,
  );
  assert.equal(backendStarts, 0);
  const heartbeat = JSON.parse(await fs.readFile(supervisor.heartbeatPath, "utf8"));
  assert.equal(heartbeat.state, "failed");
  assert.equal(heartbeat.monitor.available, false);
  assert.equal(heartbeat.monitor.origin, null);
});

test("eine fehlgeschlagene Vollprüfung stoppt das laufende Backend nicht", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "preflight-reject-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-test-instance",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    forkBackend() { return new FakeBackendChild(5_001, events); },
    async runUpdate(_executable, args) {
      events.push(["update", args]);
      if (args.includes("--preflight")) throw new Error("SOURCE_UPDATE_PAYLOAD_HASH_MISMATCH:test");
    },
    async probeBackend() { throw new Error("must not probe"); },
  });
  t.after(() => supervisor.stop("test"));
  const started = await supervisor.start();
  const controlRoot = supervisor.controlRoot;
  const request = requestFixture({
    updateId,
    manifestSha256: staged.manifestSha256,
  });
  await fs.writeFile(path.join(controlRoot, "request.json"), `${JSON.stringify(request)}\n`);

  assert.equal(await supervisor.pollOnce(), true);
  assert.equal(events.filter(([event]) => event === "backend-message").length, 0);
  assert.ok(supervisor.backendChild, "backend must keep running after preflight rejection");
  const status = JSON.parse(await fs.readFile(path.join(controlRoot, "status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "validate");
  const monitored = await monitorRequest(started.installationMonitorOrigin, request.requestId);
  assert.equal(monitored.body.terminal, true);
  assert.equal(monitored.body.switchTarget, "core");
  assert.deepEqual(monitored.body.core, { state: "online", available: true });
});

test("ohne drei erfolgreiche Healthchecks wird das Update nicht finalisiert", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "health-reject-0001";
  const staged = await stageManifest(productRoot, updateId);
  const operations = [];
  let healthCalls = 0;
  let nextPid = 5_100;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-test-instance",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    backendHealthIntervalMs: 0,
    forkBackend() { return new FakeBackendChild(nextPid += 1, operations); },
    async runUpdate(_executable, args) { operations.push(["operation", args.at(-1)]); },
    async probeBackend() {
      healthCalls += 1;
      if (healthCalls === 3) throw new Error("SUPERVISOR_BACKEND_HEALTH_NOT_READY");
      return { ok: true };
    },
  });
  t.after(() => supervisor.stop("test"));
  await supervisor.start();
  await fs.writeFile(path.join(supervisor.controlRoot, "request.json"), `${JSON.stringify(requestFixture({
    updateId,
    manifestSha256: staged.manifestSha256,
  }))}\n`);

  assert.equal(await supervisor.pollOnce(), true);
  assert.equal(healthCalls, 3);
  assert.equal(operations.some((entry) => entry[0] === "operation" && entry[1] === "--finalize"), false);
  const status = JSON.parse(await fs.readFile(path.join(supervisor.controlRoot, "status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "health");
  assert.equal(status.steps.find((step) => step.key === "health")?.status, "failed");
  assert.equal(status.steps.find((step) => step.key === "return")?.status, "pending");
});

test("Core-Exit nach bestandenem Healthcheck während finalize wird nie als completed gemeldet", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const updateId = "core-exit-during-finalize-0001";
  const staged = await stageManifest(productRoot, updateId);
  const events = [];
  let backendStarts = 0;
  let activeChild = null;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "supervisor-finalize-exit",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    backendReadyTimeoutMs: 1_000,
    backendHealthIntervalMs: 0,
    forkBackend() {
      backendStarts += 1;
      activeChild = new FakeBackendChild(7_800 + backendStarts, events);
      return activeChild;
    },
    async runUpdate(_executable, args) {
      events.push(["update", args]);
      if (!args.includes("--finalize")) return;
      activeChild.exitCode = 1;
      activeChild.connected = false;
      activeChild.emit("exit", 1, null);
      await new Promise((resolve) => setImmediate(resolve));
    },
    async probeBackend() { return { ok: true }; },
  });
  t.after(() => supervisor.stop("test"));
  await supervisor.start();
  await fs.writeFile(supervisor.requestPath, `${JSON.stringify(requestFixture({
    requestId: "finalize-exit-request",
    updateId,
    manifestSha256: staged.manifestSha256,
    supervisorInstanceId: "supervisor-finalize-exit",
  }))}\n`);

  assert.equal(await supervisor.pollOnce(), true);
  const status = JSON.parse(await fs.readFile(supervisor.statusPath, "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "return");
  assert.equal(status.errorCode, "SUPERVISOR_BACKEND_UNAVAILABLE_AFTER_UPDATE");
  assert.equal(backendStarts, 3, "Nach busy-Freigabe muss genau ein sicherer Core-Neustart erfolgen");
  assert.equal(supervisor.backendLifecycle, "online");
  assert.ok(supervisor.backendChild);
});

test("lebender Core-PID-Beleg blockiert Recovery und zweiten Fork fail-closed", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const controlRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  const oldReceipt = {
    pid: 91_001,
    supervisorInstanceId: "crashed-supervisor",
    startedAt: "2026-08-21T09:58:00.000Z",
  };
  await fs.writeFile(path.join(controlRoot, "core-child.json"), `${JSON.stringify(oldReceipt)}\n`, { mode: 0o600 });
  await fs.writeFile(
    path.join(productRoot, "SYSTEM", ".bonni-source-update", "pending-update.json"),
    "{}\n",
  );
  let backendStarts = 0;
  let updateRuns = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "replacement-supervisor",
    previousCoreExitTimeoutMs: 0,
    installationMonitorPort: 0,
    isPidAlive(pid) { return pid === oldReceipt.pid; },
    async probeExistingCore() { return false; },
    forkBackend() { backendStarts += 1; return new FakeBackendChild(91_002, []); },
    async runUpdate() { updateRuns += 1; },
  });

  await assert.rejects(supervisor.start(), /SUPERVISOR_PREVIOUS_CORE_STILL_RUNNING:91001/u);
  assert.equal(updateRuns, 0, "Recovery darf vor bestätigtem Alt-Core-Exit nicht mutieren");
  assert.equal(backendStarts, 0);
  assert.deepEqual(
    JSON.parse(await fs.readFile(supervisor.coreChildReceiptPath, "utf8")),
    oldReceipt,
  );
  await assert.rejects(fs.lstat(supervisor.supervisorLockPath), /ENOENT/u);
});

test("beendeter Core-PID-Beleg wird exakt entfernt und Recovery darf danach starten", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const controlRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
  const pendingPath = path.join(productRoot, "SYSTEM", ".bonni-source-update", "pending-update.json");
  await fs.mkdir(controlRoot, { recursive: true });
  await fs.writeFile(path.join(controlRoot, "core-child.json"), `${JSON.stringify({
    pid: 91_101,
    supervisorInstanceId: "dead-supervisor",
    startedAt: "2026-08-21T09:58:00.000Z",
  })}\n`, { mode: 0o600 });
  await fs.writeFile(pendingPath, "{}\n");
  const operations = [];
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "recovery-after-dead-core",
    now: () => FIXED_NOW,
    installationMonitorPort: 0,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    isPidAlive() { return false; },
    async probeExistingCore() { return false; },
    forkBackend() { return new FakeBackendChild(91_102, operations); },
    async runUpdate(_executable, args) {
      operations.push(["update", args]);
      if (!args.includes("--finalize")) await fs.rm(pendingPath, { force: true });
    },
    async probeBackend() { return { ok: true }; },
    backendHealthIntervalMs: 0,
  });
  t.after(() => supervisor.stop("test"));

  await supervisor.start();
  assert.deepEqual(
    operations.filter(([event]) => event === "update").map(([, args]) => args.at(-1)),
    [supervisor.updateScript, "--finalize"],
  );
  const currentReceipt = JSON.parse(await fs.readFile(supervisor.coreChildReceiptPath, "utf8"));
  assert.equal(currentReceipt.pid, 91_102);
  assert.equal(currentReceipt.supervisorInstanceId, "recovery-after-dead-core");
});

test("Core-Receipt-Removal löscht bei PID-/Owner-Wechsel niemals den fremden Beleg", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "receipt-owner-a",
    async probeExistingCore() { return false; },
  });
  await fs.mkdir(supervisor.controlRoot, { recursive: true });
  const expected = {
    pid: 91_201,
    supervisorInstanceId: "receipt-owner-a",
    startedAt: "2026-08-21T09:58:00.000Z",
  };
  const replacement = {
    pid: 91_202,
    supervisorInstanceId: "receipt-owner-b",
    startedAt: "2026-08-21T09:59:00.000Z",
  };
  await fs.writeFile(supervisor.coreChildReceiptPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  assert.equal(await supervisor.removeCoreChildReceiptExact(expected), false);
  assert.deepEqual(
    JSON.parse(await fs.readFile(supervisor.coreChildReceiptPath, "utf8")),
    replacement,
  );
});

test("Singleton-Lock verhindert zwei Supervisoren noch vor Monitor, Heartbeat und Core-Fork", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const first = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "singleton-owner-a",
    isPidAlive() { return true; },
  });
  let secondBackendStarts = 0;
  const second = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "singleton-owner-b",
    isPidAlive() { return true; },
    forkBackend() {
      secondBackendStarts += 1;
      return new FakeBackendChild(91_601, []);
    },
  });
  await fs.mkdir(first.controlRoot, { recursive: true });
  await first.acquireSupervisorLock();
  t.after(() => first.releaseSupervisorLock());

  await assert.rejects(second.start(), /SUPERVISOR_INSTANCE_ALREADY_RUNNING/u);
  assert.equal(second.installationMonitorServer, null);
  assert.equal(second.backendChild, null);
  assert.equal(secondBackendStarts, 0);
  await assert.rejects(fs.lstat(second.heartbeatPath), /ENOENT/u);
  const lock = JSON.parse(await fs.readFile(first.supervisorLockPath, "utf8"));
  assert.equal(lock.instanceId, "singleton-owner-a");
  assert.equal((await fs.stat(first.supervisorLockPath)).mode & 0o777, 0o600);
});

test("staler Singleton-Lock wird übernommen; exact removal bewahrt einen neuen Owner", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "singleton-takeover",
    now: () => FIXED_NOW,
    isPidAlive() { return false; },
  });
  await fs.mkdir(supervisor.controlRoot, { recursive: true });
  await fs.writeFile(supervisor.supervisorLockPath, `${JSON.stringify({
    pid: 91_301,
    instanceId: "stale-owner",
    startedAt: "2026-08-21T09:58:00.000Z",
  })}\n`, { mode: 0o600 });

  const owned = await supervisor.acquireSupervisorLock();
  assert.equal(owned.instanceId, "singleton-takeover");
  const replacement = {
    pid: 91_302,
    instanceId: "new-owner",
    startedAt: "2026-08-21T10:01:00.000Z",
  };
  await fs.writeFile(supervisor.supervisorLockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  assert.equal(await supervisor.releaseSupervisorLock(), false);
  assert.deepEqual(
    JSON.parse(await fs.readFile(supervisor.supervisorLockPath, "utf8")),
    replacement,
  );
});

test("lebender fremder Legacy-Heartbeat blockiert U09 unabhängig von available vor Shared-State-Writes", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const controlRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update", "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  const heartbeatPath = path.join(controlRoot, "heartbeat.json");
  const source = `${JSON.stringify({
    schemaVersion: LOCAL_UPDATE_HEARTBEAT_SCHEMA,
    version: "1.0.0",
    instanceId: "u08-supervisor",
    pid: 91_401,
    available: false,
    state: "stopping",
    updatedAt: "2026-08-21T10:00:00.000Z",
    monitor: { schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA, available: false, origin: null, bind: "127.0.0.1", port: null },
  }, null, 2)}\n`;
  await fs.writeFile(heartbeatPath, source);
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "u09-supervisor",
    isPidAlive(pid) { return pid === 91_401; },
    forkBackend() { backendStarts += 1; return new FakeBackendChild(91_402, []); },
  });

  await assert.rejects(supervisor.start(), /SUPERVISOR_ACTIVATION_RESTART_REQUIRED:91401/u);
  assert.equal(backendStarts, 0);
  assert.equal(await fs.readFile(heartbeatPath, "utf8"), source);
  await assert.rejects(fs.lstat(supervisor.supervisorLockPath), /ENOENT/u);
  assert.equal(supervisor.installationMonitorServer, null);
});

test("Legacy ohne Belege, aber mit erreichbarem Core-Endpunkt blockiert den Fork", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "legacy-endpoint-gate",
    async probeExistingCore() { return true; },
    forkBackend() { backendStarts += 1; return new FakeBackendChild(91_501, []); },
  });

  await assert.rejects(supervisor.start(), /SUPERVISOR_EXISTING_CORE_ENDPOINT_REACHABLE/u);
  assert.equal(backendStarts, 0);
  assert.equal(supervisor.installationMonitorServer, null);
  await assert.rejects(fs.lstat(supervisor.heartbeatPath), /ENOENT/u);
  await assert.rejects(fs.lstat(supervisor.supervisorLockPath), /ENOENT/u);
});

test("Start-Dispatcher wählt lokal den Supervisor und in Production direkt das Backend", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(backendRoot, "package.json"), "utf8"));
  const gateSource = await fs.readFile(
    path.join(backendRoot, "scripts", "setup", "local-source-update-gate.mjs"),
    "utf8",
  );
  const serverSource = await fs.readFile(
    path.join(backendRoot, "src", "system", "server", "run-server.ts"),
    "utf8",
  );
  const supervisorSource = await fs.readFile(
    path.join(backendRoot, "scripts", "setup", "local-source-update-supervisor.mjs"),
    "utf8",
  );
  const dockerfile = await fs.readFile(path.join(backendRoot, "Dockerfile"), "utf8");

  assert.equal(isProductionEnvironment({ NODE_ENV: "production" }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: "test" }), false);
  assert.match(
    selectBackendEntry({ backendRoot, environment: { NODE_ENV: "production" } }),
    /dist[/\\]system[/\\]server[/\\]run-server\.js$/u,
  );
  assert.match(
    selectBackendEntry({ backendRoot, environment: { NODE_ENV: "development" } }),
    /scripts[/\\]setup[/\\]local-source-update-supervisor\.mjs$/u,
  );
  assert.equal(shouldRunLocalSourceUpdateGate({ NODE_ENV: "production" }), false);
  assert.equal(shouldRunLocalSourceUpdateGate({ NODE_ENV: "development" }), true);
  assert.equal(
    packageJson.scripts.start,
    "npm run maintenance:cleanup && npm run auth:ensure-jwt && node scripts/runtime/start-backend.mjs",
  );
  assert.equal(packageJson.scripts.prestart, "node scripts/runtime/local-source-update-start-gate.mjs");
  assert.match(gateSource, /npm_lifecycle_event === "prestart"/u);
  assert.match(gateSource, /assertNoPendingLocalSourceUpdate/u);
  assert.match(serverSource, /BONNI_SUPERVISOR_SHUTDOWN/u);
  assert.match(serverSource, /BONNI_BACKEND_SHUTDOWN_COMPLETE/u);
  assert.match(serverSource, /BONNI_BACKEND_READY/u);
  assert.doesNotMatch(supervisorSource, /update-runner\.mjs|docker|compose|OCI/iu);
  assert.match(dockerfile, /COPY SYSTEM\/backend\/scripts\/maintenance \.\/scripts\/maintenance/u);
  assert.match(dockerfile, /COPY SYSTEM\/backend\/scripts\/runtime \.\/scripts\/runtime/u);
});

test("Production-Dispatcher benötigt keinen scripts/setup-Baum und startet nur dist", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-production-dispatch-"));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runtimeScripts = path.join(runtimeRoot, "scripts", "runtime");
  const setupScripts = path.join(runtimeRoot, "scripts", "setup");
  const serverEntry = path.join(runtimeRoot, "dist", "system", "server", "run-server.js");
  const marker = path.join(runtimeRoot, "selected.txt");
  await fs.mkdir(runtimeScripts, { recursive: true });
  await fs.mkdir(path.dirname(serverEntry), { recursive: true });
  await fs.copyFile(
    path.join(backendRoot, "scripts", "runtime", "start-backend.mjs"),
    path.join(runtimeScripts, "start-backend.mjs"),
  );
  await fs.copyFile(
    path.join(backendRoot, "scripts", "runtime", "runtime-mode-exclusion.mjs"),
    path.join(runtimeScripts, "runtime-mode-exclusion.mjs"),
  );
  await fs.copyFile(
    path.join(backendRoot, "scripts", "runtime", "local-source-update-start-gate.mjs"),
    path.join(runtimeScripts, "local-source-update-start-gate.mjs"),
  );
  await fs.writeFile(serverEntry, [
    'import fs from "node:fs/promises";',
    `await fs.writeFile(${JSON.stringify(marker)}, "dist");`,
    "",
  ].join("\n"));

  const environment = { ...process.env, NODE_ENV: "production" };
  await execFileAsync(process.execPath, [path.join(runtimeScripts, "local-source-update-start-gate.mjs")], {
    cwd: runtimeRoot,
    env: environment,
  });
  await execFileAsync(process.execPath, [path.join(runtimeScripts, "start-backend.mjs")], {
    cwd: runtimeRoot,
    env: environment,
  });

  assert.equal(await fs.readFile(marker, "utf8"), "dist");
  await assert.rejects(fs.lstat(setupScripts), /ENOENT/u);
});

test("Legacy npm start acquires, binds and cleanly releases its own host lifetime lease", async (t) => {
  const fixture = await createHostStartBackendFixture(t);
  await execFileAsync(process.execPath, [fixture.startScript], {
    cwd: fixture.fixtureBackendRoot,
    env: fixture.environment,
  });
  const observation = JSON.parse(await fs.readFile(fixture.observationPath, "utf8"));
  assert.equal(observation.receipt.schemaVersion, "bonni.local-host-backend-runtime/v1");
  assert.equal(observation.receipt.entry, "start");
  assert.equal(Number(observation.leaseOwnerPid), observation.receipt.pid);
  assert.equal(observation.leaseToken, observation.receipt.token);
  assert.ok(Number.isSafeInteger(observation.receipt.childPid) && observation.receipt.childPid > 0);
  await assert.rejects(fs.lstat(fixture.leasePath), (error) => error?.code === "ENOENT");
});

test("Legacy npm start retains its bound host lease after an unclean child exit", async (t) => {
  const fixture = await createHostStartBackendFixture(t, { exitCode: 7 });
  await assert.rejects(
    execFileAsync(process.execPath, [fixture.startScript], {
      cwd: fixture.fixtureBackendRoot,
      env: fixture.environment,
    }),
    /Host-Modusbeleg bleibt/u,
  );
  const receipt = JSON.parse(await fs.readFile(fixture.leasePath, "utf8"));
  assert.equal(receipt.entry, "start");
  assert.ok(Number.isSafeInteger(receipt.childPid) && receipt.childPid > 0);
});

test("Legacy npm start forwards SIGTERM and releases only after the child confirms a clean shutdown", {
  skip: process.platform === "win32" ? "POSIX-Prozessgruppenbeleg" : false,
  timeout: 30_000,
}, async (t) => {
  const fixture = await createHostStartBackendFixture(t, { gracefulSignal: true });
  const dispatcher = spawn(process.execPath, [fixture.startScript], {
    cwd: fixture.fixtureBackendRoot,
    env: fixture.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  dispatcher.stdout.on("data", (chunk) => stdout.push(chunk));
  dispatcher.stderr.on("data", (chunk) => stderr.push(chunk));
  await waitForFile(fixture.observationPath);
  dispatcher.kill("SIGTERM");
  const result = await new Promise((resolve, reject) => {
    dispatcher.once("error", reject);
    dispatcher.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, `${Buffer.concat(stderr).toString("utf8")}\n${Buffer.concat(stdout).toString("utf8")}`);
  assert.equal(await fs.readFile(fixture.shutdownPath, "utf8"), "clean");
  await assert.rejects(fs.lstat(fixture.leasePath), (error) => error?.code === "ENOENT");
});

test("Supervisor blockiert Production vor Backendstart und Request-Polling", { concurrency: false }, async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "production-supervisor-test",
    forkBackend() {
      backendStarts += 1;
      throw new Error("MUST_NOT_START");
    },
  });

  assert.throws(
    () => assertLocalSourceSupervisorEnabled({ NODE_ENV: "production" }),
    /SUPERVISOR_DISABLED_IN_PRODUCTION/u,
  );
  await assert.rejects(supervisor.start(), /SUPERVISOR_DISABLED_IN_PRODUCTION/u);
  await assert.rejects(supervisor.pollOnce(), /SUPERVISOR_DISABLED_IN_PRODUCTION/u);
  assert.equal(backendStarts, 0);
  await assert.rejects(fs.lstat(supervisor.controlRoot), /ENOENT/u);
});

test("Supervisor respektiert die atomare Docker-Runtime-Aktivierung vor jedem Backendstart", async (t) => {
  const { productRoot, fixtureBackendRoot } = await createProductFixture(t);
  const activation = await acquireDockerRuntimeActivation({
    productRoot,
    ownerPid: process.pid,
    probePort: async () => false,
  });
  let backendStarts = 0;
  const supervisor = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "docker-activation-race-supervisor",
    forkBackend() {
      backendStarts += 1;
      throw new Error("MUST_NOT_START");
    },
  });

  await assert.rejects(supervisor.start(), /DOCKER_RUNTIME_ACTIVATION_IN_PROGRESS/u);
  assert.equal(backendStarts, 0);
  await assert.rejects(fs.lstat(supervisor.supervisorLockPath), /ENOENT/u);
  assert.equal(await releaseDockerRuntimeActivation({
    productRoot,
    ownerPid: process.pid,
    token: activation.token,
  }), true);

  const stale = await acquireDockerRuntimeActivation({
    productRoot,
    ownerPid: 999_991,
    isPidAlive: () => false,
    probePort: async () => false,
  });
  assert.ok(stale.token);
  const afterRuntimeStart = new LocalSourceUpdateSupervisor({
    productRoot,
    backendRoot: fixtureBackendRoot,
    instanceId: "stale-runtime-latch-supervisor",
    forkBackend() {
      backendStarts += 1;
      throw new Error("MUST_NOT_START");
    },
  });
  await assert.rejects(afterRuntimeStart.start(), /DOCKER_RUNTIME_ACTIVATION_STALE/u);
  assert.equal(backendStarts, 0);
  const deactivation = await acquireDockerRuntimeDeactivationIntent({
    productRoot,
    ownerPid: process.pid,
    isPidAlive: (pid) => pid === process.pid,
  });
  assert.deepEqual(await deactivateDockerRuntimeMode({
    productRoot,
    deactivationOwnerPid: process.pid,
    deactivationToken: deactivation.token,
    isPidAlive: () => false,
    probePort: async () => false,
  }), { ok: true, removed: true });
  assert.equal(await releaseDockerRuntimeDeactivationIntent({
    productRoot,
    ownerPid: process.pid,
    token: deactivation.token,
  }), true);
});
