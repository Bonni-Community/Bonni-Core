import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/runtime";

export async function fetchSystemManagerRuntimeStatus(token) {
  return apiRequest(`${BASE_PATH}/status`, { token });
}

export async function fetchSystemManagerRuntimeModules(token) {
  return apiRequest(`${BASE_PATH}/modules`, { token });
}

export async function fetchSystemManagerRuntimeModuleDetails(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}`, { token });
}

export async function fetchSystemManagerRuntimeModuleInstallPlan(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/install-plan`, { token });
}

export async function installSystemManagerRuntimeModule(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/install`, {
    token,
    method: "POST",
  });
}

export async function activateSystemManagerRuntimeModule(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/activate`, {
    token,
    method: "POST",
  });
}

export async function deactivateSystemManagerRuntimeModule(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/deactivate`, {
    token,
    method: "POST",
  });
}

export async function fetchSystemManagerRuntimeModuleLifecycle(token, key) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/lifecycle`, { token });
}

export async function runSystemManagerRuntimeModuleLifecycle(token, key, action, metadata = {}) {
  return apiRequest(`${BASE_PATH}/modules/${encodeURIComponent(key)}/lifecycle/${encodeURIComponent(action)}`, {
    token,
    method: "POST",
    body: metadata,
  });
}

export async function fetchSystemManagerCompatibility(token) {
  return apiRequest(`${BASE_PATH}/compatibility`, { token });
}
