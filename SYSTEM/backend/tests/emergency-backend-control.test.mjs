import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const backendRoot = path.resolve(import.meta.dirname, "..");
const modulePath = process.env.BONNI_EMERGENCY_CONTROL_MODULE
  || path.join(
    backendRoot,
    "dist",
    "platform",
    "security",
    "control",
    "emergency-backend",
    "emergency-backend-control.service.js",
  );
const {
  getEmergencyHealth,
  isEmergencyProcessAlive,
  killPid,
  startEmergencyBackend,
  stopEmergencyBackend,
} = await import(pathToFileURL(modulePath).href);

function fakeTaskkill({ code = 0, error = null, emit = true } = {}) {
  return () => {
    const child = new EventEmitter();
    child.kill = () => true;
    if (emit) {
      setImmediate(() => {
        if (error) child.emit("error", error);
        else child.emit("exit", code, null);
      });
    }
    return child;
  };
}

function structuredReceipt(pid, startedAt = new Date().toISOString()) {
  return {
    schemaVersion: "bonni.emergency-process/v1",
    pid,
    ownerToken: "01234567-89ab-4cde-8fab-0123456789ab",
    startedAt,
    processGroup: false,
  };
}

async function receiptFixture(t, receipt = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-emergency-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.RUN_SYSTEM_SYSTEM_ROOT = root;
  const file = path.join(root, "emergency", "emergency.pid");
  if (receipt) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return { root, file };
}

const offlineHealth = {
  reachable: false,
  identity: {
    slotRole: null,
    matchesExpectedPid: false,
    matchesExpectedLaunch: false,
    matchesExpectedProcess: false,
  },
};

test("Windows taskkill muss erfolgreich enden und das echte PID-Ende abwarten", async () => {
  let alivePolls = 0;
  let clock = 0;
  const result = await killPid(1234, {
    platform: "win32",
    spawnTaskkill: fakeTaskkill(),
    processAlive() {
      alivePolls += 1;
      return alivePolls < 4;
    },
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    stopTimeoutMs: 100,
    pollIntervalMs: 10,
  });
  assert.equal(result.stopped, true);
  assert.ok(alivePolls >= 4);

  await assert.rejects(
    killPid(1234, {
      platform: "win32",
      spawnTaskkill: fakeTaskkill({ code: 5 }),
      processAlive: () => true,
    }),
    /EMERGENCY_TASKKILL_FAILED:exit-5/u,
  );
  await assert.rejects(
    killPid(1234, {
      platform: "win32",
      spawnTaskkill: fakeTaskkill({ error: new Error("spawn denied") }),
      processAlive: () => true,
    }),
    /EMERGENCY_TASKKILL_SPAWN_FAILED:spawn denied/u,
  );
});

test("Windows taskkill Erfolg darf einen weiter lebenden PID nicht verbergen", async () => {
  let clock = 0;
  await assert.rejects(
    killPid(4567, {
      platform: "win32",
      spawnTaskkill: fakeTaskkill(),
      processAlive: () => true,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
      stopTimeoutMs: 25,
      pollIntervalMs: 5,
    }),
    /EMERGENCY_PROCESS_STILL_RUNNING:4567/u,
  );
  await assert.rejects(
    killPid(4567, {
      platform: "win32",
      spawnTaskkill: fakeTaskkill({ emit: false }),
      processAlive: () => true,
      taskkillTimeoutMs: 5,
    }),
    /EMERGENCY_TASKKILL_TIMEOUT:4567/u,
  );
});

test("POSIX beendet und verifiziert einen echten Prozessbaum", { skip: process.platform === "win32" }, async (t) => {
  const childCode = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "setTimeout(() => process.exit(0), 20);",
  ].join("\n");
  const root = spawn(process.execPath, ["-e", childCode], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let descendantPid = null;
  t.after(() => {
    try { process.kill(-root.pid, "SIGKILL"); } catch {}
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
  });
  const [chunk] = await once(root.stdout, "data");
  descendantPid = Number(String(chunk).trim().split(/\s+/u)[0]);
  await once(root, "exit");
  assert.equal(isEmergencyProcessAlive(-root.pid), true);
  assert.equal(isEmergencyProcessAlive(descendantPid), true);

  await killPid(root.pid, {
    platform: process.platform,
    processGroup: true,
    stopTimeoutMs: 2_000,
    pollIntervalMs: 25,
  });
  assert.equal(isEmergencyProcessAlive(-root.pid), false);
  assert.equal(isEmergencyProcessAlive(descendantPid), false);
});

