import { apiRequest } from "./apiClient.js";

const CORE_DIAGNOSTICS_LOGS_PATH = "/api/system/diagnostics/logs";

export function fetchCoreDiagnosticsLogs(token, limit = 500, { signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  return apiRequest(`${CORE_DIAGNOSTICS_LOGS_PATH}?${query.toString()}`, {
    token,
    signal,
    cache: "no-store",
  });
}

export function downloadCoreDiagnosticsLog(token, stream = "log") {
  const selected = stream === "error" ? "error" : "log";
  const query = new URLSearchParams({ download: "1", stream: selected });
  return apiRequest(`${CORE_DIAGNOSTICS_LOGS_PATH}?${query.toString()}`, {
    token,
    responseType: "text",
    cache: "no-store",
  });
}

export function fetchCoreTerminalShellStatus(token, { signal } = {}) {
  return apiRequest("/api/terminals/shell/status", {
    token,
    signal,
    cache: "no-store",
  });
}
