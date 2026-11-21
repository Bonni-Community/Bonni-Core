import { apiRequest } from "./apiClient.js";

const CORE_DIAGNOSTICS_LOGS_PATH = "/api/system/diagnostics/logs";

export function fetchCoreLoginDiagnostics(token, { signal } = {}) {
  return apiRequest("/api/system/diagnostics/logins", { token, signal, cache: "no-store" });
}

export function fetchCoreLiveLog(token, { signal } = {}) {
  return apiRequest("/api/system/diagnostics/live", { token, signal, cache: "no-store" });
}

export function fetchCoreDiagnosticError(token, errorId, { signal } = {}) {
  return apiRequest(`/api/system/diagnostics/errors/${encodeURIComponent(errorId)}`, {
    token, signal, cache: "no-store", sensitive: true, allowFailover: false,
  });
}

export function fetchCoreDiagnosticsLogs(token, limit = 500, { signal, category = "all", moduleId } = {}) {
  const query = new URLSearchParams({ limit: String(limit), category });
  if (moduleId) query.set("moduleId", moduleId);
  return apiRequest(`${CORE_DIAGNOSTICS_LOGS_PATH}?${query.toString()}`, {
    token,
    signal,
    cache: "no-store",
  });
}

export function downloadCoreDiagnosticsLog(token, stream = "log", {category="all",operationId,moduleId} = {}) {
  const selected = ["journal","journal-error","error"].includes(stream) ? stream : "log";
  const query = new URLSearchParams({ download: "1", stream: selected, category });
  if(operationId)query.set("operationId",operationId);
  if(moduleId)query.set("moduleId",moduleId);
  return apiRequest(`${CORE_DIAGNOSTICS_LOGS_PATH}?${query.toString()}`, {
    token,
    responseType: "text",
    cache: "no-store",
  });
}

export function writeCoreDiagnosticTest(token, { signal } = {}) {
  return apiRequest("/api/system/diagnostics/test", {
    token,
    signal,
    method: "POST",
    allowFailover: false,
  });
}
