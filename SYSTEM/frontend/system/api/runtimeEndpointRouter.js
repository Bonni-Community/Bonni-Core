import {
  ACTIVE_API_ORIGIN_URL,
  EMERGENCY_API_ORIGIN_URL,
  getRuntimeOriginRole,
  normalizeOrigin,
} from "./apiConfig.js";

const STORAGE_KEY = "runtimeEndpoint";
const EVENT_NAME = "runtime-router-change";
const EMERGENCY_STICKY_MS = 30_000;
const MAX_HISTORY = 20;

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function isBrowserRuntime() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function parseStoredState() {
  if (!isBrowserRuntime()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  if (!isBrowserRuntime()) {
    return state;
  }

  const normalized = {
    mode: state.mode || "active",
    origin: normalizeOrigin(state.origin || ACTIVE_API_ORIGIN_URL),
    reason: state.reason || null,
    activeOrigin: normalizeOrigin(ACTIVE_API_ORIGIN_URL),
    emergencyOrigin: EMERGENCY_API_ORIGIN_URL ? normalizeOrigin(EMERGENCY_API_ORIGIN_URL) : null,
    runtimeSource: state.runtimeSource || null,
    slot: state.slot || null,
    state: state.state || null,
    updatedAt: nowIso(),
    updatedAtMs: nowMs(),
    lastError: state.lastError || null,
    history: Array.isArray(state.history) ? state.history.slice(-MAX_HISTORY) : [],
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: normalized }));

  return normalized;
}

function summarizeError(error) {
  if (!error) return null;
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    status: error?.status || null,
  };
}

function extractOrigin(url) {
  try {
    return normalizeOrigin(new URL(url).origin);
  } catch {
    return "";
  }
}


function inferProxyRuntime(response) {
  const headers = response?.headers;
  if (!headers?.get) {
    return { viaProxy: false, mode: null, backend: null, upstreamStatus: null };
  }

  const backend = headers.get("X-Runtime-Backend") || "";
  const upstreamStatus = headers.get("X-Runtime-Upstream-Status") || "";
  const viaProxy = headers.get("X-Runtime-Proxy") === "true" || Boolean(backend || upstreamStatus);
  const normalizedBackend = backend.toLowerCase();
  const normalizedStatus = upstreamStatus.toLowerCase();
  const mode =
    normalizedBackend.includes("emergency") ||
    normalizedBackend.includes("4001") ||
    normalizedStatus.includes(",")
      ? "emergency"
      : viaProxy
        ? "active"
        : null;

  return { viaProxy, mode, backend, upstreamStatus };
}

function inferRuntimeState(data) {
  const runtime = data?.runtime || data?.notlauf || data?.runtimeFallback || data?.data?.runtime || null;
  const runtimeSource =
    runtime?.runtimeSource ||
    runtime?.source ||
    data?.runtimeSource ||
    data?.data?.runtimeSource ||
    null;
  const slot = runtime?.slot || data?.slot || data?.data?.slot || null;
  const state = runtime?.state || data?.state || data?.data?.state || null;
  return { runtimeSource, slot, state };
}

function appendHistory(previous, entry) {
  return [
    ...(Array.isArray(previous?.history) ? previous.history : []),
    {
      ...entry,
      at: nowIso(),
    },
  ].slice(-MAX_HISTORY);
}

export function getRuntimeEndpointState() {
  const stored = parseStoredState();

  if (stored) {
    return stored;
  }

  return {
    mode: "active",
    origin: normalizeOrigin(ACTIVE_API_ORIGIN_URL),
    reason: null,
    activeOrigin: normalizeOrigin(ACTIVE_API_ORIGIN_URL),
    emergencyOrigin: EMERGENCY_API_ORIGIN_URL ? normalizeOrigin(EMERGENCY_API_ORIGIN_URL) : null,
    runtimeSource: null,
    slot: null,
    state: null,
    updatedAt: null,
    updatedAtMs: 0,
    lastError: null,
    history: [],
  };
}

export function subscribeRuntimeEndpoint(listener) {
  if (!isBrowserRuntime()) {
    return () => {};
  }

  function handleEvent(event) {
    listener(event.detail || getRuntimeEndpointState());
  }

  function handleStorage(event) {
    if (event.key === STORAGE_KEY) {
      listener(getRuntimeEndpointState());
    }
  }

  window.addEventListener(EVENT_NAME, handleEvent);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(EVENT_NAME, handleEvent);
    window.removeEventListener("storage", handleStorage);
  };
}

