import { apiRequest } from "./apiClient.js";

export async function logoutSession(token) {
  return apiRequest("/api/auth/logout", {
    method: "POST",
    token,
  });
}

export async function heartbeatSession(token) {
  return apiRequest("/api/auth/heartbeat", {
    method: "POST",
    token,
  });
}

export async function fetchShell(token) {
  return apiRequest("/api/auth/shell", {
    token,
  });
}
