import { apiRequest } from "./apiClient.js";

export async function fetchSystemModules(token) {
  const data = await apiRequest("/api/system/modules", { token });
  return Array.isArray(data?.modules) ? data.modules : [];
}

export async function syncSystemModules(token) {
  return apiRequest("/api/system/modules/sync", {
    token,
    method: "POST",
  });
}
