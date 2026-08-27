const MAX_CREDENTIALS = 20;
const MAX_RECOVERY_CODES = 20;
const MAX_QR_DATA_URL_LENGTH = 750_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const RECOVERY_CODE = /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const ENROLLMENT_STATUSES = new Set(["PENDING", "IN_PROGRESS", "EXPIRED"]);
const PROOF_NAMES = new Set(["code", "recoveryCode", "token", "password"]);
const PROOF_FIELD_KEYS = new Set(["name", "label", "type", "autocomplete", "help"]);
const PROOF_FIELD_TYPES = new Set(["text", "password"]);
const PROOF_AUTOCOMPLETE_VALUES = new Set(["off", "one-time-code", "current-password"]);
const SCHEMA_VERSION = "bonni.two-factor-enrollment/v1";

export class TwoFactorDtoError extends Error {
  constructor(message, code = "TWO_FACTOR_RESPONSE_INVALID") {
    super(message);
    this.name = "TwoFactorDtoError";
    this.code = code;
  }
}

function invalid(message) {
  throw new TwoFactorDtoError(message);
}

function record(value, label = "Antwort") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} ist ungueltig.`);
  }
  return value;
}

function boundedString(value, label, { max = 200, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) {
    invalid(`${label} ist ungueltig.`);
  }
  return value;
}

function id(value, label) {
  const result = boundedString(value, label, { max: 160 });
  if (!SAFE_ID.test(result)) invalid(`${label} ist ungueltig.`);
  return result;
}

function dateValue(value, label, optional = true) {
  if (value == null && optional) return null;
  const result = boundedString(value, label, { max: 64 });
  if (Number.isNaN(Date.parse(result))) invalid(`${label} ist ungueltig.`);
  return result;
}

function boundedInteger(value, label, { min = 0, max = 1_000, fallback = 0 } = {}) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) invalid(`${label} ist ungueltig.`);
  return number;
}

function exactSchemaVersion(value) {
  if (value !== SCHEMA_VERSION) invalid("Die 2FA-Schemaversion ist ungueltig.");
  return value;
}

function assertNoUnexpectedSecrets(value, { allow = new Set(), depth = 0 } = {}) {
  if (depth > 12) invalid("Die 2FA-Antwort ist zu tief verschachtelt.");
  if (Array.isArray(value)) {
    if (value.length > 100) invalid("Die 2FA-Antwort ist zu gross.");
    value.forEach((entry) => assertNoUnexpectedSecrets(entry, { allow, depth: depth + 1 }));
    return;
  }
  if (!value || typeof value !== "object") return;

  const entries = Object.entries(value);
  if (entries.length > 100) invalid("Die 2FA-Antwort ist zu gross.");
  for (const [key, entry] of entries) {
    const normalized = key.toLowerCase();
    const alwaysForbidden = normalized.includes("otpauth")
      || normalized.includes("manualentry")
      || normalized === "secret"
      || normalized.endsWith("secret")
      || normalized.includes("secretencrypted");
    const oneShotSecret = normalized === "enrollmentpassword"
      || normalized === "recoverycodes"
      || normalized === "qrcodedataurl";
    const passwordValue = normalized.includes("password")
      && typeof entry !== "boolean"
      && !allow.has(normalized);
    if (alwaysForbidden || passwordValue || (oneShotSecret && !allow.has(normalized))) {
      invalid("Die 2FA-Antwort enthaelt unerwartetes geheimes Material.");
    }
    assertNoUnexpectedSecrets(entry, { allow, depth: depth + 1 });
  }
}

export function normalizeProofFields(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 3) invalid("Die 2FA-Prueffelder sind ungueltig.");
  const seen = new Set();
  const fields = value.map((rawField) => {
    const field = record(rawField, "2FA-Prueffeld");
    if (Object.keys(field).some((key) => !PROOF_FIELD_KEYS.has(key))) {
      invalid("Die 2FA-Prueffelder sind ungueltig.");
    }
    const name = boundedString(field.name, "Name des 2FA-Prueffelds", { max: 32 });
    if (!PROOF_NAMES.has(name) || seen.has(name)) invalid("Die 2FA-Prueffelder sind ungueltig.");
    if (!PROOF_FIELD_TYPES.has(field.type)) invalid("Die 2FA-Prueffelder sind ungueltig.");
    if (field.autocomplete !== undefined && !PROOF_AUTOCOMPLETE_VALUES.has(field.autocomplete)) {
      invalid("Die 2FA-Prueffelder sind ungueltig.");
    }
    if (field.help !== undefined && (
      typeof field.help !== "string"
      || field.help.length > 240
      || /[\r\n\0]/u.test(field.help)
    )) invalid("Die 2FA-Prueffelder sind ungueltig.");
    seen.add(name);
    return {
      name,
      label: boundedString(field.label, "Beschriftung des 2FA-Prueffelds", { max: 100 }),
      type: field.type,
      autocomplete: field.autocomplete || "off",
      help: field.help || "",
    };
  });
  if (seen.has("recoveryCode") && fields.length !== 1) invalid("Die 2FA-Prueffelder sind ungueltig.");
  return fields;
}

function normalizeProvider(value) {
  const provider = record(value, "2FA-Anbieter");
  return {
    id: boundedString(provider.id || "local", "2FA-Anbieter-ID", { max: 80 }),
    label: boundedString(provider.label || "Bonni Core", "2FA-Anbieter", { max: 100 }),
    configured: provider.configured !== false,
    externallyManaged: provider.externallyManaged === true,
    proofFields: normalizeProofFields(provider.proofFields),
  };
}

function normalizeCredential(value) {
  const credential = record(value, "2FA-Zugang");
  return {
    id: id(credential.id, "2FA-Zugang-ID"),
    method: boundedString(credential.method || "TOTP", "2FA-Methode", { max: 40 }),
    status: boundedString(credential.status || "UNKNOWN", "2FA-Status", { max: 40 }),
    label: typeof credential.label === "string" && credential.label.length <= 100 ? credential.label : "",
    createdAt: dateValue(credential.createdAt, "Erstellungszeit"),
    confirmedAt: dateValue(credential.confirmedAt, "Bestaetigungszeit"),
    lastUsedAt: dateValue(credential.lastUsedAt, "Letzte Verwendung"),
    disabledAt: dateValue(credential.disabledAt, "Deaktivierungszeit"),
  };
}

export function normalizeEnrollmentRequest(value) {
  if (value == null) return null;
  const request = record(value, "2FA-Auftrag");
  const status = boundedString(request.status, "Status des 2FA-Auftrags", { max: 24 });
  if (!ENROLLMENT_STATUSES.has(status)) invalid("Status des 2FA-Auftrags ist ungueltig.");
  if (request.requiresCurrentPassword !== true || request.requiresEnrollmentPassword !== true) {
    invalid("Der 2FA-Auftrag besitzt keinen vollstaendigen Freigabevertrag.");
  }
  return {
    id: id(request.id, "2FA-Auftrag-ID"),
    status,
    requestedAt: dateValue(request.requestedAt, "Auftragszeit", false),
    expiresAt: dateValue(request.expiresAt, "Ablaufzeit", false),
    requiresCurrentPassword: request.requiresCurrentPassword === true,
    requiresEnrollmentPassword: request.requiresEnrollmentPassword === true,
  };
}

export function normalizeTwoFactorStatus(value) {
  const source = record(value, "2FA-Statusantwort");
  assertNoUnexpectedSecrets(source);
  if (typeof source.enabled !== "boolean") invalid("Der 2FA-Aktivstatus ist ungueltig.");
  const credentials = source.credentials == null ? [] : source.credentials;
  if (!Array.isArray(credentials) || credentials.length > MAX_CREDENTIALS) {
    invalid("Die 2FA-Statusantwort enthaelt zu viele Zugaenge.");
  }
  return {
    ok: source.ok !== false,
    schemaVersion: exactSchemaVersion(source.schemaVersion),
    enabled: source.enabled === true,
    provider: normalizeProvider(source.provider),
    methods: Array.isArray(source.methods)
      ? source.methods.slice(0, MAX_CREDENTIALS).map((method) => boundedString(method, "2FA-Methode", { max: 40 }))
      : [],
    credentials: credentials.map(normalizeCredential),
    unusedRecoveryCodeCount: boundedInteger(source.unusedRecoveryCodeCount, "Anzahl der Wiederherstellungscodes", { max: 100 }),
    maxAttempts: boundedInteger(source.maxAttempts, "Maximale 2FA-Versuche", { min: 1, max: 20, fallback: 8 }),
    challengeExpiresSeconds: boundedInteger(source.challengeExpiresSeconds, "2FA-Gueltigkeit", { min: 15, max: 600, fallback: 60 }),
    enrollmentRequest: normalizeEnrollmentRequest(source.enrollmentRequest),
  };
}

export function normalizeTotpSetup(value) {
  const source = record(value, "TOTP-Einrichtungsantwort");
  assertNoUnexpectedSecrets(source, { allow: new Set(["qrcodedataurl"]) });
  const qrCodeDataUrl = boundedString(source.qrCodeDataUrl, "QR-Code", { max: MAX_QR_DATA_URL_LENGTH });
  if (!/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(qrCodeDataUrl)) {
    invalid("Der TOTP-QR-Code ist kein gueltiges PNG.");
  }
  return {
    credentialId: id(source.credentialId, "2FA-Zugang-ID"),
    qrCodeDataUrl,
  };
}

function normalizeRecoveryCodes(value, { required = false } = {}) {
  if (value == null && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > MAX_RECOVERY_CODES) {
    invalid("Die Wiederherstellungscodes sind ungueltig.");
  }
  const codes = value.map((code) => {
    const result = boundedString(code, "Wiederherstellungscode", { max: 19 });
    if (!RECOVERY_CODE.test(result)) invalid("Die Wiederherstellungscodes sind ungueltig.");
    return result;
  });
  if (new Set(codes).size !== codes.length) invalid("Die Wiederherstellungscodes sind nicht eindeutig.");
  return codes;
}

export function normalizeTotpConfirmation(value) {
  const source = record(value, "TOTP-Bestaetigungsantwort");
  assertNoUnexpectedSecrets(source, { allow: new Set(["recoverycodes"]) });
  const alreadyConfirmed = source.alreadyConfirmed === true;
  if (alreadyConfirmed && Array.isArray(source.recoveryCodes) && source.recoveryCodes.length) {
    invalid("Eine wiederholte Bestaetigung darf keine Wiederherstellungscodes liefern.");
  }
  return {
    alreadyConfirmed,
    recoveryCodes: normalizeRecoveryCodes(source.recoveryCodes, { required: !alreadyConfirmed }),
  };
}

export function normalizeRecoveryCodeResult(value) {
  const source = record(value, "Wiederherstellungscode-Antwort");
  assertNoUnexpectedSecrets(source, { allow: new Set(["recoverycodes"]) });
  return { recoveryCodes: normalizeRecoveryCodes(source.recoveryCodes, { required: true }) };
}

function normalizeAdminRequestEnvelope(value, { mode }) {
  const source = record(value, "Administrator-2FA-Antwort");
  const allowPassword = mode === "one-shot";
  assertNoUnexpectedSecrets(source, {
    allow: allowPassword ? new Set(["enrollmentpassword"]) : new Set(),
  });
  if (mode === "status" && (
    Object.hasOwn(source, "enrollmentPasswordShownOnce")
    || Object.hasOwn(source, "requiresRotation")
    || Object.hasOwn(source, "replacedRequestId")
  )) {
    invalid("Die Administrator-Statusantwort enthaelt Einmal-Antwortfelder.");
  }
  if (typeof source.twoFactorActive !== "boolean") {
    invalid("Der 2FA-Aktivstatus des Zielkontos ist ungueltig.");
  }
  const enrollmentPassword = source.enrollmentPassword == null
    ? null
    : boundedString(source.enrollmentPassword, "Einmaliges Freigabepasswort", { max: 80 });
  if (enrollmentPassword !== null && (
    enrollmentPassword.length < 20
    || !/^[A-Za-z0-9_-]+$/.test(enrollmentPassword)
  )) {
    invalid("Das einmalige Freigabepasswort besitzt kein gueltiges Core-Format.");
  }
  const enrollmentPasswordShownOnce = source.enrollmentPasswordShownOnce;
  const requiresRotation = source.requiresRotation;
  if (allowPassword && (
    typeof enrollmentPasswordShownOnce !== "boolean"
    || typeof requiresRotation !== "boolean"
  )) {
    invalid("Die Einmal-Antwort besitzt keinen eindeutigen Sichtbarkeitsvertrag.");
  }
  const freshOneShot = Boolean(enrollmentPassword)
    && enrollmentPasswordShownOnce === true
    && requiresRotation === false;
  const replay = enrollmentPassword === null
    && enrollmentPasswordShownOnce === false
    && requiresRotation === true;
  if (allowPassword && !freshOneShot && !replay) {
    invalid("Die Einmal-Antwort ist weder frisch noch eine geheimnisfreie Wiederholung.");
  }
  const request = normalizeEnrollmentRequest(source.request);
  if (allowPassword && !request) invalid("Die Einmal-Antwort enthaelt keinen 2FA-Auftrag.");
  return {
    ok: source.ok !== false,
    schemaVersion: exactSchemaVersion(source.schemaVersion),
    accountId: id(source.accountId, "Zielkonto-ID"),
    twoFactorActive: source.twoFactorActive === true,
    request,
    enrollmentPassword,
    enrollmentPasswordShownOnce: allowPassword ? enrollmentPasswordShownOnce : false,
    requiresRotation: allowPassword ? requiresRotation : false,
    replacedRequestId: source.replacedRequestId == null ? null : id(source.replacedRequestId, "Ersetzte Auftrag-ID"),
  };
}

export function normalizeAdminEnrollmentStatus(value) {
  return normalizeAdminRequestEnvelope(value, { mode: "status" });
}

export function normalizeAdminEnrollmentOneShot(value) {
  return normalizeAdminRequestEnvelope(value, { mode: "one-shot" });
}

export function normalizeDisableResult(value) {
  const source = record(value, "2FA-Deaktivierungsantwort");
  assertNoUnexpectedSecrets(source);
  return { disabled: boundedInteger(source.disabled, "Deaktivierte 2FA-Zugaenge", { max: MAX_CREDENTIALS }) };
}
