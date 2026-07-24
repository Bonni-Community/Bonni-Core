import { apiRequest } from "./apiClient.js";

export async function loginWithPassword({
  loginName,
  password,
}) {
  return apiRequest("/api/identity/auth/login", {
    method: "POST",
    body: {
      login: loginName,
      password,
    },
  });
}

export async function fetchAccessStatus(token) {
  return apiRequest("/api/identity/auth/me", {
    token,
  });
}
