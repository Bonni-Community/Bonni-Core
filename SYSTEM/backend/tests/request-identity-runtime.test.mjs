import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import {
  createModuleRequestIdentityRuntime,
  MODULE_REQUEST_IDENTITY_CONTRACT_VERSION,
} from "../dist/platform/auth/request-identity/index.js";
import {
  getVerifiedRequestIdentity,
  runWithVerifiedRequestIdentity,
} from "../dist/platform/auth/request-identity/request-identity-context.js";
import {
  createCurrentUserMiddleware,
} from "../dist/platform/auth/middleware/current-user.middleware.js";

const accessProfiles = [
  { key: "member", usage: "local" },
  { key: "manager", usage: "local" },
  { key: "counter", usage: "technical" },
];

function identity(overrides = {}) {
  return {
    accountId: "account-1",
    loginName: "alice",
    type: "MEMBER",
    roles: ["member", "access:app:app-example:manager"],
    permissions: ["module.app-example.manager"],
    allowedApps: ["app.example"],
    personId: "person-1",
    memberId: "member-1",
    ...overrides,
  };
}

function errorCode(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return {
      code: error.code,
      statusCode: error.statusCode,
    };
  }
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
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("request identity runtime exposes only the immutable safe DTO", async () => {
  const runtime = createModuleRequestIdentityRuntime("app.example", accessProfiles);
  assert.equal(MODULE_REQUEST_IDENTITY_CONTRACT_VERSION, "bonni.request-identity/v1");
  assert.equal(runtime.contractVersion, "bonni.request-identity/v1");
  assert.equal(runtime.current(), null);

  await runWithVerifiedRequestIdentity(identity(), async () => {
    await Promise.resolve();
    const current = runtime.current();
    assert.ok(current);
    assert.deepEqual(Object.keys(current).sort(), [
      "accountId",
      "allowedApps",
      "loginName",
      "memberId",
      "permissions",
      "personId",
      "roles",
      "type",
    ]);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.roles), true);
    assert.equal(Object.isFrozen(current.permissions), true);
    assert.equal(Object.isFrozen(current.allowedApps), true);
    assert.throws(() => current.roles.push("admin"), TypeError);
    assert.equal(runtime.requireProfiles(["manager"]), current);
    assert.deepEqual(errorCode(() => runtime.requireProfiles(["member"])), {
      code: "REQUEST_IDENTITY_PROFILE_FORBIDDEN",
      statusCode: 403,
    });
  });

  assert.equal(runtime.current(), null);
  assert.deepEqual(errorCode(() => runtime.requireProfiles(["manager"])), {
    code: "REQUEST_IDENTITY_UNAUTHENTICATED",
    statusCode: 401,
  });
});

test("profile authorization is module-bound, local-only and fail-closed", () => {
  const runtime = createModuleRequestIdentityRuntime("app.example", accessProfiles);

  assert.deepEqual(errorCode(() => runtime.requireProfiles(["counter"])), {
    code: "REQUEST_IDENTITY_PROFILE_NOT_DECLARED",
    statusCode: 500,
  });
  assert.deepEqual(errorCode(() => runtime.requireProfiles(["undeclared"])), {
    code: "REQUEST_IDENTITY_PROFILE_NOT_DECLARED",
    statusCode: 500,
  });
  assert.deepEqual(errorCode(() => runtime.requireProfiles([])), {
    code: "REQUEST_IDENTITY_PROFILE_QUERY_INVALID",
    statusCode: 500,
  });
  assert.throws(
    () => createModuleRequestIdentityRuntime("not-a-module", accessProfiles),
    /REQUEST_IDENTITY_MODULE_KEY_INVALID/,
  );

  runWithVerifiedRequestIdentity(
    identity({ roles: ["access:app:app-other:manager"] }),
    () => {
      assert.deepEqual(errorCode(() => runtime.requireProfiles(["manager"])), {
        code: "REQUEST_IDENTITY_PROFILE_FORBIDDEN",
        statusCode: 403,
      });
    },
  );
});

test("AsyncLocalStorage keeps concurrent identities isolated", async () => {
  const runtime = createModuleRequestIdentityRuntime("app.example", accessProfiles);
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = runWithVerifiedRequestIdentity(
    identity({ accountId: "account-first", loginName: "first" }),
    async () => {
      await firstGate;
      return runtime.current();
    },
  );
  const second = runWithVerifiedRequestIdentity(
    identity({ accountId: "account-second", loginName: "second" }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const current = runtime.current();
      releaseFirst();
      return current;
    },
  );

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.accountId, "account-first");
  assert.equal(secondResult.accountId, "account-second");
  assert.equal(getVerifiedRequestIdentity(), null);
});

