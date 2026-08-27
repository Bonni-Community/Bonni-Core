import crypto from "node:crypto";

export const DEPLOYMENT_LIFECYCLE_PROTOCOL = "bonni-deployment-lifecycle/1";
export const DEPLOYMENT_LIFECYCLE_AUTH_DOMAIN = "BONNI_CORE_DEPLOYMENT_LIFECYCLE_V1";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const HMAC = /^[a-f0-9]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} muss ein Objekt sein.`);
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} enthält unbekannte Felder: ${unknown.join(", ")}`);
}

function requiredString(value, label, pattern, maximum = 128) {
  if (typeof value !== "string" || !value || value.length > maximum || !pattern.test(value)) {
    throw new Error(`${label} ist ungültig.`);
  }
  return value;
}

function canonicalUtc(value, label) {
  const text = requiredString(value, label, UTC_TIMESTAMP, 32);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} ist ungültig.`);
  const canonical = new Date(timestamp).toISOString();
  if (text.endsWith(".000Z") ? canonical !== text : canonical.replace(/\.000Z$/, "Z") !== text) {
    throw new Error(`${label} ist nicht kanonisch.`);
  }
  return { text, timestamp };
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("LIFECYCLE_CANONICAL_JSON_REQUIRES_SAFE_INTEGER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error(`UNSUPPORTED_LIFECYCLE_CANONICAL_JSON_TYPE:${typeof value}`);
}

function secretBuffer(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(secret || "");
  if (value.length < 32) throw new Error("UPDATE_REQUEST_SECRET_TOO_SHORT");
  return value;
}

export function validateLifecycleCommand(input, options = {}) {
  const command = record(input, "lifecycleCommand");
  exactKeys(command, [
    "schemaVersion", "commandId", "action", "holdId", "generation",
    "issuedAt", "expiresAt", "nonce", "auth",
  ], "lifecycleCommand");
  if (command.schemaVersion !== 1 || command.action !== "finalize") {
    throw new Error("Ungültige Lifecycle-Command-Identität.");
  }
  const commandId = requiredString(command.commandId, "lifecycleCommand.commandId", IDENTIFIER);
  const holdId = requiredString(command.holdId, "lifecycleCommand.holdId", IDENTIFIER);
  if (!Number.isSafeInteger(command.generation) || command.generation <= 0) {
    throw new Error("lifecycleCommand.generation ist ungültig.");
  }
  const issuedAt = canonicalUtc(command.issuedAt, "lifecycleCommand.issuedAt");
  const expiresAt = canonicalUtc(command.expiresAt, "lifecycleCommand.expiresAt");
  if (expiresAt.timestamp <= issuedAt.timestamp) throw new Error("Lifecycle-Command läuft nicht nach ihrer Ausstellung ab.");
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  if (issuedAt.timestamp > now + Number(options.futureToleranceMs ?? 5 * 60_000)) {
    throw new Error("Lifecycle-Command liegt in der Zukunft.");
  }
  if (options.allowExpired !== true && expiresAt.timestamp <= now) throw new Error("Lifecycle-Command ist abgelaufen.");
  const nonce = requiredString(command.nonce, "lifecycleCommand.nonce", NONCE);

  let auth;
  if (command.auth !== undefined) {
    const inputAuth = record(command.auth, "lifecycleCommand.auth");
    exactKeys(inputAuth, ["algorithm", "value"], "lifecycleCommand.auth");
    if (inputAuth.algorithm !== "HMAC-SHA256") throw new Error("Lifecycle-Command verwendet eine ungültige Authentifizierung.");
    auth = {
      algorithm: "HMAC-SHA256",
      value: requiredString(inputAuth.value, "lifecycleCommand.auth.value", HMAC, 64),
    };
  } else if (options.requireAuth !== false) {
    throw new Error("Lifecycle-Command besitzt keine lokale HMAC-Authentifizierung.");
  }

  return {
    schemaVersion: 1,
    commandId,
    action: "finalize",
    holdId,
    generation: command.generation,
    issuedAt: issuedAt.text,
    expiresAt: expiresAt.text,
    nonce,
    ...(auth ? { auth } : {}),
  };
}

export function canonicalLifecycleCommand(input, options = {}) {
  const { auth: _auth, ...unsigned } = input || {};
  const normalized = validateLifecycleCommand(unsigned, { ...options, requireAuth: false, allowExpired: true });
  return Buffer.from(`${DEPLOYMENT_LIFECYCLE_AUTH_DOMAIN}\n${canonicalJson(normalized)}\n`, "utf8");
}

export function signLifecycleCommand(input, secret, options = {}) {
  const { auth: _auth, ...unsigned } = input || {};
  const normalized = validateLifecycleCommand(unsigned, { ...options, requireAuth: false, allowExpired: true });
  const value = crypto.createHmac("sha256", secretBuffer(secret))
    .update(canonicalLifecycleCommand(normalized, options))
    .digest("hex");
  return { ...normalized, auth: { algorithm: "HMAC-SHA256", value } };
}

export function verifyLifecycleCommand(input, secret, options = {}) {
  const normalized = validateLifecycleCommand(input, options);
  const expected = crypto.createHmac("sha256", secretBuffer(secret))
    .update(canonicalLifecycleCommand(normalized, options))
    .digest();
  const received = Buffer.from(normalized.auth.value, "hex");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new Error("LIFECYCLE_COMMAND_HMAC_INVALID");
  }
  return normalized;
}
