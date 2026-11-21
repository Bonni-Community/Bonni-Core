import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/backup";

export function fetchSystemBackups(token) {
  return apiRequest(BASE_PATH, { token });
}

export function createSystemBackup(token, reason = "manual", { signal, directory } = {}) {
  return apiRequest(BASE_PATH, { token, signal, method: "POST", allowFailover: false, body: { reason, directory } });
}

export function fetchBackupDirectory(token, directory, { signal, details } = {}) {
  const query = new URLSearchParams({ path: directory });
  if (details) query.set("details", "true");
  return apiRequest(`${BASE_PATH}/directory?${query}`, { token, signal, cache: "no-store", allowFailover: false });
}

export function changeBackupDirectory(token, path, { signal, remove = false, parents = false } = {}) {
  return apiRequest(`${BASE_PATH}/directory`, {
    token, signal, method: remove ? "DELETE" : "POST", allowFailover: false, body: { path, parents },
  });
}

export function fetchBackupTextFile(token, path, { signal } = {}) {
  const query = new URLSearchParams({ path });
  return apiRequest(`${BASE_PATH}/file?${query}`, {
    token, signal, cache: "no-store", allowFailover: false, sensitive: true,
  });
}

export function changeBackupTextFile(token, path, method, { signal, text, revision, recursive, force } = {}) {
  return apiRequest(`${BASE_PATH}/file`, {
    token, signal, method, allowFailover: false, sensitive: true, body: { path, text, revision, recursive, force },
  });
}

export function copyBackupEntry(token, source, target, { signal, recursive } = {}) {
  return apiRequest(`${BASE_PATH}/copy`, {
    token, signal, method: "POST", allowFailover: false, body: { source, target, recursive },
  });
}

export function validateSystemBackup(token, id) {
  return apiRequest(`${BASE_PATH}/${encodeURIComponent(id)}/validate`, { token, method: "POST" });
}

export function requestSystemRestore(token, id, confirmation) {
  return apiRequest(`${BASE_PATH}/${encodeURIComponent(id)}/restore`, {
    token,
    method: "POST",
    body: { confirmation },
  });
}
