import assert from "node:assert/strict";
import test from "node:test";

import {
  coreDataAdapterRegistry,
  createModuleDataAdapterRuntime,
} from "../dist/core/data-adapters/data-adapter-registry.js";
import {
  NETWORK_USER_ACCOUNT_TYPES,
  accountNetworkOperation,
} from "../dist/platform/auth/users/users-network-data-adapter.js";

test("multiple modules can own separate data adapters", async () => {
  const pos = createModuleDataAdapterRuntime("app.bonni-pos");
  const network = createModuleDataAdapterRuntime("addon.bonni-network");
  const unregisterPos = pos.register({
    domainId: "test.pos.orders",
    name: "POS orders",
    exportSnapshot: async () => [{ entityId: "order-1", action: "upsert", version: 1, payload: { total: 12 } }],
  });
  const unregisterNetwork = network.register({
    domainId: "test.network.users",
    name: "Network users",
    exportSnapshot: async () => [{ entityId: "user-1", action: "upsert", version: 1, payload: { name: "A" } }],
  });

  const listed = coreDataAdapterRegistry.list().filter((entry) => entry.domainId.startsWith("test."));
  assert.deepEqual(listed.map((entry) => entry.sourceModule).sort(), ["addon.bonni-network", "app.bonni-pos"]);
  assert.equal((await pos.snapshot("test.pos.orders")).length, 1);
  assert.throws(() => network.register({ domainId: "test.pos.orders", name: "Takeover" }), /DOMAIN_ALREADY_OWNED/);

  unregisterPos();
  unregisterNetwork();
});

test("local changes retain module and original actor context", async () => {
  const runtime = createModuleDataAdapterRuntime("app.bonni-pos");
  const coordinator = createModuleDataAdapterRuntime("addon.bonni-network");
  const unregister = runtime.register({ domainId: "test.pos.local", name: "Local POS" });
  let received = null;
  const off = coordinator.onLocalChange((change) => { received = change; });

  await runtime.publish("test.pos.local", {
    entityId: "receipt-1",
    action: "upsert",
    version: 4,
    payload: { total: 5 },
  }, { accountId: "account-1", loginName: "kasse" });

  assert.equal(received.sourceModule, "app.bonni-pos");
  assert.equal(received.actor.accountId, "account-1");
  assert.equal(received.operations[0].entityId, "receipt-1");
  assert.throws(() => runtime.publish("test.network.users", {
    entityId: "takeover",
    action: "upsert",
    version: 1,
    payload: {},
  }), /DOMAIN_NOT_OWNED/);
  off();
  unregister();
});

test("core user adapter exports only safe human-account references", () => {
  assert.deepEqual([...NETWORK_USER_ACCOUNT_TYPES].sort(), ["ADMIN", "MEMBER"]);
  const operation = accountNetworkOperation({
    id: "account-1",
    loginName: "member",
    type: "MEMBER",
    isActive: true,
    updatedAt: new Date("2026-07-22T10:00:00.000Z"),
    email: "must-not-leave@example.org",
    passwordHash: "must-not-leave",
    refreshTokens: ["must-not-leave"],
    person: {
      displayName: "Mitglied",
      email: "must-not-leave@example.org",
      phone: "must-not-leave",
      updatedAt: new Date("2026-07-22T10:00:00.000Z"),
      member: { id: "member-1", updatedAt: new Date("2026-07-22T10:00:00.000Z"), iban: "must-not-leave" },
    },
    roles: [{ role: { key: "member" } }],
  });

  assert.deepEqual(Object.keys(operation.payload).sort(), [
    "accountType", "active", "displayName", "homeAccountId", "homeMemberId", "kind", "loginName", "roleKeys",
  ]);
  assert.doesNotMatch(JSON.stringify(operation), /password|refresh|example\.org|iban|must-not-leave/i);
});
