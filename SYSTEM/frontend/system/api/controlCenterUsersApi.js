import { apiRequest } from "./apiClient.js";

export async function fetchControlCenterUsers(token, { signal } = {}) {
  return apiRequest("/api/system/user", { token, signal });
}

export async function createControlCenterLocalMember(token, payload, { signal } = {}) {
  return apiRequest("/api/system/user", {
    token,
    signal,
    sensitive: true,
    allowFailover: false,
    method: "POST",
    body: payload,
  });
}

export async function updateControlCenterLocalMemberAccess(token, accountId, payload) {
  return apiRequest(`/api/system/user/${encodeURIComponent(accountId)}/access`, {
    token,
    method: "PATCH",
    body: payload,
  });
}

export async function updateControlCenterLocalMemberProfile(token, accountId, payload, { signal } = {}) {
  return apiRequest(`/api/system/user/${encodeURIComponent(accountId)}`, {
    token,
    signal,
    allowFailover: false,
    method: "PATCH",
    body: payload,
  });
}

export async function deleteControlCenterLocalMember(token, accountId) {
  return apiRequest(`/api/system/user/${encodeURIComponent(accountId)}`, {
    token,
    method: "DELETE",
  });
}
