import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import jwt from "jsonwebtoken";

process.env.JWT_SECRET ||= "bonni-core-test-jwt-secret-at-least-32-characters";

const { coreTokenService } = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/platform/auth/token/core-token.service.ts"
  : "../dist/platform/auth/token/core-token.service.js");

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("interactive JWTs require a non-negative credential revision", () => {
  const token = coreTokenService.issueToken({
    accountId: "account:1",
    loginName: "member",
    sessionId: "session-credential-7",
    credentialRevision: 7,
    source: "LOCAL",
  });
  assert.deepEqual(
    {
      sessionId: coreTokenService.verifyToken(token).sessionId,
      credentialRevision: coreTokenService.verifyToken(token).credentialRevision,
    },
    { sessionId: "session-credential-7", credentialRevision: 7 },
  );

  const legacy = jwt.sign(
    { accountId: "account:1", loginName: "member", source: "LOCAL" },
    process.env.JWT_SECRET,
  );
  assert.throws(() => coreTokenService.verifyToken(legacy), /CREDENTIAL_REVISION/u);
});

test("both authenticated middleware stacks compare the JWT revision to the live account", async () => {
  const coreMiddleware = await readFile(
    path.join(backendRoot, "src/core/http/middleware/requireAuth.ts"),
    "utf8",
  );
  const identityMiddleware = await readFile(
    path.join(backendRoot, "src/platform/security/identity/middleware/requireAuth.ts"),
    "utf8",
  );
  for (const source of [coreMiddleware, identityMiddleware]) {
    assert.match(source, /account\.credentialRevision\s*!==\s*payload\.credentialRevision/u);
    assert.doesNotMatch(source, /getJsonEmergencyIdentity|Authentication uses encrypted JSON emergency identity/u);
  }
});

test("password and 2FA rotation increment revision and revoke session material", async () => {
  const sources = await Promise.all([
    "src/platform/auth/users/users.mutations.service.ts",
    "src/platform/auth/members/module-members-runtime.ts",
    "src/system/database/seed-system.ts",
    "src/core/modules/security/two-factor/service.ts",
  ].map((relative) => readFile(path.join(backendRoot, relative), "utf8")));
  for (const source of sources) {
    assert.match(source, /credentialRevision:\s*\{\s*increment:\s*1/u);
    assert.match(source, /session\.updateMany/u);
    assert.match(source, /refreshToken\.updateMany/u);
  }
});