test("Health bindet Wrapper und Node-Nachfahren an Rolle und Startfenster", async (t) => {
  const startedAt = new Date().toISOString();
  const runtime = {
    pid: process.pid,
    slotRole: "emergency",
    startedAt: new Date(Date.now() + 20).toISOString(),
  };
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, runtime, path: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const config = {
    enabled: true,
    autoStart: false,
    autoStartDelayMs: 0,
    port: address.port,
    bind: "127.0.0.1",
    lastChangedAt: null,
    lastChangedBy: null,
  };

  const matching = await getEmergencyHealth(config, process.pid + 1000, startedAt);
  assert.equal(matching.identity.matchesExpectedPid, false);
  assert.equal(matching.identity.matchesExpectedLaunch, true);
  assert.equal(matching.identity.matchesExpectedProcess, true);

  const stale = await getEmergencyHealth(
    config,
    process.pid + 1000,
    new Date(Date.now() - 120_000).toISOString(),
  );
  assert.equal(stale.identity.matchesExpectedProcess, false);
});

test("fehlender PID-Beleg bei erreichbarem Emergency-Port ist fail-closed", async (t) => {
  const { file } = await receiptFixture(t);
  await assert.rejects(
    stopEmergencyBackend("manual", {
      processAlive: () => false,
      getHealth: async () => ({
        reachable: true,
        identity: { slotRole: "emergency", matchesExpectedProcess: false },
      }),
      getStatus: async () => ({ ok: true, health: offlineHealth }),
    }),
    /EMERGENCY_BACKEND_REACHABLE_WITHOUT_LIVE_OWNER_PID:missing:emergency/u,
  );
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("toter Receipt-PID mit weiter erreichbarem Backend bleibt als Beleg erhalten", async (t) => {
  const receipt = structuredReceipt(99123);
  const { file } = await receiptFixture(t, receipt);
  await assert.rejects(
    stopEmergencyBackend("manual", {
      processAlive: () => false,
      getHealth: async () => ({
        reachable: true,
        identity: { slotRole: "emergency", matchesExpectedProcess: false },
      }),
      getStatus: async () => ({ ok: true, health: offlineHealth }),
    }),
    /EMERGENCY_BACKEND_REACHABLE_WITHOUT_LIVE_OWNER_PID:99123:emergency/u,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), receipt);
});

test("PID-Beleg wird erst nach Kill- und Port-Verifikation gelöscht", async (t) => {
  const receipt = structuredReceipt(99124);
  const { file } = await receiptFixture(t, receipt);
  let alive = true;
  await assert.rejects(
    stopEmergencyBackend("manual", {
      processAlive: () => alive,
      async terminatePid() {
        alive = false;
      },
      getHealth: async () => ({
        reachable: true,
        identity: { slotRole: "emergency", matchesExpectedProcess: true },
      }),
      getStatus: async () => ({ ok: true, health: offlineHealth }),
    }),
    /EMERGENCY_BACKEND_STILL_REACHABLE_AFTER_STOP:99124:emergency/u,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), receipt);

  await stopEmergencyBackend("manual", {
    processAlive: () => false,
    getHealth: async () => offlineHealth,
    getStatus: async () => ({ ok: true, health: offlineHealth }),
  });
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("unverifizierte PID-Wiederverwendung wird nicht beendet", async (t) => {
  const receipt = structuredReceipt(99125, new Date(Date.now() - 600_000).toISOString());
  const { file } = await receiptFixture(t, receipt);
  let terminateCalled = false;
  await assert.rejects(
    stopEmergencyBackend("manual", {
      processAlive: () => true,
      async terminatePid() {
        terminateCalled = true;
      },
      getHealth: async () => ({
        reachable: true,
        identity: {
          slotRole: "emergency",
          matchesExpectedPid: false,
          matchesExpectedLaunch: false,
          matchesExpectedProcess: false,
        },
      }),
      getStatus: async () => ({ ok: true, health: offlineHealth }),
    }),
    /EMERGENCY_PROCESS_OWNERSHIP_UNVERIFIED:99125:emergency/u,
  );
  assert.equal(terminateCalled, false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), receipt);
});

test("lokaler Supervisor-Stopp annulliert laufenden Start und hält spätere Starts", async (t) => {
  await receiptFixture(t);
  let releaseInitialHealth;
  const initialHealthGate = new Promise((resolve) => {
    releaseInitialHealth = resolve;
  });
  await fs.writeFile(
    path.join(process.env.RUN_SYSTEM_SYSTEM_ROOT, "emergency-control.json"),
    `${JSON.stringify({ enabled: true, autoStart: true, autoStartDelayMs: 0, port: 65530 })}\n`,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await initialHealthGate;
    return {
      ok: false,
      status: 0,
      text: async () => "",
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const start = startEmergencyBackend("race-test");
  const stop = stopEmergencyBackend("local-source-update", {
    processAlive: () => false,
    getHealth: async () => offlineHealth,
    getStatus: async () => ({ ok: true, health: offlineHealth }),
  });
  releaseInitialHealth();
  const [startResult, stopResult] = await Promise.all([start, stop]);
  assert.equal(startResult.reason, "EMERGENCY_START_CANCELLED");
  assert.equal(stopResult.reason, "NOT_RUNNING");

  const heldStart = await startEmergencyBackend("after-local-stop");
  assert.equal(heldStart.reason, "EMERGENCY_START_CANCELLED");
});
