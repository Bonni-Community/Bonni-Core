import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/runtime";

export async function fetchControlCenterRuntimeStatus(token) {
  return apiRequest(`${BASE_PATH}/status`, { token });
}

export async function fetchControlCenterRuntimeModules(token) {
  return apiRequest(`${BASE_PATH}/modules`, { token });
}

export async function fetchControlCenterRuntimeModuleDetails(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}`, { token });
}

export async function fetchControlCenterRuntimeModuleInstallPlan(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/install-plan`, { token });
}

export async function installControlCenterRuntimeModule(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/install`, {
    token,
    method: "POST",
  });
}

export async function activateControlCenterRuntimeModule(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/activate`, {
    token,
    method: "POST",
  });
}

export async function deactivateControlCenterRuntimeModule(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/deactivate`, {
    token,
    method: "POST",
  });
}

export async function fetchControlCenterRuntimeModuleLifecycle(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/lifecycle`, { token });
}

export async function runControlCenterRuntimeModuleLifecycle(token, key, action, metadata = {}) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/lifecycle/${encodeURIComponent(action)}`, {
    token,
    method: "POST",
    body: metadata,
  });
}

export async function fetchControlCenterCompatibility(token) {
  return apiRequest(`${BASE_PATH}/compatibility`, { token });
}
