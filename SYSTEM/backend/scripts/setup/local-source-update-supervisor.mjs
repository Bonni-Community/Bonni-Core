import { fork, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertContainerRuntimeActivationInactive } from "../runtime/runtime-mode-exclusion.mjs";

export const LOCAL_UPDATE_REQUEST_SCHEMA = "bonni.local-source-update-request/v2";
export const LOCAL_UPDATE_HEARTBEAT_SCHEMA = "bonni.local-source-update-heartbeat/v1";
export const LOCAL_UPDATE_STATUS_SCHEMA = "bonni.local-source-update-status/v1";
export const LOCAL_UPDATE_MONITOR_SCHEMA = "bonni.local-source-update-monitor/v1";
export const LOCAL_UPDATE_SUPERVISOR_VERSION = "1.1.1";

const SOURCE_UPDATE_SCHEMA = "bonni.local-source-update/v1";
const REQUEST_FILE = "request.json";
const PROCESSING_FILE = "request.processing.json";
const HEARTBEAT_FILE = "heartbeat.json";
const STATUS_FILE = "status.json";
const MONITOR_ACCESS_FILE = "monitor-access.json";
const CORE_CHILD_RECEIPT_FILE = "core-child.json";
const SUPERVISOR_LOCK_FILE = "supervisor.lock.json";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_MONITOR_ACCESS_BYTES = 8 * 1024;
const MAX_CORE_CHILD_RECEIPT_BYTES = 8 * 1024;
const MAX_SUPERVISOR_LOCK_BYTES = 8 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_MONITOR_BIND = "127.0.0.1";
const DEFAULT_MONITOR_PORT = 4_198;
const MONITOR_SESSION_LIFETIME_MS = 60 * 60 * 1000;
const BACKEND_GRACEFUL_TIMEOUT_MS = 20_000;
const BACKEND_TERMINATE_TIMEOUT_MS = 10_000;
const BACKEND_READY_TIMEOUT_MS = 120_000;
const BACKEND_HEALTH_TIMEOUT_MS = 5_000;
const BACKEND_HEALTH_ATTEMPTS = 3;
const BACKEND_HEALTH_INTERVAL_MS = 500;
const PREVIOUS_CORE_EXIT_TIMEOUT_MS = 30_000;
const PREVIOUS_CORE_EXIT_INTERVAL_MS = 100;
const EXISTING_CORE_PROBE_TIMEOUT_MS = 750;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MONITOR_TOKEN = /^[a-f0-9]{64}$/u;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBackendRoot = path.resolve(scriptDirectory, "../..");
const defaultProductRoot = path.resolve(defaultBackendRoot, "../..");

class SupervisorError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "SupervisorError";
    this.code = code;
  }
}

function fail(code, detail = "") {
  throw new SupervisorError(code, detail);
}

function lifecycleAggregate(code, ...errors) {
  const aggregate = new AggregateError(errors.filter(Boolean), code);
  aggregate.code = code;
  return aggregate;
}

