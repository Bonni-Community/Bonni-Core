import assert from "node:assert/strict";
import test from "node:test";

import { featureModuleTransport } from "./featureModuleApi.js";
import {
  isTrustedOpaqueModuleMessage,
  normalizeSameOriginNavigationUrl,
  OPAQUE_RPC_REQUEST,
  sanitizeOpaqueModuleContext,
  validateOpaqueRpcRequest,
  withOpaqueRpcSession,
} from "./opaqueModuleRpc.js";

const moduleId = "app.hocketapp";
const rpcSessionId = "rpc-12345678";

function request(overrides = {}) {
  return {
    type: OPAQUE_RPC_REQUEST,
    moduleId,
    rpcSessionId,
    requestId: "request-12345678",
    method: "GET",
    path: "/api/apps/hocketapp/capabilities",
    headers: {},
    ...overrides,
  };
}

function assertValidationCode(value, code) {
  assert.throws(
    () => validateOpaqueRpcRequest(value, { moduleId, rpcSessionId }),
    (error) => error?.code === code,
  );
}

test("accepts only explicitly allowed HocketApp reads and mutations", () => {
  assert.deepEqual(
    validateOpaqueRpcRequest(request(), { moduleId, rpcSessionId }),
    {
      requestId: "request-12345678",
      method: "GET",
      path: "/api/apps/hocketapp/capabilities",
      headers: {},
      body: undefined,
    },
  );

  const mutation = validateOpaqueRpcRequest(request({
    method: "POST",
    path: "/api/apps/hocketapp/events",
    headers: { "Idempotency-Key": "event-12345678" },
    body: { title: "Sommerfest" },
  }), { moduleId, rpcSessionId });
  assert.equal(mutation.method, "POST");
  assert.deepEqual(mutation.headers, { "Idempotency-Key": "event-12345678" });
  assert.deepEqual(mutation.body, { title: "Sommerfest" });
});

test("allows only the exact allocation detail and reconcile routes", () => {
  const detail = validateOpaqueRpcRequest(request({
    path: "/api/apps/hocketapp/warehouse/allocations/org-1/pump-1",
  }), { moduleId, rpcSessionId });
  assert.equal(detail.method, "GET");

  const reconcile = validateOpaqueRpcRequest(request({
    method: "POST",
    path: "/api/apps/hocketapp/warehouse/allocations/org-1/pump-1/reconcile",
    headers: { "Idempotency-Key": "reconcile-12345678" },
    body: {
      claimIds: ["claim-1"],
      resolution: "RETURNED_TO_STOCK",
      expectedCurrentRevision: "revision-2",
      note: "Im Heimatlager geprüft",
    },
  }), { moduleId, rpcSessionId });
  assert.deepEqual(reconcile.body, {
    claimIds: ["claim-1"],
    resolution: "RETURNED_TO_STOCK",
    expectedCurrentRevision: "revision-2",
    note: "Im Heimatlager geprüft",
  });

  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/warehouse/allocations/org-1/pump-1/reconcile",
    headers: { "Idempotency-Key": "reconcile-12345678" },
    body: { claimIds: ["claim-1"], resolution: "RETURNED_TO_STOCK", quantity: 4 },
  }), "RPC_BODY_DENIED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/warehouse/allocations/org-1/pump-1/reconcile",
    headers: { "Idempotency-Key": "reconcile-12345678" },
    body: { claimIds: ["claim-1"], resolution: "RETURNED_TO_STOCK" },
  }), "RPC_BODY_INVALID");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/warehouse/allocations/org-1/pump-1",
    headers: { "Idempotency-Key": "reconcile-12345678" },
    body: {},
  }), "RPC_ROUTE_DENIED");
});

test("allows the exact reservation cancellation route", () => {
  const cancellation = validateOpaqueRpcRequest(request({
    method: "POST",
    path: "/api/apps/hocketapp/events/event-1/warehouse/reservations/reservation-1/cancel",
    headers: { "Idempotency-Key": "cancel-reservation-12345678" },
    body: {},
  }), { moduleId, rpcSessionId });
  assert.equal(cancellation.method, "POST");
  assert.deepEqual(cancellation.body, {});

  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/events/event-1/warehouse/reservations/reservation-1",
    headers: { "Idempotency-Key": "cancel-reservation-12345678" },
    body: {},
  }), "RPC_ROUTE_DENIED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/events/event-1/warehouse/reservations/reservation-1/cancel",
    headers: { "Idempotency-Key": "cancel-reservation-12345678" },
    body: { quantity: 100 },
  }), "RPC_BODY_DENIED");
});

