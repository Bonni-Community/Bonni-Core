import assert from "node:assert/strict";
import test from "node:test";

const { assertInteractiveTwoFactorAccount } = await import(
  process.env.BONNI_TEST_SOURCE === "1"
    ? "../src/core/modules/security/two-factor/account-eligibility.ts"
    : "../dist/core/modules/security/two-factor/account-eligibility.js"
);

const eligible = {
  id: "account-1",
  type: "MEMBER",
  isActive: true,
  passwordHash: "bonni-pw-v1$hash",
};

test("active personal accounts with a local password remain eligible", () => {
  assert.doesNotThrow(() => assertInteractiveTwoFactorAccount(eligible));
  assert.doesNotThrow(() => assertInteractiveTwoFactorAccount({ ...eligible, type: "ADMIN" }));
});

for (const [label, account, code] of [
  ["deactivated", { ...eligible, isActive: false }, "TWO_FACTOR_ACCOUNT_NOT_ELIGIBLE"],
  ["terminal", { ...eligible, type: "TERMINAL" }, "TWO_FACTOR_TECHNICAL_ACCOUNT_FORBIDDEN"],
  ["service", { ...eligible, type: "SERVICE" }, "TWO_FACTOR_TECHNICAL_ACCOUNT_FORBIDDEN"],
  ["passwordless", { ...eligible, passwordHash: null }, "TWO_FACTOR_LOCAL_PASSWORD_REQUIRED"],
]) {
  test(`a VERIFIED challenge becomes unusable for a ${label} account`, () => {
    assert.throws(
      () => assertInteractiveTwoFactorAccount(account),
      (error) => error?.code === code && [403, 409].includes(error?.statusCode),
    );
  });
}
