import assert from "node:assert/strict";
import test from "node:test";

process.env.MODULE_PRIVATE_DATA_SECRET ||= "test-only-module-private-data-secret-that-is-long-enough-2026";

const {
  createModulePrivateDataRuntime,
  MODULE_PRIVATE_DATA_CONTRACT_VERSION,
} = await import("../dist/platform/security/crypto/module-private-data-runtime.js");

test("module private-data ciphertext is bound to module, subject and field", () => {
  const kontor = createModulePrivateDataRuntime("app.kontorapp");
  const other = createModulePrivateDataRuntime("app.otherapp");
  const encrypted = kontor.encrypt("member-1", "iban", "DE02120300000000202051");

  assert.equal(MODULE_PRIVATE_DATA_CONTRACT_VERSION, "bonni.private-data/v1");
  assert.match(encrypted, /^mpd1\./u);
  assert.equal(kontor.decrypt("member-1", "iban", encrypted), "DE02120300000000202051");
  assert.throws(() => kontor.decrypt("member-2", "iban", encrypted));
  assert.throws(() => kontor.decrypt("member-1", "bic", encrypted));
  assert.throws(() => other.decrypt("member-1", "iban", encrypted));
});
