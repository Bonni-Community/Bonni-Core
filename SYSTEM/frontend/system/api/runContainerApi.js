import { apiRequest } from "./apiClient.js";

export function getRunContainerStatus({ token } = {}) {
  return apiRequest("/api/run-container/status", { token });
}

export function getRunContainerDiagnostics({ token } = {}) {
  return apiRequest("/api/run-container/diagnostics", { token });
}

export function buildRunContainerCandidate({ token, reason = "control-center" } = {}) {
  return apiRequest("/api/run-container/candidate", {
    token,
    method: "POST",
    body: { reason },
  });
}

export function promoteRunContainerCandidate({ token } = {}) {
  return apiRequest("/api/run-container/promote", {
    token,
    method: "POST",
  });
}
