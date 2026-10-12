import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadDevelopmentLocalKey,
  readDevelopmentTestReady,
} from "./development-package-store.mjs";
import {
  buildSlotLaunchPlan,
  readSlotPointers,
  resolveProgramSlot,
  stageProgramTree,
  verifyProgramSlot,
} from "../runcontainer/runcontainer-lib.mjs";
import {
  cleanupCandidateDataClone,
  cloneCandidateData,
  readCandidateDataCloneIntent,
  readCandidateDataCloneReceipt,
  recoverCandidateDataCloneAtStartup,
} from "../runcontainer/candidate-data-clone.mjs";
import {
  candidateDatabaseConnectionFingerprint,
  cleanupCandidateDatabaseRole,
  deriveCandidateDatabaseRoleName,
  provisionCandidateDatabaseRole,
} from "./development-test-database-role.mjs";

export const DEVELOPMENT_TEST_RUNTIME_STAGE_SCHEMA = "bonni.development-test-runtime-stage/v1";
export const DEVELOPMENT_TEST_RUNTIME_READY_SCHEMA = "bonni.development-test-runtime-ready/v1";
export const DEVELOPMENT_TEST_RUNTIME_STATE_SCHEMA = "bonni.development-test-runtime-state/v1";
export const DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_SCHEMA = "bonni.development-test-runtime-heartbeat/v1";
export const DEVELOPMENT_TEST_RUNTIME_STOP_SCHEMA = "bonni.development-test-runtime-stop/v1";
export const DEVELOPMENT_TEST_RUNTIME_CLEANUP_SCHEMA = "bonni.development-test-runtime-cleanup/v1";

export const DEVELOPMENT_TEST_RUNTIME_PORTS = Object.freeze({
  server: 4300,
  localAuth: 4301,
  moduleManager: 4302,
});

const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEVELOPMENT_RUN_ROOT_NAME = "RUN_DEV";
const SESSION_ROOT_NAME = "development-tests";
const ARCHIVE_ROOT_NAME = "development-test-receipts";
const TERMINAL_LOG_ARCHIVE_ROOT_NAME = "terminal-logs";
const STAGE_FILE = "STAGED.json";
const READY_FILE = "RUNTIME-READY.json";
const STATE_FILE = "RUNTIME-STATE.json";
const HEARTBEAT_FILE = "RUNTIME-HEARTBEAT.json";
const STOP_FILE = "STOP-REQUEST.json";
const LOG_FILE = "terminal.log";
const MAXIMUM_JSON_BYTES = 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_MAX_AGE_MS = 5_000;
const HEARTBEAT_MAX_FUTURE_SKEW_MS = 5_000;
const START_INTENT_GRACE_MS = 15_000;
const STATUS_HEALTH_TIMEOUT_MS = 3_000;
const CLEANUP_QUIESCENCE_TIMEOUT_MS = 10_000;
const MAX_BACKEND_DIAGNOSTIC_TAIL_BYTES = 16 * 1024;
const MAX_BACKEND_DIAGNOSTIC_TAIL_CHARS = 4_000;
const MAXIMUM_TERMINAL_LOG_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_TERMINAL_LOG_ARCHIVE_COUNT = 3;
const TERMINAL_LOG_ARCHIVE_NAME_PATTERN = /^bonni-terminal-[a-f0-9]{64}--[a-f0-9]{64}\.log$/u;
// A Labor candidate is a complete Bonni SYSTEM, not only the Core frontend and
// backend.  This also carries all declared apps plus System-owned addons,
// plugins and bridges into the immutable candidate slot.  The run-container
// copier still applies its fail-closed default exclusions (all .env variants
// except .env.example, keys, secrets, logs, archives, uploads, runtime and
// storage) and only admits backend node_modules as an explicit dependency
// exception below.
const CORE_INCLUDE_PATHS = Object.freeze(["SYSTEM"]);
const ACTIVE_RUNTIME_STATUSES = new Set(["starting", "ready", "stopping"]);
const TERMINAL_RUNTIME_STATUSES = new Set(["stopped", "failed"]);
const CANDIDATE_DATABASE_ROLE_PATTERN = /^bonni_candidate_[a-f0-9]{24}$/u;
const DATABASE_BINDING_MODE_SHARED = "shared-run-system";
const DATABASE_BINDING_MODE_CLONED = "candidate-clone";
// A shared RUN_DEV database contains records written with RUN_SYSTEM's
// runtime keys. Keep the database/data binding compatible with RUN_SYSTEM;
// only the runtime-control token remains candidate-scoped below.
const SHARED_DATABASE_SECRET_NAMES = Object.freeze([
  "MASTER_KEY",
  "JWT_SECRET",
  "MODULE_PRIVATE_DATA_SECRET",
  "PERSONAL_DATA_MASTER_KEY",
  "TWO_FACTOR_ENCRYPTION_KEY",
  "ACCOUNT_RECOVERY_TOKEN_SECRET",
  "FEATURE_MODULE_INSTALLER_TOKEN",
]);
const SHARED_DATABASE_REQUIRED_SECRET_NAMES = Object.freeze([
  "MASTER_KEY",
  "JWT_SECRET",
  "MODULE_PRIVATE_DATA_SECRET",
]);
const CANDIDATE_PLAN_ENVIRONMENT_KEYS = Object.freeze([
  "BONNI_PROJECT_ROOT",
  "BONNI_PROGRAM_ROOT",
  "BONNI_PRODUCT_ROOT",
  "BONNI_MODULE_PACKAGE_ROOT",
  "BONNI_PROGRAM_SLOTS_ROOT",
  "BONNI_RUNTIME_STATE_ROOT",
  "RUN_SYSTEM_ROOT",
  "RUN_SYSTEM_SYSTEM_ROOT",
  "RUN_SYSTEM_STORAGE_ROOT",
  "RUN_SYSTEM_ARCHIV_ROOT",
  "RUNCONTAINER_ROOT",
  "BONNI_STORAGE_ROOT",
  "MEDIA_STORAGE_ROOT",
  "FRONTEND_DIST_ROOT",
  "BONNI_PROGRAM_SLOT_ROOT",
  "SYSTEM_SLOT_NAME",
  "SYSTEM_SLOT_ROLE",
  "PORT",
  "LOCAL_AUTH_PORT",
  "MODULE_MANAGER_PORT",
  "SYSTEM_SERVER_BIND",
  "LOCAL_AUTH_BIND",
  "BONNI_PROGRAM_SLOT_ROLE",
  "BONNI_PROGRAM_SLOT_ID",
  "BONNI_PROGRAM_SLOT_RECEIPT_SHA256",
  "SYSTEM_VERSION",
  "BONNI_CORE_IMAGE_VERSION",
]);
const CANDIDATE_PLAN_REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  "BONNI_PROGRAM_ROOT",
  "BONNI_PRODUCT_ROOT",
  "BONNI_RUNTIME_STATE_ROOT",
  "RUN_SYSTEM_ROOT",
  "RUN_SYSTEM_SYSTEM_ROOT",
  "RUN_SYSTEM_STORAGE_ROOT",
  "RUN_SYSTEM_ARCHIV_ROOT",
  "BONNI_STORAGE_ROOT",
  "MEDIA_STORAGE_ROOT",
  "SYSTEM_SLOT_ROLE",
  "BONNI_PROGRAM_SLOT_ROLE",
  "PORT",
  "LOCAL_AUTH_PORT",
  "MODULE_MANAGER_PORT",
  "SYSTEM_SERVER_BIND",
  "LOCAL_AUTH_BIND",
  "BONNI_PROGRAM_SLOT_ID",
  "BONNI_PROGRAM_SLOT_RECEIPT_SHA256",
  "SYSTEM_VERSION",
  "BONNI_CORE_IMAGE_VERSION",
]);

export class DevelopmentTestRuntimeError extends Error {
  constructor(code, detail = "", cause = undefined) {
    super(detail ? `${code}:${detail}` : code, cause ? { cause } : undefined);
    this.name = "DevelopmentTestRuntimeError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", cause = undefined) {
  throw new DevelopmentTestRuntimeError(code, detail, cause);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signingKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "utf8");
  if (key.length < 32) fail("DEVELOPMENT_TEST_RUNTIME_SIGNING_KEY_REQUIRED");
  return key;
}

function environmentValue(environment, requestedNames) {
  const entries = Object.entries(environment && typeof environment === "object" ? environment : {});
  for (const requested of requestedNames) {
    const match = entries.find(([name, value]) => (
      name.toLowerCase() === requested.toLowerCase() && value !== undefined && value !== null
    ));
    if (match) return String(match[1]);
  }
  return "";
}

function strictChildBaseEnvironment(environment, temporaryRoot) {
  const root = String(temporaryRoot || "").trim();
  if (!root || root.includes("\0") || !path.isAbsolute(root)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CHILD_TEMPORARY_ROOT_INVALID");
  }
  const output = {
    TEMP: path.resolve(root),
    TMP: path.resolve(root),
    TMPDIR: path.resolve(root),
  };
  if (process.platform === "win32") {
    const windowsRoot = environmentValue(environment, ["SystemRoot", "WINDIR"]).trim();
    if (!windowsRoot || windowsRoot.includes("\0") || !path.isAbsolute(windowsRoot)) {
      fail("DEVELOPMENT_TEST_RUNTIME_WINDOWS_ROOT_REQUIRED");
    }
    const trustedWindowsRoot = path.resolve(windowsRoot);
    const trustedSystemDirectory = path.join(trustedWindowsRoot, "System32");
    output.ComSpec = path.join(trustedSystemDirectory, "cmd.exe");
    output.SystemRoot = trustedWindowsRoot;
    output.WINDIR = output.SystemRoot;
    // Match the minimal Bonni-Windows worker environment. The backend may
    // invoke a native Windows helper during startup; without these values a
    // direct RUN_DEV child receives a valid Node runtime but no command
    // processor/PATH context.
    output.PATH = trustedSystemDirectory;
    output.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  return output;
}

function candidateScopedSecret(key, readySha256, purpose) {
  const ready = canonicalHash(readySha256, "DEVELOPMENT_TEST_RUNTIME_READY_HASH_INVALID");
  return crypto.createHmac("sha256", signingKey(key))
    .update(`bonni-development-test\0${ready}\0${purpose}`, "utf8")
    .digest("base64url");
}

function sharedDatabaseSecretOverrides(environment) {
  const selected = {};
  for (const name of SHARED_DATABASE_SECRET_NAMES) {
    const value = environmentValue(environment, [name]).trim();
    if (value) selected[name] = value;
  }
  for (const name of SHARED_DATABASE_REQUIRED_SECRET_NAMES) {
    if (!selected[name]) fail("DEVELOPMENT_TEST_RUNTIME_SHARED_SECRET_BINDING_MISSING", name);
  }
  return Object.freeze(selected);
}

function signDocument(core, key, digestField) {
  const normalizedKey = signingKey(key);
  const digest = sha256(stableStringify(core));
  const withDigest = { ...core, [digestField]: digest };
  const mac = crypto.createHmac("sha256", normalizedKey).update(stableStringify(withDigest)).digest("hex");
  return { ...withDigest, mac };
}

function verifyDocument(raw, key, schema, digestField, code) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== schema) fail(code, "schema");
  const { mac, [digestField]: digest, ...core } = raw;
  if (!HASH_PATTERN.test(String(digest || "")) || sha256(stableStringify(core)) !== digest) {
    fail(code, "checksum");
  }
  const expectedMac = crypto.createHmac("sha256", signingKey(key))
    .update(stableStringify({ ...core, [digestField]: digest }))
    .digest("hex");
  if (!HASH_PATTERN.test(String(mac || ""))
    || !crypto.timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(mac, "hex"))) {
    fail(code, "authentication");
  }
  return raw;
}

function canonicalProductRoot(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.includes("\0")) fail("DEVELOPMENT_TEST_RUNTIME_PRODUCT_ROOT_REQUIRED");
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) fail("DEVELOPMENT_TEST_RUNTIME_PRODUCT_ROOT_UNSAFE");
  return resolved;
}

function canonicalCandidateId(value) {
  const candidateId = String(value || "").trim();
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ID_INVALID");
  return candidateId;
}

function canonicalHash(value, code = "DEVELOPMENT_TEST_RUNTIME_PACKAGE_HASH_INVALID") {
  const hash = String(value || "").trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) fail(code);
  return hash;
}

function canonicalPort(value, fallback, label) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail("DEVELOPMENT_TEST_RUNTIME_PORT_INVALID", label);
  }
  return port;
}

function canonicalPorts(input = {}) {
  const ports = {
    server: canonicalPort(input.server, DEVELOPMENT_TEST_RUNTIME_PORTS.server, "server"),
    localAuth: canonicalPort(input.localAuth, DEVELOPMENT_TEST_RUNTIME_PORTS.localAuth, "local-auth"),
    moduleManager: canonicalPort(input.moduleManager, DEVELOPMENT_TEST_RUNTIME_PORTS.moduleManager, "module-manager"),
  };
  if (new Set(Object.values(ports)).size !== 3) fail("DEVELOPMENT_TEST_RUNTIME_PORT_COLLISION");
  return Object.freeze(ports);
}

function samePorts(left, right) {
  const canonicalLeft = canonicalPorts(left);
  const canonicalRight = canonicalPorts(right);
  return canonicalLeft.server === canonicalRight.server
    && canonicalLeft.localAuth === canonicalRight.localAuth
    && canonicalLeft.moduleManager === canonicalRight.moduleManager;
}

function validPid(value, { nullable = false } = {}) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value > 0);
}

function validIsoTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validOwnerInstanceId(value) {
  return HASH_PATTERN.test(String(value || ""));
}

function pathIsInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowEqual && relative === "")
    || (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function portableRelative(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("DEVELOPMENT_TEST_RUNTIME_PATH_ESCAPE", target);
  }
  return relative.split(path.sep).join("/");
}

function containedPath(root, relative, code = "DEVELOPMENT_TEST_RUNTIME_PATH_ESCAPE") {
  const raw = String(relative || "").replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) fail(code, raw);
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") fail(code, raw);
  const target = path.resolve(root, ...normalized.split("/"));
  if (!pathIsInside(root, target)) fail(code, raw);
  return target;
}

function assertRunDevPath(paths, value, label, { allowEqual = true } = {}) {
  if (typeof value !== "string" || !pathIsInside(paths.developmentRoot, value, allowEqual)) {
    fail("DEVELOPMENT_TEST_RUNTIME_RUN_DEV_BINDING_INVALID", label);
  }
  return path.resolve(value);
}

