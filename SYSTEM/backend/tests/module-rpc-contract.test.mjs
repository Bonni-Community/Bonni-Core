import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  loadModuleRpcContract,
  validateModuleRpcContract,
} = await import("../dist/platform/module-manager/manifests/module-rpc-contract.js");
const {
  validateModuleManifest,
} = await import("../dist/platform/module-manager/manifests/manifest.service.js");

const moduleId = "app.example";
const validContract = {
  schemaVersion: "bonni.module-rpc/v1",
  moduleId,
  basePath: "/api/apps/example",
  maxBodyBytes: 262_144,
  routes: [
    {
      method: "GET",
      path: "/records/{recordId}",
      idempotency: "forbidden",
      query: ["view"],
      body: "none",
      responseType: "json",
    },
    {
      method: "POST",
      path: "/records/{recordId}/files/{path*}",
      idempotency: "required",
      body: {
        type: "json",
        maxBytes: 32_768,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              pattern: "^[A-Za-z0-9._:@~-]{1,200}$",
            },
          },
        },
      },
      headers: ["x-module-revision"],
      responseType: "blob",
    },
  ],
};

test("RPC contract validation normalizes and freezes the supported contract", () => {
  const contract = validateModuleRpcContract(validContract, moduleId);
  assert.equal(contract.moduleId, moduleId);
  assert.equal(contract.routes[1].path, "/records/{recordId}/files/{path*}");
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.routes), true);
  assert.equal(Object.isFrozen(contract.routes[1]), true);
});

test("RPC contract validation rejects mismatches, duplicate routes and unsafe wildcards", () => {
  assert.throws(
    () => validateModuleRpcContract(validContract, "app.other"),
    /MODULE_RPC_CONTRACT_MODULE_MISMATCH/,
  );
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [
        structuredClone(validContract.routes[0]),
        structuredClone(validContract.routes[0]),
      ],
    }, moduleId),
    /MODULE_RPC_CONTRACT_ROUTE_DUPLICATE/,
  );
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [{ method: "GET", path: "/records/{path*}/metadata" }],
    }, moduleId),
    /MODULE_RPC_CONTRACT_WILDCARD_POSITION_INVALID/,
  );
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [{
        method: "GET",
        path: "/records",
        forwardCredentials: true,
      }],
    }, moduleId),
    /MODULE_RPC_CONTRACT_ROUTE_KEY_INVALID/,
  );
});

test("RPC body schemas are a bounded declarative subset with safe browser regexes", () => {
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [{
        method: "POST",
        path: "/unsafe-regex",
        body: {
          type: "json",
          schema: {
            type: "string",
            maxLength: 100,
            pattern: "(a+)+$",
          },
        },
      }],
    }, moduleId),
    /MODULE_RPC_CONTRACT_BODY_SCHEMA_PATTERN_INVALID/,
  );
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [{
        method: "POST",
        path: "/invalid-regex",
        body: {
          type: "json",
          schema: {
            type: "string",
            maxLength: 100,
            pattern: "[",
          },
        },
      }],
    }, moduleId),
    /MODULE_RPC_CONTRACT_BODY_SCHEMA_PATTERN_INVALID/,
  );
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [{
        method: "POST",
        path: "/unknown-schema-key",
        body: {
          type: "json",
          schema: {
            type: "object",
            oneOf: [],
          },
        },
      }],
    }, moduleId),
    /MODULE_RPC_CONTRACT_BODY_SCHEMA_KEY_INVALID/,
  );
  assert.throws(
    () => validateModuleRpcContract({
      ...validContract,
      routes: [{
        method: "POST",
        path: "/unbounded-pattern-input",
        body: {
          type: "json",
          schema: {
            type: "string",
            pattern: "^safe$",
          },
        },
      }],
    }, moduleId),
    /MODULE_RPC_CONTRACT_BODY_SCHEMA_PATTERN_INVALID/,
  );
});

