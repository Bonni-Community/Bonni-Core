import { apiRequest } from "./apiClient.js";

export function fetchSystemMonitoringStatus(token) {
  return apiRequest("/api/system/monitoring", { token });
}
