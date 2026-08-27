import { INSTALLATION_MONITOR_ACCESS_STORAGE_KEY } from "../../../system/auth/clientAuthStorage.js";

export { INSTALLATION_MONITOR_ACCESS_STORAGE_KEY };

const ACCESS_SCHEMA = "bonni.local-source-update-monitor-access/v1";
const STATUS_SCHEMA = "bonni.local-source-update-monitor/v1";
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_ACCESS_AGE_MS = 60 * 60 * 1000;

function exactLoopbackOrigin(value) {
  try {
    const target = new URL(String(value || ""));
    if (
      target.protocol !== "http:"
      || target.hostname !== "127.0.0.1"
      || !/^[0-9]{1,5}$/u.test(target.port)
      || Number(target.port) < 1
      || Number(target.port) > 65_535
      || target.pathname !== "/"
      || target.search
      || target.hash
      || target.username
      || target.password
    ) return null;
    return target.origin;
  } catch {
    return null;
  }
}

export function normalizeInstallationMonitorAccess(
  value,
  now = Date.now(),
  maximumAgeMs = MAXIMUM_ACCESS_AGE_MS,
) {
  if (!value || typeof value !== "object" || value.schemaVersion !== ACCESS_SCHEMA) return null;
  const origin = exactLoopbackOrigin(value.origin);
  const issuedAtMs = Date.parse(String(value.issuedAt || ""));
  const ageMs = Number(now) - issuedAtMs;
  if (
    !origin
    || !REQUEST_ID.test(String(value.requestId || ""))
    || !UPDATE_ID.test(String(value.updateId || ""))
    || !SHA256.test(String(value.manifestSha256 || ""))
    || !SHA256.test(String(value.token || ""))
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(Number(now))
    || ageMs < -60_000
    || ageMs > maximumAgeMs
  ) return null;
  return Object.freeze({
    schemaVersion: ACCESS_SCHEMA,
    origin,
    requestId: value.requestId,
    updateId: value.updateId,
    manifestSha256: value.manifestSha256,
    token: value.token,
    issuedAt: new Date(issuedAtMs).toISOString(),
  });
}

export async function fetchInstallationUpdateStatus(access, {
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now(),
} = {}) {
  const normalized = normalizeInstallationMonitorAccess(access, now);
  if (!normalized) throw new Error("INSTALLATION_MONITOR_ACCESS_INVALID");
  if (typeof fetchImpl !== "function") throw new Error("INSTALLATION_MONITOR_FETCH_UNAVAILABLE");
  const target = new URL("/api/local-update/status", normalized.origin);
  target.searchParams.set("requestId", normalized.requestId);
  const response = await fetchImpl(target.href, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Bonni-Update-Monitor": normalized.token,
    },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (
    !response.ok
    || payload?.ok !== true
    || payload?.schemaVersion !== STATUS_SCHEMA
    || payload?.role !== "installation-server"
  ) {
    throw new Error(payload?.error || `INSTALLATION_MONITOR_HTTP_${response.status}`);
  }
  if (
    payload?.progress?.requestId !== normalized.requestId
    || payload?.progress?.updateId !== normalized.updateId
    || payload?.progress?.manifestSha256 !== normalized.manifestSha256
  ) throw new Error("INSTALLATION_MONITOR_STATUS_MISMATCH");
  return payload;
}

export function installationMonitorRequestsCoreSwitch(monitorStatus) {
  if (monitorStatus?.switchTarget === "core") return true;
  if (monitorStatus?.switchTarget === "installation") return false;
  return Boolean(
    monitorStatus?.terminal === true
    && monitorStatus?.core?.available === true
    && String(monitorStatus?.progress?.status || "").toLowerCase() === "completed",
  );
}

export function mergeInstallationMonitorStatus(currentStatus, monitorStatus) {
  const progress = monitorStatus?.progress || {};
  const currentLocal = currentStatus?.localSourceUpdate || {};
  const progressStatus = String(progress.status || "running").toLowerCase();
  const state = progressStatus === "completed"
    ? "completed"
    : progressStatus === "failed"
      ? "failed"
      : "in-progress";
  return {
    ...(currentStatus || {}),
    ok: true,
    checkedAt: monitorStatus?.checkedAt || progress.updatedAt || new Date().toISOString(),
    updateKind: "local-source",
    updateAvailable: false,
    installationStatusSource: "installation",
    localSourceUpdate: {
      ...currentLocal,
      enabled: true,
      state,
      updateAvailable: false,
      updateId: progress.updateId || currentLocal.updateId || null,
      manifestSha256: progress.manifestSha256 || currentLocal.manifestSha256 || null,
      message: progress.message || currentLocal.message || "Der Installationsserver führt die Aktualisierung aus.",
      errorCode: progress.errorCode || null,
      progress,
    },
  };
}
