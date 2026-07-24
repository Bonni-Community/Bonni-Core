import crypto from "node:crypto";

import { validateUpdateRunnerRequest } from "./contract.mjs";

export const UPDATE_REQUEST_AUTH_DOMAIN = "BONNI_CORE_UPDATE_REQUEST_V1";

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("REQUEST_CANONICAL_JSON_REQUIRES_SAFE_INTEGER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error(`UNSUPPORTED_REQUEST_CANONICAL_JSON_TYPE:${typeof value}`);
}

function requestSecret(secret) {
  const buffer = Buffer.isBuffer(secret) ? secret : Buffer.from(secret || "");
  if (buffer.length < 32) throw new Error("UPDATE_REQUEST_SECRET_TOO_SHORT");
  return buffer;
}

export function canonicalUpdateRunnerRequest(unsignedRequest, options = {}) {
  const { auth: _auth, ...payload } = unsignedRequest || {};
  const normalized = validateUpdateRunnerRequest(payload, { ...options, requireAuth: false, enforceInstallPolicy: false });
  return Buffer.from(`${UPDATE_REQUEST_AUTH_DOMAIN}\n${canonicalJson(normalized)}\n`, "utf8");
}

export function signUpdateRunnerRequest(unsignedRequest, secret, options = {}) {
  const { auth: _auth, ...payload } = unsignedRequest || {};
  const normalized = validateUpdateRunnerRequest(payload, { ...options, requireAuth: false, enforceInstallPolicy: false });
  const value = crypto.createHmac("sha256", requestSecret(secret))
    .update(canonicalUpdateRunnerRequest(normalized, options))
    .digest("hex");
  return { ...normalized, auth: { algorithm: "HMAC-SHA256", value } };
}

export function verifyUpdateRunnerRequestAuth(request, secret, options = {}) {
  const normalized = authenticateUpdateRunnerRequest(request, secret, options);
  return validateUpdateRunnerRequest(normalized, options);
}

export function authenticateUpdateRunnerRequest(request, secret, options = {}) {
  const normalized = validateUpdateRunnerRequest(request, { ...options, enforceInstallPolicy: false });
  const expected = crypto.createHmac("sha256", requestSecret(secret))
    .update(canonicalUpdateRunnerRequest(normalized, options))
    .digest();
  const received = Buffer.from(normalized.auth.value, "hex");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new Error("UPDATE_REQUEST_HMAC_INVALID");
  }
  return normalized;
}
