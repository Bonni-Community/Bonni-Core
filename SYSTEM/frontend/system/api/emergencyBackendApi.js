import { apiRequest } from "./apiClient.js";

const BASE = "/system/security/emergency-backend";

export function fetchEmergencyBackendStatus(token) {
  return apiRequest(BASE, { token });
}

export function updateEmergencyBackendSettings(token, settings) {
  return apiRequest(`${BASE}/settings`, {
    token,
    method: "PATCH",
    body: settings,
  });
}

export function startEmergencyBackend(token) {
  return apiRequest(`${BASE}/start`, { token, method: "POST" });
}

export function stopEmergencyBackend(token) {
  return apiRequest(`${BASE}/stop`, { token, method: "POST" });
}

export function restartEmergencyBackend(token) {
  return apiRequest(`${BASE}/restart`, { token, method: "POST" });
}

export function scheduleEmergencyBackend(token) {
  return apiRequest(`${BASE}/schedule`, { token, method: "POST" });
}
