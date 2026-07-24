import { apiRequest } from "./apiClient.js";

export function fetchArchiveDirectory(token, path = "") {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiRequest(`/api/system/explorer${query}`, { token });
}

export function createArchiveFolder(token, { path = "", name }) {
  return apiRequest("/api/system/explorer/folders", {
    token,
    method: "POST",
    body: { path, name },
  });
}

export function fetchArchiveWorkspace(token) {
  return apiRequest("/api/system/explorer/workspace", { token });
}

export function fetchArchiveWorkspaceFolder(token, folderId) {
  return apiRequest(`/api/system/explorer/workspace/folders/${encodeURIComponent(folderId)}`, { token });
}

export function createArchiveWorkspaceFolder(token, { parentId, name }) {
  return apiRequest("/api/system/explorer/workspace/folders", {
    token,
    method: "POST",
    body: { parentId, name },
  });
}

export function fetchArchiveFolderGrants(token, folderId) {
  return apiRequest(`/api/system/explorer/workspace/folders/${encodeURIComponent(folderId)}/grants`, { token });
}

export function shareArchiveFolder(token, folderId, input) {
  return apiRequest(`/api/system/explorer/workspace/folders/${encodeURIComponent(folderId)}/grants`, {
    token,
    method: "POST",
    body: input,
  });
}

export function revokeArchiveFolderShare(token, folderId, grantId) {
  return apiRequest(
    `/api/system/explorer/workspace/folders/${encodeURIComponent(folderId)}/grants/${encodeURIComponent(grantId)}`,
    { token, method: "DELETE" },
  );
}

export function fetchArchiveAccountLinks(token) {
  return apiRequest("/api/system/explorer/workspace/account-links", { token });
}

export function requestArchiveAccountLink(token, targetLoginName) {
  return apiRequest("/api/system/explorer/workspace/account-links", {
    token,
    method: "POST",
    body: { targetLoginName },
  });
}

export function approveArchiveAccountLink(token, requestId) {
  return apiRequest(
    `/api/system/explorer/workspace/account-links/${encodeURIComponent(requestId)}/approve`,
    { token, method: "POST" },
  );
}

export function closeArchiveAccountLink(token, requestId) {
  return apiRequest(
    `/api/system/explorer/workspace/account-links/${encodeURIComponent(requestId)}`,
    { token, method: "DELETE" },
  );
}