export function orderRuntimeApiUrls(urls) {
  const candidates = Array.isArray(urls) ? [...urls] : [];

  if (!EMERGENCY_API_ORIGIN_URL || candidates.length <= 1) {
    return candidates;
  }

  const state = getRuntimeEndpointState();
  const emergencyOrigin = normalizeOrigin(EMERGENCY_API_ORIGIN_URL);
  const stickyEmergency =
    state.mode === "emergency" &&
    state.updatedAtMs &&
    nowMs() - Number(state.updatedAtMs) < EMERGENCY_STICKY_MS;

  if (!stickyEmergency) {
    return candidates;
  }

  return candidates.sort((a, b) => {
    const aEmergency = extractOrigin(a) === emergencyOrigin;
    const bEmergency = extractOrigin(b) === emergencyOrigin;
    if (aEmergency === bEmergency) return 0;
    return aEmergency ? -1 : 1;
  });
}

export function markRuntimeEndpointSuccess(url, data = null, response = null) {
  const origin = extractOrigin(url);
  const role = getRuntimeOriginRole(origin);
  const previous = getRuntimeEndpointState();
  const inferred = inferRuntimeState(data);
  const proxy = inferProxyRuntime(response);
  const mode = proxy.mode || (role === "emergency" || inferred.runtimeSource === "json" ? "emergency" : "active");

  return writeState({
    ...previous,
    mode,
    origin,
    reason: mode === "emergency" ? "USING_EMERGENCY_BACKEND" : null,
    runtimeSource: inferred.runtimeSource,
    slot: inferred.slot,
    state: inferred.state,
    lastError: null,
    history: appendHistory(previous, {
      type: "success",
      mode,
      origin,
      runtimeSource: inferred.runtimeSource,
      slot: inferred.slot,
      state: inferred.state,
      proxyBackend: proxy.backend || null,
      proxyUpstreamStatus: proxy.upstreamStatus || null,
    }),
  });
}

export function markRuntimeEndpointFailure(url, error, options = {}) {
  const origin = extractOrigin(url);
  const previous = getRuntimeEndpointState();

  return writeState({
    ...previous,
    mode: previous.mode || "active",
    origin: previous.origin || origin,
    reason: options.reason || previous.reason || "BACKEND_FAILURE",
    lastError: summarizeError(error),
    history: appendHistory(previous, {
      type: "failure",
      origin,
      reason: options.reason || "BACKEND_FAILURE",
      error: summarizeError(error),
    }),
  });
}

export function markRuntimeEndpointFailover({ fromUrl, toUrl, reason = "ACTIVE_BACKEND_UNAVAILABLE", error = null } = {}) {
  const previous = getRuntimeEndpointState();
  const toOrigin = extractOrigin(toUrl) || normalizeOrigin(EMERGENCY_API_ORIGIN_URL || ACTIVE_API_ORIGIN_URL);

  return writeState({
    ...previous,
    mode: getRuntimeOriginRole(toOrigin) === "emergency" ? "emergency" : "active",
    origin: toOrigin,
    reason,
    lastError: summarizeError(error),
    history: appendHistory(previous, {
      type: "failover",
      fromOrigin: extractOrigin(fromUrl),
      toOrigin,
      reason,
      error: summarizeError(error),
    }),
  });
}

export function selectRuntimeEndpoint(mode = "active", options = {}) {
  const previous = getRuntimeEndpointState();
  const normalizedMode = mode === "redundant" ? "emergency" : mode === "emergency" ? "emergency" : "active";
  const targetOrigin = normalizeOrigin(
    options.origin ||
    (normalizedMode === "emergency" ? EMERGENCY_API_ORIGIN_URL : ACTIVE_API_ORIGIN_URL) ||
    ACTIVE_API_ORIGIN_URL
  );

  return writeState({
    ...previous,
    mode: normalizedMode,
    origin: targetOrigin,
    reason: normalizedMode === "emergency" ? "USER_SELECTED_REDUNDANT_BACKEND" : null,
    runtimeSource: "manual",
    slot: normalizedMode === "emergency" ? "redundant" : "active",
    state: "selected",
    lastError: null,
    history: appendHistory(previous, {
      type: "manual-select",
      mode: normalizedMode,
      origin: targetOrigin,
      reason: normalizedMode === "emergency" ? "USER_SELECTED_REDUNDANT_BACKEND" : "USER_SELECTED_ACTIVE_BACKEND",
    }),
  });
}

export function resetRuntimeEndpoint() {
  return writeState({
    mode: "active",
    origin: ACTIVE_API_ORIGIN_URL,
    reason: null,
    runtimeSource: null,
    slot: null,
    state: null,
    lastError: null,
    history: appendHistory(getRuntimeEndpointState(), {
      type: "reset",
      origin: ACTIVE_API_ORIGIN_URL,
    }),
  });
}
