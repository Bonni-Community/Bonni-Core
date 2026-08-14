import { apiRequest } from "./apiClient.js";

export function getControlCenterSystemSettings(token) {
  return apiRequest("/api/system/system", { token });
}

export function saveControlCenterSystemSettings(token, payload) {
  return apiRequest("/api/system/system", {
    token,
    method: "PUT",
    body: payload,
  });
}

export function getCurrentTwoFactorStatus(token) {
  return apiRequest("/api/security/2fa/status", { token });
}

export function startCurrentUserTotpSetup(token, payload = {}) {
  return apiRequest("/api/security/2fa/totp/setup", {
    token,
    method: "POST",
    body: payload,
  });
}

export function confirmCurrentUserTotpSetup(token, payload) {
  return apiRequest("/api/security/2fa/totp/confirm", {
    token,
    method: "POST",
    body: payload,
  });
}

export function pingControlCenterDatabase(token, payload) {
  return apiRequest("/api/system/system/database/ping", {
    token,
    method: "POST",
    body: payload,
  });
}

export function getControlCenterDatabaseSettings(token) {
  return apiRequest("/api/system/system/database", { token });
}

export function saveControlCenterDatabaseSettings(token, payload) {
  return apiRequest("/api/system/system/database", {
    token,
    method: "PUT",
    body: payload,
  });
}

export function getControlCenterDatabaseRouting(token) {
  return apiRequest("/api/system/system/database/routing", { token });
}

export function saveControlCenterDatabaseRouting(token, mode, options = {}) {
  return apiRequest("/api/system/system/database/routing", {
    token,
    method: "PUT",
    body: { mode, ...options },
  });
}

export function replayControlCenterJsonEmergency(token, target) {
  return apiRequest("/api/system/system/database/json-emergency/replay", {
    token,
    method: "POST",
    body: { target },
  });
}

export function runControlCenterDatabaseFullSync(token, payload) {
  return apiRequest("/api/system/system/database/full-sync", {
    token,
    method: "POST",
    body: payload,
  });
}

export function getControlCenterNotlaufStatus(token) {
  return apiRequest("/api/system/system/notlauf", { token });
}

export function startControlCenterNotlauf(token) {
  return apiRequest("/api/system/system/notlauf/start", {
    token,
    method: "POST",
  });
}

export function syncControlCenterNotlaufFiles(token) {
  return apiRequest("/api/system/system/notlauf/sync", {
    token,
    method: "POST",
  });
}

export function endControlCenterNotlauf(token, { sync = true } = {}) {
  return apiRequest("/api/system/system/notlauf/end", {
    token,
    method: "POST",
    body: { sync },
  });
}