function assertRunDevPlanBinding(paths, plan) {
  if (!plan || typeof plan !== "object") {
    fail("DEVELOPMENT_TEST_RUNTIME_RUN_DEV_BINDING_INVALID", "launch-plan");
  }
  const planPaths = [
    ["program-root", plan.programRoot],
    ["backend-root", plan.backendRoot],
    ["server-entry", plan.serverEntry],
    ["working-directory", plan.cwd],
    ["slot-root", plan.env?.BONNI_PROGRAM_SLOT_ROOT],
    ["program-slots-root", plan.env?.BONNI_PROGRAM_SLOTS_ROOT],
    ["runcontainer-root", plan.env?.RUNCONTAINER_ROOT],
    ["runtime-state", plan.env?.BONNI_RUNTIME_STATE_ROOT],
    ["run-system", plan.env?.RUN_SYSTEM_ROOT],
    ["run-system-system", plan.env?.RUN_SYSTEM_SYSTEM_ROOT],
    ["run-system-storage", plan.env?.RUN_SYSTEM_STORAGE_ROOT],
    ["run-system-archive", plan.env?.RUN_SYSTEM_ARCHIV_ROOT],
    ["bonni-storage", plan.env?.BONNI_STORAGE_ROOT],
    ["media-storage", plan.env?.MEDIA_STORAGE_ROOT],
    ["frontend-dist", plan.env?.FRONTEND_DIST_ROOT],
  ];
  for (const [label, value] of planPaths) assertRunDevPath(paths, value, label);
  return true;
}

function assertRunDevLaunchBinding(paths, plan, environment) {
  assertRunDevPlanBinding(paths, plan);

  const childPaths = [
    ["child-project-root", environment?.BONNI_PROJECT_ROOT],
    ["child-program-root", environment?.BONNI_PROGRAM_ROOT],
    ["child-product-root", environment?.BONNI_PRODUCT_ROOT],
    ["child-module-package-root", environment?.BONNI_MODULE_PACKAGE_ROOT],
    ["child-program-slots-root", environment?.BONNI_PROGRAM_SLOTS_ROOT],
    ["child-runcontainer-root", environment?.RUNCONTAINER_ROOT],
    ["child-runtime-state", environment?.BONNI_RUNTIME_STATE_ROOT],
    ["child-run-system", environment?.RUN_SYSTEM_ROOT],
    ["child-run-system-system", environment?.RUN_SYSTEM_SYSTEM_ROOT],
    ["child-run-system-storage", environment?.RUN_SYSTEM_STORAGE_ROOT],
    ["child-run-system-archive", environment?.RUN_SYSTEM_ARCHIV_ROOT],
    ["child-bonni-storage", environment?.BONNI_STORAGE_ROOT],
    ["child-media-storage", environment?.MEDIA_STORAGE_ROOT],
    ["child-frontend-dist", environment?.FRONTEND_DIST_ROOT],
    ["child-slot-root", environment?.BONNI_PROGRAM_SLOT_ROOT],
    ["child-run-dev", environment?.RUN_DEV_ROOT],
  ];
  for (const [label, value] of childPaths) assertRunDevPath(paths, value, label);

  const candidateProgramRoot = path.resolve(String(environment?.BONNI_PROGRAM_ROOT || ""));
  const candidateBackendRoot = path.resolve(String(plan.backendRoot || ""));
  const candidateFrontendRoot = path.resolve(String(environment?.FRONTEND_DIST_ROOT || ""));
  if (!pathIsInside(candidateProgramRoot, candidateBackendRoot, true)
    || !pathIsInside(candidateBackendRoot, path.resolve(String(plan.serverEntry || "")))
    || !pathIsInside(candidateProgramRoot, candidateFrontendRoot, true)
    || !samePath(environment?.BONNI_PRODUCT_ROOT, candidateProgramRoot)
    || !samePath(environment?.BONNI_MODULE_PACKAGE_ROOT, path.join(candidateProgramRoot, "SYSTEM"))) {
    fail("DEVELOPMENT_TEST_RUNTIME_RUN_DEV_BINDING_INVALID", "backend-frontend-program-root");
  }
  return true;
}

function nowIso(now = undefined) {
  const date = now === undefined
    ? new Date()
    : typeof now === "function" ? now() : now;
  const parsed = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(parsed.getTime())) fail("DEVELOPMENT_TEST_RUNTIME_TIME_INVALID");
  return parsed.toISOString();
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const state = await lstatOrNull(cursor);
    if (!state) return;
    if (state.isSymbolicLink()) fail("DEVELOPMENT_TEST_RUNTIME_SYMLINK_FORBIDDEN", label);
  }
}

async function assertNoSymlinksBelow(target, label) {
  const state = await lstatOrNull(target);
  if (!state) return;
  if (state.isSymbolicLink()) fail("DEVELOPMENT_TEST_RUNTIME_SYMLINK_FORBIDDEN", label);
  if (!state.isDirectory()) return;
  const entries = await fs.readdir(target);
  for (const name of entries) {
    const child = path.join(target, name);
    const childState = await lstatOrNull(child);
    if (!childState) continue;
    if (childState.isSymbolicLink()) fail("DEVELOPMENT_TEST_RUNTIME_SYMLINK_FORBIDDEN", label);
    if (childState.isDirectory()) await assertNoSymlinksBelow(child, label);
  }
}