export function assertLocalSourceSupervisorEnabled(environment = process.env) {
  if (String(environment.NODE_ENV || "").trim().toLowerCase() === "production") {
    fail("SUPERVISOR_DISABLED_IN_PRODUCTION");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail("SUPERVISOR_INVALID_OBJECT", label);
  const actualKeys = Object.keys(value);
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) fail("SUPERVISOR_UNKNOWN_FIELD", `${label}.${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) fail("SUPERVISOR_MISSING_FIELD", `${label}.${key}`);
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || value.length > 64) {
    fail("SUPERVISOR_INVALID_TIMESTAMP", label);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("SUPERVISOR_INVALID_TIMESTAMP", label);
  }
  return timestamp;
}

function validateMonitorAccess(value, { now = Date.now() } = {}) {
  assertExactKeys(value, new Set([
    "requestId",
    "updateId",
    "manifestSha256",
    "monitorTokenSha256",
    "expiresAt",
  ]), "monitorAccess");
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) {
    fail("SUPERVISOR_MONITOR_ACCESS_REQUEST_ID_INVALID");
  }
  if (typeof value.updateId !== "string" || !UPDATE_ID.test(value.updateId)) {
    fail("SUPERVISOR_MONITOR_ACCESS_UPDATE_ID_INVALID");
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) {
    fail("SUPERVISOR_MONITOR_ACCESS_MANIFEST_HASH_INVALID");
  }
  if (typeof value.monitorTokenSha256 !== "string" || !SHA256.test(value.monitorTokenSha256)) {
    fail("SUPERVISOR_MONITOR_ACCESS_TOKEN_HASH_INVALID");
  }
  const expiresAtMs = parseTimestamp(value.expiresAt, "monitorAccess.expiresAt");
  if (expiresAtMs > now + MONITOR_SESSION_LIFETIME_MS + MAX_CLOCK_SKEW_MS) {
    fail("SUPERVISOR_MONITOR_ACCESS_LIFETIME_INVALID");
  }
  return Object.freeze({
    requestId: value.requestId,
    updateId: value.updateId,
    manifestSha256: value.manifestSha256,
    monitorTokenSha256: value.monitorTokenSha256,
    expiresAt: value.expiresAt,
    expiresAtMs,
  });
}

/**
 * Validate the complete, intentionally small command surface shared with the
 * authenticated Control Center API. It contains no executable or filesystem
 * path supplied by the browser backend.
 */
export function validateInstallRequest(value, {
  instanceId,
  now = Date.now(),
} = {}) {
  assertExactKeys(value, new Set([
    "schemaVersion",
    "requestId",
    "action",
    "updateId",
    "manifestSha256",
    "monitorTokenSha256",
    "supervisorInstanceId",
    "issuedAt",
    "expiresAt",
  ]), "request");

  if (value.schemaVersion !== LOCAL_UPDATE_REQUEST_SCHEMA) {
    fail("SUPERVISOR_REQUEST_SCHEMA_UNSUPPORTED");
  }
  if (value.action !== "install") fail("SUPERVISOR_REQUEST_ACTION_UNSUPPORTED");
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) {
    fail("SUPERVISOR_REQUEST_ID_INVALID");
  }
  if (typeof value.updateId !== "string" || !UPDATE_ID.test(value.updateId)) {
    fail("SUPERVISOR_UPDATE_ID_INVALID");
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) {
    fail("SUPERVISOR_MANIFEST_HASH_INVALID");
  }
  if (typeof value.monitorTokenSha256 !== "string" || !SHA256.test(value.monitorTokenSha256)) {
    fail("SUPERVISOR_MONITOR_TOKEN_HASH_INVALID");
  }
  if (
    typeof value.supervisorInstanceId !== "string"
    || value.supervisorInstanceId !== instanceId
  ) {
    fail("SUPERVISOR_INSTANCE_MISMATCH");
  }

  const issuedAt = parseTimestamp(value.issuedAt, "request.issuedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "request.expiresAt");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) fail("SUPERVISOR_REQUEST_NOT_YET_VALID");
  if (expiresAt <= now) fail("SUPERVISOR_REQUEST_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_REQUEST_LIFETIME_MS) {
    fail("SUPERVISOR_REQUEST_LIFETIME_INVALID");
  }

  return Object.freeze({ ...value });
}

function errorCode(error) {
  if (error instanceof SupervisorError) return error.code;
  const message = String(error?.message || error || "");
  const candidate = message.split(":", 1)[0];
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(candidate)
    ? candidate
    : "SUPERVISOR_OPERATION_FAILED";
}

function safeErrorMessage(error) {
  const message = String(error?.message || error || "Unbekannter Fehler");
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 500);
}

function monitorPort(value) {
  const candidate = value === undefined || value === null || String(value).trim() === ""
    ? DEFAULT_MONITOR_PORT
    : value;
  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    fail("SUPERVISOR_MONITOR_PORT_INVALID");
  }
  return parsed;
}

function isLoopbackOrigin(value) {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return ["http:", "https:"].includes(origin.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      && origin.username === ""
      && origin.password === "";
  } catch {
    return false;
  }
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function equalSha256(left, right) {
  if (!SHA256.test(String(left || "")) || !SHA256.test(String(right || ""))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function writeMonitorJson(response, statusCode, payload, origin = "") {
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.end(`${JSON.stringify(payload)}\n`);
}

async function ensureDirectory(target) {
  await fs.mkdir(target, { recursive: true });
  const state = await fs.lstat(target);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("SUPERVISOR_STATE_DIRECTORY_UNSAFE", target);
  }
}

async function writeJsonAtomic(target, value) {
  await ensureDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.bonni-supervisor-${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJsonExclusive(target, value) {
  await ensureDirectory(path.dirname(target));
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSmallJson(target, maximumBytes, invalidCode) {
  const state = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return null;
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || state.nlink > 1
    || state.size <= 0
    || state.size > maximumBytes
  ) {
    fail(invalidCode);
  }
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    fail(invalidCode);
  }
}

async function sha256File(target) {
  return createHash("sha256").update(await fs.readFile(target)).digest("hex");
}

/** Verify that the signed-in API requested exactly the package it displayed. */
export async function verifyRequestedManifest({ productRoot, request }) {
  const manifestPath = path.join(
    path.resolve(productRoot),
    "UPDATE",
    "inbox",
    request.updateId,
    "bonni-source-update.json",
  );
  const manifest = await readSmallJson(
    manifestPath,
    MAX_MANIFEST_BYTES,
    "SUPERVISOR_MANIFEST_INVALID",
  );
  if (!manifest) fail("SUPERVISOR_MANIFEST_NOT_FOUND", request.updateId);
  if (
    manifest.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || manifest.updateId !== request.updateId
  ) {
    fail("SUPERVISOR_MANIFEST_ID_MISMATCH");
  }
  if (await sha256File(manifestPath) !== request.manifestSha256) {
    fail("SUPERVISOR_MANIFEST_CHANGED");
  }
  return { manifest, manifestPath };
}

function makeSteps(activeKey = null, failedKey = null, at = new Date().toISOString()) {
  const definitions = [
    ["validate", "Auftrag und Updatepaket prüfen"],
    ["handoff", "Installationsserver übernimmt"],
    ["stop", "Bonni Core sicher anhalten"],
    ["install", "Programmdaten aktualisieren"],
    ["restart", "Bonni Core neu starten"],
    ["health", "Bonni Core prüfen"],
    ["return", "Zu Bonni Core zurückkehren"],
  ];
  const activeIndex = definitions.findIndex(([key]) => key === activeKey);
  return definitions.map(([key, label], index) => {
    let status = "pending";
    if (activeKey === "idle") status = "pending";
    else if (failedKey === key) status = "failed";
    else if (activeKey === key) status = "active";
    else if (activeIndex >= 0 && index < activeIndex) status = "completed";
    else if (activeKey === null && failedKey === null) status = "completed";
    return { key, label, status, updatedAt: at };
  });
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

function waitForBackendReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null, value = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type === "BONNI_BACKEND_READY") finish(null, message);
    };
    const onExit = (code, signal) => finish(new SupervisorError(
      "SUPERVISOR_BACKEND_EXITED_BEFORE_READY",
      signal ? `signal-${signal}` : `exit-${code ?? "unknown"}`,
    ));
    const timer = setTimeout(() => finish(new SupervisorError(
      "SUPERVISOR_BACKEND_READY_TIMEOUT",
    )), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

export async function probeLocalUpdateReadiness({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = BACKEND_HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") fail("SUPERVISOR_HEALTH_FETCH_UNAVAILABLE");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    fail("SUPERVISOR_BACKEND_HEALTH_UNREACHABLE", safeErrorMessage(error));
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("SUPERVISOR_BACKEND_HEALTH_INVALID");
  }
  if (
    !response.ok
    || payload?.ok !== true
    || payload?.state !== "ready"
    || payload?.database?.ready !== true
    || payload?.modules?.counts?.error !== 0
  ) {
    fail("SUPERVISOR_BACKEND_HEALTH_NOT_READY");
  }
  return payload;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runProcess(executable, args, options) {
  const child = spawn(executable, args, options);
  const operation = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new SupervisorError(
        "SUPERVISOR_UPDATE_PROCESS_FAILED",
        signal ? `signal-${signal}` : `exit-${code ?? "unknown"}`,
      ));
    });
  });
  Object.defineProperty(operation, "child", {
    configurable: false,
    enumerable: false,
    value: child,
    writable: false,
  });
  return operation;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function validateCoreChildReceipt(value) {
  assertExactKeys(value, new Set([
    "pid",
    "supervisorInstanceId",
    "startedAt",
  ]), "coreChildReceipt");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    fail("SUPERVISOR_CORE_CHILD_RECEIPT_PID_INVALID");
  }
  if (
    typeof value.supervisorInstanceId !== "string"
    || value.supervisorInstanceId.length < 1
    || value.supervisorInstanceId.length > 256
  ) {
    fail("SUPERVISOR_CORE_CHILD_RECEIPT_INSTANCE_INVALID");
  }
  parseTimestamp(value.startedAt, "coreChildReceipt.startedAt");
  return Object.freeze({
    pid: value.pid,
    supervisorInstanceId: value.supervisorInstanceId,
    startedAt: value.startedAt,
  });
}

function sameCoreChildReceipt(left, right) {
  return Boolean(left && right)
    && left.pid === right.pid
    && left.supervisorInstanceId === right.supervisorInstanceId
    && left.startedAt === right.startedAt;
}

function validateSupervisorLock(value) {
  assertExactKeys(value, new Set([
    "pid",
    "instanceId",
    "startedAt",
  ]), "supervisorLock");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    fail("SUPERVISOR_LOCK_PID_INVALID");
  }
  if (
    typeof value.instanceId !== "string"
    || value.instanceId.length < 1
    || value.instanceId.length > 256
  ) {
    fail("SUPERVISOR_LOCK_INSTANCE_INVALID");
  }
  parseTimestamp(value.startedAt, "supervisorLock.startedAt");
  return Object.freeze({
    pid: value.pid,
    instanceId: value.instanceId,
    startedAt: value.startedAt,
  });
}

function sameSupervisorLock(left, right) {
  return Boolean(left && right)
    && left.pid === right.pid
    && left.instanceId === right.instanceId
    && left.startedAt === right.startedAt;
}

async function probeExistingCoreEndpoint({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = EXISTING_CORE_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") return false;
  try {
    await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export class LocalSourceUpdateSupervisor {
  constructor({
    backendRoot = defaultBackendRoot,
    productRoot = defaultProductRoot,
    serverScript = path.join(backendRoot, "dist", "system", "server", "run-server.js"),
    updateScript = path.join(backendRoot, "scripts", "setup", "update-system.mjs"),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    backendReadyTimeoutMs = BACKEND_READY_TIMEOUT_MS,
    backendGracefulTimeoutMs = BACKEND_GRACEFUL_TIMEOUT_MS,
    backendTerminateTimeoutMs = BACKEND_TERMINATE_TIMEOUT_MS,
    instanceId = randomUUID(),
    now = () => Date.now(),
    forkBackend = fork,
    runUpdate = runProcess,
    probeBackend = probeLocalUpdateReadiness,
    backendHealthUrl = null,
    backendHealthAttempts = BACKEND_HEALTH_ATTEMPTS,
    backendHealthIntervalMs = BACKEND_HEALTH_INTERVAL_MS,
    previousCoreExitTimeoutMs = PREVIOUS_CORE_EXIT_TIMEOUT_MS,
    previousCoreExitIntervalMs = PREVIOUS_CORE_EXIT_INTERVAL_MS,
    isPidAlive = isProcessAlive,
    probeExistingCore = probeExistingCoreEndpoint,
    installationMonitorBind = process.env.BONNI_INSTALLATION_MONITOR_BIND || DEFAULT_MONITOR_BIND,
    installationMonitorPort = process.env.BONNI_INSTALLATION_MONITOR_PORT,
  } = {}) {
    this.backendRoot = path.resolve(backendRoot);
    this.productRoot = path.resolve(productRoot);
    this.serverScript = path.resolve(serverScript);
    this.updateScript = path.resolve(updateScript);
    this.controlRoot = path.join(
      this.productRoot,
      "SYSTEM",
      ".bonni-source-update",
      "control-center",
    );
    this.pendingPath = path.join(
      this.productRoot,
      "SYSTEM",
      ".bonni-source-update",
      "pending-update.json",
    );
    this.requestPath = path.join(this.controlRoot, REQUEST_FILE);
    this.processingPath = path.join(this.controlRoot, PROCESSING_FILE);
    this.heartbeatPath = path.join(this.controlRoot, HEARTBEAT_FILE);
    this.statusPath = path.join(this.controlRoot, STATUS_FILE);
    this.monitorAccessPath = path.join(this.controlRoot, MONITOR_ACCESS_FILE);
    this.coreChildReceiptPath = path.join(this.controlRoot, CORE_CHILD_RECEIPT_FILE);
    this.supervisorLockPath = path.join(this.controlRoot, SUPERVISOR_LOCK_FILE);
    this.setupProgressPath = path.join(this.controlRoot, "setup-progress.json");
    this.pollIntervalMs = pollIntervalMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.backendReadyTimeoutMs = backendReadyTimeoutMs;
    this.backendGracefulTimeoutMs = backendGracefulTimeoutMs;
    this.backendTerminateTimeoutMs = backendTerminateTimeoutMs;
    this.instanceId = instanceId;
    this.now = now;
    this.forkBackend = forkBackend;
    this.runUpdate = runUpdate;
    this.probeBackend = probeBackend;
    this.backendHealthUrlExplicit = typeof backendHealthUrl === "string" && backendHealthUrl.length > 0;
    this.backendHealthUrl = this.backendHealthUrlExplicit
      ? backendHealthUrl
      : `http://127.0.0.1:${Number(process.env.PORT || 4000)}/api/health/local-update-ready`;
    this.backendHealthAttempts = backendHealthAttempts;
    this.backendHealthIntervalMs = backendHealthIntervalMs;
    this.previousCoreExitTimeoutMs = Math.max(0, Number(previousCoreExitTimeoutMs) || 0);
    this.previousCoreExitIntervalMs = Math.max(1, Number(previousCoreExitIntervalMs) || 1);
    this.isPidAlive = isPidAlive;
    this.probeExistingCore = probeExistingCore;
    this.installationMonitorBind = String(installationMonitorBind || DEFAULT_MONITOR_BIND).trim();
    if (this.installationMonitorBind !== DEFAULT_MONITOR_BIND) {
      fail("SUPERVISOR_MONITOR_BIND_MUST_BE_LOOPBACK");
    }
    this.installationMonitorPort = monitorPort(installationMonitorPort);
    this.installationMonitorOrigin = null;
    this.installationMonitorLastOrigin = null;
    this.installationMonitorServer = null;
    this.monitorSessions = new Map();
    this.startedAt = new Date(this.now()).toISOString();
    this.backendChild = null;
    this.backendLifecycle = "starting";
    this.backendShutdownFailure = null;
    this.backendStartPromise = null;
    this.backendStopPromise = null;
    this.backendReceiptWritePromise = null;
    this.backendReceiptCleanupPromise = null;
    this.activeUpdatePromise = null;
    this.activeUpdaterChild = null;
    this.activeWorkflowPromise = null;
    this.pollPromise = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.supervisorLockReceipt = null;
    this.busy = false;
    this.stopping = false;
    this.expectedBackendStop = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.restartTimer = null;
    this.heartbeatState = "starting";
    this.heartbeatMessage = "Lokaler Update-Supervisor startet.";
  }

  async writeHeartbeat({
    available = !this.stopping,
    state = this.heartbeatState,
    message = this.heartbeatMessage,
  } = {}) {
    this.heartbeatState = state;
    this.heartbeatMessage = message;
    const monitorOrigin = this.installationMonitorOrigin || this.installationMonitorLastOrigin;
    await writeJsonAtomic(this.heartbeatPath, {
      schemaVersion: LOCAL_UPDATE_HEARTBEAT_SCHEMA,
      version: LOCAL_UPDATE_SUPERVISOR_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      available,
      state,
      updatedAt: new Date(this.now()).toISOString(),
      ...(message ? { message } : {}),
      monitor: {
        schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
        available: Boolean(this.installationMonitorServer?.listening && this.installationMonitorOrigin),
        origin: monitorOrigin,
        bind: this.installationMonitorBind,
        port: monitorOrigin
          ? Number(new URL(monitorOrigin).port)
          : null,
      },
    });
  }

  cleanupMonitorSessions() {
    const now = this.now();
    for (const [requestId, session] of this.monitorSessions) {
      if (session.expiresAtMs <= now) this.monitorSessions.delete(requestId);
    }
  }

  monitorSessionMatches(session, request) {
    return session?.requestId === request?.requestId
      && session?.updateId === request?.updateId
      && session?.manifestSha256 === request?.manifestSha256
      && session?.monitorTokenSha256 === request?.monitorTokenSha256;
  }

  registerMonitorSession(request, {
    expiresAtMs = this.now() + MONITOR_SESSION_LIFETIME_MS,
  } = {}) {
    this.cleanupMonitorSessions();
    const session = {
      requestId: request.requestId,
      updateId: request.updateId,
      manifestSha256: request.manifestSha256,
      monitorTokenSha256: request.monitorTokenSha256,
      expiresAtMs,
    };
    this.monitorSessions.set(request.requestId, session);
    return session;
  }

  async readPersistedMonitorSession() {
    const raw = await readSmallJson(
      this.monitorAccessPath,
      MAX_MONITOR_ACCESS_BYTES,
      "SUPERVISOR_MONITOR_ACCESS_INVALID",
    );
    if (!raw) return null;
    const access = validateMonitorAccess(raw, { now: this.now() });
    if (access.expiresAtMs <= this.now()) {
      await fs.rm(this.monitorAccessPath, { force: true }).catch(() => {});
      return null;
    }
    return access;
  }

  async persistMonitorSession(session) {
    await writeJsonAtomic(this.monitorAccessPath, {
      requestId: session.requestId,
      updateId: session.updateId,
      manifestSha256: session.manifestSha256,
      monitorTokenSha256: session.monitorTokenSha256,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    });
  }

  async hydrateMonitorSession() {
    const persisted = await this.readPersistedMonitorSession();
    if (!persisted) return null;
    return this.registerMonitorSession(persisted, {
      expiresAtMs: persisted.expiresAtMs,
    });
  }

  async rememberMonitorSession(request) {
    this.cleanupMonitorSessions();
    const cached = this.monitorSessions.get(request.requestId);
    if (cached) {
      if (!this.monitorSessionMatches(cached, request)) {
        fail("SUPERVISOR_MONITOR_ACCESS_BINDING_MISMATCH");
      }
      return cached;
    }

    const persisted = await this.readPersistedMonitorSession();
    if (persisted) {
      if (!this.monitorSessionMatches(persisted, request)) {
        fail("SUPERVISOR_MONITOR_ACCESS_BINDING_MISMATCH");
      }
      return this.registerMonitorSession(persisted, {
        expiresAtMs: persisted.expiresAtMs,
      });
    }

    const session = this.registerMonitorSession(request);
    await this.persistMonitorSession(session);
    return session;
  }

  async monitorSession(requestId) {
    this.cleanupMonitorSessions();
    const existing = this.monitorSessions.get(requestId);
    if (existing) return existing;

    const persisted = await this.readPersistedMonitorSession();
    if (persisted?.requestId === requestId) {
      return this.registerMonitorSession(persisted, {
        expiresAtMs: persisted.expiresAtMs,
      });
    }

    for (const requestPath of [this.requestPath, this.processingPath]) {
      const raw = await readSmallJson(
        requestPath,
        MAX_REQUEST_BYTES,
        "SUPERVISOR_REQUEST_INVALID",
      ).catch(() => null);
      if (!raw || raw.requestId !== requestId) continue;
      const request = validateInstallRequest(raw, {
        instanceId: this.instanceId,
        now: this.now(),
      });
      return this.rememberMonitorSession(request);
    }
    return null;
  }

  async readMonitorProgress(session) {
    const progress = await readSmallJson(
      this.statusPath,
      MAX_MANIFEST_BYTES,
      "SUPERVISOR_STATUS_INVALID",
    ).catch(() => null);
    if (
      !progress
      || progress.requestId !== session.requestId
      || progress.updateId !== session.updateId
      || progress.manifestSha256 !== session.manifestSha256
    ) {
      const updatedAt = new Date(this.now()).toISOString();
      return {
        schemaVersion: LOCAL_UPDATE_STATUS_SCHEMA,
        requestId: session.requestId,
        updateId: session.updateId,
        manifestSha256: session.manifestSha256,
        status: "queued",
        phase: "handoff",
        message: "Der Installationsserver übernimmt die Aktualisierung.",
        updatedAt,
        steps: makeSteps("handoff", null, updatedAt),
      };
    }

    if (progress.phase !== "install") return progress;
    const setup = await readSmallJson(
      this.setupProgressPath,
      MAX_REQUEST_BYTES,
      "SUPERVISOR_SETUP_PROGRESS_INVALID",
    ).catch(() => null);
    if (
      !setup
      || setup.updateId !== session.updateId
      || typeof setup.message !== "string"
      || setup.message.length > 500
    ) return progress;

    return {
      ...progress,
      message: setup.message,
      updatedAt: setup.updatedAt || progress.updatedAt,
      setup: {
        status: setup.status,
        stage: setup.stage,
        stageIndex: setup.stageIndex,
        stageCount: setup.stageCount,
        message: setup.message,
      },
      steps: Array.isArray(progress.steps)
        ? progress.steps.map((step) => step.key === "install"
          ? { ...step, detail: setup.message, updatedAt: setup.updatedAt || step.updatedAt }
          : step)
        : progress.steps,
    };
  }

  async handleMonitorRequest(request, response) {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (!isLoopbackOrigin(origin)) {
      writeMonitorJson(response, 403, { ok: false, error: "MONITOR_ORIGIN_FORBIDDEN" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Cache-Control", "no-store, max-age=0");
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "X-Bonni-Update-Monitor");
      response.setHeader("Access-Control-Max-Age", "600");
      response.setHeader("Vary", "Origin");
      response.end();
      return;
    }
    if (request.method !== "GET") {
      writeMonitorJson(response, 405, { ok: false, error: "MONITOR_METHOD_NOT_ALLOWED" }, origin);
      return;
    }

    const target = new URL(request.url || "/", this.installationMonitorOrigin || "http://127.0.0.1");
    if (target.pathname === "/health") {
      writeMonitorJson(response, 200, {
        schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
        ok: true,
        role: "installation-server",
        state: "ready",
      }, origin);
      return;
    }
    if (target.pathname !== "/api/local-update/status") {
      writeMonitorJson(response, 404, { ok: false, error: "MONITOR_ROUTE_NOT_FOUND" }, origin);
      return;
    }

    const requestId = String(target.searchParams.get("requestId") || "").trim();
    const token = String(request.headers["x-bonni-update-monitor"] || "").trim();
    if (!REQUEST_ID.test(requestId) || !MONITOR_TOKEN.test(token)) {
      writeMonitorJson(response, 401, { ok: false, error: "MONITOR_AUTH_INVALID" }, origin);
      return;
    }
    const session = await this.monitorSession(requestId);
    if (!session || !equalSha256(sha256Text(token), session.monitorTokenSha256)) {
      writeMonitorJson(response, 401, { ok: false, error: "MONITOR_AUTH_INVALID" }, origin);
      return;
    }
    const progress = await this.readMonitorProgress(session);
    const completed = progress.status === "completed";
    const failed = progress.status === "failed";
    const coreAvailable = this.backendLifecycle === "online";
    writeMonitorJson(response, 200, {
      schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
      ok: true,
      role: "installation-server",
      switchTarget: (completed || failed) && coreAvailable ? "core" : "installation",
      core: {
        state: this.backendLifecycle,
        available: coreAvailable,
      },
      progress,
      terminal: completed || failed,
      checkedAt: new Date(this.now()).toISOString(),
    }, origin);
  }

  async previousMonitorPort() {
    const heartbeat = await readSmallJson(
      this.heartbeatPath,
      MAX_REQUEST_BYTES,
      "SUPERVISOR_HEARTBEAT_INVALID",
    ).catch(() => null);
    const candidate = heartbeat?.monitor?.origin;
    try {
      const origin = new URL(String(candidate || ""));
      const port = Number(origin.port);
      if (
        origin.protocol === "http:"
        && origin.hostname === this.installationMonitorBind
        && origin.username === ""
        && origin.password === ""
        && origin.pathname === "/"
        && !origin.search
        && !origin.hash
        && Number.isInteger(port)
        && port >= 1
        && port <= 65_535
        && Number(heartbeat?.monitor?.port) === port
      ) return port;
    } catch {
      // A stale or incomplete heartbeat is not an endpoint receipt.
    }
    return null;
  }

  async hasActiveUpdateOrMonitorEvidence() {
    this.cleanupMonitorSessions();
    if (this.monitorSessions.size > 0) return true;
    const persisted = await this.readPersistedMonitorSession();
    if (persisted) {
      this.registerMonitorSession(persisted, { expiresAtMs: persisted.expiresAtMs });
      return true;
    }
    for (const target of [this.requestPath, this.processingPath, this.setupProgressPath]) {
      if (await fs.lstat(target).then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      })) return true;
    }
    if (await this.hasIncompleteUpdate().catch(() => true)) return true;
    try {
      const status = await readSmallJson(
        this.statusPath,
        MAX_MANIFEST_BYTES,
        "SUPERVISOR_STATUS_INVALID",
      );
      return Boolean(status && (
        ["queued", "stopping", "installing", "restarting", "committing", "running"]
          .includes(status.status)
        || status.phase === "recovery"
      ));
    } catch {
      return true;
    }
  }

  createInstallationMonitorServer() {
    const server = createServer((request, response) => {
      void this.handleMonitorRequest(request, response).catch((error) => {
        writeMonitorJson(response, 500, {
          ok: false,
          error: "MONITOR_REQUEST_FAILED",
          message: safeErrorMessage(error),
        });
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 12_000;
    server.keepAliveTimeout = 5_000;
    return server;
  }

  async listenInstallationMonitor(server, port) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, this.installationMonitorBind);
    });
  }

  async startInstallationMonitor() {
    if (this.installationMonitorServer) return this.installationMonitorOrigin;
    const activeEvidence = await this.hasActiveUpdateOrMonitorEvidence();
    const previousPort = activeEvidence ? await this.previousMonitorPort() : null;
    if (this.monitorSessions.size > 0 && !previousPort) {
      fail("SUPERVISOR_MONITOR_ENDPOINT_RECEIPT_REQUIRED_ACTIVE_UPDATE");
    }
    const initialPort = previousPort || this.installationMonitorPort;
    if (initialPort > 0) {
      this.installationMonitorLastOrigin = `http://${this.installationMonitorBind}:${initialPort}`;
    }
    let server = this.createInstallationMonitorServer();
    try {
      await this.listenInstallationMonitor(server, initialPort);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (activeEvidence) {
        fail("SUPERVISOR_MONITOR_ENDPOINT_IN_USE_ACTIVE_UPDATE", String(initialPort));
      }
      if (initialPort !== DEFAULT_MONITOR_PORT) throw error;
      server = this.createInstallationMonitorServer();
      await this.listenInstallationMonitor(server, 0);
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise((resolve) => server.close(resolve));
      fail("SUPERVISOR_MONITOR_ADDRESS_INVALID");
    }
    this.installationMonitorServer = server;
    this.installationMonitorOrigin = `http://${this.installationMonitorBind}:${address.port}`;
    this.installationMonitorLastOrigin = this.installationMonitorOrigin;
    return this.installationMonitorOrigin;
  }

  async stopInstallationMonitor() {
    const server = this.installationMonitorServer;
    this.installationMonitorServer = null;
    this.installationMonitorOrigin = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  async writeStatus({
    request = null,
    status,
    phase,
    message,
    steps,
    error = null,
  }) {
    if (request?.requestId && request?.monitorTokenSha256) {
      await this.rememberMonitorSession(request);
    }
    const updatedAt = new Date(this.now()).toISOString();
    await writeJsonAtomic(this.statusPath, {
      schemaVersion: LOCAL_UPDATE_STATUS_SCHEMA,
      ...(request?.requestId ? { requestId: request.requestId } : {}),
      ...(request?.updateId ? { updateId: request.updateId } : {}),
      ...(request?.manifestSha256 ? { manifestSha256: request.manifestSha256 } : {}),
      status,
      phase,
      message,
      ...(error ? {
        error: safeErrorMessage(error),
        errorCode: errorCode(error),
      } : {}),
      updatedAt,
      steps: steps || makeSteps(status === "idle" ? "idle" : null, null, updatedAt),
    });
  }

  async claimRequest() {
    try {
      await fs.rename(this.requestPath, this.processingPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST") return false;
      throw error;
    }
  }

  async readClaimedRequest() {
    const raw = await readSmallJson(
      this.processingPath,
      MAX_REQUEST_BYTES,
      "SUPERVISOR_REQUEST_INVALID",
    );
    if (!raw) fail("SUPERVISOR_REQUEST_MISSING");
    const request = validateInstallRequest(raw, {
      instanceId: this.instanceId,
      now: this.now(),
    });
    await this.rememberMonitorSession(request);
    return request;
  }

  async readCoreChildReceipt() {
    const value = await readSmallJson(
      this.coreChildReceiptPath,
      MAX_CORE_CHILD_RECEIPT_BYTES,
      "SUPERVISOR_CORE_CHILD_RECEIPT_INVALID",
    );
    return value ? validateCoreChildReceipt(value) : null;
  }

  async removeCoreChildReceiptExact(expected) {
    const current = await this.readCoreChildReceipt();
    if (!sameCoreChildReceipt(current, expected)) return false;
    await fs.rm(this.coreChildReceiptPath, { force: true });
    return true;
  }

  async readSupervisorLock() {
    const value = await readSmallJson(
      this.supervisorLockPath,
      MAX_SUPERVISOR_LOCK_BYTES,
      "SUPERVISOR_LOCK_INVALID",
    );
    return value ? validateSupervisorLock(value) : null;
  }

  async removeSupervisorLockExact(expected) {
    const current = await this.readSupervisorLock();
    if (!sameSupervisorLock(current, expected)) return false;
    await fs.rm(this.supervisorLockPath, { force: true });
    return true;
  }

  async assertNoLiveLegacySupervisor() {
    const heartbeat = await readSmallJson(
      this.heartbeatPath,
      MAX_REQUEST_BYTES,
      "SUPERVISOR_HEARTBEAT_INVALID",
    );
    if (
      !heartbeat
      || !Number.isSafeInteger(heartbeat.pid)
      || heartbeat.pid <= 0
      || typeof heartbeat.instanceId !== "string"
      || heartbeat.instanceId === this.instanceId
      || (heartbeat.pid === process.pid && heartbeat.available === false)
    ) return;
    if (await Promise.resolve(this.isPidAlive(heartbeat.pid))) {
      fail("SUPERVISOR_ACTIVATION_RESTART_REQUIRED", String(heartbeat.pid));
    }
  }

  async acquireSupervisorLock() {
    if (this.supervisorLockReceipt) return this.supervisorLockReceipt;
    const expected = Object.freeze({
      pid: process.pid,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await writeJsonExclusive(this.supervisorLockPath, expected);
        this.supervisorLockReceipt = expected;
        return expected;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const owner = await this.readSupervisorLock();
      if (!owner) continue;
      if (await Promise.resolve(this.isPidAlive(owner.pid))) {
        fail("SUPERVISOR_INSTANCE_ALREADY_RUNNING", `${owner.pid}:${owner.instanceId}`);
      }
      await this.removeSupervisorLockExact(owner);
    }
    fail("SUPERVISOR_LOCK_RACE");
  }

  async releaseSupervisorLock() {
    const receipt = this.supervisorLockReceipt;
    if (!receipt) return false;
    const current = await this.readSupervisorLock();
    if (!current) {
      this.supervisorLockReceipt = null;
      return true;
    }
    if (!sameSupervisorLock(current, receipt)) return false;
    await fs.rm(this.supervisorLockPath, { force: true });
    this.supervisorLockReceipt = null;
    return true;
  }

  async waitForPreviousCoreChildExit() {
    let elapsed = 0;
    while (true) {
      const receipt = await this.readCoreChildReceipt();
      if (!receipt) {
        if (await this.probeExistingCore({ url: this.backendHealthUrl })) {
          fail("SUPERVISOR_EXISTING_CORE_ENDPOINT_REACHABLE", this.backendHealthUrl);
        }
        return;
      }
      if (!await Promise.resolve(this.isPidAlive(receipt.pid))) {
        await this.removeCoreChildReceiptExact(receipt);
        continue;
      }
      if (elapsed >= this.previousCoreExitTimeoutMs) {
        fail("SUPERVISOR_PREVIOUS_CORE_STILL_RUNNING", String(receipt.pid));
      }
      const interval = Math.min(
        this.previousCoreExitIntervalMs,
        this.previousCoreExitTimeoutMs - elapsed,
      );
      await wait(interval);
      elapsed += interval;
    }
  }

  startBackend() {
    if (this.backendChild) return Promise.resolve(this.backendChild);
    if (this.backendStartPromise) return this.backendStartPromise;
    const operation = this.startBackendOnce();
    this.backendStartPromise = operation;
    void operation.then(
      () => {
        if (this.backendStartPromise === operation) this.backendStartPromise = null;
      },
      () => {
        if (this.backendStartPromise === operation) this.backendStartPromise = null;
      },
    );
    return operation;
  }

  async startBackendOnce() {
    if (this.backendChild) return this.backendChild;
    if (this.stopping && !this.activeWorkflowPromise && !this.busy) {
      fail("SUPERVISOR_STOPPING");
    }
    if (this.backendReceiptCleanupPromise) await this.backendReceiptCleanupPromise;
    await this.waitForPreviousCoreChildExit();
    if (this.stopping && !this.activeWorkflowPromise && !this.busy) {
      fail("SUPERVISOR_STOPPING");
    }
    const state = await fs.lstat(this.serverScript).catch(() => null);
    if (!state?.isFile() || state.isSymbolicLink()) {
      fail("SUPERVISOR_BACKEND_ENTRY_MISSING", this.serverScript);
    }

    this.backendLifecycle = "starting";
    const child = this.forkBackend(this.serverScript, [], {
      cwd: this.backendRoot,
      env: {
        ...process.env,
        BONNI_LOCAL_UPDATE_SUPERVISOR: "1",
        BONNI_LOCAL_UPDATE_SUPERVISOR_INSTANCE_ID: this.instanceId,
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
      child?.kill?.("SIGTERM");
      fail("SUPERVISOR_BACKEND_PID_INVALID");
    }
    this.backendChild = child;
    this.expectedBackendStop = false;
    const receipt = Object.freeze({
      pid: child.pid,
      supervisorInstanceId: this.instanceId,
      startedAt: new Date(this.now()).toISOString(),
    });
    const receiptWrite = writeJsonAtomic(this.coreChildReceiptPath, receipt);
    this.backendReceiptWritePromise = receiptWrite;
    const readyPromise = waitForBackendReady(child, this.backendReadyTimeoutMs);
    child.once("exit", (code, signal) => {
      if (this.backendChild === child) this.backendChild = null;
      const cleanup = receiptWrite.then(() => this.removeCoreChildReceiptExact(receipt));
      this.backendReceiptCleanupPromise = cleanup;
      void cleanup.then(
        () => {
          if (this.backendReceiptCleanupPromise === cleanup) {
            this.backendReceiptCleanupPromise = null;
          }
        },
        (error) => {
          this.heartbeatState = "failed";
          this.heartbeatMessage = safeErrorMessage(error);
        },
      );
      this.backendLifecycle = this.backendShutdownFailure === "SUPERVISOR_BACKEND_DID_NOT_EXIT"
        ? "stop-failed"
        : this.backendShutdownFailure === "SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED"
          ? "shutdown-unconfirmed"
          : this.expectedBackendStop || this.busy
            ? "offline-for-update"
            : "unavailable";
      if (
        this.stopping
        || this.expectedBackendStop
        || this.busy
        || this.backendShutdownFailure
      ) return;
      this.heartbeatState = "backend-unavailable";
      this.heartbeatMessage = `Bonni Core wurde beendet (${signal || code || "unbekannt"}); Neustart läuft.`;
      void this.writeHeartbeat().catch(() => {});
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.backendLifecycle = "starting";
        void this.startBackend()
          .then(() => this.writeHeartbeat({ state: "idle", message: "Bonni Core ist bereit." }))
          .catch((error) => this.writeHeartbeat({
            state: "failed",
            message: safeErrorMessage(error),
          }).catch(() => {}));
      }, 1_000);
      this.restartTimer.unref?.();
    });
    let ready;
    try {
      await receiptWrite;
      if (this.backendReceiptWritePromise === receiptWrite) {
        this.backendReceiptWritePromise = null;
      }
      ready = await readyPromise;
    } catch (error) {
      if (this.backendChild === child) child.kill("SIGTERM");
      await waitForChildExit(child, this.backendTerminateTimeoutMs).catch(() => false);
      throw error;
    }
    const readyPort = Number(ready?.port);
    if (
      !this.backendHealthUrlExplicit
      && Number.isInteger(readyPort)
      && readyPort > 0
      && readyPort <= 65_535
    ) {
      this.backendHealthUrl = `http://127.0.0.1:${readyPort}/api/health/local-update-ready`;
    }
    this.backendLifecycle = "online";
    return child;
  }

  async stopBackend(requestId = "supervisor-stop") {
    if (this.backendStopPromise) return this.backendStopPromise;
    const operation = this.stopBackendOnce(requestId);
    this.backendStopPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.backendStopPromise === operation) this.backendStopPromise = null;
    }
  }

  async stopBackendOnce(requestId = "supervisor-stop") {
    const child = this.backendChild;
    if (!child) {
      this.backendShutdownFailure = "SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED";
      this.backendLifecycle = "shutdown-unconfirmed";
      fail("SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED", requestId);
    }
    this.backendLifecycle = "stopping";
    this.backendShutdownFailure = null;
    this.expectedBackendStop = true;

    let shutdownComplete = false;
    const onShutdownComplete = (message) => {
      if (
        message?.type === "BONNI_BACKEND_SHUTDOWN_COMPLETE"
        && message.requestId === requestId
      ) shutdownComplete = true;
    };
    child.on("message", onShutdownComplete);
    try {
      if (child.connected) {
        child.send({
          type: "BONNI_SUPERVISOR_SHUTDOWN",
          reason: "local-source-update",
          requestId,
        });
      } else {
        child.kill("SIGTERM");
      }

      let exited = await waitForChildExit(child, this.backendGracefulTimeoutMs);
      if (!exited) {
        child.kill("SIGTERM");
        exited = await waitForChildExit(child, this.backendTerminateTimeoutMs);
      }
      if (!exited) {
        child.kill("SIGKILL");
        exited = await waitForChildExit(child, this.backendTerminateTimeoutMs);
      }
      if (!exited) {
        this.backendShutdownFailure = "SUPERVISOR_BACKEND_DID_NOT_EXIT";
        this.backendLifecycle = "stop-failed";
        fail("SUPERVISOR_BACKEND_DID_NOT_EXIT", requestId);
      }
      if (this.backendChild === child) this.backendChild = null;
      if (this.backendReceiptCleanupPromise) {
        await this.backendReceiptCleanupPromise;
      }
      if (!shutdownComplete) {
        this.backendShutdownFailure = "SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED";
        this.backendLifecycle = "shutdown-unconfirmed";
        fail("SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED", requestId);
      }
      this.backendShutdownFailure = null;
      this.backendLifecycle = "offline-for-update";
    } finally {
      child.off("message", onShutdownComplete);
    }
  }

  async executeUpdate(request = null, operation = "install") {
    assertLocalSourceSupervisorEnabled();
    const state = await fs.lstat(this.updateScript).catch(() => null);
    if (!state?.isFile() || state.isSymbolicLink()) {
      fail("SUPERVISOR_UPDATE_ENTRY_MISSING", this.updateScript);
    }
    const operationArgument = operation === "preflight"
      ? "--preflight"
      : operation === "finalize"
        ? "--finalize"
        : null;
    const hasExpectedProof = Boolean(
      request
      && typeof request.updateId === "string"
      && UPDATE_ID.test(request.updateId)
      && typeof request.manifestSha256 === "string"
      && SHA256.test(request.manifestSha256),
    );
    if (this.activeUpdatePromise) fail("SUPERVISOR_UPDATE_OPERATION_ALREADY_RUNNING");
    const invoked = this.runUpdate(process.execPath, [
      this.updateScript,
      ...(operationArgument ? [operationArgument] : []),
    ], {
      cwd: this.backendRoot,
      env: {
        ...process.env,
        BONNI_UPDATE_INVOCATION: "control-center-supervisor",
        ...(operation === "install" ? { BONNI_UPDATE_DEFER_FINALIZE: "1" } : {}),
        ...(hasExpectedProof ? {
          BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_ID: request.updateId,
          BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_MANIFEST_SHA256: request.manifestSha256,
        } : {}),
      },
      stdio: "inherit",
      windowsHide: true,
    });
    const tracked = Promise.resolve(invoked);
    this.activeUpdatePromise = tracked;
    this.activeUpdaterChild = invoked?.child || null;
    try {
      await tracked;
    } finally {
      if (this.activeUpdatePromise === tracked) {
        this.activeUpdatePromise = null;
        this.activeUpdaterChild = null;
      }
    }
  }

  async verifyBackendHealth() {
    const attempts = Math.max(1, Number(this.backendHealthAttempts) || 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.probeBackend({
        url: this.backendHealthUrl,
        attempt,
        attempts,
      });
      if (attempt < attempts && this.backendHealthIntervalMs > 0) {
        await wait(this.backendHealthIntervalMs);
      }
    }
  }

  assertBackendOnline(code = "SUPERVISOR_BACKEND_UNAVAILABLE_AFTER_UPDATE") {
    const child = this.backendChild;
    if (
      !child
      || this.backendLifecycle !== "online"
      || child.exitCode !== null
      || child.signalCode !== null
    ) fail(code);
    return child;
  }

  async processClaimedRequest() {
    assertLocalSourceSupervisorEnabled();
    let request = null;
    let currentPhase = "validate";
    let completed = false;
    this.busy = true;
    try {
      request = await this.readClaimedRequest();
      let timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "queued",
        phase: "validate",
        message: "Updateauftrag wurde sicher angenommen.",
        steps: makeSteps("validate", null, timestamp),
      });
      await verifyRequestedManifest({ productRoot: this.productRoot, request });
      await this.executeUpdate(request, "preflight");

      currentPhase = "handoff";
      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "running",
        phase: "handoff",
        message: "Der Installationsserver übernimmt den Fortschritt.",
        steps: makeSteps("handoff", null, timestamp),
      });
      await this.writeHeartbeat({
        state: "handoff",
        message: "Installationsserver aktiv; Bonni Core wird gleich angehalten.",
      });

      currentPhase = "stop";
      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "stopping",
        phase: "stop",
        message: "Bonni Core wird kontrolliert angehalten.",
        steps: makeSteps("stop", null, timestamp),
      });
      await this.writeHeartbeat({ state: "stopping", message: "Bonni Core wird für das Update angehalten." });
      await this.stopBackend(request.requestId);

      currentPhase = "install";
      await fs.rm(this.setupProgressPath, { force: true }).catch(() => {});
      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "installing",
        phase: "install",
        message: "Die Programmdaten von Bonni Core werden aktualisiert.",
        steps: makeSteps("install", null, timestamp),
      });
      await this.writeHeartbeat({ state: "installing", message: "Bonni-Core-Programmdaten werden aktualisiert." });
      await this.executeUpdate(request, "install");

      currentPhase = "restart";
      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "restarting",
        phase: "restart",
        message: "Update abgeschlossen; Bonni Core wird neu gestartet.",
        steps: makeSteps("restart", null, timestamp),
      });
      await this.writeHeartbeat({ state: "restarting", message: "Bonni Core wird neu gestartet." });
      await this.startBackend();

      currentPhase = "health";
      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "running",
        phase: "health",
        message: "Der neu gestartete Bonni Core wird vollständig geprüft.",
        steps: makeSteps("health", null, timestamp),
      });
      await this.writeHeartbeat({ state: "health-check", message: "Bonni Core wird geprüft." });
      await this.verifyBackendHealth();

      currentPhase = "return";
      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "committing",
        phase: "return",
        message: "Prüfung bestanden; die Aktualisierungsseite kehrt zu Bonni Core zurück.",
        steps: makeSteps("return", null, timestamp),
      });
      await this.executeUpdate(request, "finalize");
      this.assertBackendOnline();

      timestamp = new Date(this.now()).toISOString();
      await this.writeStatus({
        request,
        status: "completed",
        phase: "complete",
        message: "Bonni Core wurde erfolgreich aktualisiert und neu gestartet.",
        steps: makeSteps(null, null, timestamp),
      });
      await fs.rm(this.setupProgressPath, { force: true }).catch(() => {});
      this.assertBackendOnline();
      await this.writeHeartbeat({ state: "idle", message: "Bonni Core ist bereit." });
      this.assertBackendOnline();
      completed = true;
    } catch (error) {
      const failedStep = ["validate", "handoff", "stop", "install", "restart", "health", "return"].includes(currentPhase)
        ? currentPhase
        : "install";
      await this.writeStatus({
        request,
        status: "failed",
        phase: currentPhase,
        message: "Die Aktualisierung wurde sicher abgebrochen.",
        error,
        steps: makeSteps(failedStep, failedStep, new Date(this.now()).toISOString()),
      }).catch(() => {});

      const incompleteUpdate = await this.hasIncompleteUpdate().catch(() => true);
      const shutdownFailure = Boolean(this.backendShutdownFailure)
        || ["stop-failed", "shutdown-unconfirmed"].includes(this.backendLifecycle);
      if (!this.backendChild && !this.stopping && !incompleteUpdate && !shutdownFailure) {
        await this.startBackend().catch(() => {});
      }
      const coreOnline = this.backendLifecycle === "online";
      await this.writeHeartbeat({
        state: coreOnline ? "idle" : "failed",
        message: coreOnline
          ? "Update fehlgeschlagen; Bonni Core läuft weiter."
          : shutdownFailure
            ? "Update abgebrochen; der vollständige Bonni-Core-Stopp wurde nicht bestätigt."
            : "Update fehlgeschlagen; Bonni Core konnte nicht neu gestartet werden.",
      }).catch(() => {});
    } finally {
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      this.busy = false;
      this.expectedBackendStop = false;
      const incompleteUpdate = await this.hasIncompleteUpdate().catch(() => true);
      const shutdownFailure = Boolean(this.backendShutdownFailure)
        || ["stop-failed", "shutdown-unconfirmed"].includes(this.backendLifecycle);
      if (!this.backendChild && !this.stopping && !incompleteUpdate && !shutdownFailure) {
        try {
          await this.startBackend();
          await this.verifyBackendHealth();
          if (completed) {
            await this.writeHeartbeat({ state: "idle", message: "Bonni Core ist bereit." });
          }
        } catch (error) {
          if (completed) {
            await this.writeStatus({
              request,
              status: "failed",
              phase: "restart",
              message: "Das Update wurde installiert, Bonni Core ist danach jedoch nicht verfügbar.",
              error,
              steps: makeSteps("restart", "restart", new Date(this.now()).toISOString()),
            }).catch(() => {});
            await this.writeHeartbeat({
              state: "failed",
              message: "Bonni Core konnte nach dem Update nicht wiederhergestellt werden.",
            }).catch(() => {});
          }
        }
      }
    }
  }

  async pollOnce() {
    if (this.pollPromise) return this.pollPromise;
    const operation = this.pollOnceInternal();
    this.pollPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.pollPromise === operation) this.pollPromise = null;
    }
  }

  async pollOnceInternal() {
    assertLocalSourceSupervisorEnabled();
    if (this.busy || this.stopping) return false;
    if (!await this.claimRequest()) return false;
    if (this.stopping) {
      try {
        await fs.rename(this.processingPath, this.requestPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return false;
    }
    const workflow = this.processClaimedRequest();
    this.activeWorkflowPromise = workflow;
    try {
      await workflow;
    } finally {
      if (this.activeWorkflowPromise === workflow) this.activeWorkflowPromise = null;
    }
    return true;
  }

  async hasIncompleteUpdate() {
    if (await fs.lstat(this.pendingPath).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    })) return true;

    const workRoot = path.join(this.productRoot, "UPDATE", ".bonni-work");
    const entries = await fs.readdir(workRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    return entries.some((entry) => entry.isDirectory() || entry.isSymbolicLink());
  }

  async recoveryRequest(rawRequest) {
    const persisted = await this.readPersistedMonitorSession();
    if (!persisted) return isPlainObject(rawRequest) ? rawRequest : null;

    const pending = await readSmallJson(
      this.pendingPath,
      MAX_MANIFEST_BYTES,
      "SUPERVISOR_RECOVERY_PENDING_INVALID",
    );
    if (pending) {
      if (
        typeof pending.updateId !== "string"
        || !UPDATE_ID.test(pending.updateId)
        || typeof pending.manifestSha256 !== "string"
        || !SHA256.test(pending.manifestSha256)
      ) {
        fail("SUPERVISOR_RECOVERY_PENDING_PROOF_INVALID");
      }
      if (
        pending.updateId !== persisted.updateId
        || pending.manifestSha256 !== persisted.manifestSha256
      ) {
        fail("SUPERVISOR_RECOVERY_MONITOR_PROOF_MISMATCH");
      }
    }

    if (isPlainObject(rawRequest)) {
      for (const key of [
        "requestId",
        "updateId",
        "manifestSha256",
        "monitorTokenSha256",
      ]) {
        if (Object.hasOwn(rawRequest, key) && rawRequest[key] !== persisted[key]) {
          fail("SUPERVISOR_RECOVERY_MONITOR_PROOF_MISMATCH", key);
        }
      }
    }

    return Object.freeze({
      requestId: persisted.requestId,
      updateId: persisted.updateId,
      manifestSha256: persisted.manifestSha256,
      monitorTokenSha256: persisted.monitorTokenSha256,
    });
  }

  async recoverInterruptedUpdate() {
    if (!await this.hasIncompleteUpdate()) return null;
    this.busy = true;
    let request = null;
    try {
      const rawRequest = await readSmallJson(
        this.processingPath,
        MAX_REQUEST_BYTES,
        "SUPERVISOR_REQUEST_INVALID",
      ).catch(() => null);
      request = await this.recoveryRequest(rawRequest);
      await this.writeStatus({
        request,
        status: "installing",
        phase: "recovery",
        message: "Ein unterbrochenes Update wird automatisch fortgesetzt.",
        steps: makeSteps("install"),
      });
      await this.writeHeartbeat({ state: "installing", message: "Unterbrochenes Update wird fortgesetzt." });
      await this.executeUpdate(request);
      await this.writeStatus({
        request,
        status: "restarting",
        phase: "restart",
        message: "Wiederherstellung abgeschlossen; Bonni Core wird gestartet.",
        steps: makeSteps("restart"),
      });
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      return request || {};
    } catch (error) {
      await this.writeStatus({
        request,
        status: "failed",
        phase: "recovery",
        message: "Das unterbrochene Update konnte nicht automatisch fortgesetzt werden.",
        error,
        steps: makeSteps("install", "install"),
      }).catch(() => {});
      throw error;
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.startPromise) return this.startPromise;
    const operation = this.startOnce();
    this.startPromise = operation;
    return operation;
  }

  async startOnce() {
    assertLocalSourceSupervisorEnabled();
    await assertContainerRuntimeActivationInactive({ productRoot: this.productRoot });
    await this.assertNoLiveLegacySupervisor();
    await ensureDirectory(this.controlRoot);
    await this.acquireSupervisorLock();
    try {
      // Close the simultaneous-start race: runtime:start acquires its marker
      // before touching shared runtime state, while this Supervisor rechecks
      // that marker only after owning its own singleton receipt.
      await assertContainerRuntimeActivationInactive({ productRoot: this.productRoot });
      await this.assertNoLiveLegacySupervisor();
      await this.waitForPreviousCoreChildExit();
      try {
        await this.hydrateMonitorSession();
        await this.startInstallationMonitor();
      } catch (error) {
        await this.writeHeartbeat({
          available: false,
          state: "failed",
          message: `Installationsmonitor konnte nicht gestartet werden: ${safeErrorMessage(error)}`,
        }).catch(() => {});
        throw error;
      }
      await this.writeHeartbeat({ state: "starting", message: "Lokaler Update-Supervisor startet." });

      let recovered = null;
      try {
        recovered = await this.recoverInterruptedUpdate();
      } catch (error) {
        await this.writeHeartbeat({ state: "failed", message: safeErrorMessage(error) });
        throw error;
      }

      if (!recovered && await fs.lstat(this.processingPath).then(() => true, () => false)) {
        await fs.rm(this.processingPath, { force: true });
        await this.writeStatus({
          status: "failed",
          phase: "validate",
          message: "Ein alter Updateauftrag wurde nach dem Neustart verworfen.",
          error: new SupervisorError("SUPERVISOR_STALE_REQUEST_DISCARDED"),
          steps: makeSteps("validate", "validate"),
        });
      }

      await this.startBackend();
      if (recovered) {
        await this.writeStatus({
          request: recovered,
          status: "running",
          phase: "health",
          message: "Der neu gestartete Bonni Core wird nach der Wiederaufnahme geprüft.",
          steps: makeSteps("health"),
        });
        await this.verifyBackendHealth();
        await this.writeStatus({
          request: recovered,
          status: "committing",
          phase: "return",
          message: "Wiederhergestelltes Update wird abgeschlossen; die Seite kehrt zu Bonni Core zurück.",
          steps: makeSteps("return"),
        });
        await this.executeUpdate(recovered, "finalize");
        this.assertBackendOnline();
        await this.writeStatus({
          request: recovered,
          status: "completed",
          phase: "complete",
          message: "Das unterbrochene Update wurde abgeschlossen und Bonni Core neu gestartet.",
          steps: makeSteps(),
        });
        await fs.rm(this.setupProgressPath, { force: true }).catch(() => {});
        this.assertBackendOnline();
      } else if (!await fs.lstat(this.statusPath).then(() => true, () => false)) {
        await this.writeStatus({
          status: "idle",
          phase: "idle",
          message: "Der Update-Supervisor ist bereit.",
          steps: makeSteps("idle"),
        });
      }
      this.assertBackendOnline();
      await this.writeHeartbeat({ state: "idle", message: "Bonni Core ist bereit." });
      this.assertBackendOnline();

      if (!this.stopping) {
        this.pollTimer = setInterval(() => {
          void this.pollOnce().catch((error) => {
            void this.writeHeartbeat({ state: "failed", message: safeErrorMessage(error) }).catch(() => {});
          });
        }, this.pollIntervalMs);
        this.heartbeatTimer = setInterval(() => {
          void this.writeHeartbeat().catch(() => {});
        }, this.heartbeatIntervalMs);
      }
      return {
        instanceId: this.instanceId,
        controlRoot: this.controlRoot,
        backendPid: this.backendChild?.pid || null,
        installationMonitorOrigin: this.installationMonitorOrigin,
      };
    } catch (error) {
      if (this.backendChild) {
        try {
          await this.stopBackend("supervisor-start-failed");
        } catch (cleanupError) {
          await this.writeHeartbeat({
            available: false,
            state: "failed",
            message: `Startabbruch konnte Bonni Core nicht sicher beenden: ${safeErrorMessage(cleanupError)}`,
          }).catch(() => {});
          throw lifecycleAggregate("SUPERVISOR_START_CLEANUP_FAILED", error, cleanupError);
        }
      }
      await this.stopInstallationMonitor();
      if (!await this.releaseSupervisorLock()) {
        throw lifecycleAggregate(
          "SUPERVISOR_START_CLEANUP_FAILED",
          error,
          new SupervisorError("SUPERVISOR_LOCK_RELEASE_NOT_CONFIRMED"),
        );
      }
      throw error;
    }
  }

  stop(reason = "SIGTERM") {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const operation = this.stopOnce(reason);
    this.stopPromise = operation;
    return operation;
  }

  async stopOnce(reason = "SIGTERM") {
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.restartTimer);
    if (this.supervisorLockReceipt) {
      await this.writeHeartbeat({
        available: false,
        state: "stopping",
        message: this.busy || this.activeUpdatePromise
          ? `Update-Supervisor beendet sich nach dem laufenden Update (${reason}).`
          : `Update-Supervisor wird beendet (${reason}).`,
      }).catch(() => {});
    }

    const operations = [
      this.pollPromise,
      this.activeWorkflowPromise,
      this.activeUpdatePromise,
      this.backendStartPromise,
    ]
      .filter(Boolean);
    if (this.startPromise) operations.unshift(this.startPromise);
    await Promise.allSettled([...new Set(operations)]);

    if (this.activeUpdatePromise || this.activeUpdaterChild) {
      fail("SUPERVISOR_UPDATE_MUTATION_STILL_RUNNING");
    }
    if (this.backendStartPromise) {
      await Promise.allSettled([this.backendStartPromise]);
    }
    if (this.backendChild) {
      try {
        await this.stopBackend(`supervisor-${reason}`);
      } catch (error) {
        await this.writeHeartbeat({
          available: false,
          state: "failed",
          message: `Supervisor-Stopp fehlgeschlagen: ${safeErrorMessage(error)}`,
        }).catch(() => {});
        throw error;
      }
    }
    await this.stopInstallationMonitor();
    if (this.supervisorLockReceipt && !await this.releaseSupervisorLock()) {
      fail("SUPERVISOR_LOCK_RELEASE_NOT_CONFIRMED");
    }
  }
}

async function runMain() {
  const supervisor = new LocalSourceUpdateSupervisor();
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    void supervisor.stop(signal).then(
      () => process.exit(0),
      (error) => {
        console.error(`[bonni-supervisor] Beenden fehlgeschlagen (${signal}).`);
        console.error(error);
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await supervisor.start();
  console.info(
    `[bonni-supervisor] Bereit (${supervisor.instanceId}). Updates werden im Control Center gestartet.`,
  );
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  runMain().catch((error) => {
    console.error("[bonni-supervisor] Start fehlgeschlagen.");
    console.error(error);
    process.exitCode = 1;
  });
}
