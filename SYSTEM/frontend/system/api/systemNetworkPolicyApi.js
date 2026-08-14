import { apiRequest } from "./apiClient.js";

const BASE = "/api/system/network-policies";

export function fetchSystemNetworkPolicies(token) {
  return apiRequest(BASE, { token });
}

export function updateSystemNetworkPolicy(token, moduleKey, policy) {
  return apiRequest(`${BASE}/${encodeURIComponent(moduleKey)}`, {
    token,
    method: "PUT",
    body: policy,
  });
}
