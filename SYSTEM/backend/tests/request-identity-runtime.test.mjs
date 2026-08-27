import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";

import {
  createModuleRequestIdentityRuntime,
  MODULE_REQUEST_IDENTITY_CONTRACT_VERSION,
} from "../dist/platform/auth/request-identity/index.js";
import {
  getVerifiedRequestIdentity,
  getVerifiedRequestSessionAssurance,
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
    credentialRevision: 0,
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

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
      "credentialRevision",
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
      credentialRevision: 0,
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
      credentialRevision: 0,
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
      credentialRevision: 0,
      loginName: "service",
      type: "SERVICE",
      isActive: true,
      personId: null,
      person: null,
      roles: [],
    }],
  ]);
  const warnings = [];
  const sessions = new Map(["alice", "bob", "service"].map((token) => [
    `session-${token}`,
    {
      id: `session-${token}`,
      accountId: `account-${token}`,
      tokenHash: tokenHash(token),
      credentialRevision: 0,
      mfaVerifiedAt: token === "alice" ? new Date("2026-08-22T08:15:00.000Z") : null,
      mfaProviderId: token === "alice" ? "local" : null,
      mfaMethod: token === "alice" ? "TOTP" : null,
      endedAt: null,
    },
  ]));
  const middleware = createCurrentUserMiddleware({
    verifyToken(token) {
      if (token === "invalid") throw new Error("invalid token");
      return {
        accountId: `account-${token}`,
        sessionId: `session-${token}`,
        credentialRevision: 0,
        source: "TEST",
      };
    },
    async findAccount(accountId) {
      await new Promise((resolve) => setTimeout(resolve, accountId.endsWith("alice") ? 8 : 1));
      return accounts.get(accountId) || null;
    },
    async findSession(sessionId, accountId) {
      const session = sessions.get(sessionId) || null;
      return session?.accountId === accountId ? session : null;
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
      assurance: getVerifiedRequestSessionAssurance(),
      verified: request.bonniIdentityVerified,
      requestUser: request.user || null,
    });
  });

  await withServer(app, async (baseUrl) => {
    const anonymous = await (await fetch(`${baseUrl}/identity`)).json();
    assert.deepEqual(anonymous, {
      identity: null,
      assurance: null,
      verified: false,
      requestUser: null,
    });

    const [alice, bob] = await Promise.all([
      fetch(`${baseUrl}/identity`, { headers: { authorization: "Bearer alice" } }).then((res) => res.json()),
      fetch(`${baseUrl}/identity`, { headers: { authorization: "Bearer bob" } }).then((res) => res.json()),
    ]);
    assert.deepEqual(alice.identity, {
      accountId: "account-alice",
      credentialRevision: 0,
      loginName: "alice-from-database",
      type: "MEMBER",
      roles: ["access:app:app-example:manager", "member"],
      permissions: ["module.app-example.manager", "profile.read"],
      allowedApps: ["app.example"],
      personId: "person-alice",
      memberId: "member-alice",
    });
    assert.deepEqual(alice.assurance, {
      sessionId: "session-alice",
      accountId: "account-alice",
      credentialRevision: 0,
      mfaVerifiedAt: "2026-08-22T08:15:00.000Z",
      mfaProviderId: "local",
      mfaMethod: "TOTP",
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

    sessions.get("session-alice").endedAt = new Date();
    const ended = await fetch(`${baseUrl}/identity`, {
      headers: { authorization: "Bearer alice" },
    }).then((res) => res.json());
    assert.equal(ended.identity, null);
    assert.equal(ended.assurance, null);

    sessions.get("session-alice").endedAt = null;
    sessions.get("session-alice").tokenHash = "0".repeat(64);
    const mismatchedToken = await fetch(`${baseUrl}/identity`, {
      headers: { authorization: "Bearer alice" },
    }).then((res) => res.json());
    assert.equal(mismatchedToken.identity, null);
    assert.equal(mismatchedToken.assurance, null);
  });

  assert.deepEqual(warnings, [["Current user could not be resolved", "invalid token"]]);
});

test("a database lookup failure never turns a valid token into an anonymous 401", async () => {
  const middleware = createCurrentUserMiddleware({
    verifyToken() {
      return {
        accountId: "account-alice",
        sessionId: "session-alice",
        credentialRevision: 0,
        source: "TEST",
      };
    },
    async findAccount() {
      throw Object.assign(
        new Error('PostgresError 42501: keine Berechtigung für Schema "core"'),
        { code: "42501" },
      );
    },
    async findSession() {
      return {
        id: "session-alice",
        accountId: "account-alice",
        tokenHash: tokenHash("valid-token"),
        credentialRevision: 0,
        mfaVerifiedAt: null,
        mfaProviderId: null,
        mfaMethod: null,
        endedAt: null,
      };
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
