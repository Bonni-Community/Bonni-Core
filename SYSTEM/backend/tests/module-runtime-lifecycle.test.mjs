import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import {
  createDynamicModuleRuntime,
  normalizeRuntimeModuleCleanup,
} from "../dist/platform/module-manager/loader/dynamic-module-runtime.js";
import { createModuleLoadGenerations } from "../dist/platform/module-manager/loader/module-load-generation.js";
import { isRuntimeActivationReady } from "../dist/platform/module-manager/install/runtime-activation-policy.js";
import {
  createModuleNetworkRequestRuntime,
  createStagedModuleNetworkRequestRuntime,
} from "../dist/core/network-requests/network-request-registry.js";

const localNetworkIdentity = {
  organizationId: "org_local",
  bonniSerial: "BONNI-LOCAL-001",
};

function inboundEnvelope(protocol, sourceModule) {
  const now = Date.now();
  return {
    protocol,
    sourceModule,
    recipientOrganizationId: localNetworkIdentity.organizationId,
    recipientBonniSerial: localNetworkIdentity.bonniSerial,
    linkId: "link-runtime-001",
    requestId: "request-runtime-0001",
    idempotencyKey: "idempotency-runtime-0001",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    actor: null,
    payload: {},
  };
}

function verifiedPeer() {
  return {
    sourceOrganizationId: "org_source",
    sourceBonniSerial: "BONNI-SOURCE-001",
    linkId: "link-runtime-001",
    serviceAccountId: "service-account-runtime-link",
    transportSecurity: "relay-e2ee",
  };
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("dynamic module route activates, deactivates immediately and never duplicates", async () => {
  let enabled = new Set();
  const runtime = createDynamicModuleRuntime(async () => enabled);
  const firstRouter = express.Router();
  let calls = 0;
  let firstCleanupCalls = 0;
  let secondCleanupCalls = 0;
  firstRouter.get("/api/apps/example/ping", (_request, response) => {
    calls += 1;
    response.json({ ok: true, calls, generation: 1 });
  });

  const app = express();
  app.use(runtime.middleware);
  app.use((_request, response) => response.status(404).json({ error: "NOT_FOUND" }));

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/apps/example/ping`)).status, 404);

    enabled = new Set(["app.example"]);
    await runtime.publish("app.example", firstRouter, () => { firstCleanupCalls += 1; });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/apps/example/ping`)).json(), {
      ok: true, calls: 1, generation: 1,
    });

    const secondRouter = express.Router();
    secondRouter.get("/api/apps/example/ping", (_request, response) => {
      calls += 1;
      response.json({ ok: true, calls, generation: 2 });
    });
    await runtime.publish(
      "app.example",
      secondRouter,
      normalizeRuntimeModuleCleanup({ dispose: () => { secondCleanupCalls += 1; } }),
    );
    assert.equal(firstCleanupCalls, 1, "slot replacement disposes the old registration once");
    assert.deepEqual(await (await fetch(`${baseUrl}/api/apps/example/ping`)).json(), {
      ok: true, calls: 2, generation: 2,
    });

    await runtime.deactivate("app.example");
    await runtime.deactivate("app.example");
    assert.equal((await fetch(`${baseUrl}/api/apps/example/ping`)).status, 404);
    assert.equal(calls, 2);
    assert.equal(secondCleanupCalls, 1, "repeated deactivation must not dispose twice");

    const reactivatedRouter = express.Router();
    reactivatedRouter.get("/api/apps/example/ping", (_request, response) => {
      calls += 1;
      response.json({ ok: true, calls, generation: 3 });
    });
    await runtime.publish("app.example", reactivatedRouter);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/apps/example/ping`)).json(), {
      ok: true, calls: 3, generation: 3,
    });
  });
});

test("dynamic module guard fails closed when the enabled-state store is unavailable", async () => {
  const runtime = createDynamicModuleRuntime(async () => {
    throw new Error("database unavailable");
  });
  const moduleRouter = express.Router();
  let called = false;
  let cleanupCalls = 0;
  moduleRouter.get("/api/apps/example/ping", (_request, response) => {
    called = true;
    response.json({ ok: true });
  });

  const app = express();
  app.use(runtime.middleware);
  app.use((_request, response) => response.status(404).json({ error: "NOT_FOUND" }));
  await runtime.publish("app.example", moduleRouter, () => { cleanupCalls += 1; });

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/apps/example/ping`)).status, 404);
    assert.equal(called, false);
    assert.equal(cleanupCalls, 1);
    assert.equal((await fetch(`${baseUrl}/api/apps/example/ping`)).status, 404);
    assert.equal(cleanupCalls, 1, "fail-closed cleanup runs only once");
  });
});

