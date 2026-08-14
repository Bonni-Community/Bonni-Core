import assert from "node:assert/strict";
import test from "node:test";

const { CoreTokenService } = await import(
  "../dist/platform/auth/token/core-token.service.js"
);
const {
  decryptSecret,
  encryptSecret,
} = await import(
  "../dist/platform/security/two-factor/services/totp.js"
);
const {
  isPersonalDataAdminLoginAccount,
} = await import(
  "../dist/platform/security/crypto/master-key.js"
);

function withEnvironment(names, callback) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  names.forEach((name) => delete process.env[name]);
  try {
    return callback();
  } finally {
    names.forEach((name) => {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    });
  }
}

test("tokens fail closed when JWT_SECRET is missing, short or a placeholder", () => {
  withEnvironment(["JWT_SECRET"], () => {
    const service = new CoreTokenService();
    assert.throws(
      () => service.issueToken({ accountId: "account-1", loginName: "member" }),
      /JWT_SECRET_MISSING_OR_WEAK/,
    );
    for (const value of ["short", "development-token-secret-that-is-long-enough", "x".repeat(64)]) {
      process.env.JWT_SECRET = value;
      assert.throws(
        () => service.issueToken({ accountId: "account-1", loginName: "member" }),
        /JWT_SECRET_MISSING_OR_WEAK/,
      );
    }
    process.env.JWT_SECRET = "3Kf!8qNzR2vP7xLm5cWd9sTy4uHa6eBj";
    const token = service.issueToken({ accountId: "account-1", loginName: "member" });
    assert.equal(service.verifyToken(token).accountId, "account-1");
  });
});

test("two-factor secret encryption has no embedded development key", () => {
  withEnvironment(["TWO_FACTOR_ENCRYPTION_KEY", "JWT_SECRET"], () => {
    assert.throws(() => encryptSecret("TOTP-SECRET"), /TWO_FACTOR_ENCRYPTION_KEY_MISSING_OR_WEAK/);
    process.env.JWT_SECRET = "4Tg!9rMaS3wQ8yKn6dXe2pUz5iHb7fCj";
    const encrypted = encryptSecret("TOTP-SECRET");
    assert.equal(decryptSecret(encrypted), "TOTP-SECRET");

    process.env.TWO_FACTOR_ENCRYPTION_KEY = "change-me-two-factor-key-that-is-long";
    assert.throws(() => encryptSecret("TOTP-SECRET"), /TWO_FACTOR_ENCRYPTION_KEY_MISSING_OR_WEAK/);
  });
});

test("master-key bypass depends on stored roles, never login names or account IDs", () => {
  assert.equal(isPersonalDataAdminLoginAccount({ loginName: "admin", roles: [] }), false);
  assert.equal(isPersonalDataAdminLoginAccount({ accountId: "sandbox-admin", roles: [] }), false);
  assert.equal(isPersonalDataAdminLoginAccount({ roles: ["app-admin"] }), false);
  assert.equal(isPersonalDataAdminLoginAccount({ roles: ["SYSTEM_ADMIN"] }), true);
  assert.equal(isPersonalDataAdminLoginAccount({ roles: ["*"] }), true);
});
