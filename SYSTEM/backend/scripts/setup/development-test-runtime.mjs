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
  stageProgramTree,
  verifyProgramSlot,
} from "../runcontainer/runcontainer-lib.mjs";
import {
  cleanupCandidateDataClone,
  cloneCandidateData,
  deriveCandidateDatabaseIdentity,
  readCandidateDataCloneReceipt,
  recoverCandidateDataCloneAtStartup,
} from "../runcontainer/candidate-data-clone.mjs";

export const DEVELOPMENT_TEST_RUNTIME_STAGE_SCHEMA = "bonni.development-test-runtime-stage/v1";
export const DEVELOPMENT_TEST_RUNTIME_READY_SCHEMA = "bonni.development-test-runtime-ready/v1";
export const DEVELOPMENT_TEST_RUNTIME_STATE_SCHEMA = "bonni.development-test-runtime-state/v1";
export const DEVELOPMENT_TEST_RUNTIME_STOP_SCHEMA = "bonni.development-test-runtime-stop/v1";
export const DEVELOPMENT_TEST_RUNTIME_CLEANUP_SCHEMA = "bonni.development-test-runtime-cleanup/v1";

export const DEVELOPMENT_TEST_RUNTIME_PORTS = Object.freeze({
  server: 4300,
  localAuth: 4301,
  moduleManager: 4302,
});

const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_ROOT_NAME = "development-tests";
const ARCHIVE_ROOT_NAME = "development-test-receipts";
const STAGE_FILE = "STAGED.json";
const READY_FILE = "RUNTIME-READY.json";
const STATE_FILE = "RUNTIME-STATE.json";
const STOP_FILE = "STOP-REQUEST.json";
const LOG_FILE = "terminal.log";
const MAXIMUM_JSON_BYTES = 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const CORE_INCLUDE_PATHS = Object.freeze(["SYSTEM/backend", "SYSTEM/frontend"]);

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

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return sha256(bytes);
}

export function resolveDevelopmentTestRuntimePaths({ productRoot, candidateId, packageSha256 }) {
  const root = canonicalProductRoot(productRoot);
  const id = canonicalCandidateId(candidateId);
  const hash = canonicalHash(packageSha256);
  const identity = `${id}--${hash}`;
  const sessionsRoot = path.join(root, "RUN_SYSTEM", SESSION_ROOT_NAME);
  const sessionRoot = path.join(sessionsRoot, identity);
  const runRoot = path.join(sessionRoot, "program-slots");
  return Object.freeze({
    productRoot: root,
    candidateId: id,
    packageSha256: hash,
    identity,
    sessionsRoot,
    sessionRoot,
    runRoot,
    stageFile: path.join(sessionRoot, STAGE_FILE),
    readyFile: path.join(sessionRoot, READY_FILE),
    stateFile: path.join(sessionRoot, STATE_FILE),
    stopFile: path.join(sessionRoot, STOP_FILE),
    logFile: path.join(sessionRoot, LOG_FILE),
    archiveRoot: path.join(root, "RUN_SYSTEM", ARCHIVE_ROOT_NAME),
  });
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
  });
  const expectedTestSystem = path.join(
    paths.productRoot,
    "DEVELOPMENT",
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
    || ready.receipt.packageSha256 !== paths.packageSha256
    || ready.receipt.testRelativePath
      !== `DEVELOPMENT/TESTS/${paths.candidateId}--${paths.packageSha256}/SYSTEM`) {
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
  readSlotPointers,
  cloneCandidateData,
  cleanupCandidateDataClone,
  recoverCandidateDataCloneAtStartup,
  readCandidateDataCloneReceipt,
  buildSlotLaunchPlan,
  spawn,
});

function runtimeOps(overrides = {}) {
  return { ...DEFAULT_OPS, ...overrides };
}

