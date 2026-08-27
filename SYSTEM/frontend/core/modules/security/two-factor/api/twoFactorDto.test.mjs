import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAdminEnrollmentOneShot,
  normalizeAdminEnrollmentStatus,
  normalizeTotpConfirmation,
  normalizeTotpSetup,
  normalizeProofFields,
  normalizeTwoFactorStatus,
} from "./twoFactorDto.js";

const SCHEMA_VERSION = "bonni.two-factor-enrollment/v1";
const REQUEST = Object.freeze({
  id: "request:42",
  status: "PENDING",
  requestedAt: "2026-08-20T10:00:00.000Z",
  expiresAt: "2026-08-20T10:15:00.000Z",
  requiresCurrentPassword: true,
  requiresEnrollmentPassword: true,
});

function status(overrides = {}) {
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    provider: {
      id: "local",
      label: "Bonni Core",
      configured: true,
      externallyManaged: false,
      proofFields: [{ name: "password", label: "Passwort", type: "password" }],
    },
    credentials: [],
    methods: [],
    unusedRecoveryCodeCount: 0,
    maxAttempts: 8,
    challengeExpiresSeconds: 60,
    enrollmentRequest: REQUEST,
    ...overrides,
  };
}

test("status accepts only the canonical v1 request envelope", () => {
  const result = normalizeTwoFactorStatus(status());
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.enrollmentRequest.id, "request:42");
  assert.throws(() => normalizeTwoFactorStatus(status({ schemaVersion: "legacy/v0" })), /Schemaversion/);
  assert.throws(() => normalizeTwoFactorStatus(status({ enrollmentRequest: { ...REQUEST, status: "CLAIMED" } })), /Status/);
  assert.throws(() => normalizeTwoFactorStatus(status({ enrollmentRequest: { ...REQUEST, requiresCurrentPassword: false } })), /Freigabevertrag/);
});

test("provider proof fields use a closed and exact contract", () => {
  assert.deepEqual(normalizeProofFields(null), []);
  assert.deepEqual(normalizeProofFields([]), []);
  assert.deepEqual(normalizeProofFields([{
    name: "token",
    label: "Provider-Token",
    type: "password",
    autocomplete: "off",
    help: "Aus der Anbieter-App",
  }]), [{
    name: "token",
    label: "Provider-Token",
    type: "password",
    autocomplete: "off",
    help: "Aus der Anbieter-App",
  }]);
  for (const fields of [
    [{ name: "token", label: "Token" }],
    [{ name: "token", label: "Token", type: "email" }],
    [{ name: "token", label: "Token", type: "password", autocomplete: "token" }],
    [{ name: "token", label: "Token", type: "password", unexpected: true }],
    [
      { name: "recoveryCode", label: "Recovery", type: "password" },
      { name: "code", label: "Code", type: "password" },
    ],
  ]) assert.throws(() => normalizeProofFields(fields), /Prueffelder/);
});

test("status and setup reject hidden or manually renderable secrets", () => {
  assert.throws(() => normalizeTwoFactorStatus(status({ manualSecret: "ABC" })), /geheimes Material/);
  assert.throws(() => normalizeTotpSetup({
    credentialId: "credential:9",
    qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgoAAAA=",
    otpauthUri: "otpauth://totp/secret",
  }), /geheimes Material/);
  assert.throws(() => normalizeTotpSetup({
    credentialId: "credential:9",
    qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
  }), /PNG/);
  assert.equal(normalizeTotpSetup({
    credentialId: "credential:9",
    qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgoAAAA=",
  }).credentialId, "credential:9");
});

test("admin one-shot accepts final flags and rejects drifted aliases", () => {
  const result = normalizeAdminEnrollmentOneShot({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    accountId: "account:7",
    twoFactorActive: false,
    request: REQUEST,
    enrollmentPassword: "AbCDefghijkLMNopqrstuv_1234",
    enrollmentPasswordShownOnce: true,
    requiresRotation: false,
  });
  assert.equal(result.enrollmentPassword, "AbCDefghijkLMNopqrstuv_1234");
  assert.equal(result.enrollmentPasswordShownOnce, true);

  assert.throws(() => normalizeAdminEnrollmentOneShot({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    accountId: "account:7",
    twoFactorActive: false,
    request: REQUEST,
    enrollmentPassword: "AbCDefghijkLMNopqrstuv_1234",
    shownOnce: true,
    rotationRequired: false,
  }), /Sichtbarkeitsvertrag/);
});

test("admin replay and secret-free status stay distinguishable", () => {
  const replay = normalizeAdminEnrollmentOneShot({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    accountId: "account:7",
    twoFactorActive: false,
    request: { ...REQUEST, status: "IN_PROGRESS" },
    enrollmentPassword: null,
    enrollmentPasswordShownOnce: false,
    requiresRotation: true,
  });
  assert.equal(replay.enrollmentPassword, null);
  assert.equal(replay.requiresRotation, true);

  assert.equal(normalizeAdminEnrollmentStatus({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    accountId: "account:7",
    twoFactorActive: false,
    request: null,
  }).request, null);
  assert.throws(() => normalizeAdminEnrollmentStatus({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    accountId: "account:7",
    twoFactorActive: false,
    request: null,
    enrollmentPasswordShownOnce: false,
  }), /Einmal-Antwortfelder/);
});

test("confirmation returns recovery codes once and never on replay", () => {
  assert.deepEqual(normalizeTotpConfirmation({
    alreadyConfirmed: false,
    recoveryCodes: ["ABCD-EFGH-JKLM-NPQR", "STUV-WXYZ-2345-6789"],
  }).recoveryCodes, ["ABCD-EFGH-JKLM-NPQR", "STUV-WXYZ-2345-6789"]);
  assert.deepEqual(normalizeTotpConfirmation({ alreadyConfirmed: true }), {
    alreadyConfirmed: true,
    recoveryCodes: [],
  });
  assert.deepEqual(normalizeTotpConfirmation({ alreadyConfirmed: true, recoveryCodes: [] }), {
    alreadyConfirmed: true,
    recoveryCodes: [],
  });
  assert.throws(() => normalizeTotpConfirmation({
    alreadyConfirmed: true,
    recoveryCodes: ["ABCD-EFGH-JKLM-NPQR"],
  }), /wiederholte/);
  assert.throws(() => normalizeTotpConfirmation({
    alreadyConfirmed: false,
    recoveryCodes: ["RECOVERY-1"],
  }), /ungueltig/);
});
