import { apiRequest } from "./apiClient.js";
import { buildExistingProof } from "../../core/modules/security/two-factor/model/twoFactorPayload.js";
const securityRequest = (path, options) => apiRequest(path, { ...options,
  headers: { Accept: "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...(options.headers || {}) },
  allowFailover: false, cache: "no-store", sensitive: true,
});
const BASE = "/api/system/integrations/matrix";
export const getMatrixManager = (token) => apiRequest(BASE, { token });
export const getMatrixStatus = (token) => apiRequest(`${BASE}/status`, { token });
export const matrixCommand = (token, action, payload = {}, challengeId) => securityRequest(`${BASE}/command`, {
  token, method: "POST", body: { action, payload, ...(challengeId ? { challengeId } : {}) },
});
export const saveMatrixManager = (token, settings, challengeId) => securityRequest(BASE, { token, method: "PUT", body: { ...settings, challengeId } });
export const createMatrixChallenge = (token) => securityRequest("/api/security/2fa/challenge", { token, method: "POST", body: { purpose: "ADMIN_ELEVATION" } });
export const verifyMatrixChallenge = (token, id, proof) => securityRequest(`/api/security/2fa/challenge/${encodeURIComponent(id)}/verify`, {
  token, method: "POST", body: buildExistingProof(proof),
});
