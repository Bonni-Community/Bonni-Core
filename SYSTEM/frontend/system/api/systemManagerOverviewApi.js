import { apiRequest } from "./apiClient.js";

export async function fetchSystemManagerOverview(token) {
  return apiRequest("/api/system/overview", { token });
}
