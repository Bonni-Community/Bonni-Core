import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/backup";

export function fetchSystemBackups(token) {
  return apiRequest(BASE_PATH, { token });
}

export function createSystemBackup(token, reason = "manual") {
  return apiRequest(BASE_PATH, { token, method: "POST", body: { reason } });
}

export function validateSystemBackup(token, id) {
  return apiRequest(`${BASE_PATH}/${encodeURIComponent(id)}/validate`, { token, method: "POST" });
}

export function requestSystemRestore(token, id, confirmation) {
  return apiRequest(`${BASE_PATH}/${encodeURIComponent(id)}/restore`, {
    token,
    method: "POST",
    body: { confirmation },
  });
}
