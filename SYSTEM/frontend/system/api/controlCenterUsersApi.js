import { apiRequest } from "./apiClient.js";

export async function fetchControlCenterUsers(token) {
  return apiRequest("/api/system/user", { token });
}

export async function createControlCenterLocalMember(token, payload) {
  return apiRequest("/api/system/user", {
    token,
    method: "POST",
    body: payload,
  });
}

export async function updateControlCenterLocalMemberAccess(token, accountId, payload) {
  return apiRequest(`/api/auth/stewardship/identification/local-members/${encodeURIComponent(accountId)}/access`, {
    token,
    method: "PATCH",
    body: payload,
  });
}

export async function updateControlCenterLocalMemberProfile(token, accountId, payload) {
  return apiRequest(`/api/system/user/${encodeURIComponent(accountId)}`, {
    token,
    method: "PATCH",
    body: payload,
  });
}

export async function deleteControlCenterLocalMember(token, accountId) {
  return apiRequest(`/api/auth/stewardship/identification/local-members/${encodeURIComponent(accountId)}`, {
    token,
    method: "DELETE",
  });
}
