import assert from "node:assert/strict";
import test from "node:test";

const { requirePermission } = await import(
  process.env.BONNI_TEST_SOURCE === "1"
    ? "../src/core/http/middleware/requirePermission.ts"
    : "../dist/core/http/middleware/requirePermission.js"
);

function runMiddleware({ auth, required = "SYSTEM_ADMIN" }) {
  let statusCode = 200;
  let body = null;
  let nextCalled = false;
  const req = { auth };
  const res = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  requirePermission(required)(req, res, () => {
    nextCalled = true;
  });

  return { statusCode, body, nextCalled };
}

function auth(overrides = {}) {
  return {
    accountId: "acc_admin",
    loginName: "admin",
    credentialRevision: 0,
    roles: [],
    permissions: [],
    ...overrides,
  };
}

for (const [label, actor] of [
  ["the exact permission", auth({ permissions: ["SYSTEM_ADMIN"] })],
  ["the canonical seeded permission", auth({ permissions: ["system.admin"] })],
  ["the underscore database variant", auth({ permissions: ["system_admin"] })],
  ["the global wildcard", auth({ permissions: ["*"] })],
  ["the canonical admin role", auth({ roles: ["admin"] })],
]) {
  test(`Core permission middleware accepts ${label}`, () => {
    assert.deepEqual(runMiddleware({ auth: actor }), {
      statusCode: 200,
      body: null,
      nextCalled: true,
    });
  });
}

test("Core permission middleware rejects an ordinary member", () => {
  assert.deepEqual(runMiddleware({
    auth: auth({ accountId: "acc_member", loginName: "user", roles: ["member"] }),
  }), {
    statusCode: 403,
    body: { error: "PERMISSION_DENIED", permission: "SYSTEM_ADMIN" },
    nextCalled: false,
  });
});

test("Core permission middleware does not treat TECH_ADMIN as a personal administrator role", () => {
  assert.deepEqual(runMiddleware({ auth: auth({ roles: ["TECH_ADMIN"] }) }), {
    statusCode: 403,
    body: { error: "PERMISSION_DENIED", permission: "SYSTEM_ADMIN" },
    nextCalled: false,
  });
});

test("Core permission middleware rejects unauthenticated requests", () => {
  assert.deepEqual(runMiddleware({ auth: undefined }), {
    statusCode: 401,
    body: { error: "AUTH_REQUIRED" },
    nextCalled: false,
  });
});