async function assertPlainDirectory(target, label) {
  await assertNoSymlinkComponents(target, label);
  const state = await lstatOrNull(target);
  if (!state) fail("DEVELOPMENT_TEST_RUNTIME_DIRECTORY_MISSING", label);
  if (state.isSymbolicLink() || !state.isDirectory()) fail("DEVELOPMENT_TEST_RUNTIME_DIRECTORY_UNSAFE", label);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EBADF"]).has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeJsonAtomic(file, value, { exclusive = false } = {}) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(directory, "json-parent");
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive && await lstatOrNull(file)) fail("DEVELOPMENT_TEST_RUNTIME_RECEIPT_EXISTS", path.basename(file));
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readSmallJson(file, code) {
  await assertNoSymlinkComponents(file, "json-file");
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const state = await handle.stat();
    const named = await fs.lstat(file);
    if (!state.isFile() || named.isSymbolicLink() || !named.isFile() || state.nlink !== 1
      || named.nlink !== 1 || state.dev !== named.dev || state.ino !== named.ino
      || state.size < 2 || state.size > MAXIMUM_JSON_BYTES) fail(code, "unsafe-file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== state.dev || after.ino !== state.ino || after.size !== state.size) fail(code, "changed");
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof DevelopmentTestRuntimeError) throw error;
    fail(code, String(error?.code || error?.message || "read"), error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sanitizeBackendDiagnosticText(value) {
  return String(value || "")
    .replace(/postgres(?:ql)?:\/\/[^\s@/]+:[^\s@/]+@/giu, "postgresql://***:***@")
    .replace(/((?:password|passwd|pwd|secret|token|authorization|cookie|master[_ -]?key|jwt[_ -]?secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_BACKEND_DIAGNOSTIC_TAIL_CHARS);
}

async function readBackendDiagnosticTail(file) {
  let handle;
  try {
    const state = await lstatOrNull(file);
    if (!state || !state.isFile() || state.isSymbolicLink() || state.nlink !== 1) return "";
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) return "";
    const start = Math.max(0, opened.size - MAX_BACKEND_DIAGNOSTIC_TAIL_BYTES);
    const length = opened.size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    return sanitizeBackendDiagnosticText(buffer.toString("utf8"));
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readTerminalLogSnapshot(file) {
  const initial = await lstatOrNull(file);
  if (!initial) return null;
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_UNSAFE");
  }
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_CHANGED");
    }
    const start = Math.max(0, opened.size - MAXIMUM_TERMINAL_LOG_ARCHIVE_BYTES);
    const length = opened.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(buffer, offset, length - offset, start + offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const named = await fs.lstat(file);
    if (!after.isFile() || after.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
      || after.dev !== initial.dev || after.ino !== initial.ino
      || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs
      || named.dev !== initial.dev || named.ino !== initial.ino
      || named.size !== initial.size || named.mtimeMs !== initial.mtimeMs
      || offset !== length) {
      fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_CHANGED");
    }
    const normalized = buffer.toString("utf8").replace(/\r\n?/gu, "\n");
    const safe = normalized.split("\n").map((line) => sanitizeBackendDiagnosticText(line)).join("\n");
    const prefix = opened.size > MAXIMUM_TERMINAL_LOG_ARCHIVE_BYTES
      ? `[Bonni] Terminal-Log gekuerzt; es werden die letzten ${MAXIMUM_TERMINAL_LOG_ARCHIVE_BYTES} Bytes gezeigt.\n`
      : "";
    return { text: `${prefix}${safe}`, truncated: opened.size > MAXIMUM_TERMINAL_LOG_ARCHIVE_BYTES };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeTextAtomic(file, value, { exclusive = false } = {}) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(directory, "terminal-log-parent");
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive && await lstatOrNull(file)) fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_ARCHIVE_EXISTS");
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function retainTerminalLogArchives(paths) {
  const directory = paths.archiveLogRoot;
  const directoryState = await lstatOrNull(directory);
  if (!directoryState) return [];
  await assertPlainDirectory(directory, "terminal-log-archive-root");
  const candidates = [];
  for (const name of await fs.readdir(directory)) {
    if (!TERMINAL_LOG_ARCHIVE_NAME_PATTERN.test(name)) continue;
    const file = path.join(directory, name);
    const state = await lstatOrNull(file);
    if (!state || !state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_ARCHIVE_UNSAFE", name);
    }
    candidates.push({ name, file, state });
  }
  candidates.sort((left, right) => right.state.mtimeMs - left.state.mtimeMs || right.name.localeCompare(left.name));
  const removed = [];
  for (const candidate of candidates.slice(MAXIMUM_TERMINAL_LOG_ARCHIVE_COUNT)) {
    const current = await lstatOrNull(candidate.file);
    if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== candidate.state.dev || current.ino !== candidate.state.ino
      || current.size !== candidate.state.size || current.mtimeMs !== candidate.state.mtimeMs) {
      fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_ARCHIVE_CHANGED", candidate.name);
    }
    await fs.unlink(candidate.file);
    removed.push(candidate.name);
  }
  if (removed.length) await syncDirectory(directory);
  return removed;
}

async function archiveTerminalLog(paths) {
  const snapshot = await readTerminalLogSnapshot(paths.logFile);
  if (!snapshot) return null;
  await fs.mkdir(paths.archiveRoot, { recursive: true, mode: 0o700 });
  await assertPlainDirectory(paths.archiveRoot, "development-test-archive-root");
  await fs.mkdir(paths.archiveLogRoot, { recursive: true, mode: 0o700 });
  await assertPlainDirectory(paths.archiveLogRoot, "terminal-log-archive-root");
  const text = [
    "Bonni Core RUN_DEV Terminal-Log",
    `candidate-id=${paths.candidateId}`,
    `package-sha256=${paths.packageSha256}`,
    "secret-values=redacted",
    "",
    snapshot.text,
  ].join("\n");
  const contentSha256 = sha256(text);
  const fileName = `bonni-terminal-${paths.packageSha256}--${contentSha256}.log`;
  const destination = path.join(paths.archiveLogRoot, fileName);
  const existing = await lstatOrNull(destination);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > MAXIMUM_TERMINAL_LOG_ARCHIVE_BYTES * 2) {
      fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_ARCHIVE_UNSAFE", fileName);
    }
    const existingBytes = await fs.readFile(destination);
    if (sha256(existingBytes.toString("utf8")) !== contentSha256) {
      fail("DEVELOPMENT_TEST_RUNTIME_TERMINAL_LOG_ARCHIVE_CONFLICT", fileName);
    }
  } else {
    await writeTextAtomic(destination, text, { exclusive: true });
  }
  const removed = await retainTerminalLogArchives(paths);
  return { fileName, path: destination, sha256: contentSha256, truncated: snapshot.truncated, removed };
}

function classifyBackendDiagnostic(tail) {
  const text = String(tail || "");
  if (/ERR_PACKAGE_IMPORT_NOT_DEFINED|Package import specifier\s+['"]#main-entry-point['"]\s+is not defined/iu.test(text)) {
    return "diagnosis=DEVELOPMENT_TEST_RUNTIME_PRISMA_PACKAGE_IMPORT_MISSING; prisma-import=#main-entry-point";
  }
  const prismaExport = /requested module\s+['"]?@prisma\/client['"]?\s+does not provide an export named\s+['"]?([A-Za-z_$][\w$]*)['"]?/iu.exec(text);
  if (prismaExport) {
    return `diagnosis=DEVELOPMENT_TEST_RUNTIME_PRISMA_ESM_EXPORT_MISMATCH; prisma-export=${prismaExport[1]}`;
  }
  if (/Prisma\.dmmf|reading\s+['"]datamodel['"]/iu.test(text)) {
    return "diagnosis=DEVELOPMENT_TEST_RUNTIME_PRISMA_RUNTIME_OBJECT_MISSING";
  }
  if (/(cannot find package|module not found).*@prisma\/client/iu.test(text)) {
    return "diagnosis=DEVELOPMENT_TEST_RUNTIME_PRISMA_CLIENT_MISSING";
  }
  return "";
}

async function enrichBackendFailure(error, logFile) {
  const code = String(error?.code || "");
  if (!code.startsWith("DEVELOPMENT_TEST_RUNTIME_BACKEND_")) return error;
  const tail = await readBackendDiagnosticTail(logFile);
  const original = sanitizeBackendDiagnosticText(error?.detail || error?.message || code);
  const detail = [
    original,
    classifyBackendDiagnostic(tail),
    tail ? `backend-log-tail=${tail}` : "backend-log-tail=leer",
  ].filter(Boolean).join("; ");
  return new DevelopmentTestRuntimeError(code, detail, error);
}

async function buildRuntimeStartFailureDetail(paths, state) {
  const stateCode = String(state?.errorCode || "timeout");
  // The detached worker writes the real child stderr/stdout to terminal.log.
  // The parent used to expose only state.errorCode, which hid the actual
  // backend startup reason from the Windows terminal. Read the same bounded,
  // sanitized tail used by the worker before returning START_FAILED.
  const tail = await readBackendDiagnosticTail(paths.logFile);
  return [
    stateCode,
    classifyBackendDiagnostic(tail),
    tail ? `backend-log-tail=${tail}` : "backend-log-tail=leer",
  ].join("; ");
}

function writeRuntimeDiagnosticLine(value) {
  try {
    process.stdout.write(`[RUN_DEV] ${sanitizeBackendDiagnosticText(value)}\n`);
  } catch {
    // The worker is already on its authenticated terminal-log path. A logging
    // failure must never change the runtime result.
  }
}

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return sha256(bytes);
}

export function resolveDevelopmentTestRuntimePaths({ productRoot, candidateId, packageSha256 }) {
  const root = canonicalProductRoot(productRoot);
  const id = canonicalCandidateId(candidateId);
  const hash = canonicalHash(packageSha256);
  const identity = `${id}--${hash}`;
  // SYSTEM is the immutable, certified raw source. RUN_SYSTEM is a derived
  // production runtime with the official key binding; it is never the source
  // tree for a Labor candidate. RUN_DEV is a sibling derived runtime with
  // candidate-scoped keys and mutable Labor state.
  const developmentRoot = path.join(root, DEVELOPMENT_RUN_ROOT_NAME);
  const sessionsRoot = path.join(developmentRoot, SESSION_ROOT_NAME);
  const sessionRoot = path.join(sessionsRoot, identity);
  const runRoot = path.join(sessionRoot, "program-slots");
  return Object.freeze({
    productRoot: root,
    developmentRoot,
    candidateId: id,
    packageSha256: hash,
    identity,
    sessionsRoot,
    sessionRoot,
    runRoot,
    stageFile: path.join(sessionRoot, STAGE_FILE),
    readyFile: path.join(sessionRoot, READY_FILE),
    stateFile: path.join(sessionRoot, STATE_FILE),
    heartbeatFile: path.join(sessionRoot, HEARTBEAT_FILE),
    stopFile: path.join(sessionRoot, STOP_FILE),
    logFile: path.join(sessionRoot, LOG_FILE),
    archiveRoot: path.join(developmentRoot, ARCHIVE_ROOT_NAME),
    archiveLogRoot: path.join(developmentRoot, ARCHIVE_ROOT_NAME, TERMINAL_LOG_ARCHIVE_ROOT_NAME),
  });
}

export async function archiveDevelopmentTestRuntimeTerminalLog(options) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  return archiveTerminalLog(paths);
}

async function loadRuntimeKey(options) {
  if (options.receiptSigningKey !== undefined) return signingKey(options.receiptSigningKey);
  return signingKey(await loadDevelopmentLocalKey({
    productRoot: options.productRoot,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
  }));
}

function publicSlot(slot) {
  return {
    slotId: slot.slotId,
    receiptSha256: slot.receipt.receiptSha256,
    treeSha256: slot.receipt.treeSha256,
    fileCount: slot.receipt.fileCount,
  };
}

function stageSummary(receipt, idempotent) {
  return {
    candidateId: receipt.candidateId,
    packageSha256: receipt.packageSha256,
    testReadySha256: receipt.testReadySha256,
    finalTreeSha256: receipt.finalTreeSha256,
    targetVersion: receipt.targetVersion,
    ports: receipt.ports,
    stageSha256: receipt.stageSha256,
    idempotent,
  };
}

function validateStageBindings(stage, paths) {
  if (stage.candidateId !== paths.candidateId || stage.packageSha256 !== paths.packageSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_STAGE_BINDING_MISMATCH");
  }
  if (stage.sessionRelativePath !== portableRelative(paths.productRoot, paths.sessionRoot)
    || stage.runRootRelativePath !== portableRelative(paths.productRoot, paths.runRoot)
    || !HASH_PATTERN.test(String(stage.testReadySha256 || ""))
    || !HASH_PATTERN.test(String(stage.testReadyFileSha256 || ""))
    || !HASH_PATTERN.test(String(stage.finalTreeSha256 || ""))) {
    fail("DEVELOPMENT_TEST_RUNTIME_STAGE_INVALID");
  }
  for (const role of ["active", "candidate"]) {
    const slot = stage.slots?.[role];
    if (!slot || !/^slot-[a-f0-9-]{36}$/u.test(String(slot.slotId || ""))
      || !HASH_PATTERN.test(String(slot.receiptSha256 || ""))
      || !HASH_PATTERN.test(String(slot.treeSha256 || ""))) {
      fail("DEVELOPMENT_TEST_RUNTIME_STAGE_INVALID", role);
    }
  }
  canonicalPorts(stage.ports);
  return stage;
}

async function verifyTestReadyBinding(paths, options, ops) {
  const ready = await ops.readDevelopmentTestReady({
    productRoot: paths.productRoot,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    ...(options.receiptSigningKey !== undefined ? { receiptSigningKey: options.receiptSigningKey } : {}),
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    verifyTree: true,
    allowLaborSource: true,
  });
  const expectedTestSystem = path.join(
    paths.developmentRoot,
    "TESTS",
    `${paths.candidateId}--${paths.packageSha256}`,
    "SYSTEM",
  );
  if (!samePath(ready.testSystem, expectedTestSystem)) {
    fail("DEVELOPMENT_TEST_RUNTIME_ACTIVE_TEST_TREE_REQUIRED");
  }
  await assertPlainDirectory(expectedTestSystem, "test-system");
  const testRoot = path.dirname(expectedTestSystem);
  const testReadyFile = path.join(testRoot, "TEST-READY.json");
  const testReadyFileState = await lstatOrNull(testReadyFile);
  if (!testReadyFileState?.isFile() || testReadyFileState.isSymbolicLink() || testReadyFileState.nlink !== 1) {
    fail("DEVELOPMENT_TEST_RUNTIME_TEST_READY_FILE_REQUIRED");
  }
  if (ready.receipt.candidateId !== paths.candidateId
    || ready.receipt.packageSha256 !== paths.packageSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_TEST_READY_BINDING_MISMATCH");
  }
  return {
    ...ready,
    testRoot,
    testReadyFile,
    testReadyFileSha256: await sha256File(testReadyFile),
  };
}

const DEFAULT_OPS = Object.freeze({
  readDevelopmentTestReady,
  stageProgramTree,
  verifyProgramSlot,
  resolveProgramSlot,
  readSlotPointers,
  cloneCandidateData,
  cleanupCandidateDataClone,
  readCandidateDataCloneIntent,
  recoverCandidateDataCloneAtStartup,
  readCandidateDataCloneReceipt,
  provisionCandidateDatabaseRole,
  cleanupCandidateDatabaseRole,
  buildSlotLaunchPlan,
  spawn,
});

function runtimeOps(overrides = {}) {
  return { ...DEFAULT_OPS, ...overrides };
}

async function verifyStagedRuntime(
  paths,
  stage,
  ready,
  ops,
  { allowCandidateRuntimeChanges = false } = {},
) {
  validateStageBindings(stage, paths);
  if (stage.testReadySha256 !== ready.receipt.testReadySha256
    || stage.testReadyFileSha256 !== ready.testReadyFileSha256
    || stage.finalTreeSha256 !== ready.receipt.finalTreeSha256
    || stage.targetVersion !== ready.receipt.targetVersion) {
    fail("DEVELOPMENT_TEST_RUNTIME_TEST_READY_CHANGED");
  }
  const [active, candidate, pointers] = await Promise.all([
    ops.verifyProgramSlot("active", { runRoot: paths.runRoot }),
    allowCandidateRuntimeChanges
      ? ops.resolveProgramSlot("candidate", { runRoot: paths.runRoot })
      : ops.verifyProgramSlot("candidate", { runRoot: paths.runRoot }),
    ops.readSlotPointers({ runRoot: paths.runRoot }),
  ]);
  if (!candidate) fail("DEVELOPMENT_TEST_RUNTIME_SLOT_BINDING_MISMATCH", "candidate-missing");
  if (active.slotId !== stage.slots.active.slotId
    || active.receipt.receiptSha256 !== stage.slots.active.receiptSha256
    || active.receipt.treeSha256 !== stage.slots.active.treeSha256
    || candidate.slotId !== stage.slots.candidate.slotId
    || candidate.receipt.receiptSha256 !== stage.slots.candidate.receiptSha256
    || pointers.roles.active?.slotId !== active.slotId
    || pointers.roles.active?.receiptSha256 !== active.receipt.receiptSha256
    || pointers.roles.candidate?.slotId !== candidate.slotId
    || pointers.roles.candidate?.receiptSha256 !== candidate.receipt.receiptSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_SLOT_BINDING_MISMATCH");
  }
  if (!allowCandidateRuntimeChanges && candidate.receipt.treeSha256 !== stage.slots.candidate.treeSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_SLOT_BINDING_MISMATCH", "candidate-tree");
  }
  if (allowCandidateRuntimeChanges) {
    // RUN_DEV is disposable and its candidate program may be hydrated or
    // repaired while the test is running (npm/Prisma can change files). The
    // candidate receipt and pointer remain immutable identity bindings; only
    // the candidate contents are allowed to differ during cleanup. Keep the
    // cleanup target fully inside this session and reject symlink pivots.
    if (!pathIsInside(paths.sessionRoot, candidate.slotRoot)
      || !pathIsInside(paths.sessionRoot, candidate.programRoot)
      || !pathIsInside(paths.sessionRoot, candidate.stateRoot)) {
      fail("DEVELOPMENT_TEST_RUNTIME_CLEANUP_PATH_UNSAFE", "candidate-slot");
    }
    await assertPlainDirectory(candidate.slotRoot, "candidate-slot");
    await assertPlainDirectory(candidate.programRoot, "candidate-program");
    await assertPlainDirectory(candidate.stateRoot, "candidate-state");
  }
  return { active, candidate, pointers };
}

export async function readDevelopmentTestRuntimeStage(
  options,
  dependencies = {},
  verificationOptions = {},
) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const key = await loadRuntimeKey({ ...options, productRoot: paths.productRoot });
  const ops = runtimeOps(dependencies);
  const ready = await verifyTestReadyBinding(paths, { ...options, receiptSigningKey: key }, ops);
  const stage = verifyDocument(
    await readSmallJson(paths.stageFile, "DEVELOPMENT_TEST_RUNTIME_STAGE_MISSING"),
    key,
    DEVELOPMENT_TEST_RUNTIME_STAGE_SCHEMA,
    "stageSha256",
    "DEVELOPMENT_TEST_RUNTIME_STAGE_AUTHENTICATION_FAILED",
  );
  const slots = await verifyStagedRuntime(paths, stage, ready, ops, verificationOptions);
  return { paths, key, ready, stage, slots };
}

async function readDevelopmentTestRuntimeStatusMetadata(options, dependencies = {}) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const key = await loadRuntimeKey({ ...options, productRoot: paths.productRoot });
  const ops = runtimeOps(dependencies);
  const ready = await ops.readDevelopmentTestReady({
    productRoot: paths.productRoot,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    receiptSigningKey: key,
    verifyTree: false,
    allowLaborSource: true,
    allowMetadataOnlyLaborSource: true,
  });
  const expectedTestSystem = path.join(
    paths.developmentRoot,
    "TESTS",
    `${paths.candidateId}--${paths.packageSha256}`,
    "SYSTEM",
  );
  if (!samePath(ready.testSystem, expectedTestSystem)) {
    fail("DEVELOPMENT_TEST_RUNTIME_ACTIVE_TEST_TREE_REQUIRED");
  }
  await assertPlainDirectory(expectedTestSystem, "test-system");
  const testRoot = path.dirname(expectedTestSystem);
  const testReadyFile = path.join(testRoot, "TEST-READY.json");
  const testReadyFileState = await lstatOrNull(testReadyFile);
  if (!testReadyFileState?.isFile() || testReadyFileState.isSymbolicLink() || testReadyFileState.nlink !== 1) {
    fail("DEVELOPMENT_TEST_RUNTIME_TEST_READY_FILE_REQUIRED");
  }
  const testReadyFileSha256 = await sha256File(testReadyFile);
  const stage = validateStageBindings(
    verifyDocument(
      await readSmallJson(paths.stageFile, "DEVELOPMENT_TEST_RUNTIME_STAGE_MISSING"),
      key,
      DEVELOPMENT_TEST_RUNTIME_STAGE_SCHEMA,
      "stageSha256",
      "DEVELOPMENT_TEST_RUNTIME_STAGE_AUTHENTICATION_FAILED",
    ),
    paths,
  );
  if (stage.testReadySha256 !== ready.receipt.testReadySha256
    || stage.testReadyFileSha256 !== testReadyFileSha256
    || stage.finalTreeSha256 !== ready.receipt.finalTreeSha256
    || stage.targetVersion !== ready.receipt.targetVersion) {
    fail("DEVELOPMENT_TEST_RUNTIME_TEST_READY_CHANGED");
  }
  const state = await readRuntimeState(paths, key);
  return {
    paths,
    key,
    ready: { ...ready, testRoot, testReadyFile, testReadyFileSha256 },
    stage,
    state,
  };
}

export async function prepareDevelopmentTestRuntime(options, dependencies = {}) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const key = await loadRuntimeKey({ ...options, productRoot: paths.productRoot });
  const ops = runtimeOps(dependencies);
  await assertPlainDirectory(paths.productRoot, "product-root");
  // SYSTEM is the immutable certified raw tree. RUN_SYSTEM and RUN_DEV are
  // derived runtime containers; neither is used as the candidate code source.
  await assertPlainDirectory(path.join(paths.productRoot, "SYSTEM"), "active-system");
  const ready = await verifyTestReadyBinding(paths, { ...options, receiptSigningKey: key }, ops);
  const existingStage = await lstatOrNull(paths.stageFile);
  if (existingStage) {
    const staged = await readDevelopmentTestRuntimeStage({ ...options, receiptSigningKey: key }, ops);
    return stageSummary(staged.stage, true);
  }
  if (await lstatOrNull(paths.sessionRoot)) {
    const entries = await fs.readdir(paths.sessionRoot);
    if (entries.length) fail("DEVELOPMENT_TEST_RUNTIME_INCOMPLETE_SESSION_CLEANUP_REQUIRED");
  }
  await fs.mkdir(paths.sessionRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(paths.sessionRoot, "session-root");
  const ports = canonicalPorts(options.ports);
  try {
    const active = await ops.stageProgramTree({
      role: "active",
      sourceRoot: paths.productRoot,
      runRoot: paths.runRoot,
      includePaths: [...CORE_INCLUDE_PATHS],
      includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
      excludePaths: ["SYSTEM/backend/node_modules/.bin"],
      version: ready.receipt.baseVersion,
      updateId: `development-test-base:${paths.candidateId}`,
    });
    const candidate = await ops.stageProgramTree({
      role: "candidate",
      sourceRoot: ready.testRoot,
      runRoot: paths.runRoot,
      includePaths: [...CORE_INCLUDE_PATHS],
      includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
      excludePaths: ["SYSTEM/backend/node_modules/.bin"],
      version: ready.runtimeCoreVersion || ready.receipt.targetVersion,
      updateId: `development-test:${paths.candidateId}:${paths.packageSha256.slice(0, 16)}`,
      manifestSha256: ready.receipt.finalTreeSha256,
    });
    const core = {
      schema: DEVELOPMENT_TEST_RUNTIME_STAGE_SCHEMA,
      candidateId: paths.candidateId,
      packageSha256: paths.packageSha256,
      testReadySha256: ready.receipt.testReadySha256,
      testReadyFileSha256: ready.testReadyFileSha256,
      finalTreeSha256: ready.receipt.finalTreeSha256,
      targetVersion: ready.receipt.targetVersion,
      baseVersion: ready.receipt.baseVersion,
      sessionRelativePath: portableRelative(paths.productRoot, paths.sessionRoot),
      runRootRelativePath: portableRelative(paths.productRoot, paths.runRoot),
      slots: { active: publicSlot(active), candidate: publicSlot(candidate) },
      ports,
      preparedAt: nowIso(options.now),
    };
    const stage = signDocument(core, key, "stageSha256");
    validateStageBindings(stage, paths);
    await writeJsonAtomic(paths.stageFile, stage, { exclusive: true });
    await verifyStagedRuntime(paths, stage, ready, ops);
    return stageSummary(stage, false);
  } catch (error) {
    // Program slots are confined to this not-yet-published session. Keep them
    // for diagnosis; a caller must explicitly run cleanup before retrying.
    throw error;
  }
}

