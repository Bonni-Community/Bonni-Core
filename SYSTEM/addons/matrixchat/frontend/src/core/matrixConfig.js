import { normalizeHomeserver } from "./matrixSession.js";

export const DEFAULT_MATRIX_CONFIG = Object.freeze({
  defaultHomeserver: "",
  allowHomeserverEdit: true,
  allowedHomeservers: [],
});

function normalizeOptionalHomeserver(value) {
  if (!String(value || "").trim()) return "";

  try {
    return normalizeHomeserver(value);
  } catch {
    return "";
  }
}

export function normalizeMatrixConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const allowedHomeservers = Array.isArray(raw.allowedHomeservers)
    ? [...new Set(raw.allowedHomeservers.map(normalizeOptionalHomeserver).filter(Boolean))]
    : [];

  return {
    defaultHomeserver: normalizeOptionalHomeserver(raw.defaultHomeserver),
    allowHomeserverEdit: raw.allowHomeserverEdit !== false,
    allowedHomeservers,
  };
}

export function isHomeserverAllowed(homeserver, config) {
  const normalized = normalizeHomeserver(homeserver);
  const allowlist = config?.allowedHomeservers || [];
  return !allowlist.length || allowlist.includes(normalized);
}

export async function loadMatrixConfig() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}matrix-config.json`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { ...DEFAULT_MATRIX_CONFIG };
    return normalizeMatrixConfig(await response.json());
  } catch {
    return { ...DEFAULT_MATRIX_CONFIG };
  }
}
