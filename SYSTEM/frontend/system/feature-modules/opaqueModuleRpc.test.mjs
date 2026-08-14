import assert from "node:assert/strict";
import test from "node:test";

import {
  featureModuleOpaqueSandbox,
  featureModuleRpcContract,
  featureModuleSandboxCapabilities,
  featureModuleTransport,
} from "./featureModuleApi.js";
import {
  isTrustedOpaqueModuleMessage,
  normalizeOpaqueRpcContract,
  normalizeSameOriginNavigationUrl,
  OPAQUE_RPC_REQUEST,
  sanitizeOpaqueModuleContext,
  validateOpaqueRpcRequest,
  withOpaqueRpcSession,
} from "./opaqueModuleRpc.js";

const moduleId = "app.example";
const rpcSessionId = "rpc-12345678";
const contract = {
  schemaVersion: "bonni.module-rpc/v1",
  moduleId,
  basePath: "/api/apps/example",
  maxBodyBytes: 262144,
  routes: [
    { method: "GET", path: "/items", query: ["cursor"] },
    { method: "GET", path: "/items/{itemId}" },
    {
      method: "POST",
      path: "/items",
      body: {
        type: "json",
        schema: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    {
      method: "POST",
      path: "/uploads",
      body: { type: "form-data", maxBytes: 1024 },
    },
    {
      method: "GET",
      path: "/documents/{documentId}",
      responseType: "blob",
    },
    {
      method: "POST",
      path: "/binary-uploads",
      headers: ["x-file-name"],
      body: {
        type: "blob",
        maxBytes: 1024,
        contentType: "application/octet-stream",
      },
    },
  ],
};

function request(overrides = {}) {
  return {
    type: OPAQUE_RPC_REQUEST,
    moduleId,
    rpcSessionId,
    requestId: "request-12345678",
    method: "GET",
    path: "/api/apps/example/items",
    headers: {},
    ...overrides,
  };
}

function validate(value) {
  return validateOpaqueRpcRequest(value, {
    moduleId,
    rpcSessionId,
    contract,
  });
}

function assertValidationCode(value, code) {
  assert.throws(
    () => validate(value),
    (error) => error?.code === code,
  );
}

test("validates a generic module contract instead of knowing an app", () => {
  const normalized = normalizeOpaqueRpcContract(contract, { moduleId });
  assert.equal(normalized.moduleId, moduleId);
  assert.equal(normalized.routes.length, 6);
  assert.throws(
    () => normalizeOpaqueRpcContract(contract, { moduleId: "app.other" }),
    (error) => error?.code === "RPC_CONTRACT_MODULE_MISMATCH",
  );
  assert.throws(
    () => normalizeOpaqueRpcContract({
      ...contract,
      maxBodyBytes: 128,
      routes: [{
        method: "POST",
        path: "/oversized",
        body: { type: "json", maxBytes: 129 },
      }],
    }, { moduleId }),
    (error) => error?.code === "RPC_CONTRACT_INVALID",
  );
});

test("accepts only routes and query keys declared by the module", () => {
  assert.deepEqual(validate(request({ path: "/api/apps/example/items?cursor=next" })), {
    requestId: "request-12345678",
    method: "GET",
    path: "/api/apps/example/items?cursor=next",
    headers: {},
    body: undefined,
    responseType: "json",
  });
  assert.equal(validate(request({ path: "/api/apps/example/items/item-1" })).method, "GET");
  assertValidationCode(request({ path: "/api/apps/example/items?admin=true" }), "RPC_QUERY_DENIED");
  assertValidationCode(request({ path: "/api/apps/other/items" }), "RPC_ROUTE_DENIED");
  assertValidationCode(request({ path: "/api/apps/example/%2e%2e/auth" }), "RPC_PATH_INVALID");
  assertValidationCode(request({ method: "DELETE", path: "/api/apps/example/items/item-1" }), "RPC_ROUTE_DENIED");
});

test("enforces generic JSON schema and idempotency rules", () => {
  const mutation = validate(request({
    method: "POST",
    path: "/api/apps/example/items",
    headers: { "Idempotency-Key": "item-12345678" },
    body: { name: "Beispiel" },
  }));
  assert.deepEqual(mutation.body, { name: "Beispiel" });
  assert.deepEqual(mutation.headers, { "Idempotency-Key": "item-12345678" });

  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/example/items",
    headers: {},
    body: { name: "Beispiel" },
  }), "RPC_IDEMPOTENCY_KEY_REQUIRED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/example/items",
    headers: { "Idempotency-Key": "item-12345678" },
  }), "RPC_BODY_REQUIRED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/example/items",
    headers: { "Idempotency-Key": "item-12345678" },
    body: { name: "Beispiel", admin: true },
  }), "RPC_BODY_DENIED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/example/items",
    headers: { "Idempotency-Key": "item-12345678" },
    body: { name: "" },
  }), "RPC_BODY_INVALID");
  assertValidationCode(request({ headers: { Authorization: "Bearer stolen" } }), "RPC_HEADER_DENIED");
});

