import { apiRequest } from "../../system/api/apiClient.js";

const SENSITIVE_OPTIONS = Object.freeze({
  allowFailover: false,
  cache: "no-store",
  sensitive: true,
  headers: {
    Accept: "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  },
});

export function fetchOwnProfile(token, { signal } = {}) {
  return apiRequest("/api/identity/auth/me", {
    token,
    signal,
    cache: "no-store",
  });
}

export function updateOwnProfile(token, profile, { signal } = {}) {
  return apiRequest("/api/identity/auth/me/profile", {
    ...SENSITIVE_OPTIONS,
    token,
    signal,
    method: "PATCH",
    body: profile,
  });
}

export function changeOwnPassword(token, passwords, { signal } = {}) {
  return apiRequest("/api/identity/auth/me/password", {
    ...SENSITIVE_OPTIONS,
    token,
    signal,
    method: "POST",
    body: passwords,
  });
}

export function fetchOwnChangeHistory(token, { signal, scope } = {}) {
  const query = scope === "security" ? "?scope=security" : "";
  return apiRequest(`/api/identity/auth/me/history${query}`, {
    token,
    signal,
    cache: "no-store",
  });
}
