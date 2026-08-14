import { apiRequest } from "./apiClient.js";

const BASE = "/api/system/integrations/jitsi";

export function getJitsiSettings(token) {
  return apiRequest(BASE, { token });
}

export function testJitsiSettings(token, serverUrl) {
  return apiRequest(`${BASE}/test`, { token, method: "POST", body: { serverUrl } });
}

export function createJitsiAdminChallenge(token) {
  return apiRequest("/api/security/2fa/challenge", {
    token,
    method: "POST",
    body: { purpose: "ADMIN_ELEVATION", metadataJson: { action: "JITSI_SERVER_CONFIGURATION_CHANGED" } },
  });
}

export function verifyJitsiAdminChallenge(token, challengeId, proof) {
  return apiRequest(`/api/security/2fa/challenge/${encodeURIComponent(challengeId)}/verify`, {
    token,
    method: "POST",
    body: proof,
  });
}

export function saveJitsiSettings(token, payload) {
  return apiRequest(BASE, { token, method: "PUT", body: payload });
}
