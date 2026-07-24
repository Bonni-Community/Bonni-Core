import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/update-center";

export function fetchCoreUpdateStatus(token) {
  return apiRequest(BASE_PATH, { token });
}

export function checkCoreUpdate(token) {
  return apiRequest(`${BASE_PATH}/check`, { token, method: "POST" });
}

export function prepareCoreUpdate(token) {
  return apiRequest(`${BASE_PATH}/prepare`, { token, method: "POST" });
}

export function installCoreUpdate(token, targetVersion) {
  return apiRequest(`${BASE_PATH}/install`, {
    token,
    method: "POST",
    body: { targetVersion },
  });
}

export function saveCoreUpdateSettings(token, settings) {
  return apiRequest(`${BASE_PATH}/settings`, { token, method: "PUT", body: settings });
}
