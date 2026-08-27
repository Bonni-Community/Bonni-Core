import { apiRequest } from "./apiClient.js";
import { validateExactSecret } from "../../core/modules/security/two-factor/model/exactSecretPolicy.js";
import { buildExistingProof } from "../../core/modules/security/two-factor/model/twoFactorPayload.js";

const SENSITIVE_REQUEST_OPTIONS = Object.freeze({
  allowFailover: false,
  cache: "no-store",
  sensitive: true,
  headers: {
    Accept: "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  },
});

function invalid(message) {
  throw Object.assign(new Error(message), { code: "AUTH_PAYLOAD_INVALID" });
}

function exactProofValue(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\r\n\0]/.test(value)) {
    invalid(`${label} ist ungueltig.`);
  }
  return value;
}

export async function loginWithPassword({
  loginName,
  password,
}) {
  const passwordError = validateExactSecret(password, { label: "Passwort" });
  if (passwordError) invalid(passwordError);
  return apiRequest("/api/identity/auth/login", {
    ...SENSITIVE_REQUEST_OPTIONS,
    method: "POST",
    body: {
      login: loginName,
      password,
    },
  });
}

export async function loginWithTwoFactor({ challengeId, proof }) {
  const payload = {
    challengeId: exactProofValue(challengeId, "2FA-Challenge", 200),
    ...buildExistingProof(proof),
  };
  return apiRequest("/api/identity/auth/login/2fa", {
    ...SENSITIVE_REQUEST_OPTIONS,
    method: "POST",
    body: payload,
  });
}

export async function fetchAccessStatus(token) {
  return apiRequest("/api/identity/auth/me", {
    token,
  });
}
