import assert from "node:assert/strict";
import test from "node:test";

import bcrypt from "bcryptjs";

const {
  hashExactLocalPassword,
  validateExactLocalPassword,
  verifyExactLocalPassword,
} = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/core/modules/identity/local-password-policy.ts"
  : "../dist/core/modules/identity/local-password-policy.js");

test("versioned local password hashes distinguish suffixes beyond bcrypt's legacy limit", async () => {
  const first = `${"a".repeat(72)}-first`;
  const second = `${"a".repeat(72)}-second`;
  const hash = await hashExactLocalPassword(first, 4);
  assert.match(hash, /^bonni-pw-v1\$\$2[aby]\$/u);
  assert.equal(await verifyExactLocalPassword(first, hash), true);
  assert.equal(await verifyExactLocalPassword(second, hash), false);
});

test("legacy bcrypt remains available only for exactly representable passwords", async () => {
  const legacy = "Legacy!Passwort-2026";
  const legacyHash = await bcrypt.hash(legacy, 4);
  assert.equal(await verifyExactLocalPassword(legacy, legacyHash), true);

  const truncated = "x".repeat(72);
  const truncatedHash = await bcrypt.hash(truncated, 4);
  assert.equal(await verifyExactLocalPassword(`${truncated}suffix`, truncatedHash), false);
});

test("password policy counts Unicode codepoints and preserves exact UTF-8", () => {
  assert.equal(validateExactLocalPassword("😀".repeat(512)).ok, true);
  assert.equal(validateExactLocalPassword("😀".repeat(513)).ok, false);
  assert.equal(validateExactLocalPassword("exact password ").ok, true);
  assert.equal(validateExactLocalPassword("line\nbreak").ok, false);
  assert.equal(validateExactLocalPassword("nul\0byte").ok, false);
  assert.equal(validateExactLocalPassword("lone-\ud800-surrogate").ok, false);
  assert.equal(validateExactLocalPassword(1234).ok, false);
});
