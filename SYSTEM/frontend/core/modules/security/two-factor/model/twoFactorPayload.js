import { LOCAL_PASSWORD_MAX_LENGTH, validateExactSecret } from "./exactSecretPolicy.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ENROLLMENT_PASSWORD = /^[A-Za-z0-9_-]{20,80}$/;
const RECOVERY_CODE = /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const TOTP_CODE = /^\d{6}(?:\d{2})?$/;
const PROOF_NAMES = new Set(["code", "recoveryCode", "token", "password"]);

export class TwoFactorPayloadError extends Error {
  constructor(message, code = "TWO_FACTOR_PAYLOAD_INVALID") {
    super(message);
    this.name = "TwoFactorPayloadError";
    this.code = code;
  }
}

function invalid(message) {
  throw new TwoFactorPayloadError(message);
}

function exactId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalid(`${label} ist ungueltig.`);
  return value;
}

function exactPassword(value, label, maxLength = LOCAL_PASSWORD_MAX_LENGTH) {
  const message = validateExactSecret(value, { label, maxLength });
  if (message) invalid(message);
  return value;
}

function exactEnrollmentPassword(value) {
  if (typeof value !== "string" || !ENROLLMENT_PASSWORD.test(value)) {
    invalid("Das Freigabepasswort besitzt kein gueltiges Core-Format.");
  }
  return value;
}

function exactRecoveryCode(value) {
  if (typeof value !== "string" || !RECOVERY_CODE.test(value)) {
    invalid("Der Wiederherstellungscode ist ungueltig.");
  }
  return value;
}

function exactTotpCode(value, label = "Authenticator-Code") {
  if (typeof value !== "string" || !TOTP_CODE.test(value)) invalid(`${label} ist ungueltig.`);
  return value;
}

export function buildProviderProof(values, proofFields, { recovery = false } = {}) {
  const fields = Array.isArray(proofFields) ? proofFields : [];
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    invalid("Der 2FA-Nachweis ist ungueltig.");
  }

  if (recovery) {
    return {
      recoveryCode: exactRecoveryCode(values.recoveryCode),
    };
  }

  const payload = {};
  for (const field of fields) {
    const name = field?.name;
    if (!PROOF_NAMES.has(name) || name === "recoveryCode") {
      invalid("Der Anbieter hat ein unbekanntes 2FA-Prueffeld geliefert.");
    }
    if (name === "password") {
      payload.password = exactPassword(values.password, field.label || "Passwort");
    } else if (name === "code") {
      payload.code = exactTotpCode(values.code, field.label || "Authenticator-Code");
    } else {
      payload.token = exactPassword(values.token, field.label || "Provider-Token", 128);
    }
  }
  if (!Object.keys(payload).length) invalid("Der Anbieter hat keinen 2FA-Nachweis angefordert.");
  return payload;
}

export function buildTotpSetupPayload(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) invalid("Die 2FA-Einrichtung ist ungueltig.");
  return {
    enrollmentRequestId: exactId(values.enrollmentRequestId, "2FA-Auftrag-ID"),
    enrollmentPassword: exactEnrollmentPassword(values.enrollmentPassword),
    currentPassword: exactPassword(values.currentPassword, "Aktuelles Passwort"),
  };
}

export function buildTotpConfirmPayload(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) invalid("Die TOTP-Bestaetigung ist ungueltig.");
  const code = exactTotpCode(values.code);
  return {
    enrollmentRequestId: exactId(values.enrollmentRequestId, "2FA-Auftrag-ID"),
    credentialId: exactId(values.credentialId, "2FA-Zugang-ID"),
    code,
  };
}

export function buildAdminCreatePayload({ accountId, expiresInMinutes = 15, proof }) {
  const expiry = Number(expiresInMinutes);
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 1_440) {
    invalid("Die Gueltigkeit des 2FA-Auftrags ist ungueltig.");
  }
  return {
    accountId: exactId(accountId, "Zielkonto-ID"),
    expiresInMinutes: expiry,
    ...buildExistingProof(proof),
  };
}

export function buildAdminRotatePayload({ expiresInMinutes = 15, proof }) {
  const expiry = Number(expiresInMinutes);
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 1_440) {
    invalid("Die Gueltigkeit des 2FA-Auftrags ist ungueltig.");
  }
  return { expiresInMinutes: expiry, ...buildExistingProof(proof) };
}

export function buildExistingProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) invalid("Der 2FA-Nachweis ist ungueltig.");
  const keys = Object.keys(proof);
  if (!keys.length || keys.some((key) => !PROOF_NAMES.has(key))) invalid("Der 2FA-Nachweis ist ungueltig.");
  if (proof.recoveryCode != null && keys.some((key) => key !== "recoveryCode")) {
    invalid("Ein Wiederherstellungscode muss exklusiv verwendet werden.");
  }
  const result = {};
  for (const key of keys) {
    if (key === "password") result.password = exactPassword(proof.password, "Passwort");
    else if (key === "recoveryCode") result.recoveryCode = exactRecoveryCode(proof.recoveryCode);
    else if (key === "code") result.code = exactTotpCode(proof.code);
    else result.token = exactPassword(proof.token, "Provider-Token", 128);
  }
  return result;
}