test("backend activation accepts only a loaded runtime while frontend-only modules may skip", () => {
  assert.equal(isRuntimeActivationReady("backend/dist/register.js", "loaded"), true);
  assert.equal(isRuntimeActivationReady("backend/dist/register.js", "skipped"), false);
  assert.equal(isRuntimeActivationReady("backend/dist/register.js", "error"), false);
  assert.equal(isRuntimeActivationReady(null, "skipped"), true);
  assert.equal(isRuntimeActivationReady(null, "error"), false);
});

test("deactivation invalidates and waits for a blocked registration before returning", async () => {
  const generations = createModuleLoadGenerations();
  const runtime = createDynamicModuleRuntime(async () => ["app.blocked"]);
  const router = express.Router();
  router.get("/api/apps/blocked", (_request, response) => response.json({ ok: true }));
  let releaseRegistration;
  const registrationGate = new Promise((resolve) => { releaseRegistration = resolve; });
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  let cleanupStarted;
  const cleanupStartedPromise = new Promise((resolve) => { cleanupStarted = resolve; });
  let disposerCalls = 0;

  const lease = generations.begin("app.blocked");
  const loading = (async () => {
    await registrationGate;
    const cleanup = normalizeRuntimeModuleCleanup(async () => {
      disposerCalls += 1;
      cleanupStarted();
      await cleanupGate;
    });
    await runtime.publish("app.blocked", router, cleanup, lease.isCurrent);
  })().finally(lease.settle);

  const olderLoadsSettled = generations.invalidate("app.blocked");
  let deactivateReturned = false;
  const deactivating = (async () => {
    await runtime.deactivate("app.blocked");
    await olderLoadsSettled;
    await runtime.deactivate("app.blocked");
    deactivateReturned = true;
  })();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deactivateReturned, false, "deactivate must wait for the older register call");
  releaseRegistration();
  await cleanupStartedPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deactivateReturned, false, "deactivate must also wait for stale registration cleanup");
  releaseCleanup();
  await Promise.all([loading, deactivating]);
  assert.equal(runtime.hasRoute("app.blocked"), false);
  assert.equal(disposerCalls, 1);

  const reactivatedLease = generations.begin("app.blocked");
  const cleanup = normalizeRuntimeModuleCleanup(() => { disposerCalls += 1; });
  assert.equal(
    await runtime.publish("app.blocked", router, cleanup, reactivatedLease.isCurrent),
    true,
  );
  reactivatedLease.settle();
  assert.equal(runtime.hasRoute("app.blocked"), true);
  await runtime.deactivate("app.blocked");
  assert.equal(disposerCalls, 2);
});

