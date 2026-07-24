import { apiRequest } from "./apiClient.js";

export async function fetchControlCenterOverview(token) {
  return apiRequest("/api/system/overview", { token });
}
