import { fork, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertContainerRuntimeActivationInactive } from "../runtime/runtime-mode-exclusion.mjs";
import { loadOpsMigrations, runOpsMigrations } from "../database/run-ops-migrations.mjs";
import {
  buildSlotLaunchPlan,
  cloneProgramSlot,
  finalizeProgramSlotPromotion,
  promoteCandidateProgramSlot,
  recoverProgramSlotPromotion,
  resealProgramSlot,
  resolveProgramSlot,
  rollbackCandidatePromotion,
  stageProgramTree,
} from "../runcontainer/runcontainer-lib.mjs";
import {
  cleanupCandidateDataClone,
  cloneCandidateData,
  recoverCandidateDataCloneAtStartup,
} from "../runcontainer/candidate-data-clone.mjs";
import { stageCandidateUpdatePackage } from "../runcontainer/candidate-update-stage.mjs";
import { promoteCandidateControlState } from "../runcontainer/candidate-control-state-promotion.mjs";
import { probeFrontendSlotHealth } from "../runcontainer/frontend-slot-health.mjs";
import { commitCanonicalSystem } from "../runcontainer/canonical-system-commit.mjs";
import { windowsCaseFoldPath } from "../runcontainer/run-layout.mjs";
import { assertLocalCandidateCompatibility } from "./local-candidate-compatibility.mjs";
import { resolveActiveSlotBackend } from "../local-run-controller/slot-launcher.mjs";
import { startLocalRunProxy } from "../local-run-controller/local-run-proxy.mjs";
import {
  commitActiveTarget,
  readActiveTargetReceipt,
  recoverActiveTarget,
} from "../local-run-controller/controller-state.mjs";
import {
  armAcceptanceGateAfterProxyCommit,
  armAcceptanceRetryAfterProxyCommit,
  bindAcceptanceRetryChoiceDeadline,
  classifyAcceptanceGateRecovery,
  confirmAcceptanceGate,
  evaluateAcceptanceGate,
  expireAcceptanceRetryChoice,
  failAcceptanceGate,
  recoverAcceptanceGate,
  startAcceptanceRetry,
  terminalizeStartedAcceptanceRetry,
} from "../local-run-controller/acceptance-gate.mjs";

