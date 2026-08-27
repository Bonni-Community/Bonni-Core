import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const systemRoot = path.resolve(backendRoot, "..");

async function backendSource(relativePath) {
  return readFile(path.join(backendRoot, relativePath), "utf8");
}

test("interactive tokens are bound to an active server session", async () => {
  const [schema, route, middleware] = await Promise.all([
    backendSource("prisma/domains/system/identity/session.prisma"),
    backendSource("src/platform/auth/routes/auth.routes.ts"),
    backendSource("src/platform/auth/middleware/current-user.middleware.ts"),
  ]);

  assert.match(schema, /mfaVerifiedAt\s+DateTime\?/u);
  assert.match(schema, /mfaProviderId\s+String\?/u);
  assert.doesNotMatch(schema, /mfaVerified\s+Boolean/u);
  assert.match(route, /sessionId,\s*source:\s*"LOCAL"/u);
  assert.match(route, /tokenHash:\s*sessionTokenHash\(nextToken\)/u);
  assert.match(route, /mfaVerifiedAt:\s*mfa\?\.verifiedAt\s*\|\|\s*null/u);
  assert.match(route, /verifiedAt:\s*consumed\.verifiedAt/u);
  assert.match(route, /mfaProviderId:\s*mfa\?\.providerId\s*\|\|\s*null/u);
  assert.match(route, /endedAt:\s*new Date\(\)/u);
  assert.match(middleware, /findSession\(payload\.sessionId, payload\.accountId\)/u);
  assert.match(middleware, /tokenMatchesSession\(token, session\.tokenHash\)/u);
  assert.match(middleware, /session\.credentialRevision\s*===\s*account\.credentialRevision/u);
});

test("all authenticated stacks require the verified live-session context", async () => {
  const sources = await Promise.all([
    backendSource("src/core/http/middleware/requireAuth.ts"),
    backendSource("src/platform/security/identity/middleware/requireAuth.ts"),
  ]);
  for (const source of sources) {
    assert.match(source, /getVerifiedRequestSessionAssurance/u);
    assert.match(source, /INVALID_OR_ENDED_SESSION/u);
  }
});

test("Kontor accepts the session proof while action challenges remain separate", async () => {
  const [people, organization, procurement, contracts] = await Promise.all([
    backendSource("src/core/protected-people/protected-people-runtime.ts"),
    backendSource("src/core/protected-organization/protected-organization-runtime.ts"),
    readFile(path.join(systemRoot, "app/kontorapp/backend/src/modules/procurement.js"), "utf8"),
    readFile(path.join(systemRoot, "app/kontorapp/backend/src/modules/contracts-management.js"), "utf8"),
  ]);
  for (const source of [people, organization]) {
    assert.match(source, /bonni-session-mfa-v1/u);
    assert.match(source, /mfaProviderId/u);
    assert.match(source, /credentialRevision/u);
  }
  assert.match(procurement, /createProcurementActionChallenge|ACTION_CHALLENGE/u);
  assert.match(contracts, /createContractActionChallenge|action-challenges/u);
});
