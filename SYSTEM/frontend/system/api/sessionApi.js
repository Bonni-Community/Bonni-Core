import { apiRequest } from "./apiClient.js";

export async function logoutSession(token, { signal } = {}) {
  return apiRequest("/api/auth/logout", {
    method: "POST",
    token,
    signal,
  });
}

export async function heartbeatSession(token, { signal } = {}) {
  return apiRequest("/api/auth/heartbeat", {
    method: "POST",
    token,
    signal,
  });
}

export async function fetchShell(token, { signal } = {}) {
  return apiRequest("/api/auth/shell", {
    token,
    signal,
  });
}