async function verifyStagedRuntime(paths, stage, ready, ops) {
  validateStageBindings(stage, paths);
  if (stage.testReadySha256 !== ready.receipt.testReadySha256
    || stage.testReadyFileSha256 !== ready.testReadyFileSha256
    || stage.finalTreeSha256 !== ready.receipt.finalTreeSha256
    || stage.targetVersion !== ready.receipt.targetVersion) {
    fail("DEVELOPMENT_TEST_RUNTIME_TEST_READY_CHANGED");
  }
  const [active, candidate, pointers] = await Promise.all([
    ops.verifyProgramSlot("active", { runRoot: paths.runRoot }),
    ops.verifyProgramSlot("candidate", { runRoot: paths.runRoot }),
    ops.readSlotPointers({ runRoot: paths.runRoot }),
  ]);
  if (active.slotId !== stage.slots.active.slotId
    || active.receipt.receiptSha256 !== stage.slots.active.receiptSha256
    || active.receipt.treeSha256 !== stage.slots.active.treeSha256
    || candidate.slotId !== stage.slots.candidate.slotId
    || candidate.receipt.receiptSha256 !== stage.slots.candidate.receiptSha256
    || candidate.receipt.treeSha256 !== stage.slots.candidate.treeSha256
    || pointers.roles.active?.slotId !== active.slotId
    || pointers.roles.candidate?.slotId !== candidate.slotId) {
    fail("DEVELOPMENT_TEST_RUNTIME_SLOT_BINDING_MISMATCH");
  }
  return { active, candidate, pointers };
}

export async function readDevelopmentTestRuntimeStage(options, dependencies = {}) {
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
  const slots = await verifyStagedRuntime(paths, stage, ready, ops);
  return { paths, key, ready, stage, slots };
}

export async function prepareDevelopmentTestRuntime(options, dependencies = {}) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const key = await loadRuntimeKey({ ...options, productRoot: paths.productRoot });
  const ops = runtimeOps(dependencies);
  await assertPlainDirectory(paths.productRoot, "product-root");
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
      version: ready.receipt.targetVersion,
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

async function resolveSourceData(options, paths) {
  const environment = options.environment || process.env;
  const sourceDatabaseUrl = String(options.sourceDatabaseUrl || environment.DATABASE_URL || "").trim();
  parsePostgresUrl(sourceDatabaseUrl, "DATABASE_URL");
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

function previousDatabaseUrl(sourceUrl, packageSha256) {
  const previous = new URL(sourceUrl);
  previous.pathname = `/bonni_devtest_not_started_${packageSha256.slice(0, 12)}`;
  return previous.toString();
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

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
    "--source-run-system-root", options.sourceRunSystemRoot,
    "--source-storage-root", options.sourceStorageRoot,
  ];
  if (options.keyFile) args.push("--key-file", path.resolve(options.keyFile));
  return args;
}

