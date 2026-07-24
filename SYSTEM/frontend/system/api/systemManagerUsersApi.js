import { apiRequest } from "./apiClient.js";

export async function fetchSystemManagerUsers(token) {
  return apiRequest("/api/system/user", { token });
}

export async function createSystemManagerLocalMember(token, payload) {
  return apiRequest("/api/auth/stewardship/identification/local-members", {
    token,
    method: "POST",
    body: payload,
  });
}

export async function updateSystemManagerLocalMemberAccess(token, accountId, payload) {
  return apiRequest(`/api/auth/stewardship/identification/local-members/${encodeURIComponent(accountId)}/access`, {
    token,
    method: "PATCH",
    body: payload,
  });
}

export async function updateSystemManagerLocalMemberProfile(token, accountId, payload) {
  return apiRequest(`/api/auth/stewardship/identification/local-members/${encodeURIComponent(accountId)}/profile`, {
    token,
    method: "PATCH",
    body: payload,
  });
}

export async function deleteSystemManagerLocalMember(token, accountId) {
  return apiRequest(`/api/auth/stewardship/identification/local-members/${encodeURIComponent(accountId)}`, {
    token,
    method: "DELETE",
  });
}