test("staged network capabilities commit atomically with the dynamic route", async () => {
  const dynamicRuntime = createDynamicModuleRuntime(async () => ["app.atomic"]);
  const staged = createStagedModuleNetworkRequestRuntime("app.atomic");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  const router = express.Router();
  router.get("/api/apps/atomic", (_request, response) => response.json({ ok: true }));
  let handlerCalls = 0;

  try {
    staged.runtime.registerHandler({
      protocol: "test.runtime.atomic.v1",
      handler: async () => {
        handlerCalls += 1;
        return { ok: true };
      },
    });
    network.registerTransportProvider({
      localIdentity: localNetworkIdentity,
      request: async () => ({ ok: true }),
    });

    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope("test.runtime.atomic.v1", "app.atomic"),
        verifiedPeer(),
      ),
      /CORE_NETWORK_REQUEST_HANDLER_NOT_FOUND/,
    );
    assert.equal(dynamicRuntime.hasRoute("app.atomic"), false);

    assert.equal(
      await dynamicRuntime.publish(
        "app.atomic",
        router,
        () => staged.dispose(),
        () => true,
        () => staged.activate(),
      ),
      true,
    );
    assert.equal(dynamicRuntime.hasRoute("app.atomic"), true);
    assert.deepEqual(
      await network.dispatchInbound(
        inboundEnvelope("test.runtime.atomic.v1", "app.atomic"),
        verifiedPeer(),
      ),
      { ok: true },
    );
    assert.equal(handlerCalls, 1);

    await dynamicRuntime.deactivate("app.atomic");
    assert.equal(dynamicRuntime.hasRoute("app.atomic"), false);
    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope("test.runtime.atomic.v1", "app.atomic"),
        verifiedPeer(),
      ),
      /CORE_NETWORK_REQUEST_HANDLER_NOT_FOUND/,
    );
  } finally {
    staged.dispose();
    network.dispose();
  }
});

test("deactivation revokes network capability before awaiting slow module cleanup", async () => {
  const dynamicRuntime = createDynamicModuleRuntime(async () => ["app.slow-cleanup"]);
  const staged = createStagedModuleNetworkRequestRuntime("app.slow-cleanup");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  const router = express.Router();
  let releaseModuleCleanup;
  const moduleCleanupGate = new Promise((resolve) => { releaseModuleCleanup = resolve; });
  let moduleCleanupStarted;
  const moduleCleanupStartedPromise = new Promise((resolve) => { moduleCleanupStarted = resolve; });

  try {
    staged.runtime.registerHandler({
      protocol: "test.runtime.slow-cleanup.v1",
      handler: async () => ({ ok: true }),
    });
    network.registerTransportProvider({
      localIdentity: localNetworkIdentity,
      request: async () => ({ ok: true }),
    });
    const cleanup = normalizeRuntimeModuleCleanup(async () => {
      staged.dispose();
      moduleCleanupStarted();
      await moduleCleanupGate;
    });
    await dynamicRuntime.publish(
      "app.slow-cleanup",
      router,
      cleanup,
      () => true,
      () => staged.activate(),
    );

    const deactivating = dynamicRuntime.deactivate("app.slow-cleanup");
    await moduleCleanupStartedPromise;
    assert.equal(dynamicRuntime.hasRoute("app.slow-cleanup"), false);
    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope("test.runtime.slow-cleanup.v1", "app.slow-cleanup"),
        verifiedPeer(),
      ),
      /CORE_NETWORK_REQUEST_HANDLER_NOT_FOUND/,
    );

    let finished = false;
    deactivating.then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    releaseModuleCleanup();
    await deactivating;
  } finally {
    releaseModuleCleanup?.();
    staged.dispose();
    network.dispose();
  }
});

test("failed staged capability activation publishes no route and cleans exactly once", async () => {
  const dynamicRuntime = createDynamicModuleRuntime(async () => ["app.conflict"]);
  const active = createModuleNetworkRequestRuntime("app.conflict-owner");
  const staged = createStagedModuleNetworkRequestRuntime("app.conflict");
  const router = express.Router();
  let cleanupCalls = 0;

  try {
    active.registerHandler({
      protocol: "test.runtime.conflict.v1",
      handler: async () => ({ generation: "active" }),
    });
    staged.runtime.registerHandler({
      protocol: "test.runtime.conflict.v1",
      handler: async () => ({ generation: "staged" }),
    });
    const cleanup = normalizeRuntimeModuleCleanup(() => {
      cleanupCalls += 1;
      staged.dispose();
    });

    await assert.rejects(
      dynamicRuntime.publish(
        "app.conflict",
        router,
        cleanup,
        () => true,
        () => staged.activate(),
      ),
      /CORE_NETWORK_REQUEST_PROTOCOL_ALREADY_OWNED/,
    );
    assert.equal(dynamicRuntime.hasRoute("app.conflict"), false);
    assert.equal(cleanupCalls, 1);
  } finally {
    active.dispose();
    staged.dispose();
  }
});
