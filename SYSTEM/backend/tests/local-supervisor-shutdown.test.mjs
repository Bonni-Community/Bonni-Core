import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const backendRoot = path.resolve(import.meta.dirname, "..");
const modulePath = process.env.BONNI_LOCAL_SUPERVISOR_SHUTDOWN_MODULE
  || path.join(backendRoot, "dist", "system", "server", "local-supervisor-shutdown.js");
const {
  completeLocalSupervisorShutdown,
  isLocalUpdateSupervisorProcess,
  sendIpcMessageAndWait,
} = await import(pathToFileURL(modulePath).href);

test("lokaler Supervisor-Schutz gilt nur für verbundenen lokalen Active-Core", () => {
  const local = {
    nodeEnv: "development",
    slotRole: "active",
    supervisorFlag: "1",
    connected: true,
  };
  assert.equal(isLocalUpdateSupervisorProcess(local), true);
  assert.equal(isLocalUpdateSupervisorProcess({ ...local, nodeEnv: "production" }), false);
  assert.equal(isLocalUpdateSupervisorProcess({ ...local, slotRole: "candidate" }), false);
  assert.equal(isLocalUpdateSupervisorProcess({ ...local, slotRole: "emergency" }), false);
  assert.equal(isLocalUpdateSupervisorProcess({ ...local, supervisorFlag: undefined }), false);
  assert.equal(isLocalUpdateSupervisorProcess({ ...local, connected: false }), false);
});

test("hängender Listener blockiert Emergency-Stopp und Prisma nicht unbegrenzt", async () => {
  const events = [];
  let releaseEmergency;
  const emergencyGate = new Promise((resolve) => {
    releaseEmergency = resolve;
  });
  const server = {
    close() {
      events.push("listener-close");
      // Absichtlich kein Callback: simuliert eine dauerhaft offene Verbindung.
      return this;
    },
    closeIdleConnections() {
      events.push("idle-close");
    },
    closeAllConnections() {
      events.push("forced-close");
    },
  };

  const completion = completeLocalSupervisorShutdown({
    servers: [server],
    drainTimeoutMs: 15,
    async stopEmergency() {
      events.push("emergency-start");
      await emergencyGate;
      events.push("emergency-stopped");
      return { stopped: true };
    },
    async disconnectPrisma() {
      events.push("prisma-disconnected");
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 3), [
    "listener-close",
    "idle-close",
    "emergency-start",
  ]);
  assert.equal(events.includes("prisma-disconnected"), false);
  releaseEmergency();

  const result = await completion;
  assert.equal(result.serverDrain[0].forced, true);
  assert.equal(events.includes("forced-close"), true);
  assert.ok(events.indexOf("emergency-stopped") < events.indexOf("prisma-disconnected"));
  assert.ok(events.indexOf("forced-close") < events.indexOf("prisma-disconnected"));
});

test("Emergency-Fehler verhindert Prisma-Freigabe", async () => {
  let prismaDisconnected = false;
  const server = {
    close(callback) {
      callback();
      return this;
    },
  };

  await assert.rejects(
    completeLocalSupervisorShutdown({
      servers: [server],
      drainTimeoutMs: 10,
      async stopEmergency() {
        throw new Error("EMERGENCY_PROCESS_STILL_RUNNING");
      },
      async disconnectPrisma() {
        prismaDisconnected = true;
      },
    }),
    /EMERGENCY_PROCESS_STILL_RUNNING/u,
  );
  assert.equal(prismaDisconnected, false);
});

test("fehlender oder fehlerhafter Zwangs-Drain bleibt fail-closed", async (t) => {
  for (const fixture of [
    {
      name: "missing",
      server: { close() { return this; } },
      pattern: /SERVER_FORCE_CLOSE_UNAVAILABLE/u,
    },
    {
      name: "throws",
      server: {
        close() { return this; },
        closeAllConnections() { throw new Error("force close denied"); },
      },
      pattern: /force close denied/u,
    },
  ]) {
    await t.test(fixture.name, async () => {
      let prismaDisconnected = false;
      await assert.rejects(
        completeLocalSupervisorShutdown({
          servers: [fixture.server],
          drainTimeoutMs: 5,
          async stopEmergency() {
            return { stopped: true, health: { reachable: false } };
          },
          async disconnectPrisma() {
            prismaDisconnected = true;
          },
        }),
        fixture.pattern,
      );
      assert.equal(prismaDisconnected, false);
    });
  }
});

test("fehlender abschließender Emergency-Nachweis verhindert Prisma", async () => {
  let prismaDisconnected = false;
  await assert.rejects(
    completeLocalSupervisorShutdown({
      servers: [{ close(callback) { callback(); return this; } }],
      async stopEmergency() {
        return { stopped: true, health: { reachable: true } };
      },
      verifyEmergency(result) {
        if (result.health.reachable) throw new Error("EMERGENCY_STILL_REACHABLE");
      },
      async disconnectPrisma() {
        prismaDisconnected = true;
      },
    }),
    /EMERGENCY_STILL_REACHABLE/u,
  );
  assert.equal(prismaDisconnected, false);
});

test("IPC-Nachricht gilt erst nach erfolgreichem Send-Callback als bestätigt", async () => {
  const events = [];
  await sendIpcMessageAndWait((message, callback) => {
    events.push(["send", message]);
    setImmediate(() => {
      events.push(["callback"]);
      callback(null);
    });
    return true;
  }, { type: "BONNI_BACKEND_SHUTDOWN_COMPLETE", requestId: "request-1" });
  events.push(["resolved"]);
  assert.deepEqual(events.map(([event]) => event), ["send", "callback", "resolved"]);

  await assert.rejects(
    sendIpcMessageAndWait((_message, callback) => {
      setImmediate(() => callback(new Error("channel closed")));
      return false;
    }, { type: "BONNI_BACKEND_SHUTDOWN_COMPLETE" }),
    /channel closed/u,
  );
});
