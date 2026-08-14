import assert from "node:assert/strict";
import test from "node:test";

process.env.MASTER_KEY ||= "bonni-users-classification-test-key";
process.env.DATABASE_URL ||= "postgresql://postgres:test@127.0.0.1:5432/bonni_users_test";

const {
  isTechnicalAccessAccount,
  usageLabelForAccount,
} = await import(
  "../dist/platform/auth/users/users.service.js"
);

function account(overrides = {}) {
  return {
    accountType: "MEMBER",
    authProviderType: "LOCAL",
    authProviderKey: "local",
    isSandbox: false,
    ...overrides,
  };
}

test("ADMIN remains a personal account in the Core user overview", () => {
  const usageLabel = usageLabelForAccount(account({ accountType: "ADMIN" }));

  assert.equal(usageLabel, "Lokal");
  assert.equal(isTechnicalAccessAccount({
    type: "ADMIN",
    usageLabel,
  }), false);
});

test("TERMINAL, SERVICE and sandbox accounts remain technical", () => {
  for (const type of ["TERMINAL", "SERVICE"]) {
    const usageLabel = usageLabelForAccount(account({ accountType: type }));
    assert.equal(usageLabel, "Technischer Account");
    assert.equal(isTechnicalAccessAccount({ type, usageLabel }), true);
  }

  const sandboxUsage = usageLabelForAccount(account({ isSandbox: true }));
  assert.equal(sandboxUsage, "Technischer Account");
  assert.equal(isTechnicalAccessAccount({
    type: "MEMBER",
    usageLabel: sandboxUsage,
  }), true);
});
