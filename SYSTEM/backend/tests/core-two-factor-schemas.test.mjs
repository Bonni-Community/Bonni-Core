import assert from "node:assert/strict";
import test from "node:test";

const schemas = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/core/modules/security/two-factor/schemas.ts"
  : "../dist/core/modules/security/two-factor/schemas.js");

test("setup and confirmation are bound to the exact admin enrollment request", () => {
  assert.equal(schemas.setupTotpSchema.safeParse({
    body: {
      enrollmentRequestId: "request:1",
      enrollmentPassword: "abcdefghijklmnopqrstuvwx",
      currentPassword: " exact owner password ",
    },
  }).success, true);
  assert.equal(schemas.setupTotpSchema.safeParse({
    body: {
      enrollmentPassword: "abcdefghijklmnopqrstuvwx",
      currentPassword: "exact owner password",
    },
  }).success, false);
  assert.equal(schemas.confirmTotpSchema.safeParse({
    body: { enrollmentRequestId: "request:1", credentialId: "credential:1", code: "123456" },
  }).success, true);
});

test("admin contract accepts expiresInMinutes and rejects drifted or extra fields", () => {
  assert.equal(schemas.adminCreateEnrollmentSchema.safeParse({
    body: { accountId: "account:1", expiresInMinutes: 15, password: "exact admin password" },
  }).success, true);
  assert.equal(schemas.adminCreateEnrollmentSchema.safeParse({
    body: { accountId: "account:1", expiresMinutes: 15, password: "exact admin password" },
  }).success, false);
});

test("secret proofs are exact and recovery is exclusive", () => {
  assert.equal(schemas.verifyChallengeSchema.safeParse({
    params: { id: "challenge:1" },
    body: { recoveryCode: "ABCD-EFGH-JKLM-NPQR" },
  }).success, true);
  assert.equal(schemas.verifyChallengeSchema.safeParse({
    params: { id: "challenge:1" },
    body: { recoveryCode: "abcd-efgh-jklm-npqr" },
  }).success, false);
  assert.equal(schemas.verifyChallengeSchema.safeParse({
    params: { id: "challenge:1" },
    body: { recoveryCode: "ABCD-EFGH-JKLM-NPQR", code: "123456" },
  }).success, false);
  assert.equal(schemas.verifyChallengeSchema.safeParse({
    params: { id: "challenge:1" },
    body: { token: "lone-\ud800-surrogate" },
  }).success, false);
  assert.equal(schemas.verifyChallengeSchema.safeParse({
    params: { id: "challenge:1" },
    body: { password: "line\nbreak" },
  }).success, false);
});
