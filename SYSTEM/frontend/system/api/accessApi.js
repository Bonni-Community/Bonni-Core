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

export async function loginWithTwoFactor({ challengeId, code, recoveryCode, token, password }) {
  return apiRequest("/api/identity/auth/login/2fa", {
    method: "POST",
    body: {
      challengeId,
      code: code || undefined,
      recoveryCode: recoveryCode || undefined,
      token: token || undefined,
      password: password || undefined,
    },
  });
}

export async function fetchAccessStatus(token) {
  return apiRequest("/api/identity/auth/me", {
    token,
  });
}