test("current-user middleware binds verified and anonymous request contexts", async () => {
  const accounts = new Map([
    ["account-alice", {
      id: "account-alice",
      loginName: "alice-from-database",
      type: "MEMBER",
      isActive: true,
      personId: "person-alice",
      person: { member: { id: "member-alice" } },
      roles: [
        {
          role: {
            key: "access:app:app-example:manager",
            permissions: [{ permission: { key: "module.app-example.manager" } }],
          },
        },
        {
          role: {
            key: "member",
            permissions: [{ permission: { key: "profile.read" } }],
          },
        },
      ],
    }],
    ["account-bob", {
      id: "account-bob",
      loginName: "bob",
      type: "ADMIN",
      isActive: true,
      personId: null,
      person: null,
      roles: [{
        role: {
          key: "admin",
          permissions: [{ permission: { key: "*" } }],
        },
      }],
    }],
    ["account-service", {
      id: "account-service",
      loginName: "service",
      type: "SERVICE",
      isActive: true,
      personId: null,
      person: null,
      roles: [],
    }],
  ]);
  const warnings = [];
  const middleware = createCurrentUserMiddleware({
    verifyToken(token) {
      if (token === "invalid") throw new Error("invalid token");
      return { accountId: `account-${token}`, source: "TEST" };
    },
    async findAccount(accountId) {
      await new Promise((resolve) => setTimeout(resolve, accountId.endsWith("alice") ? 8 : 1));
      return accounts.get(accountId) || null;
    },
    warn(message, error) {
      warnings.push([message, error.message]);
    },
  });
  const runtime = createModuleRequestIdentityRuntime("app.example", accessProfiles);
  const app = express();
  app.use((request, _response, next) => {
    request.user = { accountId: "unverified-upstream-value" };
    next();
  });
  app.use(middleware);
  app.get("/identity", async (request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    response.json({
      identity: runtime.current(),
      verified: request.bonniIdentityVerified,
      requestUser: request.user || null,
    });
  });

  await withServer(app, async (baseUrl) => {
    const anonymous = await (await fetch(`${baseUrl}/identity`)).json();
    assert.deepEqual(anonymous, {
      identity: null,
      verified: false,
      requestUser: null,
    });

    const [alice, bob] = await Promise.all([
      fetch(`${baseUrl}/identity`, { headers: { authorization: "Bearer alice" } }).then((res) => res.json()),
      fetch(`${baseUrl}/identity`, { headers: { authorization: "Bearer bob" } }).then((res) => res.json()),
    ]);
    assert.deepEqual(alice.identity, {
      accountId: "account-alice",
      loginName: "alice-from-database",
      type: "MEMBER",
      roles: ["access:app:app-example:manager", "member"],
      permissions: ["module.app-example.manager", "profile.read"],
      allowedApps: ["app.example"],
      personId: "person-alice",
      memberId: "member-alice",
    });
    assert.equal(alice.verified, true);
    assert.equal(alice.requestUser.source, "TEST");
    assert.equal(bob.identity.accountId, "account-bob");
    assert.equal(bob.identity.loginName, "bob");

    for (const token of ["service", "missing", "invalid"]) {
      const result = await (
        await fetch(`${baseUrl}/identity`, { headers: { authorization: `Bearer ${token}` } })
      ).json();
      assert.equal(result.identity, null);
      assert.equal(result.verified, false);
      assert.equal(result.requestUser, null);
    }
  });

  assert.deepEqual(warnings, [["Current user could not be resolved", "invalid token"]]);
});

test("a database lookup failure never turns a valid token into an anonymous 401", async () => {
  const middleware = createCurrentUserMiddleware({
    verifyToken() {
      return { accountId: "account-alice", source: "TEST" };
    },
    async findAccount() {
      throw Object.assign(
        new Error('PostgresError 42501: keine Berechtigung für Schema "core"'),
        { code: "42501" },
      );
    },
    warn() {},
  });
  const app = express();
  app.use(middleware);
  app.get("/identity", (_request, response) => response.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/identity`, {
      headers: { authorization: "Bearer valid-token" },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      code: "DATABASE_SCHEMA_PERMISSION_DENIED",
      message: "Die Datenbank ist erreichbar, aber dem Backend fehlen Rechte auf das Core-Schema.",
    });
  });
});