export function applicationEnvironment(environment = process.env) {
  const blocked = new Set([
    "BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID",
    "BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!blocked.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

export function trustedUpdateEnvironment(environment = process.env) {
  const result = applicationEnvironment(environment);
  for (const key of [
    "BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID",
    "BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN",
  ]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

export const LOCAL_UPDATE_REQUEST_SCHEMA = "bonni.local-source-update-request/v2";
export const LOCAL_UPDATE_HEARTBEAT_SCHEMA = "bonni.local-source-update-heartbeat/v1";
export const LOCAL_UPDATE_STATUS_SCHEMA = "bonni.local-source-update-status/v1";
export const LOCAL_UPDATE_MONITOR_SCHEMA = "bonni.local-source-update-monitor/v1";
export const LOCAL_UPDATE_SUPERVISOR_VERSION = "1.1.2";

export const LOCAL_RUN_PUBLIC_PORT = 4_000;
export const LOCAL_RUN_ACTIVE_PORT = 4_100;
export const LOCAL_RUN_CANDIDATE_PORT = 4_300;
export const LOCAL_RUN_CONFIRMATION_TTL_MS = 60_000;

const SOURCE_UPDATE_SCHEMA = "bonni.local-source-update/v1";
const REQUEST_FILE = "request.json";
const PROCESSING_FILE = "request.processing.json";
const HEARTBEAT_FILE = "heartbeat.json";
const STATUS_FILE = "status.json";
const DIAGNOSTIC_LOG_DIRECTORY = "logs";
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
// A local probe may take up to five seconds. Six total attempts keep the
// automatic rollback comfortably inside the one-minute acceptance window.
const BACKEND_HEALTH_MAX_ATTEMPTS = 6;
const BACKEND_HEALTH_INTERVAL_MS = 500;
const PREVIOUS_CORE_EXIT_TIMEOUT_MS = 30_000;
const PREVIOUS_CORE_EXIT_INTERVAL_MS = 100;
const EXISTING_CORE_PROBE_TIMEOUT_MS = 750;
const MAX_UPDATE_PROCESS_DIAGNOSTIC_BYTES = 4_096;
const MAX_UPDATE_DIAGNOSTIC_LOG_BYTES = 64 * 1024;
const MAX_UPDATE_DIAGNOSTIC_LOG_FILES = 20;
const MAX_UPDATE_DIAGNOSTIC_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPS_MIGRATION_RECEIPT_ROOT = "system/backend/ops/migrations";
const MONITOR_TOKEN = /^[a-f0-9]{64}$/u;
const STABLE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const DIAGNOSTIC_LOG_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.log$/u;
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const SECRET_NAME = "(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|pwd|secret|client[-_]?secret|private[-_]?key|api[-_]?key|apikey|jwt|access[-_]?token|refresh[-_]?token|monitor[-_]?token|session[-_]?token)";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBackendRoot = path.resolve(scriptDirectory, "../..");

class SupervisorError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "SupervisorError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new SupervisorError(code, detail);
}

export function resolveSupervisorProductRoot({
  backendRoot = defaultBackendRoot,
  environment = process.env,
} = {}) {
  const configured = String(environment.BONNI_PRODUCT_ROOT || "").trim();
  if (configured) {
    if (configured.includes("\u0000") || !path.isAbsolute(configured)) {
      fail("SUPERVISOR_PRODUCT_ROOT_INVALID");
    }
    return path.resolve(configured);
  }
  return path.resolve(backendRoot, "../..");
}

function lifecycleAggregate(code, ...errors) {
  const aggregate = new AggregateError(errors.filter(Boolean), code);
  aggregate.code = code;
  return aggregate;
}

function pathContains(root, candidate, allowEqual = true) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowEqual && relative === "")
    || (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

export function assertLocalSourceSupervisorEnabled(environment = process.env) {
  if (
    String(environment.NODE_ENV || "").trim().toLowerCase() === "production"
    && String(environment.BONNI_LOCAL_RUN_SLOTS || "").trim() !== "1"
  ) {
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

function validateClaimedRecoveryRequest(value) {
  const issuedAt = parseTimestamp(value?.issuedAt, "request.issuedAt");
  const expiresAt = parseTimestamp(value?.expiresAt, "request.expiresAt");
  // Expiry authorizes the initial claim only. Once atomically renamed to the
  // processing receipt, recovery validates the original lifetime but must not
  // discard a confirmed/promotion decision merely because the controller was
  // offline beyond that short submission window.
  const validationInstant = Math.min(expiresAt - 1, issuedAt + 1);
  return validateInstallRequest(value, {
    instanceId: value?.supervisorInstanceId,
    now: validationInstant,
  });
}

function validatePersistedMonitorIdentity(value) {
  const expiresAtMs = parseTimestamp(value?.expiresAt, "monitorAccess.expiresAt");
  return validateMonitorAccess(value, { now: expiresAtMs });
}

function errorCode(error) {
  if (error instanceof SupervisorError) return error.code;
  const message = String(error?.message || error || "");
  const candidate = message.split(":", 1)[0];
  return STABLE_ERROR_CODE.test(candidate)
    ? candidate
    : "SUPERVISOR_OPERATION_FAILED";
}

function redactDiagnosticSecrets(value) {
  return String(value)
    .replace(/(^|\n)(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:)[^\n]*/giu, "$1$2 [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/giu, "$1:[REDACTED]@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
    .replace(
      new RegExp(`((?:["']?${SECRET_NAME}["']?)\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}\\]]+)`, "giu"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`(--${SECRET_NAME}(?:=|\\s+))[^\\s]+`, "giu"),
      "$1[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_JWT]");
}

function sanitizeDiagnosticText(value, { collapseWhitespace = false } = {}) {
  let text = String(value ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_CONTROLS, "");
  text = redactDiagnosticSecrets(text);
  if (collapseWhitespace) text = text.replace(/[\n\t ]+/gu, " ");
  else text = text.replace(/\t/gu, "  ");
  return text.trim();
}

function safeErrorMessage(error) {
  const message = sanitizeDiagnosticText(
    error?.deepestMessage || error?.message || error || "Unbekannter Fehler",
    { collapseWhitespace: true },
  );
  return message.length <= 500 ? message : `…${message.slice(-499)}`;
}

function utf8Tail(value, maximumBytes) {
  const source = String(value || "");
  const bytes = Buffer.from(source, "utf8");
  if (bytes.length <= maximumBytes) return source;
  const marker = "[Frühere Diagnoseausgabe wurde gekürzt.]\n";
  const available = Math.max(0, maximumBytes - Buffer.byteLength(marker));
  let tail = bytes.subarray(bytes.length - available).toString("utf8").replace(/^\uFFFD+/gu, "");
  while (Buffer.byteLength(`${marker}${tail}`, "utf8") > maximumBytes && tail) {
    tail = tail.slice(1);
  }
  return `${marker}${tail}`;
}

function stableErrorCandidatesFromText(value) {
  const text = sanitizeDiagnosticText(value);
  const candidates = [];
  const pattern = /\b([A-Z][A-Z0-9_]{2,127})(?=:)/gu;
  for (const match of text.matchAll(pattern)) {
    const code = match[1];
    const detailStart = (match.index || 0) + match[0].length + 1;
    let detail = text.slice(detailStart).split("\n", 1)[0].trim();
    const stackStart = detail.search(/\s+at\s+(?:async\s+)?(?:file:|[A-Za-z_$])/u);
    if (stackStart >= 0) detail = detail.slice(0, stackStart).trim();
    const nextCode = detail.search(/\b[A-Z][A-Z0-9_]{2,127}:/u);
    if (nextCode >= 0) detail = detail.slice(0, nextCode).trim();
    candidates.push({ code, detail });
  }
  return candidates;
}

function deepestStableError(error) {
  const candidates = [];
  const visited = new Set();
  const visit = (value) => {
    if (value && typeof value === "object") {
      if (visited.has(value)) return;
      visited.add(value);
      if (STABLE_ERROR_CODE.test(String(value.code || ""))) {
        candidates.push({
          code: String(value.code),
          detail: sanitizeDiagnosticText(value.detail || "", { collapseWhitespace: true }),
        });
      }
      candidates.push(...stableErrorCandidatesFromText(value.diagnostic || ""));
      candidates.push(...stableErrorCandidatesFromText(value.message || ""));
      if (value.cause) visit(value.cause);
      if (Array.isArray(value.errors)) value.errors.forEach(visit);
      return;
    }
    candidates.push(...stableErrorCandidatesFromText(value));
  };
  visit(error);
  if (!candidates.length) {
    const code = errorCode(error);
    const message = safeErrorMessage(error);
    const detail = message.startsWith(`${code}:`) ? message.slice(code.length + 1).trim() : "";
    return { code, detail, message };
  }
  const selected = candidates.at(-1);
  const maximumDetailLength = Math.max(0, 499 - selected.code.length);
  const detail = selected.detail.length <= maximumDetailLength
    ? selected.detail
    : `…${selected.detail.slice(-(maximumDetailLength - 1))}`;
  return {
    code: selected.code,
    detail,
    message: detail ? `${selected.code}:${detail}` : selected.code,
  };
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

async function readMonitorJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_MONITOR_ACCESS_BYTES) fail("SUPERVISOR_MONITOR_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (size === 0) fail("SUPERVISOR_MONITOR_BODY_MISSING");
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("SUPERVISOR_MONITOR_BODY_INVALID");
  }
  if (!isPlainObject(value)) fail("SUPERVISOR_MONITOR_BODY_INVALID");
  return value;
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

async function writeTextAtomic(target, value) {
  await ensureDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.bonni-supervisor-${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(String(value), "utf8");
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

function makeLocalRunSteps(activeKey = null, failedKey = null, at = new Date().toISOString()) {
  const definitions = [
    ["validate", "Auftrag und Core-Paket prüfen"],
    ["candidate-copy", "SYSTEM vollständig nach RUN_INSTALL kopieren"],
    ["build", "UPDATE in RUN_INSTALL anwenden und versiegeln"],
    ["start", "Candidate getrennt in RUN_SYSTEM starten"],
    ["health", "Backend und Frontend des Candidate prüfen"],
    ["migration", "Expand-Migration kontrolliert produktiv anwenden"],
    ["cutover", "Anfragen kontrolliert auf den Candidate umschalten"],
    ["confirmation", "60 Sekunden auf ausdrückliche Bestätigung warten"],
    ["complete", "SYSTEM übernehmen und Vorgänger direkt in BACKUP sichern"],
  ];
  const activeIndex = definitions.findIndex(([key]) => key === activeKey);
  return definitions.map(([key, label], index) => {
    let status = "pending";
    if (failedKey === key) status = "failed";
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
    const failedModules = Array.isArray(payload?.modules?.modules)
      ? payload.modules.modules
        .filter((module) => module?.status === "error")
        .slice(0, 5)
        .map((module) => {
          const rawKey = String(module?.key || "").trim();
          const key = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(rawKey) ? rawKey : "unknown";
          const rawError = String(module?.error || "").trim();
          const errorCode = rawError.match(/^([A-Z][A-Z0-9_]{2,127})(?::|$)/u)?.[1]
            || "MODULE_RUNTIME_ERROR";
          return `${key}:${errorCode}`;
        })
      : [];
    const detail = sanitizeDiagnosticText([
      `http-${Number(response.status) || "unknown"}`,
      `state-${String(payload?.state || "unknown")}`,
      `database-${payload?.database?.ready === true ? "ready" : "not-ready"}`,
      `module-errors-${Number(payload?.modules?.counts?.error ?? -1)}`,
      failedModules.length ? `modules-${failedModules.join(",")}` : "",
    ].filter(Boolean).join(";"), { collapseWhitespace: true });
    fail("SUPERVISOR_BACKEND_HEALTH_NOT_READY", detail.slice(0, 500));
  }
  return payload;
}

export async function probeLocalRunCandidate({
  url,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = BACKEND_HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") fail("SUPERVISOR_HEALTH_FETCH_UNAVAILABLE");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    fail("SUPERVISOR_CANDIDATE_HEALTH_UNREACHABLE", safeErrorMessage(error));
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("SUPERVISOR_CANDIDATE_HEALTH_INVALID");
  }
  const runtime = payload?.runtime;
  if (
    !response.ok
    || payload?.ok !== true
    || payload?.state !== "ready"
    || payload?.database?.ready !== true
    || payload?.probe?.enabled !== true
    || payload?.probe?.roleMatches !== true
    || runtime?.slotRole !== "candidate"
    || (expectedVersion && runtime?.version !== expectedVersion)
    || payload?.probe?.modules?.counts?.error !== 0
  ) {
    fail("SUPERVISOR_CANDIDATE_HEALTH_NOT_READY");
  }
  return payload;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runProcess(executable, args, options = {}) {
  const { onOutput, ...spawnOptions } = options;
  const child = spawn(executable, args, spawnOptions);
  let diagnostic = "";
  let diagnosticWrite = Promise.resolve();
  let diagnosticWriteError = null;
  const forward = (stream, target, streamName) => {
    if (!stream || typeof stream.on !== "function") return;
    stream.on("data", (chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      target?.write?.(chunk);
      diagnostic = `${diagnostic}${text}`.slice(-MAX_UPDATE_PROCESS_DIAGNOSTIC_BYTES);
      if (typeof onOutput === "function") {
        diagnosticWrite = diagnosticWrite
          .then(() => onOutput({ stream: streamName, text }))
          .catch((error) => {
            diagnosticWriteError ||= error;
          });
      }
    });
  };
  forward(child.stdout, process.stdout, "stdout");
  forward(child.stderr, process.stderr, "stderr");
  const operation = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      void diagnosticWrite.then(() => {
        if (diagnosticWriteError && code === 0) {
          reject(new SupervisorError(
            "SUPERVISOR_UPDATE_DIAGNOSTIC_LOG_FAILED",
            safeErrorMessage(diagnosticWriteError),
          ));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const failure = new SupervisorError(
          "SUPERVISOR_UPDATE_PROCESS_FAILED",
          [
            signal ? `signal-${signal}` : `exit-${code ?? "unknown"}`,
            sanitizeDiagnosticText(diagnostic, { collapseWhitespace: true }),
          ].filter(Boolean).join(":"),
        );
        failure.diagnostic = diagnostic;
        if (diagnosticWriteError) failure.diagnosticLogError = diagnosticWriteError;
        reject(failure);
      });
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
    productRoot = resolveSupervisorProductRoot({ backendRoot }),
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
    backendHealthMaxAttempts = BACKEND_HEALTH_MAX_ATTEMPTS,
    backendHealthIntervalMs = BACKEND_HEALTH_INTERVAL_MS,
    previousCoreExitTimeoutMs = PREVIOUS_CORE_EXIT_TIMEOUT_MS,
    previousCoreExitIntervalMs = PREVIOUS_CORE_EXIT_INTERVAL_MS,
    isPidAlive = isProcessAlive,
    probeExistingCore = probeExistingCoreEndpoint,
    installationMonitorBind = process.env.BONNI_INSTALLATION_MONITOR_BIND || DEFAULT_MONITOR_BIND,
    installationMonitorPort = process.env.BONNI_INSTALLATION_MONITOR_PORT,
    localRunEnabled = String(process.env.BONNI_LOCAL_RUN_SLOTS || "").trim() === "1",
    localRunInstallRoot = process.env.BONNI_RUN_INSTALL_ROOT || path.join(productRoot, "RUN_INSTALL"),
    localRunSystemRoot = process.env.BONNI_RUN_SYSTEM_ROOT || path.join(productRoot, "RUN_SYSTEM"),
    localRunRoot = process.env.BONNI_PROGRAM_SLOTS_ROOT
      || process.env.RUNCONTAINER_ROOT
      || path.join(localRunSystemRoot, "program-slots"),
    localRunControllerStateRoot = path.join(localRunSystemRoot, "controller"),
    productionRunSystemRoot = process.env.BONNI_RUNTIME_STATE_ROOT
      || process.env.RUN_SYSTEM_ROOT
      || path.join(localRunSystemRoot, "runtime"),
    productionStorageRoot = process.env.BONNI_STORAGE_ROOT
      || path.join(productionRunSystemRoot, "storage"),
    productionDatabaseUrl = process.env.DATABASE_URL,
    localRunPublicPort = process.env.BONNI_LOCAL_RUN_PUBLIC_PORT || LOCAL_RUN_PUBLIC_PORT,
    localRunActivePort = process.env.BONNI_ACTIVE_INTERNAL_PORT || LOCAL_RUN_ACTIVE_PORT,
    localRunCandidatePort = process.env.BONNI_CANDIDATE_INTERNAL_PORT || LOCAL_RUN_CANDIDATE_PORT,
    localRunConfirmationTtlMs = LOCAL_RUN_CONFIRMATION_TTL_MS,
    localRunDependencies = {},
  } = {}) {
    this.backendRoot = path.resolve(backendRoot);
    this.programRoot = path.resolve(this.backendRoot, "../..");
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
    this.diagnosticLogRoot = path.join(this.controlRoot, DIAGNOSTIC_LOG_DIRECTORY);
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
    this.backendHealthMaxAttempts = backendHealthMaxAttempts;
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
    this.localRunEnabled = localRunEnabled === true;
    this.localRunInstallRoot = path.resolve(localRunInstallRoot);
    this.localRunSystemRoot = path.resolve(localRunSystemRoot);
    this.localRunRoot = path.resolve(localRunRoot);
    this.localRunControllerStateRoot = path.resolve(localRunControllerStateRoot);
    this.productionRunSystemRoot = path.resolve(productionRunSystemRoot);
    this.productionStorageRoot = path.resolve(productionStorageRoot);
    this.productionDatabaseUrl = String(productionDatabaseUrl || "").trim();
    this.localRunPublicPort = Number(localRunPublicPort);
    this.localRunActivePort = Number(localRunActivePort);
    this.localRunCandidatePort = Number(localRunCandidatePort);
    this.localRunConfirmationTtlMs = Math.max(1, Number(localRunConfirmationTtlMs) || LOCAL_RUN_CONFIRMATION_TTL_MS);
    this.localRunOps = Object.freeze({
      resolveProgramSlot: localRunDependencies.resolveProgramSlot || resolveProgramSlot,
      stageProgramTree: localRunDependencies.stageProgramTree || stageProgramTree,
      resolveActiveSlotBackend: localRunDependencies.resolveActiveSlotBackend || resolveActiveSlotBackend,
      startLocalRunProxy: localRunDependencies.startLocalRunProxy || startLocalRunProxy,
      readActiveTargetReceipt:
        localRunDependencies.readActiveTargetReceipt || readActiveTargetReceipt,
      recoverActiveTarget:
        localRunDependencies.recoverActiveTarget || recoverActiveTarget,
      commitActiveTarget: localRunDependencies.commitActiveTarget || commitActiveTarget,
      cloneProgramSlot: localRunDependencies.cloneProgramSlot || cloneProgramSlot,
      stageCandidateUpdatePackage: localRunDependencies.stageCandidateUpdatePackage || stageCandidateUpdatePackage,
      cloneCandidateData: localRunDependencies.cloneCandidateData || cloneCandidateData,
      cleanupCandidateDataClone: localRunDependencies.cleanupCandidateDataClone || cleanupCandidateDataClone,
      recoverCandidateDataCloneAtStartup:
        localRunDependencies.recoverCandidateDataCloneAtStartup || recoverCandidateDataCloneAtStartup,
      assertLocalCandidateCompatibility:
        localRunDependencies.assertLocalCandidateCompatibility || assertLocalCandidateCompatibility,
      buildSlotLaunchPlan: localRunDependencies.buildSlotLaunchPlan || buildSlotLaunchPlan,
      resealProgramSlot: localRunDependencies.resealProgramSlot || resealProgramSlot,
      promoteCandidateProgramSlot:
        localRunDependencies.promoteCandidateProgramSlot || promoteCandidateProgramSlot,
      finalizeProgramSlotPromotion:
        localRunDependencies.finalizeProgramSlotPromotion || finalizeProgramSlotPromotion,
      rollbackCandidatePromotion:
        localRunDependencies.rollbackCandidatePromotion || rollbackCandidatePromotion,
      recoverProgramSlotPromotion:
        localRunDependencies.recoverProgramSlotPromotion || recoverProgramSlotPromotion,
      promoteCandidateControlState:
        localRunDependencies.promoteCandidateControlState || promoteCandidateControlState,
      commitCanonicalSystem:
        localRunDependencies.commitCanonicalSystem || commitCanonicalSystem,
      armAcceptanceGateAfterProxyCommit:
        localRunDependencies.armAcceptanceGateAfterProxyCommit || armAcceptanceGateAfterProxyCommit,
      armAcceptanceRetryAfterProxyCommit:
        localRunDependencies.armAcceptanceRetryAfterProxyCommit || armAcceptanceRetryAfterProxyCommit,
      startAcceptanceRetry:
        localRunDependencies.startAcceptanceRetry || startAcceptanceRetry,
      bindAcceptanceRetryChoiceDeadline:
        localRunDependencies.bindAcceptanceRetryChoiceDeadline || bindAcceptanceRetryChoiceDeadline,
      expireAcceptanceRetryChoice:
        localRunDependencies.expireAcceptanceRetryChoice || expireAcceptanceRetryChoice,
      classifyAcceptanceGateRecovery:
        localRunDependencies.classifyAcceptanceGateRecovery || classifyAcceptanceGateRecovery,
      terminalizeStartedAcceptanceRetry:
        localRunDependencies.terminalizeStartedAcceptanceRetry || terminalizeStartedAcceptanceRetry,
      confirmAcceptanceGate:
        localRunDependencies.confirmAcceptanceGate || confirmAcceptanceGate,
      evaluateAcceptanceGate:
        localRunDependencies.evaluateAcceptanceGate || evaluateAcceptanceGate,
      failAcceptanceGate:
        localRunDependencies.failAcceptanceGate || failAcceptanceGate,
      recoverAcceptanceGate:
        localRunDependencies.recoverAcceptanceGate || recoverAcceptanceGate,
      probeCandidate: localRunDependencies.probeCandidate || probeLocalRunCandidate,
      probeFrontendSlotHealth:
        localRunDependencies.probeFrontendSlotHealth || probeFrontendSlotHealth,
      loadOpsMigrations: localRunDependencies.loadOpsMigrations || loadOpsMigrations,
      runOpsMigrations: localRunDependencies.runOpsMigrations || runOpsMigrations,
      withConsistencyBoundary: localRunDependencies.withConsistencyBoundary || null,
      receiptSigningKey: localRunDependencies.receiptSigningKey
        || (String(process.env.MASTER_KEY || "").length >= 32
          ? createHmac("sha256", process.env.MASTER_KEY)
            .update(`bonni.local-candidate-data-receipt/v1\0${this.productRoot}`)
            .digest()
          : null),
    });
    this.installationMonitorOrigin = null;
    this.installationMonitorLastOrigin = null;
    this.installationMonitorServer = null;
    this.monitorSessions = new Map();
    this.monitorPlainTokens = new Map();
    this.monitorTokenWaiters = new Map();
    this.localRunProxy = null;
    this.activeLaunchPlan = null;
    this.candidateChild = null;
    this.candidateDataClone = null;
    this.localRunCutover = null;
    this.acceptanceWaiters = new Map();
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
    this.diagnosticLogWrite = Promise.resolve();
    this.initializedDiagnosticRequests = new Set();
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
      const claimedRequestExists = await fs.lstat(this.processingPath).then(
        (state) => state.isFile() && !state.isSymbolicLink(),
        (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        },
      );
      // Keep only the token hash/expiry as recovery evidence while a claimed
      // request exists. It no longer authorizes HTTP, but bounds retry-choice
      // recovery and binds the durable claim across long controller outages.
      if (!claimedRequestExists) {
        await fs.rm(this.monitorAccessPath, { force: true }).catch(() => {});
      }
      return null;
    }
    return access;
  }

  async retireTerminalMonitorSession(observed) {
    const status = await readSmallJson(
      this.statusPath,
      MAX_MANIFEST_BYTES,
      "SUPERVISOR_STATUS_INVALID",
    );
    if (!status
      || status.schemaVersion !== LOCAL_UPDATE_STATUS_SCHEMA
      || !new Set(["completed", "failed"]).has(status.status)
      || status.requestId !== observed.requestId
      || status.updateId !== observed.updateId
      || status.manifestSha256 !== observed.manifestSha256) {
      return false;
    }
    const before = await fs.lstat(this.monitorAccessPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      fail("SUPERVISOR_MONITOR_ACCESS_RETIRE_UNSAFE");
    }
    const current = await this.readPersistedMonitorSession();
    if (!current || !this.monitorSessionMatches(current, observed)) {
      fail("SUPERVISOR_MONITOR_ACCESS_RETIRE_RACE");
    }
    const stamp = new Date(this.now()).toISOString().replace(/[^0-9A-Za-z]/gu, "");
    const retiredPath = `${this.monitorAccessPath}.terminal-${stamp}-${randomBytes(8).toString("hex")}`;
    await fs.rename(this.monitorAccessPath, retiredPath);
    const moved = await fs.lstat(retiredPath);
    const sameFile = moved.isFile()
      && !moved.isSymbolicLink()
      && moved.nlink === 1
      && moved.dev === before.dev
      && moved.ino === before.ino;
    if (!sameFile) {
      // Restore without replacing a concurrently created live receipt. A hard
      // link is an atomic no-clobber operation on Windows and POSIX.
      let restored = false;
      try {
        await fs.link(retiredPath, this.monitorAccessPath);
        restored = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (restored) await fs.rm(retiredPath, { force: true });
      fail("SUPERVISOR_MONITOR_ACCESS_RETIRE_RACE");
    }
    const movedSession = validateMonitorAccess(
      await readSmallJson(
        retiredPath,
        MAX_MONITOR_ACCESS_BYTES,
        "SUPERVISOR_MONITOR_ACCESS_INVALID",
      ),
      { now: this.now() },
    );
    if (!this.monitorSessionMatches(movedSession, observed)) {
      fail("SUPERVISOR_MONITOR_ACCESS_RETIRE_RACE");
    }
    await fs.rm(retiredPath, { force: true });
    this.monitorSessions.delete(observed.requestId);
    this.monitorPlainTokens.delete(observed.requestId);
    this.monitorTokenWaiters.get(observed.requestId)?.reject(
      new SupervisorError("SUPERVISOR_MONITOR_SESSION_RETIRED"),
    );
    this.monitorTokenWaiters.delete(observed.requestId);
    return true;
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
        if (persisted.requestId === request.requestId
          || !await this.retireTerminalMonitorSession(persisted)) {
          fail("SUPERVISOR_MONITOR_ACCESS_BINDING_MISMATCH");
        }
      } else {
        return this.registerMonitorSession(persisted, {
          expiresAtMs: persisted.expiresAtMs,
        });
      }
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

  rememberPlainMonitorToken(session, token) {
    if (!session || !MONITOR_TOKEN.test(String(token || ""))) {
      fail("SUPERVISOR_MONITOR_AUTH_INVALID");
    }
    if (!equalSha256(sha256Text(token), session.monitorTokenSha256)) {
      fail("SUPERVISOR_MONITOR_AUTH_INVALID");
    }
    this.monitorPlainTokens.set(session.requestId, token);
    const waiter = this.monitorTokenWaiters.get(session.requestId);
    if (waiter) {
      this.monitorTokenWaiters.delete(session.requestId);
      waiter.resolve(token);
    }
    return token;
  }

  async waitForPlainMonitorToken(request, timeoutMs = this.localRunConfirmationTtlMs) {
    const existing = this.monitorPlainTokens.get(request.requestId);
    if (existing && equalSha256(sha256Text(existing), request.monitorTokenSha256)) return existing;
    if (this.monitorTokenWaiters.has(request.requestId)) {
      return this.monitorTokenWaiters.get(request.requestId).promise;
    }
    let resolveWaiter;
    let rejectWaiter;
    const promise = new Promise((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const timer = setTimeout(() => {
      this.monitorTokenWaiters.delete(request.requestId);
      rejectWaiter(new SupervisorError("SUPERVISOR_MONITOR_TOKEN_NOT_PRESENTED"));
    }, Math.max(1, Number(timeoutMs) || 1));
    timer.unref?.();
    const entry = {
      promise: promise.finally(() => clearTimeout(timer)),
      resolve: resolveWaiter,
      reject: rejectWaiter,
    };
    this.monitorTokenWaiters.set(request.requestId, entry);
    return entry.promise;
  }

  async confirmLocalRunAcceptance({ session, token }) {
    const cutover = this.localRunCutover;
    if (!cutover
      || cutover.request.requestId !== session.requestId
      || cutover.request.updateId !== session.updateId
      || cutover.request.manifestSha256 !== session.manifestSha256
      || !cutover.acceptanceBinding) {
      fail("SUPERVISOR_ACCEPTANCE_NOT_ARMED");
    }
    await this.verifyConfirmedCutoverBinding();
    const confirmed = await this.localRunOps.confirmAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: session.requestId,
      updateId: session.updateId,
      manifestSha256: session.manifestSha256,
      slotId: cutover.acceptanceBinding.slotId,
      proxyGeneration: cutover.acceptanceBinding.proxyGeneration,
      token,
      now: new Date(this.now()),
    });
    cutover.commitDecided = true;
    this.acceptanceWaiters.get(session.requestId)?.resolve({ state: "confirmed", receipt: confirmed });
    return confirmed;
  }

  async retryLocalRunCutover({ session, token }) {
    const cutover = this.localRunCutover;
    if (!cutover
      || cutover.request.requestId !== session.requestId
      || cutover.request.updateId !== session.updateId
      || cutover.request.manifestSha256 !== session.manifestSha256
      || cutover.state !== "awaiting-retry"
      || !equalSha256(sha256Text(token), session.monitorTokenSha256)) {
      fail("SUPERVISOR_CUTOVER_RETRY_NOT_ALLOWED");
    }
    if (cutover.retryRequested) fail("SUPERVISOR_CUTOVER_RETRY_ALREADY_REQUESTED");
    const gate = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: session.requestId,
    });
    if (gate?.state !== "rollback-required"
      || gate.attempt !== 1
      || gate.binding?.requestId !== session.requestId
      || gate.binding?.updateId !== session.updateId
      || gate.binding?.manifestSha256 !== session.manifestSha256) {
      fail("SUPERVISOR_CUTOVER_RETRY_NOT_ALLOWED");
    }
    await this.verifyRestoredOldActiveForRetry(gate);
    let started;
    try {
      started = await this.localRunOps.startAcceptanceRetry({
        stateRoot: this.localRunControllerStateRoot,
        requestId: session.requestId,
        updateId: session.updateId,
        manifestSha256: session.manifestSha256,
        slotId: gate.binding.slotId,
        proxyGeneration: gate.binding.proxyGeneration,
        oldActiveSlotId: gate.oldActiveSlotId,
        oldActiveRestored: true,
        retryToken: token,
        now: new Date(this.now()),
      });
    } catch (error) {
      if (errorCode(error) === "ACCEPTANCE_GATE_RETRY_CHOICE_EXPIRED") {
        const terminal = await this.localRunOps.recoverAcceptanceGate({
          stateRoot: this.localRunControllerStateRoot,
          requestId: session.requestId,
        });
        cutover.retryResolve?.({ expired: true, receipt: terminal });
      }
      throw error;
    }
    cutover.retryRequested = true;
    cutover.retryToken = started.retryToken;
    cutover.retryReceipt = started.receipt;
    cutover.retryResolve?.({ token, retryToken: started.retryToken, receipt: started.receipt });
    return { state: "retry-requested", attempt: 2, terminal: false };
  }

  async verifyRestoredOldActiveForRetry(gate) {
    const child = this.assertBackendOnline("SUPERVISOR_CUTOVER_RETRY_OLD_ACTIVE_OFFLINE");
    const active = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    const controller = await this.localRunOps.readActiveTargetReceipt({
      stateRoot: this.localRunControllerStateRoot,
    });
    const proxyStatus = this.localRunProxy?.status();
    if (!active
      || active.slotId !== gate.oldActiveSlotId
      || controller?.target?.slotId !== active.slotId
      || controller.target?.receiptSha256 !== active.receipt?.receiptSha256
      || controller.target?.slotRole !== "active"
      || controller.target?.host !== "127.0.0.1"
      || Number(controller.target?.port) !== this.localRunActivePort
      || proxyStatus?.mode !== "active"
      || proxyStatus?.generation !== controller.generation
      || proxyStatus?.targetSlotId !== active.slotId) {
      fail("SUPERVISOR_CUTOVER_RETRY_OLD_ACTIVE_BINDING_MISMATCH");
    }
    const direct = await this.verifyBackendHealth();
    const publicHealth = await this.probeBackend({
      url: `http://127.0.0.1:${this.localRunPublicPort}/api/health/local-update-ready`,
      viaProxy: true,
    });
    const expectedVersion = String(active.receipt?.source?.version || "").trim();
    for (const health of [direct, publicHealth]) {
      if (!health?.runtime
        || health.runtime.slotRole !== "active"
        || health.runtime.updateProbeMode === true
        || (expectedVersion && health.runtime.version !== expectedVersion)
        || Number(health.runtime.pid) !== Number(child.pid)) {
        fail("SUPERVISOR_CUTOVER_RETRY_OLD_ACTIVE_HEALTH_MISMATCH");
      }
    }
    return { active, controller };
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
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bonni-Update-Monitor");
      response.setHeader("Access-Control-Max-Age", "600");
      response.setHeader("Vary", "Origin");
      response.end();
      return;
    }

    const target = new URL(request.url || "/", this.installationMonitorOrigin || "http://127.0.0.1");
    if (target.pathname === "/health" && request.method === "GET") {
      writeMonitorJson(response, 200, {
        schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
        ok: true,
        role: "installation-server",
        state: "ready",
      }, origin);
      return;
    }
    const statusRequest = target.pathname === "/api/local-update/status" && request.method === "GET";
    const confirmRequest = target.pathname === "/api/local-update/confirm" && request.method === "POST";
    const retryRequest = target.pathname === "/api/local-update/retry" && request.method === "POST";
    if (!statusRequest && !confirmRequest && !retryRequest) {
      if (["/health", "/api/local-update/status", "/api/local-update/confirm", "/api/local-update/retry"]
        .includes(target.pathname)) {
        writeMonitorJson(response, 405, { ok: false, error: "MONITOR_METHOD_NOT_ALLOWED" }, origin);
        return;
      }
      writeMonitorJson(response, 404, { ok: false, error: "MONITOR_ROUTE_NOT_FOUND" }, origin);
      return;
    }

    const token = String(request.headers["x-bonni-update-monitor"] || "").trim();
    let body = null;
    if (confirmRequest || retryRequest) body = await readMonitorJsonBody(request);
    const requestId = String((statusRequest ? target.searchParams.get("requestId") : body?.requestId) || "").trim();
    if (!REQUEST_ID.test(requestId) || !MONITOR_TOKEN.test(token)) {
      writeMonitorJson(response, 401, { ok: false, error: "MONITOR_AUTH_INVALID" }, origin);
      return;
    }
    const session = await this.monitorSession(requestId);
    if (!session || !equalSha256(sha256Text(token), session.monitorTokenSha256)) {
      writeMonitorJson(response, 401, { ok: false, error: "MONITOR_AUTH_INVALID" }, origin);
      return;
    }
    this.rememberPlainMonitorToken(session, token);

    if (confirmRequest || retryRequest) {
      const keys = Object.keys(body).sort();
      if (keys.join(",") !== "manifestSha256,requestId,updateId"
        || body.requestId !== session.requestId
        || body.updateId !== session.updateId
        || body.manifestSha256 !== session.manifestSha256) {
        writeMonitorJson(response, 409, { ok: false, error: "MONITOR_ACCEPTANCE_BINDING_MISMATCH" }, origin);
        return;
      }
      let result;
      try {
        result = confirmRequest
          ? await this.confirmLocalRunAcceptance({ session, token })
          : await this.retryLocalRunCutover({ session, token });
      } catch (error) {
        if (retryRequest && new Set([
          "SUPERVISOR_CUTOVER_RETRY_NOT_ALLOWED",
          "SUPERVISOR_CUTOVER_RETRY_ALREADY_REQUESTED",
          "SUPERVISOR_CUTOVER_RETRY_OLD_ACTIVE_OFFLINE",
          "SUPERVISOR_CUTOVER_RETRY_OLD_ACTIVE_BINDING_MISMATCH",
          "SUPERVISOR_CUTOVER_RETRY_OLD_ACTIVE_HEALTH_MISMATCH",
          "ACCEPTANCE_GATE_RETRY_CHOICE_EXPIRED",
        ]).has(errorCode(error))) {
          writeMonitorJson(response, 409, {
            schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
            ok: false,
            role: "installation-server",
            error: errorCode(error),
          }, origin);
          return;
        }
        throw error;
      }
      const progress = await this.readMonitorProgress(session);
      writeMonitorJson(response, 200, {
        schemaVersion: LOCAL_UPDATE_MONITOR_SCHEMA,
        ok: true,
        role: "installation-server",
        acceptanceGate: result,
        progress,
        checkedAt: new Date(this.now()).toISOString(),
      }, origin);
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

  diagnosticLogInfo(request) {
    const requestId = String(request?.requestId || "");
    if (!REQUEST_ID.test(requestId)) {
      fail("SUPERVISOR_DIAGNOSTIC_REQUEST_ID_INVALID");
    }
    const fileName = `${requestId}.log`;
    return {
      path: path.join(this.diagnosticLogRoot, fileName),
      relativePath: `${DIAGNOSTIC_LOG_DIRECTORY}/${fileName}`,
      requestId,
    };
  }

  queueDiagnosticLogWrite(operation) {
    const queued = this.diagnosticLogWrite.then(operation);
    this.diagnosticLogWrite = queued.catch(() => {});
    return queued;
  }

  async cleanupDiagnosticLogs({ reserve = 0 } = {}) {
    await this.diagnosticLogWrite;
    await ensureDirectory(this.diagnosticLogRoot);
    const entries = await fs.readdir(this.diagnosticLogRoot, { withFileTypes: true });
    const candidates = [];
    const expiry = this.now() - MAX_UPDATE_DIAGNOSTIC_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !DIAGNOSTIC_LOG_FILE.test(entry.name)) continue;
      const target = path.join(this.diagnosticLogRoot, entry.name);
      const state = await fs.lstat(target).catch(() => null);
      if (!state?.isFile() || state.isSymbolicLink() || state.nlink > 1) continue;
      if (state.mtimeMs < expiry) {
        await fs.rm(target, { force: true });
        continue;
      }
      candidates.push({ target, name: entry.name, mtimeMs: state.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    const keep = Math.max(0, MAX_UPDATE_DIAGNOSTIC_LOG_FILES - Math.max(0, reserve));
    await Promise.all(candidates.slice(keep).map(({ target }) => fs.rm(target, { force: true })));
  }

  async readDiagnosticLog(target) {
    const state = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) return "";
    if (
      !state.isFile()
      || state.isSymbolicLink()
      || state.nlink > 1
      || state.size > MAX_UPDATE_DIAGNOSTIC_LOG_BYTES
    ) {
      fail("SUPERVISOR_DIAGNOSTIC_LOG_UNSAFE");
    }
    return fs.readFile(target, "utf8");
  }

  async beginRequestDiagnostics(request, { resume = false } = {}) {
    const info = this.diagnosticLogInfo(request);
    await this.cleanupDiagnosticLogs({ reserve: 1 });
    await this.queueDiagnosticLogWrite(async () => {
      const existing = await this.readDiagnosticLog(info.path);
      const previous = resume ? existing : "";
      const timestamp = new Date(this.now()).toISOString();
      const header = [
        previous,
        `[${timestamp}] Bonni-Core-Updateauftrag ${resume ? "wiederaufgenommen" : "angenommen"}.`,
        `requestId=${info.requestId}`,
        ...(UPDATE_ID.test(String(request?.updateId || "")) ? [`updateId=${request.updateId}`] : []),
        "",
      ].filter((value, index) => Boolean(value) || index === 0).join("\n");
      const sanitized = sanitizeDiagnosticText(header);
      await writeTextAtomic(
        info.path,
        `${utf8Tail(sanitized, MAX_UPDATE_DIAGNOSTIC_LOG_BYTES - 1)}\n`,
      );
    });
    this.initializedDiagnosticRequests.add(info.requestId);
    return info;
  }

  async ensureRequestDiagnostics(request) {
    const info = this.diagnosticLogInfo(request);
    if (this.initializedDiagnosticRequests.has(info.requestId)) return info;
    const exists = await fs.lstat(info.path).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (exists) await this.readDiagnosticLog(info.path);
    else await this.beginRequestDiagnostics(request);
    this.initializedDiagnosticRequests.add(info.requestId);
    return info;
  }

  async appendRequestDiagnostic(request, value) {
    const info = await this.ensureRequestDiagnostics(request);
    await this.queueDiagnosticLogWrite(async () => {
      const previous = await this.readDiagnosticLog(info.path);
      const sanitized = sanitizeDiagnosticText(`${previous}\n${String(value || "")}`);
      await writeTextAtomic(
        info.path,
        `${utf8Tail(sanitized, MAX_UPDATE_DIAGNOSTIC_LOG_BYTES - 1)}\n`,
      );
    });
    return info;
  }

  async writeStatus({
    request = null,
    status,
    phase,
    message,
    steps,
    error = null,
    acceptanceGate = null,
  }) {
    if (request?.requestId && request?.monitorTokenSha256) {
      await this.rememberMonitorSession(request);
    }
    const diagnosticLog = request?.requestId && REQUEST_ID.test(request.requestId)
      ? this.diagnosticLogInfo(request).relativePath
      : null;
    const diagnostic = error ? deepestStableError(error) : null;
    const supervisorErrorCode = error ? errorCode(error) : null;
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
        error: diagnostic.message,
        errorCode: diagnostic.code,
        ...(diagnostic.detail ? { errorDetail: diagnostic.detail } : {}),
        ...(supervisorErrorCode !== diagnostic.code ? { supervisorErrorCode } : {}),
        failedPhase: phase,
      } : {}),
      ...(diagnosticLog ? { diagnosticLog } : {}),
      ...(acceptanceGate ? { acceptanceGate } : {}),
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

  assertLocalRunRootIsolation() {
    if (!this.localRunEnabled) return;
    const acceptedRunRoots = new Set([
      windowsCaseFoldPath(path.join(this.productRoot, "RUN")),
      windowsCaseFoldPath(path.join(this.productRoot, "RUN_SYSTEM", "program-slots")),
    ]);
    if (!acceptedRunRoots.has(windowsCaseFoldPath(this.localRunRoot))) {
      fail("SUPERVISOR_LOCAL_RUN_ROOT_INVALID", this.localRunRoot);
    }
    if (
      pathsOverlap(this.localRunRoot, this.productionRunSystemRoot)
      || pathsOverlap(this.localRunRoot, this.productionStorageRoot)
    ) {
      fail("SUPERVISOR_LOCAL_RUN_STATE_OVERLAP");
    }
  }

  async ensureLocalRunActiveSlot() {
    if (!this.localRunEnabled) return null;
    this.assertLocalRunRootIsolation();
    await Promise.all([
      ensureDirectory(this.localRunRoot),
      ensureDirectory(this.productionRunSystemRoot),
      ensureDirectory(this.productionStorageRoot),
    ]);
    const existing = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    if (existing) return existing;
    const packageDocument = await readSmallJson(
      path.join(this.backendRoot, "package.json"),
      MAX_REQUEST_BYTES,
      "SUPERVISOR_BACKEND_PACKAGE_INVALID",
    );
    return this.localRunOps.stageProgramTree({
      role: "active",
      sourceRoot: this.productRoot,
      runRoot: this.localRunRoot,
      version: String(packageDocument?.version || "unknown"),
      includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
      excludePaths: ["SYSTEM/backend/node_modules/.bin"],
    });
  }

  async resolveActiveLaunchPlan() {
    await this.ensureLocalRunActiveSlot();
    const runtimeEnvironment = applicationEnvironment();
    const plan = await this.localRunOps.resolveActiveSlotBackend({
      runRoot: this.localRunRoot,
      productRoot: this.productRoot,
      internalPort: this.localRunActivePort,
      publicPort: this.localRunPublicPort,
      productionRunSystemRoot: this.productionRunSystemRoot,
      productionStorageRoot: this.productionStorageRoot,
      productionLogRoot: path.join(this.productionRunSystemRoot, "logs"),
      environment: {
        ...runtimeEnvironment,
        RUNCONTAINER_ROOT: this.localRunRoot,
        RUN_SYSTEM_ROOT: this.productionRunSystemRoot,
        BONNI_STORAGE_ROOT: this.productionStorageRoot,
        ...(this.productionDatabaseUrl ? { DATABASE_URL: this.productionDatabaseUrl } : {}),
      },
    });
    if (pathContains(this.localRunRoot, this.productionRunSystemRoot)
      || pathContains(this.localRunRoot, this.productionStorageRoot)) {
      fail("SUPERVISOR_LOCAL_RUN_STATE_OVERLAP");
    }
    this.activeLaunchPlan = plan;
    return plan;
  }

  async ensureLocalRunProxy() {
    if (!this.localRunEnabled) return null;
    if (this.localRunProxy) return this.localRunProxy;
    const plan = this.activeLaunchPlan || await this.resolveActiveLaunchPlan();
    this.localRunProxy = await this.localRunOps.startLocalRunProxy({
      stateRoot: this.localRunControllerStateRoot,
      publicHost: "127.0.0.1",
      publicPort: this.localRunPublicPort,
      bootstrapTarget: plan.proxyTarget,
      localStartProofToken: process.env.BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN,
      localStartProofOwnerPid: process.env.BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID,
      localStartProofRuntime: () => (
        this.backendLifecycle === "online"
        && Number.isSafeInteger(this.backendChild?.pid)
        && this.backendChild.pid > 0
        && this.backendStartedAt
          ? {
              backendPid: this.backendChild.pid,
              backendStartedAt: this.backendStartedAt,
              supervisorInstanceId: this.instanceId,
            }
          : null
      ),
    });
    return this.localRunProxy;
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
    const localRunPlan = this.localRunEnabled ? await this.resolveActiveLaunchPlan() : null;
    const selectedServerScript = localRunPlan?.args?.[0] || this.serverScript;
    const selectedBackendRoot = localRunPlan?.cwd || this.backendRoot;
    const selectedEnvironment = localRunPlan?.env || {
      ...process.env,
      BONNI_PROGRAM_ROOT: this.programRoot,
      BONNI_PROJECT_ROOT: this.programRoot,
      BONNI_PRODUCT_ROOT: this.productRoot,
      BONNI_MODULE_PACKAGE_ROOT: path.join(this.productRoot, "SYSTEM"),
    };
    const state = await fs.lstat(selectedServerScript).catch(() => null);
    if (!state?.isFile() || state.isSymbolicLink()) {
      fail("SUPERVISOR_BACKEND_ENTRY_MISSING", selectedServerScript);
    }

    this.backendLifecycle = "starting";
    const child = this.forkBackend(selectedServerScript, [], {
      cwd: selectedBackendRoot,
      env: {
        ...selectedEnvironment,
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
    this.backendStartedAt = null;
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
      if (this.backendChild === child) {
        this.backendChild = null;
        this.backendStartedAt = null;
      }
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
          : this.expectedBackendStop
            ? "offline-for-update"
            : "unavailable";
      if (
        this.stopping
        || this.expectedBackendStop
        || this.backendShutdownFailure
      ) return;
      const cutover = this.localRunCutover;
      if (cutover?.promotion && cutover.state === "awaiting-confirmation" && !cutover.commitDecided) {
        try {
          if (this.localRunProxy?.status().mode === "active") {
            this.localRunProxy.fence({ phase: "active-runtime-exit", retryAfterSeconds: 3 });
          }
        } catch {
          // Persistence below is the decision point; a later rollback fences
          // again before touching pointers even if this best-effort fence lost
          // a simultaneous controller race.
        }
        cutover.runtimeFailurePromise ||= this.persistLocalRunRuntimeFailure(
          cutover,
          signal || code || "unknown",
        );
        return;
      }
      if (this.localRunProxy?.status().mode === "active") {
        this.localRunProxy.fence({ phase: "active-runtime-exit", retryAfterSeconds: 3 });
      }
      this.heartbeatState = "backend-unavailable";
      this.heartbeatMessage = `Bonni Core wurde beendet (${signal || code || "unbekannt"}); Neustart läuft.`;
      void this.writeHeartbeat().catch(() => {});
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.backendLifecycle = "starting";
        void this.startBackend()
          .then(() => {
            const proxyStatus = this.localRunProxy?.status();
            if (proxyStatus?.mode === "maintenance" && proxyStatus.phase === "active-runtime-exit") {
              this.localRunProxy.resume();
            }
            return this.writeHeartbeat({ state: "idle", message: "Bonni Core ist bereit." });
          })
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
    this.backendStartedAt = receipt.startedAt;
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
    const wholeSupervisorShutdown = requestId === "supervisor-SIGINT"
      || requestId === "supervisor-SIGTERM";
    if (!child) {
      if (wholeSupervisorShutdown) {
        if (this.backendReceiptWritePromise) {
          await this.backendReceiptWritePromise;
        }
        if (this.backendReceiptCleanupPromise) {
          await this.backendReceiptCleanupPromise;
        }
        await this.waitForPreviousCoreChildExit();
        this.backendShutdownFailure = null;
        this.backendLifecycle = "offline";
        return;
      }
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
      if (!shutdownComplete && !wholeSupervisorShutdown) {
        this.backendShutdownFailure = "SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED";
        this.backendLifecycle = "shutdown-unconfirmed";
        fail("SUPERVISOR_BACKEND_SHUTDOWN_NOT_CONFIRMED", requestId);
      }
      this.backendShutdownFailure = null;
      this.backendLifecycle = wholeSupervisorShutdown ? "offline" : "offline-for-update";
    } finally {
      child.off("message", onShutdownComplete);
    }
  }

  async spawnCandidateBackend(plan) {
    if (this.candidateChild) fail("SUPERVISOR_CANDIDATE_ALREADY_RUNNING");
    const entry = plan?.serverEntry || plan?.args?.[0];
    const state = entry ? await fs.lstat(entry).catch(() => null) : null;
    if (!state?.isFile() || state.isSymbolicLink()) {
      fail("SUPERVISOR_CANDIDATE_ENTRY_MISSING", String(entry || "missing"));
    }
    const child = this.forkBackend(entry, [], {
      cwd: plan.backendRoot || plan.cwd,
      env: plan.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
      child?.kill?.("SIGTERM");
      fail("SUPERVISOR_CANDIDATE_PID_INVALID");
    }
    this.candidateChild = child;
    child.once("exit", () => {
      if (this.candidateChild === child) this.candidateChild = null;
    });
    try {
      await waitForBackendReady(child, this.backendReadyTimeoutMs);
      return child;
    } catch (error) {
      child.kill("SIGTERM");
      await waitForChildExit(child, this.backendTerminateTimeoutMs).catch(() => false);
      if (this.candidateChild === child) this.candidateChild = null;
      throw error;
    }
  }

  async stopCandidateBackend(requestId = "candidate-probe-complete") {
    const child = this.candidateChild;
    if (!child) return;
    let shutdownComplete = false;
    const onMessage = (message) => {
      if (message?.type === "BONNI_BACKEND_SHUTDOWN_COMPLETE" && message.requestId === requestId) {
        shutdownComplete = true;
      }
    };
    child.on("message", onMessage);
    try {
      if (child.connected) {
        child.send({
          type: "BONNI_SUPERVISOR_SHUTDOWN",
          reason: "local-candidate-probe",
          requestId,
        });
      } else child.kill("SIGTERM");
      let exited = await waitForChildExit(child, this.backendGracefulTimeoutMs);
      if (!exited) {
        child.kill("SIGTERM");
        exited = await waitForChildExit(child, this.backendTerminateTimeoutMs);
      }
      if (!exited) {
        child.kill("SIGKILL");
        exited = await waitForChildExit(child, this.backendTerminateTimeoutMs);
      }
      if (!exited) fail("SUPERVISOR_CANDIDATE_DID_NOT_EXIT", requestId);
      if (!shutdownComplete) fail("SUPERVISOR_CANDIDATE_SHUTDOWN_NOT_CONFIRMED", requestId);
    } finally {
      child.off("message", onMessage);
      if (this.candidateChild === child && child.exitCode !== null) this.candidateChild = null;
    }
  }

  async executeCandidateUpdate(request, operation, candidate) {
    const updateScript = path.join(candidate.backendRoot, "scripts", "setup", "update-system.mjs");
    const state = await fs.lstat(updateScript).catch(() => null);
    if (!state?.isFile() || state.isSymbolicLink()) {
      fail("SUPERVISOR_CANDIDATE_UPDATE_ENTRY_MISSING", updateScript);
    }
    const operationArgument = operation === "preflight"
      ? "--preflight"
      : operation === "finalize"
        ? "--finalize"
        : null;
    if (this.activeUpdatePromise) fail("SUPERVISOR_UPDATE_OPERATION_ALREADY_RUNNING");
    const invoked = this.runUpdate(process.execPath, [
      updateScript,
      ...(operationArgument ? [operationArgument] : []),
    ], {
      cwd: candidate.backendRoot,
      env: {
        ...applicationEnvironment({ ...applicationEnvironment(), ...candidate.env }),
        BONNI_PROGRAM_ROOT: candidate.programRoot,
        BONNI_PROJECT_ROOT: candidate.programRoot,
        BONNI_PRODUCT_ROOT: candidate.programRoot,
        BONNI_MODULE_PACKAGE_ROOT: path.join(this.productRoot, "SYSTEM"),
        BONNI_UPDATE_INVOCATION: "local-run-candidate-supervisor",
        ...(operation === "install" ? { BONNI_UPDATE_DEFER_FINALIZE: "1" } : {}),
        BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_ID: request.updateId,
        BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_MANIFEST_SHA256: request.manifestSha256,
      },
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      onOutput: ({ text }) => this.appendRequestDiagnostic(request, text),
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
    const diagnosticInfo = request?.requestId
      ? await this.ensureRequestDiagnostics(request)
      : null;
    if (diagnosticInfo) {
      await this.appendRequestDiagnostic(
        request,
        `[${new Date(this.now()).toISOString()}] Phase ${operation} gestartet.\n`,
      );
    }
    const invoked = this.runUpdate(process.execPath, [
      this.updateScript,
      ...(operationArgument ? [operationArgument] : []),
    ], {
      cwd: this.backendRoot,
      env: {
        ...trustedUpdateEnvironment(),
        BONNI_PROGRAM_ROOT: this.programRoot,
        BONNI_PROJECT_ROOT: this.programRoot,
        BONNI_PRODUCT_ROOT: this.productRoot,
        BONNI_MODULE_PACKAGE_ROOT: path.join(this.productRoot, "SYSTEM"),
        BONNI_UPDATE_INVOCATION: "control-center-supervisor",
        ...(operation === "install" ? { BONNI_UPDATE_DEFER_FINALIZE: "1" } : {}),
        ...(hasExpectedProof ? {
          BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_ID: request.updateId,
          BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_MANIFEST_SHA256: request.manifestSha256,
        } : {}),
      },
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      ...(diagnosticInfo ? {
        onOutput: ({ text }) => this.appendRequestDiagnostic(request, text),
      } : {}),
    });
    const tracked = Promise.resolve(invoked);
    this.activeUpdatePromise = tracked;
    this.activeUpdaterChild = invoked?.child || null;
    try {
      await tracked;
      if (diagnosticInfo) {
        await this.appendRequestDiagnostic(
          request,
          `[${new Date(this.now()).toISOString()}] Phase ${operation} abgeschlossen.\n`,
        );
      }
    } catch (error) {
      if (diagnosticInfo) {
        const diagnostic = deepestStableError(error);
        await this.appendRequestDiagnostic(
          request,
          `[${new Date(this.now()).toISOString()}] Phase ${operation} fehlgeschlagen: ${diagnostic.message}\n`,
        ).catch(() => {});
      }
      throw error;
    } finally {
      if (this.activeUpdatePromise === tracked) {
        this.activeUpdatePromise = null;
        this.activeUpdaterChild = null;
      }
    }
  }

  async verifyBackendHealth() {
    const requiredSuccesses = Math.max(1, Number(this.backendHealthAttempts) || 1);
    const maxAttempts = Math.max(
      requiredSuccesses,
      Number(this.backendHealthMaxAttempts) || requiredSuccesses,
    );
    let lastPayload = null;
    let lastError = null;
    let consecutiveSuccesses = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        lastPayload = await this.probeBackend({
          url: this.backendHealthUrl,
          attempt,
          attempts: requiredSuccesses,
          maxAttempts,
        });
        consecutiveSuccesses += 1;
        lastError = null;
        if (consecutiveSuccesses >= requiredSuccesses) return lastPayload;
      } catch (error) {
        lastError = error;
        consecutiveSuccesses = 0;
        if (!new Set([
          "SUPERVISOR_BACKEND_HEALTH_NOT_READY",
          "SUPERVISOR_BACKEND_HEALTH_UNREACHABLE",
        ]).has(error?.code)) {
          throw error;
        }
      }
      if (attempt < maxAttempts && this.backendHealthIntervalMs > 0) {
        await wait(this.backendHealthIntervalMs);
      }
    }
    if (lastError) throw lastError;
    fail("SUPERVISOR_BACKEND_HEALTH_NOT_READY", "health-stability-not-confirmed");
  }

  async verifyFrontendHealth(slot, { port, surface }) {
    const receiptFiles = Array.isArray(slot?.receipt?.files) ? slot.receipt.files : [];
    const indexPath = "SYSTEM/backend/public/system/index.html";
    const indexReceipt = receiptFiles.find((entry) => entry?.path === indexPath);
    if (!indexReceipt || !SHA256.test(String(indexReceipt.sha256 || ""))) {
      fail("SUPERVISOR_FRONTEND_INDEX_RECEIPT_MISSING", surface);
    }
    const baseUrl = `http://127.0.0.1:${Number(port)}/`;
    const result = await this.localRunOps.probeFrontendSlotHealth({
      baseUrl,
      expectedHtmlSha256: indexReceipt.sha256,
    });
    let assetPath;
    try {
      const parsed = new URL(result?.asset?.url || "", baseUrl);
      if (parsed.origin !== new URL(baseUrl).origin) throw new Error("origin");
      assetPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    } catch {
      fail("SUPERVISOR_FRONTEND_ASSET_PATH_INVALID", surface);
    }
    if (!assetPath
      || assetPath.includes("\\")
      || assetPath.includes("\u0000")
      || path.posix.normalize(assetPath) !== assetPath
      || assetPath === ".."
      || assetPath.startsWith("../")) {
      fail("SUPERVISOR_FRONTEND_ASSET_PATH_INVALID", surface);
    }
    const receiptPath = `SYSTEM/backend/public/system/${assetPath}`;
    const assetReceipt = receiptFiles.find((entry) => entry?.path === receiptPath);
    if (!assetReceipt || !SHA256.test(String(assetReceipt.sha256 || ""))) {
      fail("SUPERVISOR_FRONTEND_ASSET_RECEIPT_MISSING", `${surface}:${receiptPath}`);
    }
    if (String(result?.asset?.sha256 || "") !== assetReceipt.sha256) {
      fail("SUPERVISOR_FRONTEND_ASSET_RECEIPT_MISMATCH", surface);
    }
    return result;
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

  async writeLocalRunPhase(request, phase, message, {
    status = "running",
    error = null,
    acceptanceGate = null,
  } = {}) {
    await this.writeStatus({
      request,
      status,
      phase,
      message,
      error,
      acceptanceGate,
      steps: makeLocalRunSteps(phase, error ? phase : null, new Date(this.now()).toISOString()),
    });
  }

  candidateDataCloneOptions() {
    if (!this.productionDatabaseUrl) fail("SUPERVISOR_PRODUCTION_DATABASE_URL_REQUIRED");
    if (!this.localRunOps.receiptSigningKey) fail("SUPERVISOR_MASTER_KEY_REQUIRED_FOR_CANDIDATE_DATA");
    return {
      runRoot: this.localRunRoot,
      sourceDatabaseUrl: this.productionDatabaseUrl,
      sourceRunSystemRoot: this.productionRunSystemRoot,
      sourceStorageRoot: this.productionStorageRoot,
      receiptSigningKey: this.localRunOps.receiptSigningKey,
      ...(this.localRunOps.withConsistencyBoundary
        ? { withConsistencyBoundary: this.localRunOps.withConsistencyBoundary }
        : {}),
    };
  }

  async cloneAndProbeCandidate(request, candidate, expectedVersion) {
    const dataClone = await this.localRunOps.cloneCandidateData(this.candidateDataCloneOptions());
    this.candidateDataClone = dataClone;
    const plan = await this.localRunOps.buildSlotLaunchPlan("candidate", {
      runRoot: this.localRunRoot,
      installationRoot: this.productRoot,
      environment: applicationEnvironment(),
      serverPorts: {
        active: this.localRunActivePort,
        candidate: this.localRunCandidatePort,
        previous: 4_400,
      },
      localAuthPorts: { active: 4_101, candidate: 4_301, previous: 4_401 },
      moduleManagerPorts: { active: 4_201, candidate: 4_302, previous: 4_402 },
      reservedPorts: [this.localRunPublicPort, this.installationMonitorPort || DEFAULT_MONITOR_PORT],
    });
    const launch = {
      ...plan,
      env: {
        ...applicationEnvironment(),
        ...plan.env,
        ...dataClone.candidateEnvironment,
        BONNI_PRODUCT_ROOT: candidate.programRoot,
        BONNI_PROGRAM_ROOT: candidate.programRoot,
        BONNI_PROJECT_ROOT: candidate.programRoot,
        BONNI_MODULE_PACKAGE_ROOT: path.join(this.productRoot, "SYSTEM"),
        SYSTEM_SLOT_ROLE: "candidate",
        BONNI_PROGRAM_SLOT_ROLE: "candidate",
        SYSTEM_UPDATE_PROBE_MODE: "true",
        SYSTEM_VERSION: expectedVersion,
        BONNI_CORE_IMAGE_VERSION: expectedVersion,
        PORT: String(this.localRunCandidatePort),
      },
    };
    await this.spawnCandidateBackend(launch);
    try {
      const probeUrl = `http://127.0.0.1:${this.localRunCandidatePort}/api/health/update-probe`;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await this.localRunOps.probeCandidate({
          url: probeUrl,
          expectedVersion,
          attempt,
          attempts: 3,
        });
        if (attempt < 3 && this.backendHealthIntervalMs > 0) await wait(this.backendHealthIntervalMs);
      }
    } finally {
      await this.stopCandidateBackend(`${request.requestId}-candidate-probe`);
    }
    await this.localRunOps.cleanupCandidateDataClone({
      ...this.candidateDataCloneOptions(),
      receiptPath: dataClone.receiptPath,
    });
    this.candidateDataClone = null;
    return launch;
  }

  async prepareLocalRunCandidate(request, manifest) {
    const active = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    if (!active) fail("SUPERVISOR_ACTIVE_SLOT_MISSING");
    const installWorkspaceRoot = path.join(this.localRunInstallRoot, "workspace", request.requestId);
    const installProgramSlotsRoot = path.join(installWorkspaceRoot, "program-slots");
    const installCandidate = await this.localRunOps.stageProgramTree({
      role: "candidate",
      sourceRoot: this.productRoot,
      stagingRoot: path.join(installWorkspaceRoot, "copy"),
      runRoot: installProgramSlotsRoot,
      version: active.receipt?.source?.version || "unknown",
      updateId: request.updateId,
      manifestSha256: request.manifestSha256,
      replace: true,
    });
    await this.localRunOps.stageCandidateUpdatePackage({
      installationRoot: this.productRoot,
      candidateProgramRoot: installCandidate.programRoot,
      updateId: request.updateId,
      manifestSha256: request.manifestSha256,
    });
    const dataClone = await this.localRunOps.cloneCandidateData(this.candidateDataCloneOptions());
    this.candidateDataClone = dataClone;
    const candidateRuntime = {
      ...installCandidate,
      backendRoot: path.join(installCandidate.programRoot, "SYSTEM", "backend"),
      env: {
        ...dataClone.candidateEnvironment,
        SYSTEM_SLOT_ROLE: "candidate",
        SYSTEM_UPDATE_PROBE_MODE: "true",
      },
    };
    try {
      for (const operation of ["preflight", "install", "finalize"]) {
        await this.executeCandidateUpdate(request, operation, candidateRuntime);
      }
      // npm creates command shims (and Unix symlinks) below .bin. They are
      // required only while building, never by the running ESM backend, and
      // must not enter the immutable program receipt.
      await fs.rm(path.join(candidateRuntime.backendRoot, "node_modules", ".bin"), {
        recursive: true,
        force: true,
      });
      const targetVersion = String(manifest?.to?.coreVersion || "").trim();
      if (!targetVersion) fail("SUPERVISOR_CANDIDATE_TARGET_VERSION_MISSING");
      const preparedInRunInstall = await this.localRunOps.resealProgramSlot("candidate", {
        runRoot: installProgramSlotsRoot,
        expectedSlotId: installCandidate.slotId,
        version: targetVersion,
        updateId: request.updateId,
        manifestSha256: request.manifestSha256,
      });
      const publishedCandidate = await this.localRunOps.stageProgramTree({
        role: "candidate",
        sourceRoot: preparedInRunInstall.programRoot,
        stagingRoot: path.join(this.localRunInstallRoot, "state", "publish", request.requestId),
        runRoot: this.localRunRoot,
        version: targetVersion,
        updateId: request.updateId,
        manifestSha256: request.manifestSha256,
        replace: true,
        includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
      });
      if (publishedCandidate.receipt?.treeSha256 !== preparedInRunInstall.receipt?.treeSha256
        || publishedCandidate.receipt?.fileCount !== preparedInRunInstall.receipt?.fileCount
        || publishedCandidate.receipt?.totalBytes !== preparedInRunInstall.receipt?.totalBytes) {
        fail("SUPERVISOR_RUN_INSTALL_PUBLISH_MISMATCH", request.requestId);
      }
      return {
        ...publishedCandidate,
        targetVersion,
        dataClone,
        installWorkspaceRoot,
        installReceiptSha256: preparedInRunInstall.receipt?.receiptSha256,
      };
    } catch (error) {
      await this.localRunOps.cleanupCandidateDataClone({
        ...this.candidateDataCloneOptions(),
        receiptPath: dataClone.receiptPath,
      }).catch(() => {});
      this.candidateDataClone = null;
      throw error;
    }
  }

  async loadVerifiedCandidateOpsMigrationSet(candidate, compatibility) {
    const candidateProgramRoot = String(candidate?.programRoot || "");
    if (!path.isAbsolute(candidateProgramRoot)
      || !candidate?.slotId
      || !candidate?.receipt?.receiptSha256
      || !candidate?.receipt?.treeSha256) {
      fail("SUPERVISOR_CANDIDATE_MIGRATION_SLOT_INVALID");
    }
    const verified = await this.localRunOps.resolveProgramSlot("candidate", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    if (!verified
      || verified.slotId !== candidate?.slotId
      || verified.receipt?.receiptSha256 !== candidate?.receipt?.receiptSha256
      || verified.receipt?.treeSha256 !== candidate?.receipt?.treeSha256
      || windowsCaseFoldPath(verified.programRoot) !== windowsCaseFoldPath(candidateProgramRoot)) {
      fail("SUPERVISOR_CANDIDATE_MIGRATION_SLOT_MISMATCH");
    }

    const migrationsDirectory = path.join(
      verified.programRoot,
      "SYSTEM",
      "backend",
      "ops",
      "migrations",
    );
    const migrations = await this.localRunOps.loadOpsMigrations(migrationsDirectory);
    const receiptMigrations = new Map();
    for (const file of verified.receipt.files) {
      const rawPath = String(file?.path || "");
      if (!rawPath || rawPath.includes("\\") || path.posix.normalize(rawPath) !== rawPath) {
        fail("SUPERVISOR_CANDIDATE_MIGRATION_RECEIPT_PATH_INVALID", rawPath || "missing");
      }
      const receiptPath = rawPath.toLocaleLowerCase("en-US");
      if (!receiptPath.startsWith(`${OPS_MIGRATION_RECEIPT_ROOT}/`)) continue;
      const relative = receiptPath.slice(OPS_MIGRATION_RECEIPT_ROOT.length + 1);
      if (relative.includes("/") || !relative.endsWith(".sql")) continue;
      if (receiptMigrations.has(receiptPath)) {
        fail("SUPERVISOR_CANDIDATE_MIGRATION_RECEIPT_DUPLICATE", receiptPath);
      }
      receiptMigrations.set(receiptPath, file);
    }

    if (receiptMigrations.size !== migrations.length) {
      fail("SUPERVISOR_CANDIDATE_MIGRATION_SET_MISMATCH");
    }
    const byReceiptPath = new Map();
    for (const migration of migrations) {
      const receiptPath = `${OPS_MIGRATION_RECEIPT_ROOT}/${migration.name}`;
      const receiptFile = receiptMigrations.get(receiptPath);
      if (!receiptFile || receiptFile.sha256 !== migration.sha256) {
        fail("SUPERVISOR_CANDIDATE_MIGRATION_HASH_MISMATCH", migration.name);
      }
      byReceiptPath.set(receiptPath, migration);
    }

    if (compatibility?.migrationCompatibility === "expand-contract") {
      const declaredPaths = Array.isArray(compatibility.opsMigrations)
        ? compatibility.opsMigrations
        : [];
      const declaredHashes = compatibility.opsMigrationSha256;
      if (!declaredPaths.length || !declaredHashes || typeof declaredHashes !== "object") {
        fail("SUPERVISOR_CANDIDATE_MIGRATION_CONTRACT_INVALID");
      }
      const uniquePaths = new Set();
      for (const declaredPath of declaredPaths) {
        const normalized = String(declaredPath || "").toLocaleLowerCase("en-US");
        const migration = byReceiptPath.get(normalized);
        if (uniquePaths.has(normalized)
          || !migration
          || declaredHashes[normalized] !== migration.sha256) {
          fail("SUPERVISOR_CANDIDATE_MIGRATION_CONTRACT_MISMATCH", normalized || "missing");
        }
        uniquePaths.add(normalized);
      }
    }

    return migrations;
  }

  async migrateLocalRunCandidateDatabase(request, candidate, dataClone, compatibility) {
    const databaseUrl = String(dataClone?.candidateDatabaseUrl || "").trim();
    if (!databaseUrl || dataClone?.candidateEnvironment?.DATABASE_URL !== databaseUrl) {
      fail("SUPERVISOR_CANDIDATE_DATABASE_URL_MISMATCH");
    }
    const migrations = await this.loadVerifiedCandidateOpsMigrationSet(candidate, compatibility);
    const diagnosticLines = [];
    const results = await this.localRunOps.runOpsMigrations({
      databaseUrl,
      includeCanonicalRedundantIfExists: false,
      migrations,
      logger: {
        info(message) {
          diagnosticLines.push(String(message));
        },
      },
    });
    for (const line of diagnosticLines) {
      await this.appendRequestDiagnostic(request, `${line}\n`);
    }
    return results;
  }

  async probePreparedLocalRunCandidate(
    request,
    candidate,
    compatibility,
    { reuseClone = true } = {},
  ) {
    let dataClone = reuseClone ? this.candidateDataClone : null;
    if (!dataClone) {
      dataClone = await this.localRunOps.cloneCandidateData(this.candidateDataCloneOptions());
      this.candidateDataClone = dataClone;
    }
    await this.migrateLocalRunCandidateDatabase(request, candidate, dataClone, compatibility);
    const plan = await this.localRunOps.buildSlotLaunchPlan("candidate", {
      runRoot: this.localRunRoot,
      installationRoot: this.productRoot,
      environment: applicationEnvironment(),
      serverPorts: { active: this.localRunActivePort, candidate: this.localRunCandidatePort, previous: 4_400 },
      localAuthPorts: { active: 4_101, candidate: 4_301, previous: 4_401 },
      moduleManagerPorts: { active: 4_201, candidate: 4_302, previous: 4_402 },
      reservedPorts: [this.localRunPublicPort, this.installationMonitorPort || DEFAULT_MONITOR_PORT],
    });
    const launch = {
      ...plan,
      env: {
        ...applicationEnvironment(),
        ...plan.env,
        ...dataClone.candidateEnvironment,
        BONNI_PRODUCT_ROOT: candidate.programRoot,
        BONNI_PROGRAM_ROOT: candidate.programRoot,
        BONNI_PROJECT_ROOT: candidate.programRoot,
        BONNI_MODULE_PACKAGE_ROOT: path.join(this.productRoot, "SYSTEM"),
        SYSTEM_SLOT_ROLE: "candidate",
        BONNI_PROGRAM_SLOT_ROLE: "candidate",
        SYSTEM_UPDATE_PROBE_MODE: "true",
        SYSTEM_VERSION: candidate.targetVersion,
        BONNI_CORE_IMAGE_VERSION: candidate.targetVersion,
        PORT: String(this.localRunCandidatePort),
      },
    };
    await this.spawnCandidateBackend(launch);
    try {
      const url = `http://127.0.0.1:${this.localRunCandidatePort}/api/health/update-probe`;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await this.localRunOps.probeCandidate({
          url,
          expectedVersion: candidate.targetVersion,
          attempt,
          attempts: 3,
        });
        if (attempt < 3 && this.backendHealthIntervalMs > 0) await wait(this.backendHealthIntervalMs);
      }
      await this.verifyFrontendHealth(candidate, {
        port: this.localRunCandidatePort,
        surface: "candidate",
      });
    } finally {
      await this.stopCandidateBackend(`${request.requestId}-candidate-probe`);
    }
    await this.localRunOps.cleanupCandidateDataClone({
      ...this.candidateDataCloneOptions(),
      receiptPath: dataClone.receiptPath,
    });
    this.candidateDataClone = null;
    return launch;
  }

  async migrateLocalRunProductionDatabase(request, candidate, compatibility) {
    if (compatibility?.migrationCompatibility === "none") return [];
    if (compatibility?.migrationCompatibility !== "expand-contract") {
      fail(
        "SUPERVISOR_PRODUCTION_MIGRATION_CONTRACT_INVALID",
        compatibility?.migrationCompatibility || "missing",
      );
    }
    if (!this.productionDatabaseUrl) fail("SUPERVISOR_PRODUCTION_DATABASE_URL_REQUIRED");
    this.assertBackendOnline("SUPERVISOR_ACTIVE_UNAVAILABLE_BEFORE_PRODUCTION_MIGRATION");

    const migrations = await this.loadVerifiedCandidateOpsMigrationSet(candidate, compatibility);
    const diagnosticLines = [];
    const results = await this.localRunOps.runOpsMigrations({
      databaseUrl: this.productionDatabaseUrl,
      includeCanonicalRedundantIfExists: true,
      migrations,
      logger: {
        info(message) {
          diagnosticLines.push(String(message));
        },
      },
    });
    for (const line of diagnosticLines) {
      await this.appendRequestDiagnostic(request, `${line}\n`);
    }

    this.assertBackendOnline("SUPERVISOR_ACTIVE_CHANGED_DURING_PRODUCTION_MIGRATION");
    await this.verifyBackendHealth();
    return results;
  }

  async rollbackLocalRunCutover(cutover, reason = "cutover-rollback") {
    const proxy = await this.ensureLocalRunProxy();
    if (proxy.status().mode === "active") proxy.fence({ phase: "rollback" });
    // Once a new Active has accepted traffic, rollback may take longer than the
    // confirmation window: an already accepted HTTP write is never aborted.
    // New traffic stays fenced while tunnels may be closed and requests drain.
    for (;;) {
      const drained = await proxy.drain({
        timeoutMs: this.backendGracefulTimeoutMs,
        forceTunnels: true,
        forceRequests: false,
      });
      if (drained?.drained === true && Number(drained?.pending?.requests || 0) === 0) break;
      await wait(Math.max(25, this.backendHealthIntervalMs || 100));
    }
    if (this.backendChild) await this.stopBackend(`${cutover.request.requestId}-${reason}`);
    if (cutover.promotion?.transaction?.transactionId) {
      await this.localRunOps.rollbackCandidatePromotion({
        runRoot: this.localRunRoot,
        transactionId: cutover.promotion.transaction.transactionId,
        expectedNewActiveSlotId: cutover.promotion.transaction.newActiveSlotId,
      });
    }
    this.activeLaunchPlan = null;
    await this.startBackend();
    await this.verifyBackendHealth();
    const restored = this.activeLaunchPlan || await this.resolveActiveLaunchPlan();
    const receipt = await proxy.commitActiveTarget(restored.proxyTarget);
    proxy.resume();
    const restoredActive = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    await this.verifyFrontendHealth(restoredActive, {
      port: this.localRunActivePort,
      surface: "rollback-direct",
    });
    await this.verifyFrontendHealth(restoredActive, {
      port: this.localRunPublicPort,
      surface: "rollback-public",
    });
    cutover.promotion = null;
    cutover.proxyReceipt = receipt;
    cutover.state = "rolled-back";
    return { receipt, restored };
  }

  async performLocalRunCutover(request, candidate, { attempt, token, retryToken = null }) {
    const proxy = await this.ensureLocalRunProxy();
    const cutover = this.localRunCutover;
    cutover.runtimeFailure = null;
    cutover.runtimeFailurePromise = null;
    const oldActivePlan = this.activeLaunchPlan || await this.resolveActiveLaunchPlan();
    let fenced = false;
    try {
      proxy.fence({ phase: "cutover", retryAfterSeconds: 3 });
      fenced = true;
      const drained = await proxy.drain({
        timeoutMs: this.backendGracefulTimeoutMs,
        forceTunnels: false,
        forceRequests: false,
      });
      if (drained?.drained !== true
        || Number(drained?.pending?.requests || 0) > 0
        || Number(drained?.pending?.tunnels || 0) > 0) {
        // The old Active has not been touched yet. Resume it and retry only via
        // a fresh, explicit update attempt rather than risking a partial write.
        proxy.resume();
        fenced = false;
        const pendingRequests = Number(drained?.pending?.requests || 0);
        const pendingTunnels = Number(drained?.pending?.tunnels || 0);
        fail(
          pendingTunnels > 0
            ? "SUPERVISOR_CUTOVER_ACTIVE_TUNNELS_NOT_DRAINED"
            : "SUPERVISOR_CUTOVER_ACTIVE_REQUESTS_NOT_DRAINED",
          `${pendingRequests}:${pendingTunnels}`,
        );
      }
      await this.stopBackend(`${request.requestId}-cutover-${attempt}`);
      const promotion = await this.localRunOps.promoteCandidateProgramSlot({
        runRoot: this.localRunRoot,
        expectedCandidateSlotId: candidate.slotId,
        retentionDays: 14,
      });
      cutover.promotion = promotion;
      this.activeLaunchPlan = null;
      await this.startBackend();
      await this.verifyBackendHealth();
      const promotedActive = await this.localRunOps.resolveProgramSlot("active", {
        runRoot: this.localRunRoot,
        verify: true,
      });
      await this.verifyFrontendHealth(promotedActive, {
        port: this.localRunActivePort,
        surface: "active-direct",
      });
      const newActivePlan = this.activeLaunchPlan || await this.resolveActiveLaunchPlan();
      const proxyReceipt = await proxy.commitActiveTarget(newActivePlan.proxyTarget);
      proxy.resume();
      fenced = false;
      await this.verifyFrontendHealth(promotedActive, {
        port: this.localRunPublicPort,
        surface: "active-public",
      });
      const armOptions = {
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
        updateId: request.updateId,
        manifestSha256: request.manifestSha256,
        oldActiveSlotId: promotion.transaction.oldActiveSlotId,
        proxyReceipt,
        token,
        ttlMs: this.localRunConfirmationTtlMs,
        now: new Date(this.now()),
      };
      const armed = attempt === 1
        ? await this.localRunOps.armAcceptanceGateAfterProxyCommit(armOptions)
        : await this.localRunOps.armAcceptanceRetryAfterProxyCommit({
          ...armOptions,
          retryToken,
        });
      cutover.proxyReceipt = proxyReceipt;
      cutover.acceptanceBinding = armed.receipt.binding;
      cutover.state = "awaiting-confirmation";
      return { armed, oldActivePlan, newActivePlan };
    } catch (error) {
      if (fenced || cutover.promotion) {
        await this.rollbackLocalRunCutover(cutover, `cutover-${attempt}-failed`).catch((rollbackError) => {
          throw lifecycleAggregate("SUPERVISOR_CUTOVER_ROLLBACK_FAILED", error, rollbackError);
        });
      }
      throw error;
    }
  }

  async waitForLocalRunAcceptance(request, armed) {
    const persistedBefore = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
    });
    if (persistedBefore?.state === "confirmed") {
      return { state: "confirmed", receipt: persistedBefore };
    }
    let resolveDecision;
    const decision = new Promise((resolve) => { resolveDecision = resolve; });
    this.acceptanceWaiters.set(request.requestId, { resolve: resolveDecision });
    const persistedAfter = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
    });
    if (persistedAfter?.state === "confirmed") {
      resolveDecision({ state: "confirmed", receipt: persistedAfter });
    }
    if (this.localRunCutover?.runtimeFailure) {
      resolveDecision(this.localRunCutover.runtimeFailure);
    }
    const deadline = Date.parse(armed?.receipt?.deadlineAt || "");
    if (!Number.isFinite(deadline)) fail("SUPERVISOR_ACCEPTANCE_DEADLINE_INVALID");
    let timeoutHandle;
    let timeoutCancelled = false;
    const timeout = new Promise((resolve, reject) => {
      const scheduleEvaluation = () => {
        if (timeoutCancelled) return;
        const remainingMs = Math.max(0, deadline - this.now());
        timeoutHandle = setTimeout(() => {
          void this.localRunOps.evaluateAcceptanceGate({
            stateRoot: this.localRunControllerStateRoot,
            requestId: request.requestId,
            now: new Date(this.now()),
          }).then(
            (receipt) => {
              if (receipt?.state === "armed") {
                // A timer may fire a few milliseconds early (or the wall clock
                // may move backwards). Never interpret `armed` as a timeout;
                // keep the immutable receipt deadline authoritative.
                scheduleEvaluation();
                return;
              }
              resolve({ state: receipt?.state || "missing", receipt });
            },
            reject,
          );
        }, remainingMs > 0 ? remainingMs : 1);
        timeoutHandle.unref?.();
      };
      scheduleEvaluation();
    });
    try {
      return await Promise.race([decision, timeout]);
    } finally {
      timeoutCancelled = true;
      clearTimeout(timeoutHandle);
      this.acceptanceWaiters.delete(request.requestId);
    }
  }

  async retryChoiceDeadlineForRequest(request, gate = null) {
    if (gate?.retryChoiceDeadlineAt) return gate.retryChoiceDeadlineAt;
    const cached = this.monitorSessions.get(request.requestId);
    if (cached) {
      if (!this.monitorSessionMatches(cached, request)) {
        fail("SUPERVISOR_MONITOR_ACCESS_BINDING_MISMATCH");
      }
      return new Date(cached.expiresAtMs).toISOString();
    }
    const recovered = await this.recoveryMonitorRequest();
    if (!recovered
      || recovered.requestId !== request.requestId
      || recovered.updateId !== request.updateId
      || recovered.manifestSha256 !== request.manifestSha256
      || recovered.monitorTokenSha256 !== request.monitorTokenSha256) {
      return null;
    }
    return recovered.monitorExpiresAt || null;
  }

  async bindOrExpireLocalRunRetryChoice(request, gate = null, { abandon = false } = {}) {
    let current = gate || await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
    });
    if (current?.state === "failed-old-active") return current;
    if (current?.state === "armed") {
      current = await this.localRunOps.failAcceptanceGate({
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
        failureCode: abandon ? "SUPERVISOR_STOPPING" : "ACCEPTANCE_DECISION_INTERRUPTED",
        failureDetail: abandon
          ? "Supervisor stopped after restoring Old Active"
          : "Acceptance ended before a terminal gate decision",
        now: new Date(this.now()),
      });
    }
    if (current?.state !== "rollback-required" || current?.attempt !== 1) {
      fail("SUPERVISOR_CUTOVER_RETRY_GATE_INVALID", current?.state || "missing");
    }

    const deadlineAt = await this.retryChoiceDeadlineForRequest(request, current);
    const nowMs = this.now();
    if (abandon || !deadlineAt || Date.parse(deadlineAt) <= nowMs) {
      current = await this.localRunOps.expireAcceptanceRetryChoice({
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
        failureCode: abandon || !deadlineAt ? "RETRY_ABANDONED" : "RETRY_WINDOW_EXPIRED",
        failureDetail: abandon
          ? "Supervisor is stopping"
          : !deadlineAt
            ? "Monitor grant deadline is unavailable"
            : "Monitor grant expired while Old Active was serving",
        deadlineAt: deadlineAt || new Date(nowMs).toISOString(),
        now: new Date(nowMs),
      });
    } else {
      current = await this.localRunOps.bindAcceptanceRetryChoiceDeadline({
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
        deadlineAt,
        now: new Date(nowMs),
      });
    }
    if (this.localRunCutover?.request?.requestId === request.requestId) {
      this.localRunCutover.retryChoiceDeadlineAt = current.retryChoiceDeadlineAt || deadlineAt;
    }
    return current;
  }

  async waitForExplicitCutoverRetry(request) {
    let gate = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
    });
    if (gate?.state === "rollback-required") {
      gate = await this.bindOrExpireLocalRunRetryChoice(request, gate);
    }
    if (gate?.state === "failed-old-active") {
      return { expired: true, receipt: gate };
    }
    if (this.localRunCutover?.retryRequested && this.localRunCutover.retryToken) {
      const token = this.monitorPlainTokens.get(request.requestId);
      if (!token) fail("SUPERVISOR_MONITOR_TOKEN_NOT_PRESENTED");
      return {
        token,
        retryToken: this.localRunCutover.retryToken,
        receipt: this.localRunCutover.retryReceipt || null,
      };
    }
    let resolveRetry;
    const retry = new Promise((resolve) => { resolveRetry = resolve; });
    this.localRunCutover.retryResolve = resolveRetry;
    if (this.localRunCutover.retryRequested && this.localRunCutover.retryToken) {
      const token = this.monitorPlainTokens.get(request.requestId);
      if (token) resolveRetry({
        token,
        retryToken: this.localRunCutover.retryToken,
        receipt: this.localRunCutover.retryReceipt || null,
      });
    }
    // Re-read after installing the waiter. A retry POST or expiry can win
    // exactly between the status write and this in-memory registration.
    gate = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
    });
    if (gate?.state === "failed-old-active") resolveRetry({ expired: true, receipt: gate });

    const deadlineAt = gate?.retryChoiceDeadlineAt
      || this.localRunCutover.retryChoiceDeadlineAt;
    const deadlineMs = Date.parse(deadlineAt || "");
    if (!Number.isFinite(deadlineMs)) fail("SUPERVISOR_CUTOVER_RETRY_DEADLINE_INVALID");
    let expiryTimer;
    const expiry = new Promise((resolve, reject) => {
      const delayMs = Math.max(0, deadlineMs - this.now());
      expiryTimer = setTimeout(() => {
        void this.localRunOps.expireAcceptanceRetryChoice({
          stateRoot: this.localRunControllerStateRoot,
          requestId: request.requestId,
          failureCode: "RETRY_WINDOW_EXPIRED",
          deadlineAt,
          // The monotonic wait reached the persisted instant. Use at least the
          // exact bound deadline if the wall clock moved backwards meanwhile.
          now: new Date(Math.max(this.now(), deadlineMs)),
        }).then(
          (receipt) => resolve({ expired: true, receipt }),
          async (error) => {
            const persisted = await this.localRunOps.recoverAcceptanceGate({
              stateRoot: this.localRunControllerStateRoot,
              requestId: request.requestId,
            }).catch(() => null);
            if (persisted?.state === "retry-started") {
              resolve({
                token: this.monitorPlainTokens.get(request.requestId),
                retryToken: this.localRunCutover?.retryToken,
                receipt: persisted,
              });
              return;
            }
            if (persisted?.state === "failed-old-active") {
              resolve({ expired: true, receipt: persisted });
              return;
            }
            reject(error);
          },
        );
      }, delayMs > 0 ? delayMs : 1);
      expiryTimer.unref?.();
    });
    try {
      const result = await Promise.race([retry, expiry]);
      if (result?.stopped) fail("SUPERVISOR_STOPPING");
      return result;
    } finally {
      clearTimeout(expiryTimer);
      if (this.localRunCutover) this.localRunCutover.retryResolve = null;
    }
  }

  async terminalizeStartedLocalRunRetry(request) {
    if (!request?.requestId) return null;
    const gate = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
    });
    if (gate?.state !== "retry-started") return gate;
    return this.localRunOps.terminalizeStartedAcceptanceRetry({
      stateRoot: this.localRunControllerStateRoot,
      requestId: request.requestId,
      now: new Date(this.now()),
    });
  }

  async persistLocalRunRuntimeFailure(cutover, detail = "unknown") {
    let delayMs = 25;
    for (;;) {
      if (this.stopping || this.localRunCutover !== cutover) return null;
      try {
        const receipt = await this.localRunOps.failAcceptanceGate({
          stateRoot: this.localRunControllerStateRoot,
          requestId: cutover.request.requestId,
          failureCode: "NEW_ACTIVE_RUNTIME_EXITED",
          failureDetail: String(detail),
          now: new Date(this.now()),
        });
        const failure = {
          state: "backend-failed",
          receipt,
          error: new SupervisorError("SUPERVISOR_NEW_ACTIVE_EXITED_BEFORE_CONFIRMATION"),
        };
        cutover.runtimeFailure = failure;
        this.acceptanceWaiters.get(cutover.request.requestId)?.resolve(failure);
        return failure;
      } catch (error) {
        const gate = await this.localRunOps.recoverAcceptanceGate({
          stateRoot: this.localRunControllerStateRoot,
          requestId: cutover.request.requestId,
        }).catch(() => null);
        if (gate?.state === "confirmed") {
          // Confirmation and process exit can cross between the durable gate
          // write and the in-memory flag. The durable confirmation wins: keep
          // the promoted pointer, restart exactly that Active generation, and
          // only then wake the commit path.
          cutover.commitDecided = true;
          cutover.state = "commit-pending";
          cutover.acceptanceBinding = gate.binding;
          await this.restoreConfirmedActiveAfterRuntimeExit(cutover, gate);
          const confirmed = { state: "confirmed", receipt: gate };
          cutover.runtimeFailure = confirmed;
          this.acceptanceWaiters.get(cutover.request.requestId)?.resolve(confirmed);
          return confirmed;
        }
        this.heartbeatState = "failed";
        this.heartbeatMessage = `Runtime-Ausfall wird sicher protokolliert: ${safeErrorMessage(error)}`;
        await this.writeHeartbeat().catch(() => {});
      }
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }

  async restoreConfirmedActiveAfterRuntimeExit(cutover, gate) {
    let delayMs = 25;
    for (;;) {
      if (this.stopping || this.localRunCutover !== cutover) return false;
      try {
        const current = await this.localRunOps.readActiveTargetReceipt({
          stateRoot: this.localRunControllerStateRoot,
        });
        const proxyStatus = this.localRunProxy?.status();
        if (!current
          || current.generation !== gate.binding?.proxyGeneration
          || current.target?.slotId !== gate.binding?.slotId
          || current.target?.slotRole !== "active"
          || proxyStatus?.generation !== gate.binding?.proxyGeneration
          || proxyStatus?.targetSlotId !== gate.binding?.slotId) {
          fail("SUPERVISOR_CONFIRMED_RUNTIME_RECOVERY_BINDING_MISMATCH");
        }
        if (!this.backendChild) {
          this.activeLaunchPlan = null;
          await this.startBackend();
        }
        await this.verifyBackendHealth();
        if (proxyStatus.mode !== "active") this.localRunProxy.resume();
        await this.probeBackend({
          url: `http://127.0.0.1:${this.localRunPublicPort}/api/health/local-update-ready`,
          viaProxy: true,
        });
        return true;
      } catch (error) {
        this.heartbeatState = "commit-pending";
        this.heartbeatMessage = `Bestätigter Bonni Core wird wiederhergestellt: ${safeErrorMessage(error)}`;
        await this.writeHeartbeat().catch(() => {});
      }
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }

  async recoveryMonitorRequest() {
    const claim = await this.recoveryClaimedRequest();
    const rawMonitor = await readSmallJson(
      this.monitorAccessPath,
      MAX_MONITOR_ACCESS_BYTES,
      "SUPERVISOR_MONITOR_ACCESS_INVALID",
    );
    const session = rawMonitor ? validatePersistedMonitorIdentity(rawMonitor) : null;
    if (claim && session && (
      claim.requestId !== session.requestId
      || claim.updateId !== session.updateId
      || claim.manifestSha256 !== session.manifestSha256
      || claim.monitorTokenSha256 !== session.monitorTokenSha256
    )) {
      fail("SUPERVISOR_RECOVERY_MONITOR_PROOF_MISMATCH");
    }
    const identity = claim || session;
    if (!identity) return null;
    return Object.freeze({
      requestId: identity.requestId,
      updateId: identity.updateId,
      manifestSha256: identity.manifestSha256,
      monitorTokenSha256: identity.monitorTokenSha256,
      monitorExpiresAt: session?.expiresAt || null,
      monitorExpiresAtMs: session?.expiresAtMs || null,
    });
  }

  async recoveryClaimedRequest() {
    const rawClaim = await readSmallJson(
      this.processingPath,
      MAX_REQUEST_BYTES,
      "SUPERVISOR_REQUEST_INVALID",
    );
    return rawClaim ? validateClaimedRecoveryRequest(rawClaim) : null;
  }

  async recoverConfirmedCutoverWithoutMonitor({ promotion, proxyReceipt }) {
    if (!new Set(["decision-required", "committed"]).has(promotion?.status)) return null;
    const transaction = promotion.transaction;
    const claimed = await this.recoveryClaimedRequest();
    if (!claimed || !transaction) return null;
    const confirmedGate = await this.localRunOps.recoverAcceptanceGate({
      stateRoot: this.localRunControllerStateRoot,
      requestId: claimed.requestId,
    });
    if (confirmedGate?.state !== "confirmed") return null;
    const active = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    if (!active
      || active.slotId !== transaction.newActiveSlotId
      || confirmedGate.binding?.requestId !== claimed.requestId
      || confirmedGate.binding?.updateId !== claimed.updateId
      || confirmedGate.binding?.manifestSha256 !== claimed.manifestSha256
      || confirmedGate.tokenSha256 !== claimed.monitorTokenSha256
      || confirmedGate.binding?.slotId !== active.slotId
      || confirmedGate.binding?.proxyGeneration !== proxyReceipt?.generation
      || proxyReceipt?.public?.host !== "127.0.0.1"
      || Number(proxyReceipt?.public?.port) !== this.localRunPublicPort
      || proxyReceipt?.target?.slotId !== active.slotId
      || proxyReceipt?.target?.slotRole !== "active"
      || proxyReceipt?.target?.host !== "127.0.0.1"
      || Number(proxyReceipt?.target?.port) !== this.localRunActivePort
      || proxyReceipt?.target?.receiptSha256 !== active.receipt?.receiptSha256) {
      return null;
    }
    const request = Object.freeze({
      requestId: claimed.requestId,
      updateId: claimed.updateId,
      manifestSha256: claimed.manifestSha256,
      monitorTokenSha256: claimed.monitorTokenSha256,
      monitorExpiresAt: null,
      monitorExpiresAtMs: null,
    });
    if (promotion.status === "committed") {
      return {
        state: "confirmed-committed",
        request,
        acceptanceGate: confirmedGate,
      };
    }
    const candidate = {
      ...active,
      backendRoot: path.join(active.programRoot, "SYSTEM", "backend"),
      targetVersion: active.receipt?.source?.version || "unknown",
    };
    this.localRunCutover = {
      request,
      candidate,
      state: "commit-pending",
      promotion: { transaction },
      proxyReceipt,
      acceptanceBinding: confirmedGate.binding,
      retryRequested: false,
      retryToken: null,
      retryResolve: null,
      commitDecided: true,
    };
    return {
      state: "confirmed-pending",
      request,
      candidate,
      acceptanceGate: confirmedGate,
    };
  }

  async commitControllerToCurrentActive(currentReceipt = null) {
    this.activeLaunchPlan = null;
    const plan = await this.resolveActiveLaunchPlan();
    if (currentReceipt?.target?.slotId === plan.slotId
      && currentReceipt.target.receiptSha256 === plan.receiptSha256
      && currentReceipt.target.slotRole === "active"
      && currentReceipt.target.host === "127.0.0.1"
      && Number(currentReceipt.target.port) === this.localRunActivePort
      && currentReceipt.public?.host === "127.0.0.1"
      && Number(currentReceipt.public?.port) === this.localRunPublicPort) {
      return currentReceipt;
    }
    return this.localRunOps.commitActiveTarget({
      stateRoot: this.localRunControllerStateRoot,
      publicHost: "127.0.0.1",
      publicPort: this.localRunPublicPort,
      expectedGeneration: currentReceipt?.generation || 0,
      target: plan.proxyTarget,
    });
  }

  async recoverLocalRunState() {
    if (!this.localRunEnabled) return null;
    await this.ensureLocalRunActiveSlot();
    let request = null;
    let recoveryIdentityError = null;
    try {
      request = await this.recoveryMonitorRequest();
    } catch (error) {
      recoveryIdentityError = error;
    }
    const processingPresent = await fs.lstat(this.processingPath).then(
      (state) => state.isFile() && !state.isSymbolicLink(),
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      },
    );
    let candidateDataRecovery = null;
    let candidateDataRecoveryError = null;
    try {
      if (!recoveryIdentityError) {
        candidateDataRecovery = await this.localRunOps.recoverCandidateDataCloneAtStartup(
          this.candidateDataCloneOptions(),
        );
      }
    } catch (error) {
      // A forged/ambiguous receipt must never trigger a database operation. Keep
      // the productive Active pointer untouched, start it normally, and expose
      // the recovery failure only after the public runtime is back online.
      candidateDataRecoveryError = error;
    }
    const promotion = await this.localRunOps.recoverProgramSlotPromotion({ runRoot: this.localRunRoot });
    this.activeLaunchPlan = null;
    const bootstrapPlan = await this.resolveActiveLaunchPlan();
    const proxyReceipt = (await this.localRunOps.recoverActiveTarget({
      stateRoot: this.localRunControllerStateRoot,
      publicHost: "127.0.0.1",
      publicPort: this.localRunPublicPort,
      bootstrapTarget: bootstrapPlan.proxyTarget,
    })).receipt;
    if (recoveryIdentityError) {
      // UI monitor access is deliberately fail-closed, but it is not part of
      // the cutover commit authority. A claimed request, terminal acceptance
      // receipt, promoted Active pointer and committed proxy generation are an
      // independent exact proof. This also covers the crash boundary after the
      // promotion transaction itself became `committed` but before terminal UI
      // status and request cleanup were persisted.
      const confirmedRecovery = await this.recoverConfirmedCutoverWithoutMonitor({
        promotion,
        proxyReceipt,
      }).catch(() => null);
      if (confirmedRecovery) return confirmedRecovery;
      if (promotion.status === "decision-required") {
        const transaction = promotion.transaction;
        const proxySlotId = proxyReceipt?.target?.slotId || null;
        if (proxySlotId !== transaction.oldActiveSlotId
          && proxySlotId !== transaction.newActiveSlotId) {
          fail("SUPERVISOR_CUTOVER_RECOVERY_PROXY_AMBIGUOUS", String(proxySlotId || "missing"));
        }
        await this.localRunOps.rollbackCandidatePromotion({
          runRoot: this.localRunRoot,
          transactionId: transaction.transactionId,
          expectedNewActiveSlotId: transaction.newActiveSlotId,
        });
        await this.commitControllerToCurrentActive(proxyReceipt);
      } else if (promotion.status === "rolled-back") {
        // Crash boundary: rollback already restored the old pointer, while the
        // controller receipt can still name the former New Active. Reconcile
        // the receipt before the proxy starts; no monitor identity is required
        // to prove which slot the authoritative pointer selected.
        await this.commitControllerToCurrentActive(proxyReceipt);
      }
      return {
        state: "recovery-identity-failed",
        request: null,
        error: recoveryIdentityError,
      };
    }
    let gate = request
      ? await this.localRunOps.recoverAcceptanceGate({
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
      })
      : null;
    if (gate?.state === "armed") {
      gate = await this.localRunOps.evaluateAcceptanceGate({
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
        now: new Date(this.now()),
      });
    }

    if (promotion.status === "decision-required") {
      const transaction = promotion.transaction;
      if (!request) fail("SUPERVISOR_CUTOVER_RECOVERY_IDENTITY_MISSING");
      const proxySlotId = proxyReceipt?.target?.slotId || null;
      if (proxySlotId === transaction.newActiveSlotId && gate?.state === "confirmed") {
        const active = await this.localRunOps.resolveProgramSlot("active", {
          runRoot: this.localRunRoot,
          verify: true,
        });
        if (gate.binding?.requestId !== request.requestId
          || gate.binding?.updateId !== request.updateId
          || gate.binding?.manifestSha256 !== request.manifestSha256
          || gate.binding?.slotId !== active.slotId
          || gate.binding?.proxyGeneration !== proxyReceipt?.generation
          || proxyReceipt?.target?.receiptSha256 !== active.receipt?.receiptSha256) {
          fail("SUPERVISOR_CUTOVER_RECOVERY_BINDING_MISMATCH");
        }
        const candidate = {
          ...active,
          backendRoot: path.join(active.programRoot, "SYSTEM", "backend"),
          targetVersion: active.receipt?.source?.version || "unknown",
        };
        this.localRunCutover = {
          request,
          candidate,
          state: "commit-pending",
          promotion: { transaction },
          proxyReceipt,
          acceptanceBinding: gate.binding,
          retryRequested: false,
          retryToken: null,
          retryResolve: null,
          commitDecided: true,
        };
        return { state: "confirmed-pending", request, candidate, acceptanceGate: gate };
      }
      if (proxySlotId === transaction.newActiveSlotId && gate?.state === "armed") {
        const active = await this.localRunOps.resolveProgramSlot("active", {
          runRoot: this.localRunRoot,
          verify: true,
        });
        if (gate.binding?.requestId !== request.requestId
          || gate.binding?.updateId !== request.updateId
          || gate.binding?.manifestSha256 !== request.manifestSha256
          || gate.binding?.slotId !== active.slotId
          || gate.binding?.proxyGeneration !== proxyReceipt?.generation
          || proxyReceipt?.target?.receiptSha256 !== active.receipt?.receiptSha256) {
          fail("SUPERVISOR_CUTOVER_RECOVERY_BINDING_MISMATCH");
        }
        const candidate = {
          ...active,
          backendRoot: path.join(active.programRoot, "SYSTEM", "backend"),
          targetVersion: active.receipt?.source?.version || "unknown",
        };
        this.localRunCutover = {
          request,
          candidate,
          state: "awaiting-confirmation",
          promotion: { transaction },
          proxyReceipt,
          acceptanceBinding: gate.binding,
          retryRequested: false,
          retryToken: null,
          retryResolve: null,
          commitDecided: false,
        };
        return { state: "awaiting-confirmation", request, candidate, acceptanceGate: gate };
      }
      if (proxySlotId !== transaction.oldActiveSlotId && proxySlotId !== transaction.newActiveSlotId) {
        fail("SUPERVISOR_CUTOVER_RECOVERY_PROXY_AMBIGUOUS", String(proxySlotId || "missing"));
      }
      await this.localRunOps.rollbackCandidatePromotion({
        runRoot: this.localRunRoot,
        transactionId: transaction.transactionId,
        expectedNewActiveSlotId: transaction.newActiveSlotId,
      });
      await this.commitControllerToCurrentActive(proxyReceipt);
      gate = gate || null;
    }

    if (gate?.state === "retry-started") {
      const retryRecovery = await this.localRunOps.classifyAcceptanceGateRecovery({
        stateRoot: this.localRunControllerStateRoot,
        requestId: request.requestId,
      });
      gate = retryRecovery.action === "terminalize-on-old-active"
        ? await this.localRunOps.terminalizeStartedAcceptanceRetry({
          stateRoot: this.localRunControllerStateRoot,
          requestId: request.requestId,
          now: new Date(this.now()),
        })
        : retryRecovery.receipt;
    }
    if (gate?.state === "failed-old-active" && gate?.attempt === 2) {
      await this.commitControllerToCurrentActive(proxyReceipt);
      return {
        state: "failed-old-active",
        request,
        acceptanceGate: gate,
      };
    }
    if (gate?.state === "rollback-required") {
      if (!request) fail("SUPERVISOR_CUTOVER_RECOVERY_IDENTITY_MISSING");
      const candidate = await this.localRunOps.resolveProgramSlot("candidate", {
        runRoot: this.localRunRoot,
        verify: true,
      });
      if (!candidate) fail("SUPERVISOR_CUTOVER_RETRY_CANDIDATE_MISSING");
      const prepared = {
        ...candidate,
        backendRoot: path.join(candidate.programRoot, "SYSTEM", "backend"),
        targetVersion: candidate.receipt?.source?.version || "unknown",
      };
      this.localRunCutover = {
        request,
        candidate: prepared,
        state: "awaiting-retry",
        promotion: null,
        proxyReceipt: await this.commitControllerToCurrentActive(proxyReceipt),
        acceptanceBinding: gate.binding,
        retryRequested: false,
        retryToken: null,
        retryResolve: null,
        commitDecided: false,
      };
      return { state: "awaiting-retry", request, candidate: prepared, acceptanceGate: gate };
    }
    if (gate?.state === "failed-old-active") {
      await this.commitControllerToCurrentActive(proxyReceipt);
      return { state: "failed-old-active", request, acceptanceGate: gate };
    }
    if (promotion.status === "committed" && gate?.state === "confirmed") {
      const active = await this.localRunOps.resolveProgramSlot("active", {
        runRoot: this.localRunRoot,
        verify: true,
      });
      if (!request
        || gate.binding?.requestId !== request.requestId
        || gate.binding?.updateId !== request.updateId
        || gate.binding?.manifestSha256 !== request.manifestSha256
        || gate.binding?.slotId !== active.slotId
        || gate.binding?.proxyGeneration !== proxyReceipt?.generation
        || proxyReceipt?.target?.receiptSha256 !== active.receipt?.receiptSha256) {
        fail("SUPERVISOR_CUTOVER_RECOVERY_BINDING_MISMATCH");
      }
      return { state: "confirmed-committed", request, acceptanceGate: gate };
    }
    await this.commitControllerToCurrentActive(proxyReceipt);
    if (candidateDataRecoveryError) {
      return {
        state: "candidate-data-recovery-failed",
        request,
        error: candidateDataRecoveryError,
      };
    }
    if (candidateDataRecovery?.status === "cleaned"
      || candidateDataRecovery?.reason === "candidate-clone-intent-cleaned") {
      return {
        state: "candidate-data-cleaned",
        request,
        candidateDataRecovery,
      };
    }
    if (request && processingPresent) {
      return {
        state: "candidate-preparation-interrupted",
        request,
      };
    }
    return null;
  }

  async completeRecoveredConfirmation(recovery, decision) {
    const { request, candidate } = recovery;
    await this.verifyConfirmedCutoverBinding();
    this.localRunCutover.commitDecided = true;
    await this.writeLocalRunPhase(
      request,
      "complete",
      "Bestätigter Backend- und Frontend-Stand wird nach SYSTEM übernommen; ersetzte Dateien werden vorher unter BACKUP gesichert.",
      { status: "running", acceptanceGate: decision.receipt || decision },
    );
    const confirmedProof = decision.receipt || decision;
    await this.localRunOps.commitCanonicalSystem({
      installationRoot: this.productRoot,
      candidateProgramRoot: candidate.programRoot,
      candidateReceipt: candidate.receipt,
      updateId: request.updateId,
      manifestSha256: request.manifestSha256,
      confirmation: {
        ...confirmedProof,
        state: "confirmed",
        binding: {
          ...(confirmedProof?.binding || {}),
          updateId: request.updateId,
          manifestSha256: request.manifestSha256,
          slotId: candidate.slotId,
          candidateReceiptSha256: candidate.receipt?.receiptSha256,
        },
      },
      now: () => new Date(this.now()),
    });
    await this.localRunOps.promoteCandidateControlState({
      installationRoot: this.productRoot,
      candidateProductRoot: candidate.programRoot,
      updateId: request.updateId,
      manifestSha256: request.manifestSha256,
    });
    await this.localRunOps.finalizeProgramSlotPromotion({
      runRoot: this.localRunRoot,
      transactionId: this.localRunCutover.promotion.transaction.transactionId,
    });
    await this.writeLocalRunPhase(request, "complete", "Der bestätigte Bonni Core wurde verbindlich übernommen.", {
      status: "completed",
      acceptanceGate: decision.receipt || decision,
    });
    await fs.rm(this.processingPath, { force: true }).catch(() => {});
    this.localRunCutover = null;
  }

  async reconcileConfirmedLocalRunCommit(recovery, initialError = null) {
    let lastError = initialError;
    let delayMs = 100;
    for (;;) {
      if (lastError) {
        await this.writeLocalRunPhase(
          recovery.request,
          "complete",
          "Die Bestätigung ist verbindlich. Bonni schließt den Kontrollstand erneut und idempotent ab; der neue Core bleibt online.",
          {
            status: "commit-pending",
            error: lastError,
            acceptanceGate: await this.localRunOps.recoverAcceptanceGate({
              stateRoot: this.localRunControllerStateRoot,
              requestId: recovery.request.requestId,
            }).catch(() => null),
          },
        ).catch(() => {});
      }
      if (this.stopping) return false;
      try {
        const gate = await this.localRunOps.recoverAcceptanceGate({
          stateRoot: this.localRunControllerStateRoot,
          requestId: recovery.request.requestId,
        });
        if (gate?.state !== "confirmed") {
          fail("SUPERVISOR_CONFIRMED_COMMIT_GATE_MISSING", gate?.state || "missing");
        }
        await this.completeRecoveredConfirmation(recovery, { state: "confirmed", receipt: gate });
        return true;
      } catch (error) {
        lastError = error;
      }
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, 2_000);
    }
  }

  async verifyConfirmedCutoverBinding() {
    const child = this.assertBackendOnline("SUPERVISOR_CONFIRMED_BACKEND_NOT_ONLINE");
    const directHealth = await this.verifyBackendHealth();
    const publicHealth = await this.probeBackend({
      url: `http://127.0.0.1:${this.localRunPublicPort}/api/health/local-update-ready`,
      viaProxy: true,
    });
    const expected = this.localRunCutover?.acceptanceBinding;
    const current = await this.localRunOps.readActiveTargetReceipt({
      stateRoot: this.localRunControllerStateRoot,
    });
    const active = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    if (!expected
      || !current
      || current.generation !== expected.proxyGeneration
      || current.target?.slotId !== expected.slotId
      || active?.slotId !== expected.slotId
      || current.target?.receiptSha256 !== active?.receipt?.receiptSha256
      || current.target?.slotRole !== "active"
      || current.target?.host !== "127.0.0.1"
      || Number(current.target?.port) !== this.localRunActivePort
      || this.localRunProxy?.status().mode !== "active") {
      fail("SUPERVISOR_ACCEPTANCE_PROXY_BINDING_CHANGED");
    }
    const expectedVersion = String(this.localRunCutover?.candidate?.targetVersion || "").trim();
    for (const [surface, health] of [["direct", directHealth], ["public", publicHealth]]) {
      if (!health?.runtime
        || health.runtime.slotRole !== "active"
        || health.runtime.updateProbeMode === true
        || (expectedVersion && health.runtime.version !== expectedVersion)
        || Number(health.runtime.pid) !== Number(child.pid)) {
        fail("SUPERVISOR_ACCEPTANCE_RUNTIME_BINDING_MISMATCH", surface);
      }
    }
    await this.verifyFrontendHealth(active, {
      port: this.localRunActivePort,
      surface: "confirmed-direct",
    });
    await this.verifyFrontendHealth(active, {
      port: this.localRunPublicPort,
      surface: "confirmed-public",
    });
    return current;
  }

  async verifyRecoveredCommittedCutover(recovery) {
    const child = this.assertBackendOnline("SUPERVISOR_CONFIRMED_BACKEND_NOT_ONLINE");
    const active = await this.localRunOps.resolveProgramSlot("active", {
      runRoot: this.localRunRoot,
      verify: true,
    });
    const controller = await this.localRunOps.readActiveTargetReceipt({
      stateRoot: this.localRunControllerStateRoot,
    });
    const binding = recovery.acceptanceGate?.binding;
    if (!active || !controller || !binding
      || binding.requestId !== recovery.request?.requestId
      || binding.updateId !== recovery.request?.updateId
      || binding.manifestSha256 !== recovery.request?.manifestSha256
      || binding.slotId !== active.slotId
      || binding.proxyGeneration !== controller.generation
      || controller.target?.slotId !== active.slotId
      || controller.target?.receiptSha256 !== active.receipt?.receiptSha256
      || controller.target?.slotRole !== "active"
      || controller.target?.host !== "127.0.0.1"
      || Number(controller.target?.port) !== this.localRunActivePort
      || this.localRunProxy?.status().mode !== "active") {
      fail("SUPERVISOR_CONFIRMED_RECOVERY_BINDING_CHANGED");
    }
    const [directHealth, publicHealth] = await Promise.all([
      this.verifyBackendHealth(),
      this.probeBackend({
        url: `http://127.0.0.1:${this.localRunPublicPort}/api/health/local-update-ready`,
        viaProxy: true,
      }),
    ]);
    const expectedVersion = String(active.receipt?.source?.version || "").trim();
    for (const [surface, health] of [["direct", directHealth], ["public", publicHealth]]) {
      if (!health?.runtime
        || health.runtime.slotRole !== "active"
        || health.runtime.updateProbeMode === true
        || (expectedVersion && health.runtime.version !== expectedVersion)
        || Number(health.runtime.pid) !== Number(child.pid)) {
        fail("SUPERVISOR_CONFIRMED_RECOVERY_RUNTIME_MISMATCH", surface);
      }
    }
    await this.verifyFrontendHealth(active, {
      port: this.localRunActivePort,
      surface: "recovered-confirmed-direct",
    });
    await this.verifyFrontendHealth(active, {
      port: this.localRunPublicPort,
      surface: "recovered-confirmed-public",
    });
  }

  async resumeRecoveredLocalRunState(recovery) {
    if (!recovery) return;
    if (recovery.state === "candidate-data-cleaned"
      || recovery.state === "candidate-data-recovery-failed"
      || recovery.state === "candidate-preparation-interrupted"
      || recovery.state === "recovery-identity-failed") {
      const recoveryError = recovery.error || new SupervisorError(
        "SUPERVISOR_CANDIDATE_PREPARATION_INTERRUPTED",
        recovery.candidateDataRecovery?.cloneId || recovery.state,
      );
      await this.writeLocalRunPhase(
        recovery.request,
        "rollback",
        recovery.state === "recovery-identity-failed"
          ? "Die Recovery-Belege widersprechen sich; Bonni hat keine Candidate-Daten übernommen und hält den bisherigen Core aktiv."
          : recovery.error
          ? "Ein unterbrochener Candidate-Datenstand war nicht eindeutig authentisiert und wurde nicht verändert; der bisherige Bonni Core bleibt aktiv."
          : recovery.state === "candidate-data-cleaned"
            ? "Ein unterbrochener isolierter Candidate-Datenstand wurde authentisiert bereinigt; der bisherige Bonni Core bleibt aktiv."
            : "Eine unterbrochene Candidate-Vorbereitung wurde requestgenau beendet; der bisherige Bonni Core bleibt aktiv.",
        {
          status: "failed",
          error: recoveryError,
        },
      );
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      return;
    }
    if (recovery.state === "confirmed-pending") {
      await this.reconcileConfirmedLocalRunCommit(recovery);
      return;
    }
    if (recovery.state === "confirmed-committed") {
      await this.verifyRecoveredCommittedCutover(recovery);
      await this.writeLocalRunPhase(recovery.request, "complete", "Bestätigter Cutover wurde nach dem Neustart vollständig abgeschlossen.", {
        status: "completed",
        acceptanceGate: recovery.acceptanceGate,
      });
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      return;
    }
    if (recovery.state === "failed-old-active") {
      await this.writeLocalRunPhase(recovery.request, "confirmation", "Auch der zweite Bestätigungszeitraum ist abgelaufen; der alte Bonni Core bleibt aktiv.", {
        status: "failed",
        error: new SupervisorError("SUPERVISOR_ACCEPTANCE_SECOND_TIMEOUT"),
        acceptanceGate: recovery.acceptanceGate,
      });
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      return;
    }

    let state = recovery.state;
    let request = recovery.request;
    let candidate = recovery.candidate;
    if (state === "awaiting-confirmation") {
      await this.writeLocalRunPhase(request, "confirmation", "Manuelle Bestätigung läuft nach dem Controller-Neustart mit demselben Beleg weiter.", {
        status: "awaiting-confirmation",
        acceptanceGate: recovery.acceptanceGate,
      });
      const decision = await this.waitForLocalRunAcceptance(request, { receipt: recovery.acceptanceGate });
      if (decision.state === "confirmed") {
        this.localRunCutover.commitDecided = true;
        await this.reconcileConfirmedLocalRunCommit(recovery);
        return;
      }
      await this.rollbackLocalRunCutover(this.localRunCutover, "recovered-confirmation-timeout");
      this.localRunCutover.state = "awaiting-retry";
      state = "awaiting-retry";
      await this.writeLocalRunPhase(request, "confirmation", "Bestätigung fehlte; der alte Bonni Core läuft wieder. Ein einziger neuer Umschaltversuch ist möglich.", {
        status: "awaiting-retry",
        acceptanceGate: decision.receipt,
      });
    }
    if (state !== "awaiting-retry") return;
    const retryCommand = await this.waitForExplicitCutoverRetry(request);
    if (retryCommand?.expired) {
      await this.writeLocalRunPhase(request, "confirmation", "Das Zeitfenster für den einzigen Wiederholungsversuch ist abgelaufen; der alte Bonni Core bleibt aktiv.", {
        status: "failed",
        error: new SupervisorError("SUPERVISOR_ACCEPTANCE_RETRY_WINDOW_EXPIRED"),
        acceptanceGate: retryCommand.receipt,
      });
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      this.localRunCutover = null;
      return;
    }
    try {
      const { manifest } = await verifyRequestedManifest({ productRoot: this.productRoot, request });
      const compatibility = this.localRunOps.assertLocalCandidateCompatibility(manifest);
      await this.probePreparedLocalRunCandidate(
        request,
        candidate,
        compatibility,
        { reuseClone: false },
      );
      const { armed } = await this.performLocalRunCutover(request, candidate, {
        attempt: 2,
        token: retryCommand.token,
        retryToken: retryCommand.retryToken,
      });
      await this.writeLocalRunPhase(request, "confirmation", "Zweiter Cutover läuft; die letzte manuelle Bestätigung wird erwartet.", {
        status: "awaiting-confirmation",
        acceptanceGate: armed.receipt,
      });
      const decision = await this.waitForLocalRunAcceptance(request, armed);
      if (decision.state === "confirmed") {
        this.localRunCutover.commitDecided = true;
        await this.reconcileConfirmedLocalRunCommit({ request, candidate });
        return;
      }
      await this.rollbackLocalRunCutover(this.localRunCutover, "recovered-second-timeout");
      const terminal = decision.receipt?.state === "failed-old-active"
        ? decision.receipt
        : await this.localRunOps.evaluateAcceptanceGate({
          stateRoot: this.localRunControllerStateRoot,
          requestId: request.requestId,
          now: new Date(this.now()),
        });
      await this.writeLocalRunPhase(request, "confirmation", "Auch der zweite Bestätigungszeitraum ist abgelaufen; der alte Bonni Core bleibt aktiv.", {
        status: "failed",
        error: new SupervisorError("SUPERVISOR_ACCEPTANCE_SECOND_TIMEOUT"),
        acceptanceGate: terminal,
      });
    } catch (error) {
      if (this.localRunCutover?.promotion) {
        await this.rollbackLocalRunCutover(this.localRunCutover, "recovered-second-attempt-failed").catch(() => {});
      }
      const terminal = await this.terminalizeStartedLocalRunRetry(request).catch(() => null);
      await this.writeLocalRunPhase(request, "confirmation", "Der einzige Wiederholungsversuch ist fehlgeschlagen; der alte Bonni Core bleibt aktiv.", {
        status: "failed",
        error,
        acceptanceGate: terminal || { state: "failed-old-active", attempt: 2, terminal: true },
      });
    } finally {
      if (this.candidateChild) {
        await this.stopCandidateBackend(`${request?.requestId || "unknown"}-recovery-cleanup`).catch(() => {});
      }
      if (this.candidateDataClone) {
        await this.localRunOps.cleanupCandidateDataClone({
          ...this.candidateDataCloneOptions(),
          receiptPath: this.candidateDataClone.receiptPath,
        }).catch(() => {});
        this.candidateDataClone = null;
      }
      await fs.rm(this.processingPath, { force: true }).catch(() => {});
      this.localRunCutover = null;
    }
  }

  async processLocalRunClaimedRequest() {
    let request = null;
    let candidate = null;
    let phase = "validate";
    this.busy = true;
    try {
      request = await this.readClaimedRequest();
      // A claimed request has a durable, one-hour Monitor grant even when a
      // test/repair launcher entered the claimed workflow directly. Its expiry
      // later becomes the immutable upper bound for choosing the sole retry.
      await this.rememberMonitorSession(request);
      await this.beginRequestDiagnostics(request);
      await this.writeLocalRunPhase(request, phase, "Updateauftrag und signiertes Core-Paket werden geprüft.");
      const { manifest } = await verifyRequestedManifest({ productRoot: this.productRoot, request });
      const compatibility = this.localRunOps.assertLocalCandidateCompatibility(manifest);

      phase = "candidate-copy";
      await this.writeLocalRunPhase(request, phase, "Der laufende Bonni Core bleibt online; sein geprüfter Programmstand wird isoliert kopiert.");
      candidate = await this.prepareLocalRunCandidate(request, manifest);

      phase = "build";
      await this.writeLocalRunPhase(request, phase, "Das Update wurde ausschließlich im getrennten Candidate aufgebaut und versiegelt.");

      phase = "start";
      await this.writeLocalRunPhase(request, phase, "Candidate startet isoliert auf Port 4300 mit eigener Datenbank und eigenem Speicher.");
      await this.probePreparedLocalRunCandidate(request, candidate, compatibility);

      phase = "health";
      await this.writeLocalRunPhase(request, phase, "Candidate wurde dreimal mit Version, Rolle, Datenbank und Modulen geprüft.");
      this.assertBackendOnline("SUPERVISOR_ACTIVE_CHANGED_DURING_CANDIDATE_BUILD");

      if (compatibility.migrationCompatibility === "expand-contract") {
        phase = "migration";
        await this.writeLocalRunPhase(
          request,
          phase,
          "Candidate ist geprüft; die rückwärtskompatible Expand-Migration wird auf der normalen und vorhandenen redundanten Datenbank angewendet.",
        );
        await this.migrateLocalRunProductionDatabase(request, candidate, compatibility);
      }

      const token = await this.waitForPlainMonitorToken(request);
      this.localRunCutover = {
        request,
        candidate,
        state: "prepared",
        promotion: null,
        proxyReceipt: null,
        acceptanceBinding: null,
        retryRequested: false,
        retryToken: null,
        retryResolve: null,
        commitDecided: false,
      };

      let retryCommand = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt === 2) {
          await this.probePreparedLocalRunCandidate(
            request,
            candidate,
            compatibility,
            { reuseClone: false },
          );
        }
        phase = "cutover";
        await this.writeLocalRunPhase(
          request,
          phase,
          attempt === 1
            ? "Candidate ist bereit; laufende Anfragen werden entleert und atomar umgeschaltet."
            : "Der einmalige zweite Umschaltversuch wird mit demselben versiegelten Candidate durchgeführt.",
        );
        const { armed } = await this.performLocalRunCutover(request, candidate, {
          attempt,
          token,
          retryToken: retryCommand?.retryToken || null,
        });
        phase = "confirmation";
        await this.writeLocalRunPhase(request, phase, "Neuer Bonni Core läuft. Manuelle Bestätigung wird 60 Sekunden erwartet.", {
          status: "awaiting-confirmation",
          acceptanceGate: armed.receipt,
        });
        const decision = await this.waitForLocalRunAcceptance(request, armed);
        if (decision.state === "confirmed") {
          this.localRunCutover.commitDecided = true;
          phase = "complete";
          await this.completeRecoveredConfirmation({ request, candidate }, decision);
          await this.writeHeartbeat({ state: "idle", message: "Bonni Core ist bestätigt und bereit." });
          return true;
        }

        await this.rollbackLocalRunCutover(this.localRunCutover, `confirmation-timeout-${attempt}`);
        if (attempt === 2) {
          const terminal = decision.receipt?.state === "failed-old-active"
            ? decision.receipt
            : await this.localRunOps.evaluateAcceptanceGate({
              stateRoot: this.localRunControllerStateRoot,
              requestId: request.requestId,
              now: new Date(this.now()),
            });
          const failure = new SupervisorError(
            "SUPERVISOR_ACCEPTANCE_SECOND_TIMEOUT",
            terminal?.state || "failed-old-active",
          );
          failure.acceptanceGate = terminal;
          throw failure;
        }
        this.localRunCutover.state = "awaiting-retry";
        await this.writeLocalRunPhase(request, "confirmation", "Bestätigung fehlte; der alte Bonni Core läuft wieder. Ein einziger neuer Umschaltversuch ist möglich.", {
          status: "awaiting-retry",
          acceptanceGate: decision.receipt,
        });
        retryCommand = await this.waitForExplicitCutoverRetry(request);
        if (retryCommand?.expired) {
          const failure = new SupervisorError(
            "SUPERVISOR_ACCEPTANCE_RETRY_WINDOW_EXPIRED",
            retryCommand.receipt?.state || "failed-old-active",
          );
          failure.acceptanceGate = retryCommand.receipt;
          throw failure;
        }
      }
      return false;
    } catch (error) {
      if (this.localRunCutover?.commitDecided) {
        return this.reconcileConfirmedLocalRunCommit({ request, candidate }, error);
      }
      if (this.localRunCutover?.promotion && !this.localRunCutover.commitDecided) {
        await this.rollbackLocalRunCutover(this.localRunCutover, "workflow-failed").catch(() => {});
      }
      if (!this.localRunCutover?.commitDecided) {
        const terminal = await this.terminalizeStartedLocalRunRetry(request).catch(() => null);
        if (terminal?.state === "failed-old-active") error.acceptanceGate = terminal;
      }
      if (!this.backendChild && !this.stopping && !this.localRunCutover?.commitDecided) {
        this.activeLaunchPlan = null;
        await this.startBackend().then(() => this.verifyBackendHealth()).catch(() => {});
      }
      await this.writeLocalRunPhase(request, phase, "Die Aktualisierung wurde sicher abgebrochen; der bisherige Bonni Core bleibt aktiv.", {
        status: this.localRunCutover?.commitDecided ? "commit-pending" : "failed",
        error,
        acceptanceGate: error?.acceptanceGate || null,
      }).catch(() => {});
      await this.writeHeartbeat({
        state: this.backendLifecycle === "online" ? "idle" : "failed",
        message: this.backendLifecycle === "online"
          ? "Update fehlgeschlagen; der bisherige Bonni Core läuft weiter."
          : "Update fehlgeschlagen; Bonni Core konnte nicht sicher bestätigt werden.",
      }).catch(() => {});
      return false;
    } finally {
      if (this.candidateChild) await this.stopCandidateBackend(`${request?.requestId || "unknown"}-cleanup`).catch(() => {});
      if (this.candidateDataClone) {
        await this.localRunOps.cleanupCandidateDataClone({
          ...this.candidateDataCloneOptions(),
          receiptPath: this.candidateDataClone.receiptPath,
        }).catch(() => {});
        this.candidateDataClone = null;
      }
      if (!this.localRunCutover?.commitDecided) {
        await fs.rm(this.processingPath, { force: true }).catch(() => {});
        this.localRunCutover = null;
      }
      this.busy = false;
      this.expectedBackendStop = false;
    }
  }

  async processClaimedRequest() {
    assertLocalSourceSupervisorEnabled();
    if (this.localRunEnabled) return this.processLocalRunClaimedRequest();
    let request = null;
    let currentPhase = "validate";
    let completed = false;
    this.busy = true;
    try {
      request = await this.readClaimedRequest();
      await this.beginRequestDiagnostics(request);
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
      if (this.localRunEnabled) await this.ensureLocalRunProxy();

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
      if (request?.requestId) await this.beginRequestDiagnostics(request, { resume: true });
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
      await this.cleanupDiagnosticLogs();
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

      let localRunRecovery = null;
      let recovered = null;
      try {
        if (this.localRunEnabled) localRunRecovery = await this.recoverLocalRunState();
        else recovered = await this.recoverInterruptedUpdate();
      } catch (error) {
        await this.writeHeartbeat({ state: "failed", message: safeErrorMessage(error) });
        throw error;
      }

      if (!localRunRecovery && !recovered && await fs.lstat(this.processingPath).then(() => true, () => false)) {
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
      if (this.localRunEnabled) {
        await this.ensureLocalRunProxy();
        await this.verifyBackendHealth();
        if (localRunRecovery) await this.resumeRecoveredLocalRunState(localRunRecovery);
      } else if (recovered) {
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
    for (const waiter of this.monitorTokenWaiters.values()) {
      waiter.reject(new SupervisorError("SUPERVISOR_STOPPING"));
    }
    this.monitorTokenWaiters.clear();
    for (const waiter of this.acceptanceWaiters.values()) {
      waiter.resolve({ state: "stopping", receipt: null });
    }
    this.acceptanceWaiters.clear();
    if (this.localRunCutover?.retryResolve) {
      this.localRunCutover.retryResolve({ stopped: true });
    }
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
    if (this.candidateChild) {
      await this.stopCandidateBackend(`supervisor-${reason}`).catch(() => {});
    }
    if (this.localRunProxy) {
      await this.localRunProxy.close();
      this.localRunProxy = null;
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