test("denies paths and methods outside the HocketApp RPC allowlist", () => {
  assertValidationCode(request({ path: "/api/auth/shell" }), "RPC_PATH_DENIED");
  assertValidationCode(request({ path: "/api/apps/hocketapplication/capabilities" }), "RPC_PATH_DENIED");
  assertValidationCode(request({ path: "/api/apps/hocketapp/events?all=true" }), "RPC_PATH_INVALID");
  assertValidationCode(request({ path: "/api/apps/hocketapp/%2e%2e/auth" }), "RPC_PATH_INVALID");
  assertValidationCode(request({ path: "/api/apps/hocketapp/events/a%2Fb" }), "RPC_PATH_INVALID");
  assertValidationCode(request({ method: "DELETE", path: "/api/apps/hocketapp/events/event-1" }), "RPC_ROUTE_DENIED");
  assertValidationCode(request({ path: "/api/apps/hocketapp/internal" }), "RPC_ROUTE_DENIED");
});

test("allows no child headers except one valid mutation idempotency key", () => {
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/events",
    headers: { Authorization: "Bearer stolen" },
    body: {},
  }), "RPC_HEADER_DENIED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/events",
    headers: {},
    body: {},
  }), "RPC_IDEMPOTENCY_KEY_REQUIRED");
  assertValidationCode(request({ headers: { "Idempotency-Key": "read-12345678" } }), "RPC_HEADER_DENIED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/hocketapp/events",
    headers: { "Idempotency-Key": "event-12345678", "idempotency-key": "event-87654321" },
    body: {},
  }), "RPC_HEADER_DENIED");
});

test("requires the exact opaque iframe source, module and session", () => {
  const frameWindow = {};
  const valid = {
    source: frameWindow,
    origin: "null",
    data: { moduleId, rpcSessionId },
  };
  assert.equal(isTrustedOpaqueModuleMessage(valid, { frameWindow, moduleId, rpcSessionId }), true);
  assert.equal(isTrustedOpaqueModuleMessage({ ...valid, source: {} }, { frameWindow, moduleId, rpcSessionId }), false);
  assert.equal(isTrustedOpaqueModuleMessage({ ...valid, origin: "https://bonni.local" }, { frameWindow, moduleId, rpcSessionId }), false);
  assert.equal(isTrustedOpaqueModuleMessage({ ...valid, data: { ...valid.data, rpcSessionId: "rpc-attacker" } }, { frameWindow, moduleId, rpcSessionId }), false);
});

test("keeps navigation same-origin and keeps the RPC session in the fragment", () => {
  assert.equal(
    normalizeSameOriginNavigationUrl("/boards/event-1", "https://bonni.local"),
    "https://bonni.local/boards/event-1",
  );
  assert.equal(normalizeSameOriginNavigationUrl("https://attacker.invalid/", "https://bonni.local"), "");
  assert.equal(normalizeSameOriginNavigationUrl("https://user:pass@bonni.local/", "https://bonni.local"), "");
  assert.equal(normalizeSameOriginNavigationUrl("javascript:alert(1)", "https://bonni.local"), "");
  assert.equal(
    withOpaqueRpcSession("/feature-modules/hocketapp/index.html", rpcSessionId, "https://bonni.local/").href,
    "https://bonni.local/feature-modules/hocketapp/index.html#bonni-rpc-session=rpc-12345678",
  );
});

test("removes bearer-like credentials from the opaque module context", () => {
  assert.deepEqual(sanitizeOpaqueModuleContext({
    transport: "opaque-rpc-v1",
    token: "secret",
    user: { id: "a", accessToken: "nested-secret" },
    shell: { identity: { name: "Admin" }, authorization: "Bearer secret" },
  }), {
    transport: "opaque-rpc-v1",
    user: { id: "a" },
    shell: { identity: { name: "Admin" } },
  });
});

test("reads the opaque transport opt-in from a feature manifest", () => {
  assert.equal(featureModuleTransport({ manifest: { frontend: { transport: "OPAQUE-RPC-V1" } } }), "opaque-rpc-v1");
  assert.equal(featureModuleTransport({ manifest: { frontend: {} } }), "");
});