test("fails closed when a hydrated schema contains an invalid regular expression", () => {
  const invalidPatternContract = {
    ...contract,
    routes: [{
      method: "POST",
      path: "/pattern",
      body: {
        type: "json",
        schema: {
          type: "object",
          required: ["value"],
          properties: {
            value: { type: "string", pattern: "[" },
          },
        },
      },
    }],
  };

  assert.throws(
    () => validateOpaqueRpcRequest(request({
      method: "POST",
      path: "/api/apps/example/pattern",
      headers: { "Idempotency-Key": "pattern-12345678" },
      body: { value: "test" },
    }), {
      moduleId,
      rpcSessionId,
      contract: invalidPatternContract,
    }),
    (error) => error?.code === "RPC_BODY_INVALID",
  );
});

test("supports contract-limited form data and binary responses", () => {
  const upload = validate(request({
    method: "POST",
    path: "/api/apps/example/uploads",
    headers: { "Idempotency-Key": "upload-12345678" },
    body: {
      __bonniRpcBody: "form-data",
      entries: [{ name: "title", value: "Beleg" }],
    },
  }));
  assert.equal(upload.body instanceof FormData, true);
  assert.equal(upload.body.get("title"), "Beleg");

  const download = validate(request({
    path: "/api/apps/example/documents/document-1",
  }));
  assert.equal(download.responseType, "blob");
});

test("supports bounded binary uploads and only contract-declared headers", () => {
  const body = new Blob(["content"]);
  const upload = validate(request({
    method: "POST",
    path: "/api/apps/example/binary-uploads",
    headers: {
      "Idempotency-Key": "binary-12345678",
      "X-File-Name": "document.pdf",
    },
    body,
  }));

  assert.equal(upload.body, body);
  assert.deepEqual(upload.headers, {
    "x-file-name": "document.pdf",
    "Idempotency-Key": "binary-12345678",
    "Content-Type": "application/octet-stream",
  });
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/example/binary-uploads",
    headers: {
      "Idempotency-Key": "binary-12345678",
      "X-Admin": "true",
    },
    body,
  }), "RPC_HEADER_DENIED");
  assertValidationCode(request({
    method: "POST",
    path: "/api/apps/example/binary-uploads",
    headers: { "Idempotency-Key": "binary-12345678" },
    body: new Blob(["x".repeat(1025)]),
  }), "RPC_BODY_INVALID");
});

test("requires exact opaque iframe source, module and session", () => {
  const frameWindow = {};
  const valid = {
    source: frameWindow,
    origin: "null",
    data: { moduleId, rpcSessionId },
  };
  assert.equal(isTrustedOpaqueModuleMessage(valid, { frameWindow, moduleId, rpcSessionId }), true);
  assert.equal(isTrustedOpaqueModuleMessage({ ...valid, source: {} }, { frameWindow, moduleId, rpcSessionId }), false);
  assert.equal(isTrustedOpaqueModuleMessage({ ...valid, origin: "https://bonni.local" }, { frameWindow, moduleId, rpcSessionId }), false);
});

test("keeps navigation same-origin and the RPC session in the fragment", () => {
  assert.equal(
    normalizeSameOriginNavigationUrl("/module/example", "https://bonni.local"),
    "https://bonni.local/module/example",
  );
  assert.equal(normalizeSameOriginNavigationUrl("https://attacker.invalid/", "https://bonni.local"), "");
  assert.equal(normalizeSameOriginNavigationUrl("javascript:alert(1)", "https://bonni.local"), "");
  assert.equal(
    withOpaqueRpcSession("/feature-modules/example/index.html", rpcSessionId, "https://bonni.local/").href,
    "https://bonni.local/feature-modules/example/index.html#bonni-rpc-session=rpc-12345678",
  );
});

test("removes bearer-like credentials from the module context", () => {
  assert.deepEqual(sanitizeOpaqueModuleContext({
    transport: "opaque-rpc-v1",
    token: "secret",
    user: { id: "a", accessToken: "nested-secret", sessionToken: "also-secret" },
    shell: {
      identity: { name: "Admin" },
      authorization: "Bearer secret",
      databasePassword: "password",
    },
  }), {
    transport: "opaque-rpc-v1",
    user: { id: "a" },
    shell: { identity: { name: "Admin" } },
  });
});

test("reads transport and hydrated contract from a feature manifest", () => {
  const module = {
    manifest: {
      frontend: {
        transport: "OPAQUE-RPC-V1",
        rpcContract: contract,
        sandboxCapabilities: ["downloads", "forms", "popups", "allow-same-origin", "downloads"],
      },
    },
  };
  assert.equal(featureModuleTransport(module), "opaque-rpc-v1");
  assert.equal(featureModuleRpcContract(module), contract);
  assert.deepEqual(featureModuleSandboxCapabilities(module), ["downloads", "forms", "popups"]);
});

test("enables only declared safe capabilities in an opaque iframe sandbox", () => {
  assert.equal(featureModuleOpaqueSandbox([]), "allow-scripts");
  assert.equal(
    featureModuleOpaqueSandbox(["forms", "downloads", "popups"]),
    "allow-scripts allow-forms allow-downloads allow-popups",
  );
  assert.equal(
    featureModuleOpaqueSandbox(["forms", "allow-same-origin", "allow-top-navigation", "forms"]),
    "allow-scripts allow-forms",
  );
});
