import { apiRequest } from "./apiClient.js";

export async function fetchShell(token) {
  return apiRequest("/api/auth/shell", {
    token,
  });
}
