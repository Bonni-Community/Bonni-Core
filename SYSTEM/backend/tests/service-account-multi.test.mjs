import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeServiceAccountIdentity } from "../dist/platform/auth/service-accounts/service-account.service.js";

test("service accounts are isolated by owning module and service key", () => {
  const network = describeServiceAccountIdentity("addon.bonni-network", "network-data-adapter");
  const pos = describeServiceAccountIdentity("app.bonni-pos", "pos-runtime");
  const posExport = describeServiceAccountIdentity("app.bonni-pos", "tax-export");

  assert.notEqual(network.externalSubject, pos.externalSubject);
  assert.notEqual(pos.externalSubject, posExport.externalSubject);
  assert.notEqual(network.roleKey, pos.roleKey);
  assert.notEqual(pos.roleKey, posExport.roleKey);
  assert.match(network.externalSubject, /^urn:bonni:service:/);
});

test("all SERVICE accounts are blocked from interactive browser authentication", async () => {
  const [route, middleware, identityMiddleware] = await Promise.all([
    readFile(new URL("../dist/platform/auth/routes/auth.routes.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/platform/auth/middleware/current-user.middleware.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/platform/security/identity/middleware/requireAuth.js", import.meta.url), "utf8"),
  ]);

  assert.match(route, /SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN/);
  assert.match(middleware, /account\.type === "SERVICE"/);
  assert.match(identityMiddleware, /account\.type === "SERVICE"/);
});

test("login and follow-up authentication use the same routed core client", async () => {
  const route = await readFile(
    new URL("../dist/platform/auth/routes/auth.routes.js", import.meta.url),
    "utf8",
  );

  assert.match(route, /core\/database\/database\.js/);
  assert.match(route, /getServerPrismaClient\("core"\)/);
  assert.doesNotMatch(route, /new PrismaClient\(\)/);
});
