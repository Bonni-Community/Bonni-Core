import { apiRequest } from "./apiClient.js";
import { buildExistingProof } from "../../core/modules/security/two-factor/model/twoFactorPayload.js";

const BASE = "/api/system/integrations/jitsi";
const NO_STORE_HEADERS = Object.freeze({
  Accept: "application/json",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
});

function securityRequest(path, options = {}) {
  return apiRequest(path, {
    ...options,
    headers: { ...NO_STORE_HEADERS, ...(options.headers || {}) },
    allowFailover: false,
    cache: "no-store",
    sensitive: true,
  });
}

export function getJitsiSettings(token) {
  return apiRequest(BASE, { token });
}

export function testJitsiSettings(token, serverUrl) {
  return apiRequest(`${BASE}/test`, { token, method: "POST", body: { serverUrl } });
}

export function createJitsiAdminChallenge(token) {
  return securityRequest("/api/security/2fa/challenge", {
    token,
    method: "POST",
    body: { purpose: "ADMIN_ELEVATION" },
  });
}

export function verifyJitsiAdminChallenge(token, challengeId, proof) {
  return securityRequest(`/api/security/2fa/challenge/${encodeURIComponent(challengeId)}/verify`, {
    token,
    method: "POST",
    body: buildExistingProof(proof),
  });
}

export function saveJitsiSettings(token, payload) {
  return securityRequest(BASE, { token, method: "PUT", body: payload });
}
