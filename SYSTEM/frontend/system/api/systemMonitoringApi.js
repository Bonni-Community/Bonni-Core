import { apiRequest } from "./apiClient.js";

export function fetchSystemMonitoringStatus(token) {
  return apiRequest("/api/system/monitoring", { token });
}

export function fetchSystemResources(token, { signal } = {}) {
  return apiRequest("/api/system/monitoring/resources", { token, signal, cache: "no-store" });
}