async function spawnDetachedWorker(paths, source, candidateDatabaseUrl, options, ops) {
  const logHandle = await fs.open(paths.logFile, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
  try {
    const child = ops.spawn(process.execPath, workerArguments(paths, {
      ...options,
      sourceRunSystemRoot: source.sourceRunSystemRoot,
      sourceStorageRoot: source.sourceStorageRoot,
    }), {
      cwd: paths.productRoot,
      env: {
        ...(options.environment || process.env),
        BONNI_DEVELOPMENT_TEST_SOURCE_DATABASE_URL: source.sourceDatabaseUrl,
        BONNI_DEVELOPMENT_TEST_DATABASE_URL: candidateDatabaseUrl,
      },
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
  if (existingState && new Set(["starting", "ready", "stopping"]).has(existingState.status)) {
    if (processExists(existingState.workerPid)) {
      return readySummary(await readRuntimeReady(paths, key), { status: existingState.status, idempotent: true });
    }
    fail("DEVELOPMENT_TEST_RUNTIME_STALE_RUNNING_STATE");
  }
  if (existingState) fail("DEVELOPMENT_TEST_RUNTIME_SESSION_RESTART_REQUIRES_CLEANUP", existingState.status);

  const source = await resolveSourceData(options, paths);
  const clone = await ops.cloneCandidateData({
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

  const sourceUrl = parsePostgresUrl(source.sourceDatabaseUrl, "DATABASE_URL");
  const plan = await ops.buildSlotLaunchPlan("candidate", {
    runRoot: paths.runRoot,
    installationRoot: paths.productRoot,
    environment: options.environment || process.env,
    serverPorts: { active: 4100, candidate: stage.ports.server, previous: 4400 },
    localAuthPorts: { active: 4101, candidate: stage.ports.localAuth, previous: 4401 },
    moduleManagerPorts: { active: 4201, candidate: stage.ports.moduleManager, previous: 4402 },
    reservedPorts: [4000, 4198],
    databaseUrls: {
      active: source.sourceDatabaseUrl,
      candidate: clone.candidateDatabaseUrl,
      previous: previousDatabaseUrl(sourceUrl, paths.packageSha256),
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
    dataCloneReceiptSha256: clone.receipt.receiptSha256,
    sourceDatabaseConnectionSha256: clone.receipt.source.connectionSha256,
    candidateDatabaseConnectionSha256: clone.receipt.candidate.connectionSha256,
    candidateStatePathSha256: clone.receipt.candidate.statePathSha256,
    ports: stage.ports,
    bind: "127.0.0.1",
    proxyCutover: false,
    preparedAt: nowIso(options.now),
  }, key, "readySha256");
  await writeJsonAtomic(paths.readyFile, runtimeReady, { exclusive: true });

  let workerPid;
  try {
    workerPid = dependencies.spawnWorker
      ? await dependencies.spawnWorker({ paths, source, clone, plan, runtimeReady, key })
      : await spawnDetachedWorker(paths, source, clone.candidateDatabaseUrl, options, ops);
    if (!Number.isSafeInteger(workerPid) || workerPid <= 0) fail("DEVELOPMENT_TEST_RUNTIME_WORKER_PID_INVALID");
    if (dependencies.spawnWorker) {
      await persistRuntimeState(paths, key, {
        readySha256: runtimeReady.readySha256,
        status: "ready",
        workerPid,
        childPid: workerPid,
        ports: stage.ports,
        updatedAt: nowIso(options.now),
        errorCode: null,
      });
    }
    const state = await waitForState(
      paths,
      key,
      (entry) => new Set(["ready", "failed", "stopped"]).has(entry.status),
      Number(options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS),
    );
    if (!state || state.status !== "ready") {
      fail("DEVELOPMENT_TEST_RUNTIME_START_FAILED", state?.errorCode || "timeout");
    }
    return readySummary(runtimeReady, {
      status: "ready",
      workerPid: state.workerPid,
      childPid: state.childPid,
      endpoint: `http://127.0.0.1:${stage.ports.server}`,
      idempotent: false,
    });
  } catch (error) {
    if (workerPid && processExists(workerPid)) {
      // Never kill a durable PID from a later CLI process; only the freshly
      // spawned, still-owned ChildProcess may be terminated by spawnWorker.
    }
    throw error;
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function waitForBackendReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
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
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function probeCandidateHealth({ url, expectedVersion, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") fail("DEVELOPMENT_TEST_RUNTIME_HEALTH_FETCH_UNAVAILABLE");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
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
    || payload?.state !== "ready"
    || payload?.database?.ready !== true
    || payload?.probe?.enabled !== true
    || payload?.probe?.roleMatches !== true
    || runtime?.slotRole !== "candidate"
    || runtime?.version !== expectedVersion
    || payload?.probe?.modules?.counts?.error !== 0) {
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
  const sourceDatabaseUrl = String(
    options.sourceDatabaseUrl
      || options.environment?.BONNI_DEVELOPMENT_TEST_SOURCE_DATABASE_URL
      || process.env.BONNI_DEVELOPMENT_TEST_SOURCE_DATABASE_URL
      || "",
  ).trim();
  const candidateDatabaseUrl = String(
    options.candidateDatabaseUrl
      || options.environment?.BONNI_DEVELOPMENT_TEST_DATABASE_URL
      || process.env.BONNI_DEVELOPMENT_TEST_DATABASE_URL
      || "",
  ).trim();
  parsePostgresUrl(sourceDatabaseUrl, "source");
  parsePostgresUrl(candidateDatabaseUrl, "candidate");
  if (sourceDatabaseUrl === candidateDatabaseUrl) fail("DEVELOPMENT_TEST_RUNTIME_DATABASE_NOT_ISOLATED");
  const cloneReceipt = await ops.readCandidateDataCloneReceipt({
    candidateStateRoot: slots.candidate.stateRoot,
    receiptSigningKey: key,
    candidateSlotId: slots.candidate.slotId,
  });
  const expectedIdentity = deriveCandidateDatabaseIdentity(sourceDatabaseUrl, {
    cloneId: cloneReceipt.cloneId,
    now: () => new Date(cloneReceipt.startedAt),
  });
  if (candidateDatabaseUrl !== expectedIdentity.candidateDatabaseUrl
    || cloneReceipt.receiptSha256 !== runtimeReady.dataCloneReceiptSha256
    || cloneReceipt.candidate.connectionSha256 !== runtimeReady.candidateDatabaseConnectionSha256) {
    fail("DEVELOPMENT_TEST_RUNTIME_DATA_CLONE_BINDING_MISMATCH");
  }
  await assertDevelopmentTestRuntimePortsAvailable(stage.ports);
  const plan = await ops.buildSlotLaunchPlan("candidate", {
    runRoot: paths.runRoot,
    installationRoot: paths.productRoot,
    environment: options.environment || process.env,
    serverPorts: { active: 4100, candidate: stage.ports.server, previous: 4400 },
    localAuthPorts: { active: 4101, candidate: stage.ports.localAuth, previous: 4401 },
    moduleManagerPorts: { active: 4201, candidate: stage.ports.moduleManager, previous: 4402 },
    reservedPorts: [4000, 4198],
    databaseUrls: {
      active: sourceDatabaseUrl,
      candidate: candidateDatabaseUrl,
      previous: previousDatabaseUrl(new URL(sourceDatabaseUrl), paths.packageSha256),
    },
  });
  const candidateStateRoot = slots.candidate.stateRoot;
  const launchEnvironment = {
    ...(options.environment || process.env),
    ...plan.env,
    DATABASE_URL: candidateDatabaseUrl,
    RUN_SYSTEM_ROOT: candidateStateRoot,
    RUN_SYSTEM_SYSTEM_ROOT: path.join(candidateStateRoot, "system"),
    RUN_SYSTEM_STORAGE_ROOT: path.join(candidateStateRoot, "storage"),
    RUN_SYSTEM_ARCHIV_ROOT: path.join(candidateStateRoot, "archiv"),
    BONNI_STORAGE_ROOT: path.join(candidateStateRoot, "storage"),
    MEDIA_STORAGE_ROOT: path.join(candidateStateRoot, "media"),
    BONNI_PRODUCT_ROOT: plan.programRoot,
    BONNI_PROJECT_ROOT: plan.programRoot,
    BONNI_PROGRAM_ROOT: plan.programRoot,
    BONNI_RUN_DEV_ROOT: path.join(paths.productRoot, "RUN_DEV"),
    SYSTEM_SLOT_ROLE: "candidate",
    BONNI_PROGRAM_SLOT_ROLE: "candidate",
    SYSTEM_UPDATE_PROBE_MODE: "true",
    SYSTEM_VERSION: stage.targetVersion,
    BONNI_CORE_IMAGE_VERSION: stage.targetVersion,
    PORT: String(stage.ports.server),
  };
  await fs.unlink(paths.stopFile).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await persistRuntimeState(paths, key, {
    readySha256: runtimeReady.readySha256,
    status: "starting",
    workerPid: process.pid,
    childPid: null,
    ports: stage.ports,
    updatedAt: nowIso(options.now),
    errorCode: null,
  });
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
    await waitForBackendReady(child, Number(options.backendReadyTimeoutMs || 60_000));
    const healthUrl = `http://127.0.0.1:${stage.ports.server}/api/health/update-probe`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await probeCandidateHealth({
        url: healthUrl,
        expectedVersion: stage.targetVersion,
        fetchImpl: dependencies.fetchImpl || globalThis.fetch,
      });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await persistRuntimeState(paths, key, {
      readySha256: runtimeReady.readySha256,
      status: "ready",
      workerPid: process.pid,
      childPid: child.pid,
      ports: stage.ports,
      updatedAt: nowIso(options.now),
      errorCode: null,
    });
    let authenticatedStopRequested = false;
    while (child.exitCode === null && child.signalCode === null && !signalStopRequested) {
      const stop = await readStopRequest(paths, key, runtimeReady.readySha256);
      if (stop) {
        authenticatedStopRequested = true;
        break;
      }
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
    await persistRuntimeState(paths, key, {
      readySha256: runtimeReady.readySha256,
      status: "stopping",
      workerPid: process.pid,
      childPid: child.pid,
      ports: stage.ports,
      updatedAt: nowIso(options.now),
      errorCode: null,
    });
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({
        type: "BONNI_SUPERVISOR_SHUTDOWN",
        reason: "development-test-runtime-stop",
        requestId: runtimeReady.readySha256,
      });
      else child.kill("SIGTERM");
      if (!(await waitForChildExit(child, 10_000))) child.kill("SIGTERM");
      if (!(await waitForChildExit(child, 5_000))) child.kill("SIGKILL");
      if (!(await waitForChildExit(child, 5_000))) fail("DEVELOPMENT_TEST_RUNTIME_CHILD_STOP_UNCONFIRMED");
    }
    await persistRuntimeState(paths, key, {
      readySha256: runtimeReady.readySha256,
      status: "stopped",
      workerPid: process.pid,
      childPid: child.pid,
      ports: stage.ports,
      updatedAt: nowIso(options.now),
      errorCode: null,
    });
    return { status: "stopped" };
  } catch (error) {
    child?.kill?.("SIGTERM");
    await persistRuntimeState(paths, key, {
      readySha256: runtimeReady.readySha256,
      status: "failed",
      workerPid: process.pid,
      childPid: Number.isSafeInteger(child?.pid) ? child.pid : null,
      ports: stage.ports,
      updatedAt: nowIso(options.now),
      errorCode: String(error?.code || "DEVELOPMENT_TEST_RUNTIME_WORKER_FAILED"),
    }).catch(() => undefined);
    throw error;
  } finally {
    process.off("SIGINT", requestSignalStop);
    process.off("SIGTERM", requestSignalStop);
  }
}

export async function stopDevelopmentTestRuntime(options, dependencies = {}) {
  const paths = resolveDevelopmentTestRuntimePaths(options);
  const key = await loadRuntimeKey({ ...options, productRoot: paths.productRoot });
  const state = await readRuntimeState(paths, key);
  if (!state || new Set(["stopped", "failed"]).has(state.status)) {
    return { status: state?.status || "not-started", idempotent: true };
  }
  const ready = await readRuntimeReady(paths, key);
  if (!new Set(["starting", "ready", "stopping"]).has(state.status)) {
    fail("DEVELOPMENT_TEST_RUNTIME_STATE_INVALID", state.status);
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
  const staged = await readDevelopmentTestRuntimeStage(options, ops);
  const ready = await lstatOrNull(staged.paths.readyFile)
    ? await readRuntimeReady(staged.paths, staged.key)
    : null;
  const state = await readRuntimeState(staged.paths, staged.key);
  return {
    ...stageSummary(staged.stage, true),
    runtimeReady: Boolean(ready),
    readySha256: ready?.readySha256 || null,
    status: state?.status || "prepared",
    workerPid: state?.workerPid || null,
    childPid: state?.childPid || null,
    endpoint: ready ? `http://127.0.0.1:${staged.stage.ports.server}` : null,
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

export async function cleanupDevelopmentTestRuntime(options, dependencies = {}) {
  const ops = runtimeOps(dependencies);
  const staged = await readDevelopmentTestRuntimeStage(options, ops);
  const { paths, key, stage } = staged;
  const state = await readRuntimeState(paths, key);
  if (state && new Set(["starting", "ready", "stopping"]).has(state.status)) {
    await stopDevelopmentTestRuntime({ ...options, receiptSigningKey: key }, dependencies);
  }
  let dataCleanup = null;
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
    const source = await resolveSourceData(options, paths);
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
  await fs.rm(paths.sessionRoot, { recursive: true, force: false });
  await syncDirectory(paths.sessionsRoot);
  return {
    candidateId: paths.candidateId,
    packageSha256: paths.packageSha256,
    status: "cleaned",
    cleanupSha256: cleanup.cleanupSha256,
    dataStatus: dataCleanup?.status || "none",
  };
}
