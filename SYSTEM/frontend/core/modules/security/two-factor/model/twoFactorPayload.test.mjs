import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminCreatePayload,
  buildExistingProof,
  buildProviderProof,
  buildTotpConfirmPayload,
  buildTotpSetupPayload,
} from "./twoFactorPayload.js";

test("setup keeps the canonical one-shot and own password byte-exact", () => {
  const payload = buildTotpSetupPayload({
    enrollmentRequestId: "request:42",
    enrollmentPassword: "AbCdEfGhIjKlMnOpQrSt_123",
    currentPassword: "  eigenes Pässwort  ",
  });

  assert.deepEqual(payload, {
    enrollmentRequestId: "request:42",
    enrollmentPassword: "AbCdEfGhIjKlMnOpQrSt_123",
    currentPassword: "  eigenes Pässwort  ",
  });
  assert.throws(() => buildTotpSetupPayload({
    enrollmentRequestId: "request:42",
    enrollmentPassword: "  Freigabe-Pässwort  ",
    currentPassword: "eigenes Passwort",
  }), /Core-Format/);
});

test("provider proof projects every and only provider-published field", () => {
  const fields = [
    { name: "code", label: "Code" },
    { name: "token", label: "Token" },
    { name: "password", label: "Passwort" },
  ];
  assert.deepEqual(buildProviderProof({
    code: "123456",
    token: "adapter-token",
    password: "exact password",
    ignored: "must-not-leak",
  }, fields), {
    code: "123456",
    token: "adapter-token",
    password: "exact password",
  });
  assert.throws(() => buildProviderProof({ code: "123456" }, [], {}), /keinen 2FA-Nachweis/);
});

test("provider token length uses Unicode codepoints and rejects invalid UTF-8", () => {
  const fields = [{ name: "token", label: "Token", type: "password" }];
  const exactly128Emoji = "😀".repeat(128);
  assert.deepEqual(buildProviderProof({ token: exactly128Emoji }, fields), {
    token: exactly128Emoji,
  });
  for (const invalid of ["😀".repeat(129), "\uD800", "token\r\nvalue", "token\0value"]) {
    assert.throws(() => buildProviderProof({ token: invalid }, fields));
  }
});

test("recovery proof is exclusive at every payload boundary", () => {
  assert.deepEqual(buildProviderProof({ recoveryCode: "ABCD-EFGH-JKLM-NPQR" }, [], { recovery: true }), {
    recoveryCode: "ABCD-EFGH-JKLM-NPQR",
  });
  assert.throws(() => buildExistingProof({ recoveryCode: "ABCD-EFGH-JKLM-NPQR", code: "123456" }), /exklusiv/);
  assert.throws(() => buildExistingProof({ recoveryCode: "RECOVERY-123" }), /ungueltig/);
});

test("admin and confirmation payload names follow the v1 contract", () => {
  assert.deepEqual(buildAdminCreatePayload({
    accountId: "account:7",
    expiresInMinutes: 30,
    proof: { password: "admin password" },
  }), {
    accountId: "account:7",
    expiresInMinutes: 30,
    password: "admin password",
  });
  assert.deepEqual(buildTotpConfirmPayload({
    enrollmentRequestId: "request:42",
    credentialId: "credential:9",
    code: "123456",
  }), {
    enrollmentRequestId: "request:42",
    credentialId: "credential:9",
    code: "123456",
  });
});