function parsePostgresUrl(raw, label) {
  const text = String(raw || "").trim();
  if (!text) fail("DEVELOPMENT_TEST_RUNTIME_SOURCE_DATABASE_REQUIRED", label);
  let value;
  try {
    value = new URL(text);
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_SOURCE_DATABASE_INVALID", label, error);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(value.protocol)) {
    fail("DEVELOPMENT_TEST_RUNTIME_SOURCE_DATABASE_INVALID", "postgresql-required");
  }
  const databaseName = decodeURIComponent(value.pathname.replace(/^\//u, ""));
  if (!databaseName) fail("DEVELOPMENT_TEST_RUNTIME_SOURCE_DATABASE_INVALID", "database-name");
  return value;
}

function canonicalDatabaseBindingMode(value = DATABASE_BINDING_MODE_SHARED) {
  const mode = String(value || DATABASE_BINDING_MODE_SHARED).trim();
  if (![DATABASE_BINDING_MODE_SHARED, DATABASE_BINDING_MODE_CLONED].includes(mode)) {
    fail("DEVELOPMENT_TEST_RUNTIME_DATABASE_BINDING_MODE_INVALID", mode);
  }
  return mode;
}

function sharedRuntimeDatabaseBinding(raw, expectedDatabaseName = undefined) {
  const connection = parsePostgresUrl(raw, "shared-runtime");
  const databaseName = decodeURIComponent(connection.pathname.replace(/^\//u, ""));
  if (expectedDatabaseName !== undefined
    && String(expectedDatabaseName || "").trim() !== databaseName) {
    fail("DEVELOPMENT_TEST_RUNTIME_SHARED_DATABASE_BINDING_MISMATCH", "database-name");
  }
  const databaseUrl = connection.toString();
  return Object.freeze({
    databaseUrl,
    databaseName,
    connectionSha256: candidateDatabaseConnectionFingerprint(databaseUrl, databaseName),
  });
}

function runtimeDatabaseUrl(raw, expectedDatabaseName, databaseBindingMode) {
  const mode = canonicalDatabaseBindingMode(databaseBindingMode);
  return mode === DATABASE_BINDING_MODE_SHARED
    ? sharedRuntimeDatabaseBinding(raw, expectedDatabaseName).databaseUrl
    : canonicalCandidateRuntimeDatabaseUrl(raw, expectedDatabaseName);
}

function canonicalCandidateRuntimeDatabaseUrl(raw, expectedDatabaseName) {
  const value = parsePostgresUrl(raw, "candidate-runtime");
  let username;
  let password;
  let databaseName;
  try {
    username = decodeURIComponent(value.username || "");
    password = decodeURIComponent(value.password || "");
    databaseName = decodeURIComponent(value.pathname.replace(/^\//u, ""));
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_CREDENTIALS_INVALID", "encoding", error);
  }
  const expected = String(expectedDatabaseName || "").trim();
  let expectedRole;
  try {
    expectedRole = deriveCandidateDatabaseRoleName(expected);
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_CREDENTIALS_INVALID", "role", error);
  }
  const parameters = [...value.searchParams.entries()];
  const parametersSafe = parameters.length === 0
    || (parameters.length === 1 && parameters[0][0] === "schema" && parameters[0][1] === "public");
  if (!CANDIDATE_DATABASE_ROLE_PATTERN.test(username)
    || username !== expectedRole
    || password.length < 32
    || password.length > 512
    || !expected
    || databaseName !== expected
    || !new Set(["127.0.0.1", "::1", "[::1]", "localhost"]).has(value.hostname.toLowerCase())
    || value.hash !== ""
    || !parametersSafe) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_CREDENTIALS_INVALID");
  }
  return value.toString();
}

function assertCandidateDatabaseRuntimeBinding(rawUrl, expectedDatabaseName, expectedConnectionSha256 = undefined) {
  const databaseUrl = canonicalCandidateRuntimeDatabaseUrl(rawUrl, expectedDatabaseName);
  const expectedRole = deriveCandidateDatabaseRoleName(expectedDatabaseName);
  const connection = new URL(databaseUrl);
  let username;
  try {
    username = decodeURIComponent(connection.username || "");
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_CREDENTIALS_INVALID", "role-encoding", error);
  }
  if (username !== expectedRole) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_ROLE_BINDING_MISMATCH");
  }
  if (expectedConnectionSha256 !== undefined
    && candidateDatabaseConnectionFingerprint(databaseUrl, expectedDatabaseName) !== expectedConnectionSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_CONNECTION_BINDING_MISMATCH");
  }
  return databaseUrl;
}

function planningDatabaseUrl(candidateDatabaseUrl, role, packageSha256) {
  const value = new URL(candidateDatabaseUrl);
  value.pathname = `/bonni_devtest_${role}_${canonicalHash(packageSha256).slice(0, 12)}`;
  value.search = "";
  value.hash = "";
  return value.toString();
}

export function buildDevelopmentTestWorkerEnvironment({
  ownerInstanceId,
  candidateDatabaseUrl,
  candidateDatabaseName,
  databaseBindingMode = DATABASE_BINDING_MODE_CLONED,
  temporaryRoot,
  operatingSystemEnvironment = process.env,
  sharedRuntimeEnvironment = operatingSystemEnvironment,
} = {}) {
  if (!validOwnerInstanceId(ownerInstanceId)) fail("DEVELOPMENT_TEST_RUNTIME_OWNER_INTENT_MISMATCH");
  const databaseUrl = runtimeDatabaseUrl(candidateDatabaseUrl, candidateDatabaseName, databaseBindingMode);
  const sharedSecrets = databaseBindingMode === DATABASE_BINDING_MODE_SHARED
    ? sharedDatabaseSecretOverrides(sharedRuntimeEnvironment)
    : {};
  return Object.freeze({
    ...strictChildBaseEnvironment(operatingSystemEnvironment, temporaryRoot),
    ...sharedSecrets,
    BONNI_DEVELOPMENT_TEST_OWNER_INSTANCE_ID: String(ownerInstanceId),
    BONNI_DEVELOPMENT_TEST_CANDIDATE_DATABASE_URL: databaseUrl,
  });
}

export function buildDevelopmentTestCandidateEnvironment({
  planEnvironment,
  candidateDatabaseUrl,
  candidateDatabaseName,
  databaseBindingMode = DATABASE_BINDING_MODE_CLONED,
  receiptSigningKey,
  readySha256,
  temporaryRoot,
  developmentRoot,
  operatingSystemEnvironment = process.env,
} = {}) {
  const source = planEnvironment && typeof planEnvironment === "object" ? planEnvironment : {};
  const selected = {};
  for (const name of CANDIDATE_PLAN_ENVIRONMENT_KEYS) {
    if (source[name] === undefined || source[name] === null) continue;
    const value = String(source[name]);
    if (!value || value.includes("\0")) {
      fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", name);
    }
    selected[name] = value;
  }
  for (const name of CANDIDATE_PLAN_REQUIRED_ENVIRONMENT_KEYS) {
    if (!selected[name]) fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", name);
  }
  if (selected.SYSTEM_SLOT_ROLE !== "candidate"
    || selected.BONNI_PROGRAM_SLOT_ROLE !== "candidate"
    || selected.SYSTEM_SERVER_BIND !== "127.0.0.1"
    || !new Set(["127.0.0.1", "::1", "localhost"]).has(selected.LOCAL_AUTH_BIND)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", "binding");
  }
  for (const name of [
    "BONNI_PROGRAM_ROOT",
    "BONNI_PRODUCT_ROOT",
    "BONNI_RUNTIME_STATE_ROOT",
    "RUN_SYSTEM_ROOT",
    "RUN_SYSTEM_SYSTEM_ROOT",
    "RUN_SYSTEM_STORAGE_ROOT",
    "RUN_SYSTEM_ARCHIV_ROOT",
    "BONNI_STORAGE_ROOT",
    "MEDIA_STORAGE_ROOT",
  ]) {
    if (!path.isAbsolute(selected[name])) {
      fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", name);
    }
  }
  // The candidate slot owns a persistent storage root below its RUN_DEV
  // state.  Older run-container plans put candidate media beside that root
  // (`<state>/media`), but the media module deliberately rejects that layout
  // because it would not be covered by the persistent-storage backup root.
  // Keep the source/productive storage untouched and bind the child to the
  // candidate's own persistent storage instead (`<state>/storage/media`).
  const candidatePersistentStorageRoot = path.resolve(selected.BONNI_STORAGE_ROOT);
  const candidateRunSystemStorageRoot = path.resolve(selected.RUN_SYSTEM_STORAGE_ROOT);
  if (!pathIsInside(candidateRunSystemStorageRoot, candidatePersistentStorageRoot, true)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", "persistent-storage-root");
  }
  selected.MEDIA_STORAGE_ROOT = path.join(candidatePersistentStorageRoot, "media");
  // The candidate must be entirely self-contained.  In particular it must not
  // inherit BONNI_MODULE_PACKAGE_ROOT from the stable run-container plan,
  // because doing so could load an app from the productive SYSTEM while the
  // Core itself is running from the Labor slot.
  if (!samePath(selected.BONNI_PRODUCT_ROOT, selected.BONNI_PROGRAM_ROOT)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", "BONNI_PRODUCT_ROOT");
  }
  const candidateProgramRoot = path.resolve(selected.BONNI_PROGRAM_ROOT);
  const candidateModulePackageRoot = path.resolve(candidateProgramRoot, "SYSTEM");
  if (!pathIsInside(candidateProgramRoot, candidateModulePackageRoot)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", "BONNI_MODULE_PACKAGE_ROOT");
  }
  const resolvedDevelopmentRoot = path.resolve(String(developmentRoot || ""));
  if (!developmentRoot || !pathIsInside(resolvedDevelopmentRoot, candidateProgramRoot, true)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", "RUN_DEV_ROOT");
  }
  selected.BONNI_PROGRAM_ROOT = candidateProgramRoot;
  selected.BONNI_PRODUCT_ROOT = candidateProgramRoot;
  selected.BONNI_MODULE_PACKAGE_ROOT = candidateModulePackageRoot;
  // The backend serves the certified/build-published frontend from the same
  // copied candidate SYSTEM. Never leave a frontend path pointing back to the
  // official SYSTEM or to the installation root.
  const candidateFrontendRoot = path.resolve(
    selected.FRONTEND_DIST_ROOT || path.join(candidateProgramRoot, "SYSTEM", "backend", "public"),
  );
  if (!pathIsInside(candidateProgramRoot, candidateFrontendRoot, true)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_ENVIRONMENT_INVALID", "FRONTEND_DIST_ROOT");
  }
  selected.FRONTEND_DIST_ROOT = candidateFrontendRoot;
  selected.RUN_DEV_ROOT = resolvedDevelopmentRoot;
  const rawTemporaryRoot = String(temporaryRoot || "").trim();
  if (!rawTemporaryRoot || rawTemporaryRoot.includes("\0") || !path.isAbsolute(rawTemporaryRoot)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CHILD_TEMPORARY_ROOT_INVALID");
  }
  const resolvedTemporaryRoot = path.resolve(rawTemporaryRoot);
  if (!pathIsInside(selected.BONNI_RUNTIME_STATE_ROOT, resolvedTemporaryRoot)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CHILD_TEMPORARY_ROOT_INVALID");
  }
  const databaseUrl = runtimeDatabaseUrl(candidateDatabaseUrl, candidateDatabaseName, databaseBindingMode);
  const sharedSecrets = databaseBindingMode === DATABASE_BINDING_MODE_SHARED
    ? sharedDatabaseSecretOverrides(operatingSystemEnvironment)
    : {};
  const masterKey = candidateScopedSecret(receiptSigningKey, readySha256, "master-key");
  const jwtSecret = candidateScopedSecret(receiptSigningKey, readySha256, "jwt-secret");
  const moduleSecret = candidateScopedSecret(receiptSigningKey, readySha256, "module-private-data");
  const personalDataKey = candidateScopedSecret(receiptSigningKey, readySha256, "personal-data-master-key");
  return Object.freeze({
    ...strictChildBaseEnvironment(operatingSystemEnvironment, resolvedTemporaryRoot),
    ...sharedSecrets,
    ...selected,
    DATABASE_URL: databaseUrl,
    LOCAL_DATABASE_URL: databaseUrl,
    SERVER_DATABASE_URL: databaseUrl,
    MASTER_KEY: sharedSecrets.MASTER_KEY || masterKey,
    JWT_SECRET: sharedSecrets.JWT_SECRET || jwtSecret,
    MODULE_PRIVATE_DATA_SECRET: sharedSecrets.MODULE_PRIVATE_DATA_SECRET || moduleSecret,
    PERSONAL_DATA_MASTER_KEY: sharedSecrets.PERSONAL_DATA_MASTER_KEY || `base64url:${personalDataKey}`,
    PERSONAL_DATA_MASTER_KEY_STARTUP_MODE: "environment",
    PERSONAL_DATA_MASTER_KEY_REQUIRED: "true",
    TWO_FACTOR_ENCRYPTION_KEY: sharedSecrets.TWO_FACTOR_ENCRYPTION_KEY
      || candidateScopedSecret(receiptSigningKey, readySha256, "two-factor"),
    ACCOUNT_RECOVERY_TOKEN_SECRET: sharedSecrets.ACCOUNT_RECOVERY_TOKEN_SECRET
      || candidateScopedSecret(receiptSigningKey, readySha256, "account-recovery"),
    FEATURE_MODULE_INSTALLER_TOKEN: sharedSecrets.FEATURE_MODULE_INSTALLER_TOKEN
      || candidateScopedSecret(receiptSigningKey, readySha256, "module-installer"),
    RUNTIME_CONTROL_TOKEN: candidateScopedSecret(receiptSigningKey, readySha256, "runtime-control"),
    NODE_ENV: "production",
    AUTH_MODE: "LOCAL",
    OIDC_ENABLED: "false",
    // The update supervisor's candidate probes set this flag themselves.
    // RUN_DEV is already an isolated, interactive laboratory runtime, so its
    // browser must receive the normal candidate UI instead of the
    // update-probe-only response.
    SYSTEM_UPDATE_PROBE_MODE: "false",
    DATABASE_OPERATION_MODE: "server-only",
    DATABASE_SYNC_MODE: "disabled",
    CONTROL_CENTER_SHELL_ENABLED: "false",
    BONNI_ALLOW_UNSIGNED_UPDATES: "false",
    BONNI_AUTO_BUILD_MODULE_BACKENDS: "false",
    // RUN_DEV is a direct candidate-slot runtime. The production local-run
    // controller/proxy is never started for this process.
    BONNI_LOCAL_RUN_SLOTS: "0",
  });
}

async function resolveSourceData(
  options,
  paths,
  databaseBindingMode = DATABASE_BINDING_MODE_CLONED,
) {
  const environment = options.environment || process.env;
  const sourceDatabaseUrl = String(
    options.sourceDatabaseUrl
      || environment.DATABASE_URL
      || environment.SERVER_DATABASE_URL
      || environment.LOCAL_DATABASE_URL
      || "",
  ).trim();
  parsePostgresUrl(sourceDatabaseUrl, "DATABASE_URL");
  // Certified raw code/assets always come from SYSTEM above. RUN_DEV keeps its
  // own program slot, runtime state, ports and candidate-scoped secrets. In
  // the normal shared-database mode there is deliberately no dependency on a
  // RUN_SYSTEM directory: the database URL is the shared binding. The
  // filesystem source roots are only needed for the optional clone mode.
  if (databaseBindingMode === DATABASE_BINDING_MODE_SHARED) {
    return Object.freeze({
      sourceDatabaseUrl,
      sourceRunSystemRoot: null,
      sourceStorageRoot: null,
    });
  }
  const defaultRuntimeRoot = path.join(paths.productRoot, "RUN_SYSTEM", "runtime");
  const sourceRunSystemRoot = path.resolve(
    options.sourceRunSystemRoot
      || environment.BONNI_RUNTIME_STATE_ROOT
      || environment.RUN_SYSTEM_ROOT
      || defaultRuntimeRoot,
  );
  const sourceStorageRoot = path.resolve(
    options.sourceStorageRoot
      || environment.BONNI_STORAGE_ROOT
      || path.join(sourceRunSystemRoot, "storage"),
  );
  await assertPlainDirectory(sourceRunSystemRoot, "source-run-system");
  await assertPlainDirectory(sourceStorageRoot, "source-storage");
  if (samePath(sourceRunSystemRoot, sourceStorageRoot)
    || pathIsInside(sourceStorageRoot, sourceRunSystemRoot)
    || pathIsInside(paths.sessionRoot, sourceRunSystemRoot, true)
    || pathIsInside(paths.sessionRoot, sourceStorageRoot, true)
    || pathIsInside(sourceRunSystemRoot, paths.sessionRoot, true)
    || pathIsInside(sourceStorageRoot, paths.sessionRoot, true)) {
    fail("DEVELOPMENT_TEST_RUNTIME_SOURCE_LAYOUT_UNSAFE");
  }
  return { sourceDatabaseUrl, sourceRunSystemRoot, sourceStorageRoot };
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(new DevelopmentTestRuntimeError(
      "DEVELOPMENT_TEST_RUNTIME_PORT_UNAVAILABLE",
      String(port),
      error,
    )));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

export async function assertDevelopmentTestRuntimePortsAvailable(ports = DEVELOPMENT_TEST_RUNTIME_PORTS) {
  const canonical = canonicalPorts(ports);
  for (const port of Object.values(canonical)) await assertPortAvailable(port);
  return canonical;
}

function readySummary(receipt, extra = {}) {
  return {
    candidateId: receipt.candidateId,
    packageSha256: receipt.packageSha256,
    targetVersion: receipt.targetVersion,
    testReadySha256: receipt.testReadySha256,
    finalTreeSha256: receipt.finalTreeSha256,
    readySha256: receipt.readySha256,
    ports: receipt.ports,
    databaseBindingMode: receipt.databaseBindingMode || null,
    databaseName: receipt.candidateDatabaseName || null,
    proxyCutover: false,
    ...extra,
  };
}

async function readRuntimeReady(paths, key) {
  const ready = verifyDocument(
    await readSmallJson(paths.readyFile, "DEVELOPMENT_TEST_RUNTIME_READY_MISSING"),
    key,
    DEVELOPMENT_TEST_RUNTIME_READY_SCHEMA,
    "readySha256",
    "DEVELOPMENT_TEST_RUNTIME_READY_AUTHENTICATION_FAILED",
  );
  if (ready.candidateId !== paths.candidateId || ready.packageSha256 !== paths.packageSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_READY_BINDING_MISMATCH");
  }
  return ready;
}

function runtimeBindingFromReady(paths, key, ready) {
  let ports;
  try {
    ports = canonicalPorts(ready?.ports);
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_READY_BINDING_INVALID", "ports", error);
  }
  if (!ready || typeof ready !== "object" || Array.isArray(ready)
    || !CANDIDATE_ID_PATTERN.test(String(ready.targetVersion || ""))
    || ready.targetVersion !== String(ready.targetVersion).normalize("NFC")
    || ready.bind !== "127.0.0.1"
    || ready.proxyCutover !== false
    || !validIsoTimestamp(ready.preparedAt)) {
    fail("DEVELOPMENT_TEST_RUNTIME_READY_BINDING_INVALID");
  }
  return {
    paths,
    key,
    stage: {
      targetVersion: ready.targetVersion,
      ports,
    },
  };
}

async function readRuntimeState(paths, key, { required = false } = {}) {
  if (!(await lstatOrNull(paths.stateFile))) {
    if (required) fail("DEVELOPMENT_TEST_RUNTIME_STATE_MISSING");
    return null;
  }
  const state = verifyDocument(
    await readSmallJson(paths.stateFile, "DEVELOPMENT_TEST_RUNTIME_STATE_INVALID"),
    key,
    DEVELOPMENT_TEST_RUNTIME_STATE_SCHEMA,
    "stateSha256",
    "DEVELOPMENT_TEST_RUNTIME_STATE_AUTHENTICATION_FAILED",
  );
  if (state.candidateId !== paths.candidateId || state.packageSha256 !== paths.packageSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_STATE_BINDING_MISMATCH");
  }
  return state;
}

async function persistRuntimeState(paths, key, input) {
  const state = signDocument({
    schema: DEVELOPMENT_TEST_RUNTIME_STATE_SCHEMA,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    ...input,
  }, key, "stateSha256");
  await writeJsonAtomic(paths.stateFile, state);
  return state;
}

function validateRuntimeStateBinding(state, staged, ready) {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !new Set([...ACTIVE_RUNTIME_STATUSES, ...TERMINAL_RUNTIME_STATUSES]).has(state.status)
    || !validIsoTimestamp(state.updatedAt)
    || !samePorts(state.ports, staged.stage.ports)) {
    fail("DEVELOPMENT_TEST_RUNTIME_STATE_BINDING_INVALID");
  }
  if (ready && state.readySha256 !== ready.readySha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_STATE_BINDING_INVALID", "ready");
  }
  if (ACTIVE_RUNTIME_STATUSES.has(state.status)) {
    if (!ready || !validOwnerInstanceId(state.ownerInstanceId)
      || !validPid(state.workerPid, { nullable: state.status === "starting" })
      || !validPid(state.childPid, { nullable: state.status !== "ready" })) {
      fail("DEVELOPMENT_TEST_RUNTIME_STATE_BINDING_INVALID", state.status);
    }
    if (state.status === "ready" && !validIsoTimestamp(state.childStartedAt)) {
      fail("DEVELOPMENT_TEST_RUNTIME_STATE_BINDING_INVALID", "child-started-at");
    }
    if (state.childStartedAt !== null && state.childStartedAt !== undefined
      && !validIsoTimestamp(state.childStartedAt)) {
      fail("DEVELOPMENT_TEST_RUNTIME_STATE_BINDING_INVALID", "child-started-at");
    }
  }
  return state;
}

async function persistRuntimeHeartbeat(paths, key, input) {
  const heartbeat = signDocument({
    schema: DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_SCHEMA,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    ...input,
  }, key, "heartbeatSha256");
  await writeJsonAtomic(paths.heartbeatFile, heartbeat);
  return heartbeat;
}

async function readRuntimeHeartbeat(paths, key, state, ready) {
  const heartbeat = verifyDocument(
    await readSmallJson(paths.heartbeatFile, "DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_MISSING"),
    key,
    DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_SCHEMA,
    "heartbeatSha256",
    "DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_AUTHENTICATION_FAILED",
  );
  if (heartbeat.candidateId !== paths.candidateId
    || heartbeat.packageSha256 !== paths.packageSha256
    || heartbeat.readySha256 !== ready.readySha256
    || heartbeat.ownerInstanceId !== state.ownerInstanceId
    || heartbeat.status !== state.status
    || heartbeat.workerPid !== state.workerPid
    || heartbeat.childPid !== state.childPid
    || (heartbeat.childStartedAt ?? null) !== (state.childStartedAt ?? null)
    || !samePorts(heartbeat.ports, state.ports)
    || !validIsoTimestamp(heartbeat.heartbeatAt)) {
    fail("DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_BINDING_INVALID");
  }
  return heartbeat;
}

function currentTimeMs(now = undefined) {
  return Date.parse(nowIso(now));
}

function heartbeatIsFresh(heartbeat, now = undefined) {
  const age = currentTimeMs(now) - Date.parse(heartbeat.heartbeatAt);
  return age >= -HEARTBEAT_MAX_FUTURE_SKEW_MS && age <= HEARTBEAT_MAX_AGE_MS;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function portOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function allRuntimePortsAvailable(ports, dependencies = {}) {
  if (typeof dependencies.runtimePortsAvailable === "function") {
    return Boolean(await dependencies.runtimePortsAvailable(ports));
  }
  try {
    for (const port of Object.values(canonicalPorts(ports))) await assertPortAvailable(port);
    return true;
  } catch (error) {
    if (error?.code === "DEVELOPMENT_TEST_RUNTIME_PORT_UNAVAILABLE") return false;
    throw error;
  }
}

async function runtimeServerPortOpen(ports, dependencies = {}) {
  const probe = typeof dependencies.portOpen === "function" ? dependencies.portOpen : portOpen;
  // LocalAuth and ModuleManager are runtime bindings, not independent
  // listeners that every Core build must expose. The server endpoint is the
  // authoritative liveness boundary; the normal candidate health check
  // below validates the candidate process, role, version and runtime state.
  return Boolean(await probe(canonicalPorts(ports).server));
}

async function inspectActiveRuntimeBinding(staged, ready, state, options = {}, dependencies = {}) {
  validateRuntimeStateBinding(state, staged, ready);
  const exists = typeof dependencies.processExists === "function"
    ? dependencies.processExists
    : processExists;
  const workerAlive = validPid(state.workerPid) && Boolean(await exists(state.workerPid));
  const childAlive = validPid(state.childPid) && Boolean(await exists(state.childPid));
  const noStoredProcessAlive = !workerAlive && !childAlive;
  if (noStoredProcessAlive) {
    const intentAge = currentTimeMs(options.now) - Date.parse(state.updatedAt);
    const freshUnspawnedIntent = state.status === "starting"
      && state.workerPid === null
      && state.childPid === null
      && intentAge >= -HEARTBEAT_MAX_FUTURE_SKEW_MS
      && intentAge <= START_INTENT_GRACE_MS;
    if (!freshUnspawnedIntent && await allRuntimePortsAvailable(state.ports, dependencies)) {
      return { classification: "stale-recoverable", workerAlive, childAlive };
    }
  }

  let heartbeat;
  try {
    heartbeat = await readRuntimeHeartbeat(staged.paths, staged.key, state, ready);
  } catch (error) {
    return {
      classification: "unconfirmed",
      detail: String(error?.code || "DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_UNCONFIRMED"),
      workerAlive,
      childAlive,
    };
  }
  if (!heartbeatIsFresh(heartbeat, options.now)) {
    return {
      classification: "unconfirmed",
      detail: "DEVELOPMENT_TEST_RUNTIME_HEARTBEAT_STALE",
      workerAlive,
      childAlive,
    };
  }
  if (!workerAlive || (state.childPid !== null && !childAlive)) {
    return {
      classification: "unconfirmed",
      detail: "DEVELOPMENT_TEST_RUNTIME_PROCESS_BINDING_UNCONFIRMED",
      workerAlive,
      childAlive,
    };
  }
  if (state.status === "ready") {
    if (!await runtimeServerPortOpen(state.ports, dependencies)) {
      return {
        classification: "unconfirmed",
        detail: "DEVELOPMENT_TEST_RUNTIME_BOUND_PORT_NOT_REACHABLE",
        workerAlive,
        childAlive,
      };
    }
    try {
      await probeCandidateHealth({
        url: `http://127.0.0.1:${state.ports.server}/api/health/ready`,
        expectedVersion: staged.stage.targetVersion,
        expectedPid: state.childPid,
        expectedStartedAt: state.childStartedAt,
        fetchImpl: dependencies.fetchImpl || globalThis.fetch,
        timeoutMs: Number(options.statusHealthTimeoutMs || STATUS_HEALTH_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        classification: "unconfirmed",
        detail: String(error?.code || "DEVELOPMENT_TEST_RUNTIME_HEALTH_UNCONFIRMED"),
        workerAlive,
        childAlive,
      };
    }
  }
  return { classification: "confirmed", workerAlive, childAlive };
}

async function inspectRuntimeBinding(staged, ready, state, options = {}, dependencies = {}) {
  if (typeof dependencies.inspectRuntimeBinding === "function") {
    return dependencies.inspectRuntimeBinding({ staged, ready, state, options });
  }
  return inspectActiveRuntimeBinding(staged, ready, state, options, dependencies);
}

async function waitForRuntimeQuiescence(state, ports, options = {}, dependencies = {}) {
  const exists = typeof dependencies.processExists === "function"
    ? dependencies.processExists
    : processExists;
  const deadline = Date.now() + Number(
    options.cleanupQuiescenceTimeoutMs || CLEANUP_QUIESCENCE_TIMEOUT_MS,
  );
  while (Date.now() <= deadline) {
    const workerAlive = validPid(state?.workerPid) && Boolean(await exists(state.workerPid));
    const childAlive = validPid(state?.childPid) && Boolean(await exists(state.childPid));
    if (!workerAlive && !childAlive && await allRuntimePortsAvailable(ports, dependencies)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  fail("DEVELOPMENT_TEST_RUNTIME_CLEANUP_RUNTIME_NOT_QUIESCENT");
}

async function waitForState(paths, key, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await readRuntimeState(paths, key).catch((error) => {
      if (error?.code === "DEVELOPMENT_TEST_RUNTIME_STATE_INVALID") return null;
      throw error;
    });
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return latest;
}

function workerArguments(paths, options) {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "development-test-runtime-cli.mjs");
  const args = [
    cli,
    "__worker",
    "--product-root", paths.productRoot,
    "--candidate-id", paths.candidateId,
    "--package-sha256", paths.packageSha256,
  ];
  if (options.sourceRunSystemRoot) {
    args.push("--source-run-system-root", options.sourceRunSystemRoot);
  }
  if (options.sourceStorageRoot) {
    args.push("--source-storage-root", options.sourceStorageRoot);
  }
  if (options.keyFile) args.push("--key-file", path.resolve(options.keyFile));
  return args;
}

async function spawnDetachedWorker(
  paths,
  candidateDatabaseUrl,
  candidateDatabaseName,
  databaseBindingMode,
  options,
  ops,
) {
  const workerTemporaryRoot = path.join(paths.sessionRoot, "worker-temp");
  await fs.mkdir(workerTemporaryRoot, { recursive: true, mode: 0o700 });
  const workerEnvironment = buildDevelopmentTestWorkerEnvironment({
    ownerInstanceId: options.ownerInstanceId,
    candidateDatabaseUrl,
    candidateDatabaseName,
    databaseBindingMode,
    temporaryRoot: workerTemporaryRoot,
    operatingSystemEnvironment: options.operatingSystemEnvironment || process.env,
    sharedRuntimeEnvironment: options.sharedRuntimeEnvironment || options.operatingSystemEnvironment || process.env,
  });
  const logHandle = await fs.open(paths.logFile, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
  try {
    const child = ops.spawn(process.execPath, workerArguments(paths, options), {
      cwd: paths.productRoot,
      env: workerEnvironment,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      detached: true,
      windowsHide: true,
    });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      child.kill?.("SIGTERM");
      fail("DEVELOPMENT_TEST_RUNTIME_WORKER_PID_INVALID");
    }
    child.unref?.();
    return child.pid;
  } finally {
    await logHandle.close();
  }
}

export async function startDevelopmentTestRuntime(options, dependencies = {}) {
  const ops = runtimeOps(dependencies);
  await prepareDevelopmentTestRuntime(options, ops);
  const staged = await readDevelopmentTestRuntimeStage(options, ops);
  const { paths, key, ready: testReady, stage, slots } = staged;
  const existingState = await readRuntimeState(paths, key);
  if (existingState && ACTIVE_RUNTIME_STATUSES.has(existingState.status)) {
    const existingReady = await readRuntimeReady(paths, key);
    const inspection = await inspectRuntimeBinding(
      staged,
      existingReady,
      existingState,
      options,
      dependencies,
    );
    if (inspection.classification === "confirmed") {
      return readySummary(existingReady, {
        status: existingState.status,
        workerPid: existingState.workerPid,
        childPid: existingState.childPid,
        ...(existingState.status === "ready"
          ? { endpoint: `http://127.0.0.1:${stage.ports.server}` }
          : {}),
        idempotent: true,
      });
    }
    fail(
      inspection.classification === "stale-recoverable"
        ? "DEVELOPMENT_TEST_RUNTIME_STALE_RUNNING_STATE"
        : "DEVELOPMENT_TEST_RUNTIME_RUNNING_STATE_UNCONFIRMED",
      inspection.detail || existingState.status,
    );
  }
  if (existingState) fail("DEVELOPMENT_TEST_RUNTIME_SESSION_RESTART_REQUIRES_CLEANUP", existingState.status);

  const databaseBindingMode = canonicalDatabaseBindingMode(options.databaseBindingMode);
  const source = await resolveSourceData(options, paths, databaseBindingMode);
  let clone = null;
  let candidateRole = null;
  let sharedDatabase = null;
  let candidateDatabaseName;
  let candidateRuntimeDatabaseUrl;
  let candidateDatabaseConnectionSha256;
  let candidateDatabaseRoleName = null;
  if (databaseBindingMode === DATABASE_BINDING_MODE_SHARED) {
    sharedDatabase = sharedRuntimeDatabaseBinding(source.sourceDatabaseUrl);
    candidateDatabaseName = sharedDatabase.databaseName;
    candidateRuntimeDatabaseUrl = sharedDatabase.databaseUrl;
    candidateDatabaseConnectionSha256 = sharedDatabase.connectionSha256;
    try {
      candidateDatabaseRoleName = decodeURIComponent(new URL(candidateRuntimeDatabaseUrl).username || "") || null;
    } catch (error) {
      fail("DEVELOPMENT_TEST_RUNTIME_SHARED_DATABASE_BINDING_MISMATCH", "username", error);
    }
  } else {
    clone = await ops.cloneCandidateData({
      runRoot: paths.runRoot,
      activeSlot: slots.active,
      candidateSlot: slots.candidate,
      sourceDatabaseUrl: source.sourceDatabaseUrl,
      sourceRunSystemRoot: source.sourceRunSystemRoot,
      sourceStorageRoot: source.sourceStorageRoot,
      receiptSigningKey: key,
      cloneId: `devtest-${paths.packageSha256.slice(0, 24)}`,
      ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.withConsistencyBoundary ? { withConsistencyBoundary: options.withConsistencyBoundary } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    if (!clone?.receipt || clone.receipt.candidate?.slotId !== stage.slots.candidate.slotId
      || clone.receipt.source?.slotId !== stage.slots.active.slotId
      || clone.receipt.source?.databaseName === clone.receipt.candidate?.databaseName
      || clone.candidateDatabaseUrl === source.sourceDatabaseUrl) {
      fail("DEVELOPMENT_TEST_RUNTIME_DATA_CLONE_BINDING_MISMATCH");
    }

    candidateDatabaseName = clone.receipt.candidate.databaseName;
    candidateRole = await ops.provisionCandidateDatabaseRole({
      sourceDatabaseUrl: source.sourceDatabaseUrl,
      candidateDatabaseUrl: clone.candidateDatabaseUrl,
      candidateDatabaseName,
      environment: options.environment || process.env,
      ...(options.databaseRoleCommandRunner ? { commandRunner: options.databaseRoleCommandRunner } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
    });
    if (!candidateRole
      || candidateRole.candidateDatabaseName !== candidateDatabaseName
      || candidateRole.roleName !== deriveCandidateDatabaseRoleName(candidateDatabaseName)) {
      fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_ROLE_BINDING_MISMATCH");
    }
    candidateRuntimeDatabaseUrl = assertCandidateDatabaseRuntimeBinding(
      candidateRole.candidateDatabaseUrl,
      candidateDatabaseName,
      candidateRole.connectionSha256,
    );
    candidateDatabaseConnectionSha256 = candidateRole.connectionSha256;
    candidateDatabaseRoleName = candidateRole.roleName;
  }
  const plan = await ops.buildSlotLaunchPlan("candidate", {
    runRoot: paths.runRoot,
    installationRoot: paths.productRoot,
    environment: {},
    bind: "127.0.0.1",
    serverPorts: { active: 4100, candidate: stage.ports.server, previous: 4400 },
    localAuthPorts: { active: 4101, candidate: stage.ports.localAuth, previous: 4401 },
    moduleManagerPorts: { active: 4201, candidate: stage.ports.moduleManager, previous: 4402 },
    reservedPorts: [4000, 4198],
    databaseUrls: {
      active: planningDatabaseUrl(candidateRuntimeDatabaseUrl, "active", paths.packageSha256),
      candidate: candidateRuntimeDatabaseUrl,
      previous: planningDatabaseUrl(candidateRuntimeDatabaseUrl, "previous", paths.packageSha256),
    },
  });
  if (plan.slotId !== stage.slots.candidate.slotId
    || plan.receiptSha256 !== stage.slots.candidate.receiptSha256
    || plan.health.serverPort !== stage.ports.server
    || plan.health.localAuthPort !== stage.ports.localAuth
    || plan.health.moduleManagerPort !== stage.ports.moduleManager
    || plan.databaseIsolationConfigured !== true
    || plan.databaseIsolationRequired !== true
    || plan.env.SYSTEM_SERVER_BIND !== "127.0.0.1") {
    fail("DEVELOPMENT_TEST_RUNTIME_LAUNCH_PLAN_INVALID");
  }
  // The production SYSTEM remains the certified source. The candidate
  // backend and its published frontend must already be addressable only from
  // the RUN_DEV program slot before a worker is allowed to start.
  assertRunDevPlanBinding(paths, plan);
  const runtimeReady = signDocument({
    schema: DEVELOPMENT_TEST_RUNTIME_READY_SCHEMA,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    targetVersion: testReady.receipt.targetVersion,
    testReadySha256: testReady.receipt.testReadySha256,
    testReadyFileSha256: testReady.testReadyFileSha256,
    finalTreeSha256: testReady.receipt.finalTreeSha256,
    stageSha256: stage.stageSha256,
    candidateSlotId: plan.slotId,
    candidateSlotReceiptSha256: plan.receiptSha256,
    candidateProgramTreeSha256: stage.slots.candidate.treeSha256,
    databaseBindingMode,
    sharedDatabaseConnectionSha256: sharedDatabase?.connectionSha256 || null,
    dataCloneReceiptSha256: clone?.receipt?.receiptSha256 || null,
    sourceDatabaseConnectionSha256: sharedDatabase?.connectionSha256 || clone?.receipt?.source?.connectionSha256 || null,
    dataCloneCandidateDatabaseConnectionSha256: clone?.receipt?.candidate?.connectionSha256 || null,
    candidateDatabaseConnectionSha256,
    candidateDatabaseRoleName,
    candidateDatabaseName,
    candidateStatePathSha256: clone?.receipt?.candidate?.statePathSha256 || null,
    ports: stage.ports,
    bind: "127.0.0.1",
    proxyCutover: false,
    preparedAt: nowIso(options.now),
  }, key, "readySha256");
  await writeJsonAtomic(paths.readyFile, runtimeReady, { exclusive: true });

  const ownerInstanceId = crypto.randomBytes(32).toString("hex");
  await persistRuntimeState(paths, key, {
    readySha256: runtimeReady.readySha256,
    ownerInstanceId,
    status: "starting",
    workerPid: null,
    childPid: null,
    childStartedAt: null,
    ports: stage.ports,
    updatedAt: nowIso(options.now),
    errorCode: null,
  });

  let workerPid;
  let workerSpawned = false;
  try {
    const spawned = dependencies.spawnWorker
      ? await dependencies.spawnWorker({
        paths,
        plan,
        runtimeReady,
        ownerInstanceId,
        candidateDatabaseUrl: candidateRuntimeDatabaseUrl,
        candidateDatabaseName,
        databaseBindingMode,
      })
      : await spawnDetachedWorker(
        paths,
        candidateRuntimeDatabaseUrl,
        candidateDatabaseName,
        databaseBindingMode,
        {
          ownerInstanceId,
          sourceRunSystemRoot: source.sourceRunSystemRoot,
          sourceStorageRoot: source.sourceStorageRoot,
          ...(options.keyFile ? { keyFile: options.keyFile } : {}),
          operatingSystemEnvironment: options.operatingSystemEnvironment || process.env,
          sharedRuntimeEnvironment: options.environment || process.env,
        },
        ops,
      );
    workerPid = Number(spawned?.workerPid ?? spawned);
    if (!Number.isSafeInteger(workerPid) || workerPid <= 0) fail("DEVELOPMENT_TEST_RUNTIME_WORKER_PID_INVALID");
    workerSpawned = true;
    if (dependencies.spawnWorker) {
      const childPid = Number(spawned?.childPid ?? workerPid);
      const childStartedAt = String(spawned?.childStartedAt || nowIso(options.now));
      if (!validPid(childPid) || !validIsoTimestamp(childStartedAt)) {
        fail("DEVELOPMENT_TEST_RUNTIME_CHILD_IDENTITY_INVALID");
      }
      await persistRuntimeState(paths, key, {
        readySha256: runtimeReady.readySha256,
        ownerInstanceId,
        status: "ready",
        workerPid,
        childPid,
        childStartedAt,
        ports: stage.ports,
        updatedAt: nowIso(options.now),
        errorCode: null,
      });
      await persistRuntimeHeartbeat(paths, key, {
        readySha256: runtimeReady.readySha256,
        ownerInstanceId,
        status: "ready",
        workerPid,
        childPid,
        childStartedAt,
        ports: stage.ports,
        heartbeatAt: nowIso(options.now),
      });
    }
    const state = await waitForState(
      paths,
      key,
      (entry) => new Set(["ready", "failed", "stopped"]).has(entry.status),
      Number(options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS),
    );
    if (!state || state.status !== "ready") {
      fail(
        "DEVELOPMENT_TEST_RUNTIME_START_FAILED",
        await buildRuntimeStartFailureDetail(paths, state),
      );
    }
    return readySummary(runtimeReady, {
      status: "ready",
      workerPid: state.workerPid,
      childPid: state.childPid,
      endpoint: `http://127.0.0.1:${stage.ports.server}`,
      idempotent: false,
    });
  } catch (error) {
    if (!workerSpawned) {
      await persistRuntimeState(paths, key, {
        readySha256: runtimeReady.readySha256,
        ownerInstanceId,
        status: "failed",
        workerPid: null,
        childPid: null,
        childStartedAt: null,
        ports: stage.ports,
        updatedAt: nowIso(options.now),
        errorCode: String(error?.code || "DEVELOPMENT_TEST_RUNTIME_WORKER_SPAWN_FAILED"),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function waitForChildExit(child, timeoutMs, onHeartbeat = undefined) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let heartbeatBusy = false;
    const heartbeat = typeof onHeartbeat === "function"
      ? setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        Promise.resolve(onHeartbeat()).catch(() => undefined).finally(() => { heartbeatBusy = false; });
      }, HEARTBEAT_INTERVAL_MS)
      : null;
    const timeout = setTimeout(() => {
      if (heartbeat) clearInterval(heartbeat);
      resolve(false);
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      resolve(true);
    });
  });
}

async function waitForBackendReady(child, timeoutMs, onHeartbeat = undefined) {
  return new Promise((resolve, reject) => {
    let heartbeatBusy = false;
    const heartbeat = typeof onHeartbeat === "function"
      ? setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        Promise.resolve(onHeartbeat()).catch((error) => {
          cleanup();
          reject(error);
        }).finally(() => { heartbeatBusy = false; });
      }, HEARTBEAT_INTERVAL_MS)
      : null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new DevelopmentTestRuntimeError("DEVELOPMENT_TEST_RUNTIME_BACKEND_READY_TIMEOUT"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type === "BONNI_BACKEND_READY") {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new DevelopmentTestRuntimeError(
        "DEVELOPMENT_TEST_RUNTIME_BACKEND_EXITED",
        `${code ?? "signal"}:${signal || ""}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function terminateOwnedChild(child, onHeartbeat = undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 10_000, onHeartbeat)) return true;
  child.kill("SIGKILL");
  return waitForChildExit(child, 5_000, onHeartbeat);
}

async function probeCandidateHealth({
  url,
  expectedVersion,
  expectedPid = undefined,
  expectedStartedAt = undefined,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  if (typeof fetchImpl !== "function") fail("DEVELOPMENT_TEST_RUNTIME_HEALTH_FETCH_UNAVAILABLE");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_HEALTH_UNREACHABLE", String(error?.code || error?.name || "fetch"), error);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    fail("DEVELOPMENT_TEST_RUNTIME_HEALTH_INVALID", "json", error);
  }
  const runtime = payload?.runtime;
  if (!response.ok
    || payload?.ok !== true
    || !["ready", "degraded"].includes(payload?.state)
    || runtime?.slotRole !== "candidate"
    || runtime?.updateProbeMode !== false
    || runtime?.version !== expectedVersion
    || (expectedPid !== undefined && runtime?.pid !== expectedPid)
    || (expectedStartedAt !== undefined && runtime?.startedAt !== expectedStartedAt)
    || !validPid(runtime?.pid)
    || !validIsoTimestamp(runtime?.startedAt)) {
    fail("DEVELOPMENT_TEST_RUNTIME_HEALTH_NOT_READY");
  }
  return payload;
}

async function readStopRequest(paths, key, readySha256) {
  if (!(await lstatOrNull(paths.stopFile))) return null;
  const stop = verifyDocument(
    await readSmallJson(paths.stopFile, "DEVELOPMENT_TEST_RUNTIME_STOP_INVALID"),
    key,
    DEVELOPMENT_TEST_RUNTIME_STOP_SCHEMA,
    "stopSha256",
    "DEVELOPMENT_TEST_RUNTIME_STOP_AUTHENTICATION_FAILED",
  );
  if (stop.candidateId !== paths.candidateId || stop.packageSha256 !== paths.packageSha256
    || stop.readySha256 !== readySha256) fail("DEVELOPMENT_TEST_RUNTIME_STOP_BINDING_MISMATCH");
  return stop;
}

export async function runDevelopmentTestRuntimeWorker(options, dependencies = {}) {
  const ops = runtimeOps(dependencies);
  const staged = await readDevelopmentTestRuntimeStage(options, ops);
  const { paths, key, stage, slots } = staged;
  const runtimeReady = await readRuntimeReady(paths, key);
  if (runtimeReady.stageSha256 !== stage.stageSha256
    || runtimeReady.testReadySha256 !== stage.testReadySha256
    || runtimeReady.finalTreeSha256 !== stage.finalTreeSha256
    || runtimeReady.candidateSlotId !== slots.candidate.slotId
    || runtimeReady.candidateSlotReceiptSha256 !== slots.candidate.receipt.receiptSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_READY_BINDING_MISMATCH");
  }
  const databaseBindingMode = canonicalDatabaseBindingMode(
    runtimeReady.databaseBindingMode || DATABASE_BINDING_MODE_CLONED,
  );
  let cloneReceipt = null;
  let candidateDatabaseName;
  let candidateDatabaseUrl;
  if (databaseBindingMode === DATABASE_BINDING_MODE_SHARED) {
    const sharedDatabase = sharedRuntimeDatabaseBinding(options.candidateRuntimeDatabaseUrl);
    candidateDatabaseName = sharedDatabase.databaseName;
    candidateDatabaseUrl = sharedDatabase.databaseUrl;
    if (runtimeReady.sharedDatabaseConnectionSha256 !== sharedDatabase.connectionSha256
      || runtimeReady.candidateDatabaseConnectionSha256 !== sharedDatabase.connectionSha256
      || runtimeReady.candidateDatabaseName !== candidateDatabaseName
      || runtimeReady.dataCloneReceiptSha256 !== null
      || runtimeReady.dataCloneCandidateDatabaseConnectionSha256 !== null) {
      fail("DEVELOPMENT_TEST_RUNTIME_SHARED_DATABASE_BINDING_MISMATCH");
    }
  } else {
    cloneReceipt = await ops.readCandidateDataCloneReceipt({
      candidateStateRoot: slots.candidate.stateRoot,
      receiptSigningKey: key,
      candidateSlotId: slots.candidate.slotId,
    });
    candidateDatabaseName = cloneReceipt.candidate?.databaseName;
    candidateDatabaseUrl = assertCandidateDatabaseRuntimeBinding(
      options.candidateRuntimeDatabaseUrl,
      candidateDatabaseName,
      runtimeReady.candidateDatabaseConnectionSha256,
    );
    if (cloneReceipt.receiptSha256 !== runtimeReady.dataCloneReceiptSha256
      || cloneReceipt.candidate.connectionSha256 !== runtimeReady.dataCloneCandidateDatabaseConnectionSha256
      || runtimeReady.candidateDatabaseRoleName !== deriveCandidateDatabaseRoleName(candidateDatabaseName)
      || runtimeReady.candidateDatabaseName !== candidateDatabaseName) {
      fail("DEVELOPMENT_TEST_RUNTIME_DATA_CLONE_BINDING_MISMATCH");
    }
  }
  await assertDevelopmentTestRuntimePortsAvailable(stage.ports);
  const plan = await ops.buildSlotLaunchPlan("candidate", {
    runRoot: paths.runRoot,
    installationRoot: paths.productRoot,
    environment: {},
    bind: "127.0.0.1",
    serverPorts: { active: 4100, candidate: stage.ports.server, previous: 4400 },
    localAuthPorts: { active: 4101, candidate: stage.ports.localAuth, previous: 4401 },
    moduleManagerPorts: { active: 4201, candidate: stage.ports.moduleManager, previous: 4402 },
    reservedPorts: [4000, 4198],
    databaseUrls: {
      active: planningDatabaseUrl(candidateDatabaseUrl, "active", paths.packageSha256),
      candidate: candidateDatabaseUrl,
      previous: planningDatabaseUrl(candidateDatabaseUrl, "previous", paths.packageSha256),
    },
  });
  const candidateStateRoot = slots.candidate.stateRoot;
  if (plan.env.RUN_SYSTEM_ROOT !== candidateStateRoot
    || plan.env.BONNI_PROGRAM_ROOT !== plan.programRoot
    || plan.env.BONNI_PRODUCT_ROOT !== plan.programRoot
    || plan.env.DATABASE_URL !== candidateDatabaseUrl) {
    fail("DEVELOPMENT_TEST_RUNTIME_LAUNCH_PLAN_INVALID");
  }
  assertRunDevPlanBinding(paths, plan);
  const candidateTemporaryRoot = path.join(candidateStateRoot, "tmp", "development-test-runtime");
  await fs.mkdir(candidateTemporaryRoot, { recursive: true, mode: 0o700 });
  const launchEnvironment = buildDevelopmentTestCandidateEnvironment({
    planEnvironment: {
      ...plan.env,
      SYSTEM_VERSION: stage.targetVersion,
      BONNI_CORE_IMAGE_VERSION: stage.targetVersion,
    },
    candidateDatabaseUrl,
    candidateDatabaseName,
    databaseBindingMode,
    receiptSigningKey: key,
    readySha256: runtimeReady.readySha256,
    temporaryRoot: candidateTemporaryRoot,
    developmentRoot: paths.developmentRoot,
    operatingSystemEnvironment: options.operatingSystemEnvironment || process.env,
  });
  assertRunDevLaunchBinding(paths, plan, launchEnvironment);
  writeRuntimeDiagnosticLine(
    `Direktbindung vorbereitet: Backend/Frontend=127.0.0.1:${stage.ports.server}; `
      + `LocalAuth=${stage.ports.localAuth}; ModuleManager=${stage.ports.moduleManager}; `
      + "proxyCutover=false; Produktionsproxy=unveraendert; BONNI_LOCAL_RUN_SLOTS=0",
  );
  await fs.unlink(paths.stopFile).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const ownerInstanceId = String(options.ownerInstanceId || "");
  const launchIntent = await readRuntimeState(paths, key, { required: true });
  validateRuntimeStateBinding(launchIntent, staged, runtimeReady);
  if (!validOwnerInstanceId(ownerInstanceId)
    || launchIntent.status !== "starting"
    || launchIntent.ownerInstanceId !== ownerInstanceId
    || launchIntent.workerPid !== null
    || launchIntent.childPid !== null) {
    fail("DEVELOPMENT_TEST_RUNTIME_OWNER_INTENT_MISMATCH");
  }
  let childStartedAt = null;
  const writeWorkerState = async (status, childPid, errorCode = null) => persistRuntimeState(paths, key, {
    readySha256: runtimeReady.readySha256,
    ownerInstanceId,
    status,
    workerPid: process.pid,
    childPid,
    childStartedAt,
    ports: stage.ports,
    updatedAt: nowIso(options.now),
    errorCode,
  });
  const writeHeartbeat = async (status, childPid) => persistRuntimeHeartbeat(paths, key, {
    readySha256: runtimeReady.readySha256,
    ownerInstanceId,
    status,
    workerPid: process.pid,
    childPid,
    childStartedAt,
    ports: stage.ports,
    heartbeatAt: nowIso(options.now),
  });
  await writeWorkerState("starting", null);
  await writeHeartbeat("starting", null);
  let child;
  let signalStopRequested = false;
  const requestSignalStop = () => {
    signalStopRequested = true;
  };
  process.on("SIGINT", requestSignalStop);
  process.on("SIGTERM", requestSignalStop);
  try {
    child = dependencies.spawnCandidate
      ? await dependencies.spawnCandidate({ plan, environment: launchEnvironment })
      : spawn(process.execPath, [plan.serverEntry], {
        cwd: plan.backendRoot,
        env: launchEnvironment,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        windowsHide: true,
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) fail("DEVELOPMENT_TEST_RUNTIME_CHILD_PID_INVALID");
    await writeWorkerState("starting", child.pid);
    await writeHeartbeat("starting", child.pid);
    await waitForBackendReady(
      child,
      Number(options.backendReadyTimeoutMs || 60_000),
      () => writeHeartbeat("starting", child.pid),
    );
    const healthUrl = `http://127.0.0.1:${stage.ports.server}/api/health/ready`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await writeHeartbeat("starting", child.pid);
      const health = await probeCandidateHealth({
        url: healthUrl,
        expectedVersion: stage.targetVersion,
        expectedPid: child.pid,
        ...(childStartedAt ? { expectedStartedAt: childStartedAt } : {}),
        fetchImpl: dependencies.fetchImpl || globalThis.fetch,
      });
      childStartedAt ||= health.runtime.startedAt;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await writeWorkerState("ready", child.pid);
    await writeHeartbeat("ready", child.pid);
    let authenticatedStopRequested = false;
    while (child.exitCode === null && child.signalCode === null && !signalStopRequested) {
      const stop = await readStopRequest(paths, key, runtimeReady.readySha256);
      if (stop) {
        authenticatedStopRequested = true;
        break;
      }
      await writeHeartbeat("ready", child.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (!authenticatedStopRequested && !signalStopRequested) {
        fail(
          "DEVELOPMENT_TEST_RUNTIME_BACKEND_EXITED_UNEXPECTEDLY",
          `${child.exitCode ?? "signal"}:${child.signalCode || ""}`,
        );
      }
    }
    await writeWorkerState("stopping", child.pid);
    await writeHeartbeat("stopping", child.pid);
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({
        type: "BONNI_SUPERVISOR_SHUTDOWN",
        reason: "development-test-runtime-stop",
        requestId: runtimeReady.readySha256,
      });
      else child.kill("SIGTERM");
      if (!(await waitForChildExit(child, 10_000, () => writeHeartbeat("stopping", child.pid)))
        && !(await terminateOwnedChild(child, () => writeHeartbeat("stopping", child.pid)))) {
        fail("DEVELOPMENT_TEST_RUNTIME_CHILD_STOP_UNCONFIRMED");
      }
    }
    await writeWorkerState("stopped", child.pid);
    await fs.unlink(paths.heartbeatFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { status: "stopped" };
  } catch (error) {
    const childPid = Number.isSafeInteger(child?.pid) ? child.pid : null;
    let childStopped = true;
    if (childPid !== null && child.exitCode === null && child.signalCode === null) {
      await writeWorkerState("stopping", childPid, String(error?.code || "DEVELOPMENT_TEST_RUNTIME_WORKER_FAILED")).catch(() => undefined);
      await writeHeartbeat("stopping", childPid).catch(() => undefined);
      childStopped = await terminateOwnedChild(child, () => writeHeartbeat("stopping", childPid));
    }
    const terminalCode = childStopped
      ? String(error?.code || "DEVELOPMENT_TEST_RUNTIME_WORKER_FAILED")
      : "DEVELOPMENT_TEST_RUNTIME_CHILD_STOP_UNCONFIRMED";
    await writeWorkerState(childStopped ? "failed" : "stopping", childPid, terminalCode).catch(() => undefined);
    if (childStopped) {
      await fs.unlink(paths.heartbeatFile).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    } else {
      await writeHeartbeat("stopping", childPid).catch(() => undefined);
    }
    const diagnosticError = await enrichBackendFailure(error, paths.logFile);
    if (!childStopped) fail("DEVELOPMENT_TEST_RUNTIME_CHILD_STOP_UNCONFIRMED", terminalCode, diagnosticError);
    throw diagnosticError;
  } finally {
    process.off("SIGINT", requestSignalStop);
    process.off("SIGTERM", requestSignalStop);
  }
}

export async function stopDevelopmentTestRuntime(options, dependencies = {}) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const key = await loadRuntimeKey({ ...options, productRoot: paths.productRoot });
  const ready = await lstatOrNull(paths.readyFile) ? await readRuntimeReady(paths, key) : null;
  const state = await readRuntimeState(paths, key);
  if (!state) {
    if (ready) fail("DEVELOPMENT_TEST_RUNTIME_OWNER_STATE_MISSING");
    return { status: "not-started", idempotent: true };
  }
  if (!ready) fail("DEVELOPMENT_TEST_RUNTIME_READY_MISSING");
  const staged = runtimeBindingFromReady(paths, key, ready);
  validateRuntimeStateBinding(state, staged, ready);
  if (TERMINAL_RUNTIME_STATUSES.has(state.status)) {
    return { status: state.status, idempotent: true };
  }
  const inspection = await inspectRuntimeBinding(staged, ready, state, options, dependencies);
  if (inspection.classification === "stale-recoverable") {
    const recovered = await persistRuntimeState(paths, key, {
      readySha256: ready.readySha256,
      ownerInstanceId: state.ownerInstanceId,
      status: "failed",
      workerPid: state.workerPid,
      childPid: state.childPid,
      childStartedAt: state.childStartedAt ?? null,
      ports: state.ports,
      updatedAt: nowIso(options.now),
      errorCode: "DEVELOPMENT_TEST_RUNTIME_STALE_STATE_RECOVERED",
    });
    await Promise.all([
      fs.unlink(paths.heartbeatFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
      fs.unlink(paths.stopFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ]);
    return {
      status: "failed",
      idempotent: false,
      recovered: true,
      stateSha256: recovered.stateSha256,
    };
  }
  if (inspection.classification !== "confirmed") {
    fail("DEVELOPMENT_TEST_RUNTIME_RUNNING_STATE_UNCONFIRMED", inspection.detail || state.status);
  }
  const stop = signDocument({
    schema: DEVELOPMENT_TEST_RUNTIME_STOP_SCHEMA,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    readySha256: ready.readySha256,
    requestedAt: nowIso(options.now),
    requestNonce: crypto.randomBytes(16).toString("hex"),
  }, key, "stopSha256");
  await writeJsonAtomic(paths.stopFile, stop);
  const finalState = dependencies.waitForStop
    ? await dependencies.waitForStop({ paths, key, ready, state, stop })
    : await waitForState(
      paths,
      key,
      (entry) => new Set(["stopped", "failed"]).has(entry.status),
      Number(options.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS),
    );
  if (!finalState || !new Set(["stopped", "failed"]).has(finalState.status)) {
    fail("DEVELOPMENT_TEST_RUNTIME_STOP_UNCONFIRMED");
  }
  return { status: finalState.status, idempotent: false, stateSha256: finalState.stateSha256 };
}

export async function getDevelopmentTestRuntimeStatus(options, dependencies = {}) {
  const ops = runtimeOps(dependencies);
  // Status is called from the interactive Windows UI immediately before a
  // start. It validates signed metadata and the tiny TEST-READY receipt, but
  // deliberately does not re-hash the complete candidate tree or both slot
  // trees. Full tree verification remains mandatory for prepare/start/stop.
  const metadata = await readDevelopmentTestRuntimeStatusMetadata(options, ops);
  const { paths, key, stage } = metadata;
  const ready = await lstatOrNull(paths.readyFile)
    ? await readRuntimeReady(paths, key)
    : null;
  const state = metadata.state;
  if (!state && ready) fail("DEVELOPMENT_TEST_RUNTIME_OWNER_STATE_MISSING");
  let status = "prepared";
  let binding = "not-started";
  if (state) {
    validateRuntimeStateBinding(state, metadata, ready);
    status = state.status;
    if (ACTIVE_RUNTIME_STATUSES.has(state.status)) {
      const inspection = await inspectRuntimeBinding(metadata, ready, state, options, dependencies);
      if (inspection.classification === "stale-recoverable") {
        fail("DEVELOPMENT_TEST_RUNTIME_STALE_RUNNING_STATE", state.status);
      }
      if (inspection.classification !== "confirmed") {
        fail("DEVELOPMENT_TEST_RUNTIME_RUNNING_STATE_UNCONFIRMED", inspection.detail || state.status);
      }
      binding = "confirmed";
    } else {
      binding = "terminal";
    }
  }
  return {
    ...stageSummary(stage, true),
    runtimeReady: Boolean(ready),
    readySha256: ready?.readySha256 || null,
    databaseBindingMode: ready?.databaseBindingMode || null,
    databaseName: ready?.candidateDatabaseName || null,
    status,
    binding,
    workerPid: state?.workerPid || null,
    childPid: state?.childPid || null,
    endpoint: status === "ready" ? `http://127.0.0.1:${stage.ports.server}` : null,
    proxyCutover: false,
  };
}

async function archiveCleanupReceipt(paths, key, input) {
  await fs.mkdir(paths.archiveRoot, { recursive: true, mode: 0o700 });
  const cleanup = signDocument({
    schema: DEVELOPMENT_TEST_RUNTIME_CLEANUP_SCHEMA,
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    stageSha256: input.stageSha256,
    readySha256: input.readySha256,
    dataCleanupReceiptSha256: input.dataCleanupReceiptSha256,
    cleanedAt: nowIso(input.now),
  }, key, "cleanupSha256");
  const file = path.join(paths.archiveRoot, `${paths.identity}--${input.stageSha256.slice(0, 16)}.json`);
  if (await lstatOrNull(file)) {
    const existing = verifyDocument(
      await readSmallJson(file, "DEVELOPMENT_TEST_RUNTIME_CLEANUP_INVALID"),
      key,
      DEVELOPMENT_TEST_RUNTIME_CLEANUP_SCHEMA,
      "cleanupSha256",
      "DEVELOPMENT_TEST_RUNTIME_CLEANUP_AUTHENTICATION_FAILED",
    );
    return existing;
  }
  await writeJsonAtomic(file, cleanup, { exclusive: true });
  return cleanup;
}

const INCOMPLETE_SESSION_PROTECTED_FILES = Object.freeze([
  READY_FILE,
  STATE_FILE,
  HEARTBEAT_FILE,
  STOP_FILE,
]);

async function cleanupUnpublishedDevelopmentTestRuntime(paths) {
  // A failed prepare can leave only the private program-slots tree behind.
  // There is no signed STAGED.json in that case, so the normal cleanup path
  // cannot authenticate a stage that was never published.  Treat this exact
  // candidate/hash directory as an unpublished, idempotently removable
  // preparation.  Published or running sessions still go through the fully
  // authenticated path below.
  if (await lstatOrNull(paths.stageFile)) return null;
  if (!pathIsInside(paths.sessionsRoot, paths.sessionRoot)) {
    fail("DEVELOPMENT_TEST_RUNTIME_CLEANUP_PATH_UNSAFE");
  }
  await assertNoSymlinkComponents(paths.sessionsRoot, "cleanup-sessions-root");
  const sessionsRootState = await lstatOrNull(paths.sessionsRoot);
  if (sessionsRootState && (!sessionsRootState.isDirectory() || sessionsRootState.isSymbolicLink())) {
    fail("DEVELOPMENT_TEST_RUNTIME_DIRECTORY_UNSAFE", "cleanup-sessions-root");
  }
  const sessionState = await lstatOrNull(paths.sessionRoot);
  if (!sessionState) {
    return {
      candidateId: paths.candidateId,
      packageSha256: paths.packageSha256,
      status: "cleaned",
      idempotent: true,
      incomplete: true,
      cleanupReason: "stage-missing",
      cleanupSha256: null,
      dataStatus: "none",
      terminalLog: null,
    };
  }
  if (sessionState.isSymbolicLink() || !sessionState.isDirectory()) {
    fail("DEVELOPMENT_TEST_RUNTIME_DIRECTORY_UNSAFE", "cleanup-session");
  }
  for (const name of INCOMPLETE_SESSION_PROTECTED_FILES) {
    if (await lstatOrNull(path.join(paths.sessionRoot, name))) {
      fail("DEVELOPMENT_TEST_RUNTIME_STAGE_MISSING", name);
    }
  }
  const entries = await fs.readdir(paths.sessionRoot);
  if (entries.some((name) => name.startsWith(".STAGED.json.") || name.startsWith(".RUNTIME-"))) {
    fail("DEVELOPMENT_TEST_RUNTIME_INCOMPLETE_SESSION_CLEANUP_REQUIRED");
  }
  await assertNoSymlinksBelow(paths.sessionRoot, "cleanup-session");

  // Recheck the publication markers immediately before removal.  A concurrent
  // prepare must never be mistaken for the unpublished failed preparation.
  if (await lstatOrNull(paths.stageFile)) {
    fail("DEVELOPMENT_TEST_RUNTIME_SESSION_CHANGED");
  }
  for (const name of INCOMPLETE_SESSION_PROTECTED_FILES) {
    if (await lstatOrNull(path.join(paths.sessionRoot, name))) {
      fail("DEVELOPMENT_TEST_RUNTIME_SESSION_CHANGED");
    }
  }
  const terminalLog = await archiveTerminalLog(paths);
  await fs.rm(paths.sessionRoot, { recursive: true, force: false });
  await syncDirectory(paths.sessionsRoot);
  return {
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    status: "cleaned",
    idempotent: true,
    incomplete: true,
    cleanupReason: "stage-missing",
    cleanupSha256: null,
    dataStatus: "none",
    terminalLog: terminalLog?.fileName || null,
  };
}

export async function cleanupDevelopmentTestRuntime(options, dependencies = {}) {
  const ops = runtimeOps(dependencies);
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const unpublished = await cleanupUnpublishedDevelopmentTestRuntime(paths);
  if (unpublished) return unpublished;
  // The candidate is a disposable RUN_DEV runtime. Its program tree may have
  // been changed by dependency hydration or Prisma generation during the test;
  // cleanup still authenticates the stage and verifies the active slot, but it
  // must not reject the exact temporary tree it is about to remove.
  const staged = await readDevelopmentTestRuntimeStage(
    options,
    ops,
    { allowCandidateRuntimeChanges: true },
  );
  const { key, stage } = staged;
  let state = await readRuntimeState(paths, key);
  const readyBeforeStop = await lstatOrNull(paths.readyFile) ? await readRuntimeReady(paths, key) : null;
  if (!state && readyBeforeStop) fail("DEVELOPMENT_TEST_RUNTIME_OWNER_STATE_MISSING");
  if (state && ACTIVE_RUNTIME_STATUSES.has(state.status)) {
    await stopDevelopmentTestRuntime({ ...options, receiptSigningKey: key }, dependencies);
    state = await readRuntimeState(paths, key);
  }
  if (state) {
    validateRuntimeStateBinding(state, staged, readyBeforeStop);
    if (!TERMINAL_RUNTIME_STATUSES.has(state.status)) {
      fail("DEVELOPMENT_TEST_RUNTIME_CLEANUP_STATE_UNSAFE", state.status);
    }
    await waitForRuntimeQuiescence(state, stage.ports, options, dependencies);
  }
  let dataCleanup = null;
  let databaseRoleCleanup = null;
  let source = null;
  let candidateDatabaseName = null;
  const candidateCloneReceipt = path.join(staged.slots.candidate.stateRoot, "candidate-data-clone.json");
  const cloneIntent = path.join(
    paths.runRoot,
    "receipts",
    "candidate-data-clone-intents",
    `${staged.slots.candidate.slotId}.json`,
  );
  const hasCloneLifecycle = Boolean(
    await lstatOrNull(candidateCloneReceipt) || await lstatOrNull(cloneIntent),
  );
  if (hasCloneLifecycle) {
    source = await resolveSourceData(options, paths);
    if (await lstatOrNull(candidateCloneReceipt)) {
      const cloneReceipt = await ops.readCandidateDataCloneReceipt({
        candidateStateRoot: staged.slots.candidate.stateRoot,
        receiptSigningKey: key,
        sourceDatabaseUrl: source.sourceDatabaseUrl,
        sourceRunSystemRoot: source.sourceRunSystemRoot,
        sourceStorageRoot: source.sourceStorageRoot,
        candidateSlotId: staged.slots.candidate.slotId,
      });
      candidateDatabaseName = cloneReceipt.candidate?.databaseName || null;
    } else if (await lstatOrNull(cloneIntent)) {
      const cloneIntentState = await ops.readCandidateDataCloneIntent({
        intentPath: cloneIntent,
        receiptSigningKey: key,
        runRoot: paths.runRoot,
        sourceDatabaseUrl: source.sourceDatabaseUrl,
        sourceRunSystemRoot: source.sourceRunSystemRoot,
        sourceStorageRoot: source.sourceStorageRoot,
        sourceSlotId: staged.slots.active.slotId,
        candidateSlotId: staged.slots.candidate.slotId,
        candidateStateRoot: staged.slots.candidate.stateRoot,
      });
      candidateDatabaseName = cloneIntentState.candidate?.databaseName || null;
    }
    if (dependencies.cleanupDataClone) {
      dataCleanup = await dependencies.cleanupDataClone({ staged, source });
    } else {
      dataCleanup = await ops.recoverCandidateDataCloneAtStartup({
        runRoot: paths.runRoot,
        sourceDatabaseUrl: source.sourceDatabaseUrl,
        sourceRunSystemRoot: source.sourceRunSystemRoot,
        sourceStorageRoot: source.sourceStorageRoot,
        receiptSigningKey: key,
        ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
    if (!candidateDatabaseName && dataCleanup?.candidateDatabaseName) {
      candidateDatabaseName = String(dataCleanup.candidateDatabaseName);
    }
    if (!candidateDatabaseName) {
      fail("DEVELOPMENT_TEST_RUNTIME_CANDIDATE_DATABASE_ROLE_BINDING_MISSING");
    }
    databaseRoleCleanup = await ops.cleanupCandidateDatabaseRole({
      sourceDatabaseUrl: source.sourceDatabaseUrl,
      candidateDatabaseName,
      environment: options.environment || process.env,
      ...(options.databaseRoleCommandRunner ? { commandRunner: options.databaseRoleCommandRunner } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
    });
  }
  const ready = await lstatOrNull(paths.readyFile) ? await readRuntimeReady(paths, key) : null;
  const cleanup = await archiveCleanupReceipt(paths, key, {
    stageSha256: stage.stageSha256,
    readySha256: ready?.readySha256 || null,
    dataCleanupReceiptSha256: dataCleanup?.cleanupReceipt?.receiptSha256 || null,
    now: options.now,
  });
  await assertNoSymlinkComponents(paths.sessionRoot, "cleanup-session");
  if (!pathIsInside(paths.sessionsRoot, paths.sessionRoot)) fail("DEVELOPMENT_TEST_RUNTIME_CLEANUP_PATH_UNSAFE");
  const terminalLog = await archiveTerminalLog(paths);
  await fs.rm(paths.sessionRoot, { recursive: true, force: false });
  await syncDirectory(paths.sessionsRoot);
  return {
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    status: "cleaned",
    cleanupSha256: cleanup.cleanupSha256,
    dataStatus: dataCleanup?.status || "none",
    databaseRoleStatus: databaseRoleCleanup?.status || "none",
    terminalLog: terminalLog?.fileName || null,
  };
}
