const DEFAULT_ACTIVE_API_ORIGIN = "http://localhost:4000";
const DEFAULT_EMERGENCY_API_ORIGIN = "http://127.0.0.1:4001";
const API_PREFIX = "/api";

function envValue(name, fallback = "") {
  try {
    return import.meta?.env?.[name] || fallback;
  } catch {
    return fallback;
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function stripApiSuffix(value) {
  return value.replace(/\/api$/i, "");
}

export function normalizeOrigin(value) {
  return stripApiSuffix(trimTrailingSlash(value));
}

function unique(values) {
  return [...new Set(values.map(normalizeOrigin).filter(Boolean))];
}

function isBrowserRuntime() {
  return typeof window !== "undefined" && Boolean(window.location);
}

function isViteDevelopmentRuntime() {
  return isBrowserRuntime() && ["5173", "5174"].includes(window.location.port);
}


function getStoredRuntimeOriginCandidate() {
  if (!isBrowserRuntime()) {
    return "";
  }

  try {
    const raw = window.localStorage.getItem("runtimeEndpoint");
    const state = raw ? JSON.parse(raw) : null;
    return state?.origin ? normalizeOrigin(state.origin) : "";
  } catch {
    return "";
  }
}

function getCurrentOrigin() {
  if (!isBrowserRuntime()) {
    return DEFAULT_ACTIVE_API_ORIGIN;
  }

  return normalizeOrigin(window.location.origin);
}

function getActiveOrigin() {
  const configured = envValue("VITE_BACKEND_ACTIVE_URL") || envValue("VITE_API_ORIGIN");

  if (configured) {
    return normalizeOrigin(configured);
  }

  if (isViteDevelopmentRuntime()) {
    return DEFAULT_ACTIVE_API_ORIGIN;
  }

  return getCurrentOrigin();
}

function getEmergencyOrigin() {
  const configured = envValue("VITE_BACKEND_EMERGENCY_URL") || envValue("VITE_NOTLAUF_API_ORIGIN");

  if (configured) {
    return normalizeOrigin(configured);
  }

  if (isViteDevelopmentRuntime()) {
    return DEFAULT_EMERGENCY_API_ORIGIN;
  }

  // Im installierten Betrieb läuft normalerweise der runtime-proxy auf derselben Origin.
  // Die Umschaltung active → emergency passiert dann serverseitig im Proxy.
  return "";
}

// Die konfigurierten Backend-Adressen bleiben fuer Diagnose und
// Runtime-Umschaltung sichtbar. Browser-Anfragen selbst laufen aber immer
// ueber die Origin der Oberflaeche. So uebernehmen Vite beziehungsweise der
// Runtime-Proxy das Routing, ohne dass CORS-Preflights zu 4000/4001 entstehen.
export const ACTIVE_API_ORIGIN_URL = getActiveOrigin();
export const EMERGENCY_API_ORIGIN_URL = getEmergencyOrigin();
export const API_ORIGIN_URL = isBrowserRuntime()
  ? getCurrentOrigin()
  : ACTIVE_API_ORIGIN_URL;
export const LOCAL_API_ORIGIN_URL = EMERGENCY_API_ORIGIN_URL || DEFAULT_EMERGENCY_API_ORIGIN;

// Keine Frontend-.env nötig:
// - installierter Betrieb: gleiche Origin + /api, runtime-proxy übernimmt Failover
// - VS-Code/Vite-Entwicklung: active 4000, emergency/notlauf 4001
export const API_ORIGIN_CANDIDATES = isBrowserRuntime()
  ? unique([API_ORIGIN_URL])
  : unique([
      getStoredRuntimeOriginCandidate(),
      ACTIVE_API_ORIGIN_URL,
      EMERGENCY_API_ORIGIN_URL,
    ]);

export const API_ROOT_URL = `${API_ORIGIN_URL}${API_PREFIX}`;
export const API_ROOT_CANDIDATES = API_ORIGIN_CANDIDATES.map(
  (origin) => `${origin}${API_PREFIX}`
);

// Backwards-kompatibel: bisher wurde API_BASE_URL als Backend-Origin benutzt.
export const API_BASE_URL = API_ORIGIN_URL;

export function getRuntimeOriginRole(origin) {
  const normalized = normalizeOrigin(origin);

  if (EMERGENCY_API_ORIGIN_URL && normalized === normalizeOrigin(EMERGENCY_API_ORIGIN_URL)) {
    return "emergency";
  }

  if (normalized === normalizeOrigin(ACTIVE_API_ORIGIN_URL)) {
    return "active";
  }

  return "proxy";
}

export function buildBackendUrl(path = "") {
  if (!path) return API_ORIGIN_URL;

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${API_ORIGIN_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildApiUrlForOrigin(origin, path = "") {
  if (!path) return `${origin}${API_PREFIX}`;

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (normalizedPath === API_PREFIX || normalizedPath.startsWith(`${API_PREFIX}/`)) {
    return `${origin}${normalizedPath}`;
  }

  return `${origin}${API_PREFIX}${normalizedPath}`;
}

export function buildApiUrl(path = "") {
  return buildApiUrlForOrigin(API_ORIGIN_URL, path);
}

export function buildApiUrls(path = "") {
  if (/^https?:\/\//i.test(path)) {
    return [path];
  }

  return API_ORIGIN_CANDIDATES.map((origin) => buildApiUrlForOrigin(origin, path));
}