test("RPC contract loader stays inside the package, rejects symlinks and enforces its size limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonni-rpc-contract-"));
  const packageRoot = path.join(root, "package");
  const outside = path.join(root, "outside.json");
  await mkdir(path.join(packageRoot, "contracts"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "contracts", "rpc.json"),
    `${JSON.stringify(validContract)}\n`,
  );
  await writeFile(outside, `${JSON.stringify(validContract)}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const loaded = await loadModuleRpcContract({
    packageRoot,
    contractPath: "contracts/rpc.json",
    moduleId,
  });
  assert.equal(loaded.schemaVersion, "bonni.module-rpc/v1");

  await assert.rejects(
    loadModuleRpcContract({
      packageRoot,
      contractPath: "../outside.json",
      moduleId,
    }),
    /MODULE_RPC_CONTRACT_OUTSIDE_PACKAGE/,
  );

  const linkPath = path.join(packageRoot, "contracts", "linked.json");
  await symlink(outside, linkPath);
  await assert.rejects(
    loadModuleRpcContract({
      packageRoot,
      contractPath: "contracts/linked.json",
      moduleId,
    }),
    /MODULE_RPC_CONTRACT_FILE_INVALID/,
  );

  await writeFile(
    path.join(packageRoot, "contracts", "large.json"),
    JSON.stringify({ padding: "x".repeat(300 * 1024) }),
  );
  await assert.rejects(
    loadModuleRpcContract({
      packageRoot,
      contractPath: "contracts/large.json",
      moduleId,
    }),
    /MODULE_RPC_CONTRACT_SIZE_INVALID/,
  );
});

test("manifest validation requires opaque iframe transport and a loaded matching contract", () => {
  const base = {
    key: moduleId,
    kind: "app",
    name: "Example",
    version: "1.0.0",
    frontend: {
      integration: "iframe",
      transport: "opaque-rpc-v1",
      runtimeEntry: "/feature-modules/example/index.html",
      mountPath: "/feature-modules/example",
      rpcContractPath: "contracts/rpc.json",
      rpcContract: validateModuleRpcContract(validContract, moduleId),
    },
  };
  assert.deepEqual(validateModuleManifest(base), { ok: true, errors: [] });

  const missingContract = {
    ...base,
    frontend: {
      ...base.frontend,
      rpcContract: "contracts/rpc.json",
    },
  };
  const result = validateModuleManifest(missingContract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("geladenen RPC-Vertrag")));
});

test("manifest validation only permits explicitly supported iframe sandbox capabilities", () => {
  const base = {
    key: moduleId,
    kind: "app",
    name: "Example",
    version: "1.0.0",
    frontend: {
      integration: "iframe",
      transport: "opaque-rpc-v1",
      runtimeEntry: "/feature-modules/example/index.html",
      mountPath: "/feature-modules/example",
      rpcContractPath: "contracts/rpc.json",
      rpcContract: validateModuleRpcContract(validContract, moduleId),
      sandboxCapabilities: ["downloads", "forms", "popups"],
    },
  };
  assert.deepEqual(validateModuleManifest(base), { ok: true, errors: [] });

  assert.deepEqual(validateModuleManifest({
    ...base,
    frontend: { ...base.frontend, sandboxCapabilities: ["forms"] },
  }), { ok: true, errors: [] });

  for (const sandboxCapabilities of [
    ["allow-same-origin"],
    ["downloads", "downloads"],
    ["downloads", "forms", "popups", "modals"],
  ]) {
    const result = validateModuleManifest({
      ...base,
      frontend: { ...base.frontend, sandboxCapabilities },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("sandboxCapabilities")));
  }
});

test("manifest validation accepts complete access profiles and rejects unsafe profile mixes", () => {
  const base = {
    key: moduleId,
    kind: "app",
    name: "Example",
    version: "1.0.0",
    permissions: {
      provides: [
        "module.app-example.member",
        "module.app-example.worker",
      ],
    },
    metadata: {
      accessProfiles: [
        {
          key: "member",
          label: "Member",
          permission: "module.app-example.member",
          workspace: "MEMBER",
          usage: "local",
          accountType: "MEMBER",
        },
        {
          key: "worker",
          label: "Worker",
          permission: "module.app-example.worker",
          workspace: "WORKER",
          usage: "technical",
          accountType: "TERMINAL",
        },
      ],
    },
  };
  assert.deepEqual(validateModuleManifest(base), { ok: true, errors: [] });

  const result = validateModuleManifest({
    ...base,
    metadata: {
      accessProfiles: [{
        ...base.metadata.accessProfiles[1],
        accountType: "MEMBER",
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("accessProfiles")));
});
