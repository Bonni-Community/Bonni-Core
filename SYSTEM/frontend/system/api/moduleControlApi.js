import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/modules/packages";

function packagePath(key, action = "") {
  const safeKey = encodeURIComponent(key);
  return action ? `${BASE_PATH}/${safeKey}/${action}` : `${BASE_PATH}/${safeKey}`;
}

export async function fetchControlCenterModules(token) {
  const data = await apiRequest(BASE_PATH, { token });
  return Array.isArray(data?.packages) ? data.packages : Array.isArray(data?.modules) ? data.modules : [];
}

export async function syncControlCenterModules(token) {
  const data = await apiRequest("/api/system/modules/sync", { token, method: "POST" });
  return { ...data, modules: Array.isArray(data?.modules) ? data.modules : [] };
}

export async function fetchModuleDependencies(_token, _key) {
  return { ok: true, missing: [] };
}

export async function fetchModuleRuntimeRoutes(_token, _key) {
  return [];
}

export async function runModuleAction(token, key, action, body = {}, { signal } = {}) {
  const data = await apiRequest(packagePath(key, action), {
    token,
    signal,
    method: "POST",
    body,
    allowFailover: false,
  });
  return data?.ok === true ? data.module || data : data;
}

export const moduleActions = {
  install: "install",
  enable: "activate",
  disable: "deactivate",
  uninstall: "uninstall",
  delete: "delete",
};
