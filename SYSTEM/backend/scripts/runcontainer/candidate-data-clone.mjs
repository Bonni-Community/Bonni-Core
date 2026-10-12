import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJson,
  resolveProgramSlot,
  runContainerRoot,
  writeJson,
} from "./runcontainer-lib.mjs";

export const CANDIDATE_DATA_CLONE_RECEIPT_SCHEMA = "bonni.local-candidate-data-clone/v1";
export const CANDIDATE_DATA_CLONE_CLEANUP_SCHEMA = "bonni.local-candidate-data-clone-cleanup/v1";
export const CANDIDATE_DATA_CLONE_INTENT_SCHEMA = "bonni.local-candidate-data-clone-intent/v1";
export const DEFAULT_CANDIDATE_RUN_EXCLUSIONS = Object.freeze([
  "controller",
  "logs",
  "locks",
  ".locks",
  "tmp",
  "temp",
  "system/controller",
  "system/logs",
  "system/locks",
  "system/.locks",
  "system/tmp",
  "system/temp",
  "system/emergency-control.json",
  "system/emergency/emergency.pid",
  "system/emergency/emergency.log",
  "system/update-center/downloads",
  "system/backups",
  "system/restore-request.json",
]);

const RECEIPT_FILE = "candidate-data-clone.json";
const INTENT_DIRECTORY = "candidate-data-clone-intents";
const SLOT_ID_PATTERN = /^slot-[a-f0-9-]{36}$/u;
const INTENT_PHASES = Object.freeze([
  "prepared",
  "database-created",
  "database-restored",
  "state-activated",
  "completed",
  "cleanup-started",
  "cleaned",
]);
const INTENT_PHASE_SET = new Set(INTENT_PHASES);
const RECOVERY_INTENT_AUTHORITY = Symbol("candidate-data-clone-recovery-intent");
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_POSTGRES_IDENTIFIER_BYTES = 63;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const CLONE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class CandidateDataCloneError extends Error {
  constructor(code, detail = "", cause = undefined) {
    super(detail ? `${code}:${detail}` : code, cause ? { cause } : undefined);
    this.name = "CandidateDataCloneError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", cause = undefined) {
  throw new CandidateDataCloneError(code, detail, cause);
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

function receiptSigningKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "utf8");
  if (key.length < 32) fail("CANDIDATE_CLONE_RECEIPT_SIGNING_KEY_REQUIRED");
  return key;
}

function receiptMac(value, key) {
  return crypto.createHmac("sha256", key).update(stableStringify(value)).digest("hex");
}

function nowIso(now = () => new Date()) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("CANDIDATE_CLONE_TIME_INVALID");
  return date.toISOString();
}

function portableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function pathIdentity(value) {
  const resolved = path.normalize(path.resolve(value));
  const normalized = resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathIdentity(left) === pathIdentity(right);
}

function statePathFingerprint(value) {
  return sha256(pathIdentity(value));
}

function isInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowEqual && relative === "")
    || (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isInside(left, right, true) || isInside(right, left, true);
}

async function lstatOrNull(target, options = undefined) {
  try {
    return await fs.lstat(target, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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

async function writeJsonExclusive(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(directory, "candidate-lifecycle-parent");
  let handle;
  let created = false;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) {
      await fs.unlink(file).catch(() => undefined);
      await syncDirectory(directory).catch(() => undefined);
    }
    if (error?.code === "EEXIST") {
      fail("CANDIDATE_CLONE_LIFECYCLE_LOCKED", path.basename(file), error);
    }
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
    if (state.isSymbolicLink()) fail("CANDIDATE_CLONE_SYMLINK_FORBIDDEN", `${label}:${cursor}`);
  }
}

async function assertPlainDirectory(target, label) {
  await assertNoSymlinkComponents(target, label);
  const state = await lstatOrNull(target);
  if (!state) fail("CANDIDATE_CLONE_SOURCE_MISSING", label);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    fail("CANDIDATE_CLONE_SOURCE_UNSAFE", label);
  }
}

async function inspectEmptyCandidateState(target) {
  await assertNoSymlinkComponents(path.dirname(target), "candidate-state-parent");
  const state = await lstatOrNull(target, { bigint: true });
  if (!state) return null;
  if (state.isSymbolicLink() || !state.isDirectory()) {
    fail("CANDIDATE_CLONE_TARGET_UNSAFE", target);
  }
  if ((await fs.readdir(target)).length !== 0) {
    fail("CANDIDATE_CLONE_TARGET_NOT_EMPTY", target);
  }
  return state;
}

async function removeUnchangedEmptyCandidateState(target, expectedState) {
  if (!expectedState) return;
  const current = await lstatOrNull(target, { bigint: true });
  if (!current || !current.isDirectory() || current.isSymbolicLink()
    || String(current.dev) !== String(expectedState.dev)
    || String(current.ino) !== String(expectedState.ino)
    || (await fs.readdir(target)).length !== 0) {
    fail("CANDIDATE_CLONE_TARGET_CHANGED");
  }
  try {
    await fs.rmdir(target);
  } catch (error) {
    fail("CANDIDATE_CLONE_TARGET_CHANGED", safeCommandError(error), error);
  }
}

function parsePostgresUrl(raw, label = "DATABASE_URL") {
  const text = String(raw ?? "").trim();
  if (!text) fail("CANDIDATE_CLONE_DATABASE_URL_MISSING", label);
  let connection;
  try {
    connection = new URL(text);
  } catch (error) {
    fail("CANDIDATE_CLONE_DATABASE_URL_INVALID", label, error);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(connection.protocol)) {
    fail("CANDIDATE_CLONE_DATABASE_ENGINE_UNSUPPORTED", connection.protocol || label);
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(connection.pathname.replace(/^\//u, ""));
  } catch (error) {
    fail("CANDIDATE_CLONE_DATABASE_NAME_INVALID", label, error);
  }
  if (!databaseName || databaseName.includes("\0") || databaseName.includes("/")) {
    fail("CANDIDATE_CLONE_DATABASE_NAME_INVALID", label);
  }
  return { connection, databaseName };
}

function sanitizedDatabaseStem(databaseName) {
  const normalized = databaseName.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const withPrefix = /^[a-z]/u.test(normalized) ? normalized : `db_${normalized || "bonni"}`;
  return withPrefix;
}

function connectionFingerprint(connection, databaseName) {
  const parameters = [...connection.searchParams.entries()]
    .filter(([key]) => !/password|secret|token/iu.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  return sha256(stableStringify({
    protocol: connection.protocol,
    host: connection.hostname.toLowerCase(),
    port: connection.port || "5432",
    username: decodeURIComponent(connection.username || ""),
    databaseName,
    parameters,
  }));
}

export function deriveCandidateDatabaseIdentity(sourceDatabaseUrl, options = {}) {
  const { connection, databaseName: sourceDatabaseName } = parsePostgresUrl(sourceDatabaseUrl, "source");
  const cloneId = String(options.cloneId || crypto.randomUUID()).trim();
  if (!CLONE_ID_PATTERN.test(cloneId)) fail("CANDIDATE_CLONE_ID_INVALID");
  const createdAt = nowIso(options.now);
  const timestamp = createdAt.replace(/[-:.TZ]/gu, "").slice(0, 14).toLowerCase();
  const suffix = sha256(`${cloneId}\0${sourceDatabaseName}\0${timestamp}`).slice(0, 14);
  const fixed = `_candidate_${timestamp}_${suffix}`;
  const stemBytes = MAX_POSTGRES_IDENTIFIER_BYTES - Buffer.byteLength(fixed, "utf8");
  const stem = sanitizedDatabaseStem(sourceDatabaseName).slice(0, Math.max(1, stemBytes)).replace(/_+$/u, "") || "db";
  const candidateDatabaseName = `${stem}${fixed}`;
  if (!DATABASE_NAME_PATTERN.test(candidateDatabaseName)
    || Buffer.byteLength(candidateDatabaseName, "utf8") > MAX_POSTGRES_IDENTIFIER_BYTES
    || candidateDatabaseName === sourceDatabaseName) {
    fail("CANDIDATE_CLONE_DATABASE_NAME_DERIVATION_FAILED");
  }
  const candidate = new URL(connection.href);
  candidate.pathname = `/${encodeURIComponent(candidateDatabaseName)}`;
  const candidateDatabaseUrl = candidate.toString();
  return {
    cloneId,
    createdAt,
    sourceDatabaseName,
    candidateDatabaseName,
    candidateDatabaseUrl,
    sourceConnectionSha256: connectionFingerprint(connection, sourceDatabaseName),
    candidateConnectionSha256: connectionFingerprint(candidate, candidateDatabaseName),
  };
}

function postgresEnvironment(baseEnvironment, rawUrl, databaseName) {
  const { connection } = parsePostgresUrl(rawUrl, "postgres-command");
  const environment = { ...baseEnvironment };
  for (const key of [
    "DATABASE_URL",
    "SOURCE_DATABASE_URL",
    "TARGET_DATABASE_URL",
    "PGDATABASE",
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGOPTIONS",
    "PGREQUIRESSL",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGCHANNELBINDING",
    "PGTARGETSESSIONATTRS",
  ]) delete environment[key];
  if (connection.hostname) environment.PGHOST = connection.hostname;
  if (connection.port) environment.PGPORT = connection.port;
  if (connection.username) environment.PGUSER = decodeURIComponent(connection.username);
  if (connection.password) environment.PGPASSWORD = decodeURIComponent(connection.password);
  environment.PGDATABASE = databaseName;
  environment.PGCONNECT_TIMEOUT = String(baseEnvironment.PGCONNECT_TIMEOUT || "10");
  const parameterMap = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    channel_binding: "PGCHANNELBINDING",
    target_session_attrs: "PGTARGETSESSIONATTRS",
  };
  for (const [parameter, environmentKey] of Object.entries(parameterMap)) {
    const value = connection.searchParams.get(parameter);
    if (value) environment[environmentKey] = value;
  }
  return environment;
}

function safeCommandError(error) {
  return String(error?.message || error || "unknown")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/postgres(?:ql)?:\/\/[^\s@/]+:[^\s@/]+@/giu, "postgresql://***:***@")
    .slice(0, 2_000);
}

export function runPostgresCommand({ command, args, environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-256_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-12_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ code: 0, stdout });
      else reject(new Error(stderr.trim() || `${path.basename(command)}:exit-${code ?? "signal"}:${signal || ""}`));
    });
  });
}

async function executePostgres(runner, label, command, args, environment) {
  try {
    return await runner({ command, args, environment, label });
  } catch (error) {
    fail("CANDIDATE_CLONE_POSTGRES_COMMAND_FAILED", `${label}:${safeCommandError(error)}`, error);
  }
}

function statIdentity(state) {
  return {
    dev: String(state.dev),
    ino: String(state.ino),
    size: String(state.size),
    mtimeNs: String(state.mtimeNs),
    ctimeNs: String(state.ctimeNs),
  };
}

function sameStatIdentity(left, right) {
  return stableStringify(statIdentity(left)) === stableStringify(statIdentity(right));
}

async function hashStableFile(file, initialState, label) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStatIdentity(initialState, opened)) {
      fail("CANDIDATE_CLONE_SOURCE_CHANGED", label);
    }
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("CANDIDATE_CLONE_FILE_TOO_LARGE", label);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const visible = await fs.lstat(file, { bigint: true });
    if (!sameStatIdentity(opened, after) || !sameStatIdentity(opened, visible)) {
      fail("CANDIDATE_CLONE_SOURCE_CHANGED", label);
    }
    return { size: Number(opened.size), sha256: digest.digest("hex") };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inventoryTree(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  await assertPlainDirectory(resolvedRoot, options.label || "source-tree");
  const excluded = new Set((options.excluded || []).map((value) => String(value).replaceAll("\\", "/").toLowerCase()));
  const entries = [];

  async function visit(directory, relativeDirectory = "") {
    const children = (await fs.readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const comparable = relative.toLowerCase();
      if ([...excluded].some((entry) => comparable === entry || comparable.startsWith(`${entry}/`))) continue;
      const state = await fs.lstat(absolute, { bigint: true });
      if (state.isSymbolicLink()) fail("CANDIDATE_CLONE_SYMLINK_FORBIDDEN", `${options.label || "tree"}:${relative}`);
      if (state.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        await visit(absolute, relative);
      } else if (state.isFile()) {
        const content = await hashStableFile(absolute, state, `${options.label || "tree"}:${relative}`);
        entries.push({ path: relative, type: "file", mode: Number(state.mode & 0o777n), ...content });
      } else {
        fail("CANDIDATE_CLONE_SPECIAL_FILE_FORBIDDEN", `${options.label || "tree"}:${relative}`);
      }
    }
  }

  await visit(resolvedRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const canonical = entries.map(({ path: entryPath, type, size = null, sha256: digest = null }) => ({
    path: entryPath,
    type,
    size,
    sha256: digest,
  }));
  return {
    root: resolvedRoot,
    entries,
    files: entries.filter((entry) => entry.type === "file").length,
    directories: entries.filter((entry) => entry.type === "directory").length,
    bytes: entries.reduce((total, entry) => total + (entry.size || 0), 0),
    treeSha256: sha256(stableStringify(canonical)),
  };
}

function assertMatchingInventory(expected, actual, label) {
  if (expected.treeSha256 !== actual.treeSha256
    || expected.files !== actual.files
    || expected.directories !== actual.directories
    || expected.bytes !== actual.bytes) {
    fail("CANDIDATE_CLONE_SOURCE_CHANGED", label);
  }
}

async function copySnapshotFile(source, destination, expected, label) {
  const sourceState = await fs.lstat(source, { bigint: true });
  if (sourceState.isSymbolicLink() || !sourceState.isFile()) {
    fail("CANDIDATE_CLONE_SOURCE_CHANGED", label);
  }
  let input;
  let output;
  try {
    input = await fs.open(source, fsConstants.O_RDONLY);
    const opened = await input.stat({ bigint: true });
    if (!sameStatIdentity(sourceState, opened) || Number(opened.size) !== expected.size) {
      fail("CANDIDATE_CLONE_SOURCE_CHANGED", label);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    output = await fs.open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) fail("CANDIDATE_CLONE_COPY_SHORT_WRITE", label);
        offset += bytesWritten;
      }
      bytes += bytesRead;
    }
    await output.sync();
    const finalSource = await input.stat({ bigint: true });
    const visibleSource = await fs.lstat(source, { bigint: true });
    const contentSha256 = digest.digest("hex");
    if (!sameStatIdentity(opened, finalSource)
      || !sameStatIdentity(opened, visibleSource)
      || bytes !== expected.size
      || contentSha256 !== expected.sha256) {
      fail("CANDIDATE_CLONE_SOURCE_CHANGED", label);
    }
    try {
      await output.chmod(expected.mode & 0o777);
    } catch (error) {
      if (!new Set(["ENOSYS", "ENOTSUP", "EPERM"]).has(error?.code)) throw error;
    }
  } finally {
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
  }
  const targetState = await fs.lstat(destination);
  if (!targetState.isFile() || targetState.isSymbolicLink() || targetState.nlink !== 1) {
    fail("CANDIDATE_CLONE_TARGET_LINK_FORBIDDEN", label);
  }
}

async function copyInventory(snapshot, targetRoot, targetPrefix = "") {
  for (const entry of snapshot.entries.filter((item) => item.type === "directory")) {
    const target = path.join(targetRoot, targetPrefix, ...entry.path.split("/"));
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
  }
  for (const entry of snapshot.entries.filter((item) => item.type === "file")) {
    const source = path.join(snapshot.root, ...entry.path.split("/"));
    const target = path.join(targetRoot, targetPrefix, ...entry.path.split("/"));
    await assertNoSymlinkComponents(path.dirname(source), `source-parent:${entry.path}`);
    await copySnapshotFile(source, target, entry, entry.path);
  }
}

async function verifyDumpFile(dumpFile) {
  const state = await lstatOrNull(dumpFile, { bigint: true });
  if (!state || state.isSymbolicLink() || !state.isFile() || state.size <= 0n || state.nlink !== 1n) {
    fail("CANDIDATE_CLONE_DATABASE_DUMP_INVALID");
  }
  return hashStableFile(dumpFile, state, "database-dump");
}

async function verifyTocFile(tocFile) {
  const state = await lstatOrNull(tocFile, { bigint: true });
  if (!state || state.isSymbolicLink() || !state.isFile() || state.size <= 0n || state.nlink !== 1n) {
    fail("CANDIDATE_CLONE_DATABASE_TOC_INVALID");
  }
  return hashStableFile(tocFile, state, "database-toc");
}

const DATABASE_PROBE_SQL = [
  "SELECT json_build_object(",
  "'database', current_database(),",
  "'schemas', (SELECT count(*)::int FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'),",
  "'tables', (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p')),",
  "'views', (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('v','m')),",
  "'sequences', (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind='S')",
  ")::text;",
].join(" ");

function parseDatabaseProbe(result, expectedDatabaseName, label) {
  const lines = String(result?.stdout || "").trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  let probe;
  try {
    probe = JSON.parse(lines.at(-1) || "");
  } catch (error) {
    fail("CANDIDATE_CLONE_DATABASE_PROBE_INVALID", label, error);
  }
  if (probe.database !== expectedDatabaseName
    || !["schemas", "tables", "views", "sequences"].every((key) => Number.isInteger(probe[key]) && probe[key] >= 0)) {
    fail("CANDIDATE_CLONE_DATABASE_PROBE_INVALID", label);
  }
  return probe;
}

function compareDatabaseProbes(source, candidate) {
  for (const key of ["schemas", "tables", "views", "sequences"]) {
    if (source[key] !== candidate[key]) fail("CANDIDATE_CLONE_DATABASE_PROBE_MISMATCH", key);
  }
}

function receiptChecksum(base) {
  return sha256(stableStringify(base));
}

function receiptWithChecksum(base, signingKey) {
  const checksummed = { ...base, receiptSha256: receiptChecksum(base) };
  return { ...checksummed, receiptMac: receiptMac(checksummed, signingKey) };
}

export function candidateDataCloneIntentPath(options = {}) {
  const environment = options.environment || process.env;
  const runRoot = path.resolve(options.runRoot || runContainerRoot(environment));
  const candidateSlotId = String(options.candidateSlotId || "").trim();
  if (!SLOT_ID_PATTERN.test(candidateSlotId)) fail("CANDIDATE_CLONE_INTENT_SLOT_INVALID");
  return path.join(runRoot, "receipts", INTENT_DIRECTORY, `${candidateSlotId}.json`);
}

function intentRequestPayload(intent) {
  return {
    schema: intent.schema,
    cloneId: intent.cloneId,
    createdAt: intent.createdAt,
    runRootPathSha256: intent.runRootPathSha256,
    source: intent.source,
    candidate: intent.candidate,
    temporaryRoot: intent.temporaryRoot,
  };
}

function authenticatedIntent(base, signingKey) {
  const withRequest = {
    ...base,
    requestSha256: sha256(stableStringify(intentRequestPayload(base))),
  };
  const withChecksum = { ...withRequest, intentSha256: sha256(stableStringify(withRequest)) };
  return { ...withChecksum, intentMac: receiptMac(withChecksum, signingKey) };
}

function advanceIntent(intent, phase, signingKey, options = {}) {
  if (!INTENT_PHASE_SET.has(phase)) fail("CANDIDATE_CLONE_INTENT_PHASE_INVALID", phase);
  const currentIndex = INTENT_PHASES.indexOf(intent.phase);
  const nextIndex = INTENT_PHASES.indexOf(phase);
  if (currentIndex >= 0 && nextIndex < currentIndex) {
    fail("CANDIDATE_CLONE_INTENT_PHASE_REGRESSION", `${intent.phase}:${phase}`);
  }
  const {
    intentMac: _oldMac,
    intentSha256: _oldChecksum,
    requestSha256: _oldRequest,
    ...base
  } = intent;
  return authenticatedIntent({
    ...base,
    phase,
    phaseSequence: nextIndex,
    updatedAt: nowIso(options.now),
    completedReceiptSha256: options.completedReceiptSha256 ?? base.completedReceiptSha256 ?? null,
    cleanupStartedIntentSha256:
      options.cleanupStartedIntentSha256 ?? base.cleanupStartedIntentSha256 ?? null,
    cleanupReceiptSha256: options.cleanupReceiptSha256 ?? base.cleanupReceiptSha256 ?? null,
  }, signingKey);
}

async function persistIntentPhase(intentPath, intent, phase, signingKey, options = {}) {
  const updated = advanceIntent(intent, phase, signingKey, options);
  await writeJson(intentPath, updated);
  await options.onLifecyclePhase?.({
    phase,
    cloneId: updated.cloneId,
    candidateSlotId: updated.candidate.slotId,
    candidateDatabaseName: updated.candidate.databaseName,
    intentPath,
  });
  return updated;
}

export function validateCandidateDataCloneIntent(intent, options = {}) {
  if (!intent || intent.schema !== CANDIDATE_DATA_CLONE_INTENT_SCHEMA
    || !INTENT_PHASE_SET.has(intent.phase)
    || intent.phaseSequence !== INTENT_PHASES.indexOf(intent.phase)) {
    fail("CANDIDATE_CLONE_INTENT_SCHEMA_INVALID");
  }
  const signingKey = receiptSigningKey(options.receiptSigningKey);
  const { intentMac: actualMac, intentSha256, ...withRequest } = intent;
  if (!HASH_PATTERN.test(String(intentSha256 || ""))
    || sha256(stableStringify(withRequest)) !== intentSha256) {
    fail("CANDIDATE_CLONE_INTENT_CHECKSUM_INVALID");
  }
  const expectedMac = receiptMac({ ...withRequest, intentSha256 }, signingKey);
  if (!HASH_PATTERN.test(String(actualMac || ""))
    || !crypto.timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(actualMac, "hex"))) {
    fail("CANDIDATE_CLONE_INTENT_AUTHENTICATION_FAILED");
  }
  if (!CLONE_ID_PATTERN.test(String(intent.cloneId || ""))
    || !SLOT_ID_PATTERN.test(String(intent.source?.slotId || ""))
    || !SLOT_ID_PATTERN.test(String(intent.candidate?.slotId || ""))
    || intent.source.slotId === intent.candidate.slotId
    || !DATABASE_NAME_PATTERN.test(String(intent.candidate?.databaseName || ""))
    || intent.source?.databaseName === intent.candidate.databaseName
    || !Number.isFinite(Date.parse(intent.createdAt))
    || !Number.isFinite(Date.parse(intent.updatedAt))) {
    fail("CANDIDATE_CLONE_INTENT_CONTENT_INVALID");
  }
  for (const digest of [
    intent.runRootPathSha256,
    intent.source.connectionSha256,
    intent.source.runSystemPathSha256,
    intent.source.storagePathSha256,
    intent.candidate.connectionSha256,
    intent.candidate.statePathSha256,
    intent.candidate.stagingPathSha256,
    intent.temporaryRoot?.pathSha256,
    intent.requestSha256,
  ]) {
    if (!HASH_PATTERN.test(String(digest || ""))) fail("CANDIDATE_CLONE_INTENT_CONTENT_INVALID", "hash");
  }
  if (intent.requestSha256 !== sha256(stableStringify(intentRequestPayload(intent)))) {
    fail("CANDIDATE_CLONE_INTENT_REQUEST_MISMATCH");
  }
  const temporaryRoot = path.resolve(String(intent.temporaryRoot?.path || ""));
  if (!isInside(os.tmpdir(), temporaryRoot)
    || statePathFingerprint(temporaryRoot) !== intent.temporaryRoot.pathSha256) {
    fail("CANDIDATE_CLONE_INTENT_TEMPORARY_PATH_INVALID");
  }
  if (intent.completedReceiptSha256 !== null
    && !HASH_PATTERN.test(String(intent.completedReceiptSha256 || ""))) {
    fail("CANDIDATE_CLONE_INTENT_RECEIPT_BINDING_INVALID");
  }
  const cleanupStartedIntentSha256 = intent.cleanupStartedIntentSha256 ?? null;
  const cleanupReceiptSha256 = intent.cleanupReceiptSha256 ?? null;
  if ((cleanupStartedIntentSha256 !== null
      && !HASH_PATTERN.test(String(cleanupStartedIntentSha256 || "")))
    || (cleanupReceiptSha256 !== null
      && !HASH_PATTERN.test(String(cleanupReceiptSha256 || "")))
    || ((cleanupStartedIntentSha256 === null) !== (cleanupReceiptSha256 === null))) {
    fail("CANDIDATE_CLONE_INTENT_CLEANUP_BINDING_INVALID");
  }
  if (cleanupReceiptSha256 !== null && intent.phase !== "cleaned") {
    fail("CANDIDATE_CLONE_INTENT_CLEANUP_BINDING_INVALID", intent.phase);
  }
  if (options.runRoot && statePathFingerprint(options.runRoot) !== intent.runRootPathSha256) {
    fail("CANDIDATE_CLONE_INTENT_RUN_ROOT_MISMATCH");
  }
  if (options.sourceRunSystemRoot
    && statePathFingerprint(options.sourceRunSystemRoot) !== intent.source.runSystemPathSha256) {
    fail("CANDIDATE_CLONE_INTENT_SOURCE_RUN_SYSTEM_MISMATCH");
  }
  if (options.sourceStorageRoot
    && statePathFingerprint(options.sourceStorageRoot) !== intent.source.storagePathSha256) {
    fail("CANDIDATE_CLONE_INTENT_SOURCE_STORAGE_MISMATCH");
  }
  if (options.sourceSlotId && options.sourceSlotId !== intent.source.slotId) {
    fail("CANDIDATE_CLONE_INTENT_SOURCE_SLOT_MISMATCH");
  }
  if (options.candidateSlotId && options.candidateSlotId !== intent.candidate.slotId) {
    fail("CANDIDATE_CLONE_INTENT_CANDIDATE_SLOT_MISMATCH");
  }
  if (options.candidateStateRoot
    && statePathFingerprint(options.candidateStateRoot) !== intent.candidate.statePathSha256) {
    fail("CANDIDATE_CLONE_INTENT_STATE_PATH_MISMATCH");
  }
  if (options.stagingRoot
    && statePathFingerprint(options.stagingRoot) !== intent.candidate.stagingPathSha256) {
    fail("CANDIDATE_CLONE_INTENT_STAGING_PATH_MISMATCH");
  }
  if (options.sourceDatabaseUrl) {
    const expected = deriveCandidateDatabaseIdentity(options.sourceDatabaseUrl, {
      cloneId: intent.cloneId,
      now: () => new Date(intent.createdAt),
    });
    if (expected.sourceDatabaseName !== intent.source.databaseName
      || expected.sourceConnectionSha256 !== intent.source.connectionSha256
      || expected.candidateDatabaseName !== intent.candidate.databaseName
      || expected.candidateConnectionSha256 !== intent.candidate.connectionSha256) {
      fail("CANDIDATE_CLONE_INTENT_DATABASE_MISMATCH");
    }
  }
  return intent;
}

export async function readCandidateDataCloneIntent(options = {}) {
  if (!options.intentPath) fail("CANDIDATE_CLONE_INTENT_PATH_MISSING");
  const intentPath = path.resolve(options.intentPath);
  await assertNoSymlinkComponents(intentPath, "candidate-clone-intent");
  const state = await lstatOrNull(intentPath);
  if (!state || state.isSymbolicLink() || !state.isFile() || state.nlink !== 1) {
    fail("CANDIDATE_CLONE_INTENT_FILE_UNSAFE");
  }
  return validateCandidateDataCloneIntent(await readJson(intentPath), options);
}

function validateSlot(slot, role, runRoot) {
  if (!slot || slot.role !== role || !slot.slotId || !slot.slotRoot || !slot.stateRoot) {
    fail("CANDIDATE_CLONE_SLOT_INVALID", role);
  }
  const slotRoot = path.resolve(slot.slotRoot);
  const stateRoot = path.resolve(slot.stateRoot);
  const stateParent = path.join(path.resolve(runRoot), "state");
  if (!isInside(path.resolve(runRoot), slotRoot)
    || !isInside(stateParent, stateRoot)
    || isInside(path.join(slotRoot, "program"), stateRoot, true)) {
    fail("CANDIDATE_CLONE_STATE_TARGET_UNSAFE", role);
  }
  return { ...slot, slotRoot, stateRoot };
}

async function resolveCloneSlots(options, runRoot) {
  const active = validateSlot(
    options.activeSlot || await resolveProgramSlot("active", { runRoot, verify: true }),
    "active",
    runRoot,
  );
  const candidate = validateSlot(
    options.candidateSlot || await resolveProgramSlot("candidate", { runRoot, verify: true }),
    "candidate",
    runRoot,
  );
  if (active.slotId === candidate.slotId || samePath(active.stateRoot, candidate.stateRoot)) {
    fail("CANDIDATE_CLONE_SLOT_NOT_ISOLATED");
  }
  return { active, candidate };
}

export async function resolveCandidateDataClonePaths(options = {}) {
  const environment = options.environment || process.env;
  const runRoot = path.resolve(options.runRoot || runContainerRoot(environment));
  const { active, candidate } = await resolveCloneSlots(options, runRoot);
  if (!options.sourceRunSystemRoot) fail("CANDIDATE_CLONE_SOURCE_RUN_SYSTEM_REQUIRED");
  if (!options.sourceStorageRoot) fail("CANDIDATE_CLONE_SOURCE_STORAGE_REQUIRED");
  const sourceRunSystemRoot = path.resolve(options.sourceRunSystemRoot);
  const sourceStorageRoot = path.resolve(options.sourceStorageRoot);
  const candidateStateRoot = path.resolve(options.candidateStateRoot || candidate.stateRoot);
  if (!samePath(candidateStateRoot, candidate.stateRoot)) {
    fail("CANDIDATE_CLONE_STATE_TARGET_MISMATCH", candidateStateRoot);
  }
  const targetStorageRoot = path.join(candidateStateRoot, "storage");
  await assertNoSymlinkComponents(runRoot, "run-root");
  await assertNoSymlinkComponents(candidate.slotRoot, "candidate-slot");
  await assertNoSymlinkComponents(path.dirname(candidateStateRoot), "candidate-state-parent");
  const candidateStateParent = await lstatOrNull(path.dirname(candidateStateRoot));
  if (!candidateStateParent || candidateStateParent.isSymbolicLink() || !candidateStateParent.isDirectory()) {
    fail("CANDIDATE_CLONE_STATE_PARENT_UNSAFE");
  }
  if (samePath(sourceRunSystemRoot, sourceStorageRoot) || isInside(sourceStorageRoot, sourceRunSystemRoot)) {
    fail("CANDIDATE_CLONE_SOURCE_ROOT_LAYOUT_UNSUPPORTED");
  }
  if (pathsOverlap(sourceRunSystemRoot, candidateStateRoot)
    || pathsOverlap(sourceStorageRoot, candidateStateRoot)) {
    fail("CANDIDATE_CLONE_SOURCE_TARGET_OVERLAP");
  }
  let storageExclusion = null;
  if (isInside(sourceRunSystemRoot, sourceStorageRoot)) {
    storageExclusion = portableRelative(sourceRunSystemRoot, sourceStorageRoot);
  }
  return {
    runRoot,
    active,
    candidate,
    sourceRunSystemRoot,
    sourceStorageRoot,
    candidateStateRoot,
    targetStorageRoot,
    storageExclusion,
    receiptPath: path.join(candidateStateRoot, RECEIPT_FILE),
  };
}

function postgresTools(options, environment) {
  return {
    pgDump: String(options.tools?.pgDump || environment.PG_DUMP_PATH || "pg_dump"),
    pgRestore: String(options.tools?.pgRestore || environment.PG_RESTORE_PATH || "pg_restore"),
    createDb: String(options.tools?.createDb || environment.CREATEDB_PATH || "createdb"),
    dropDb: String(options.tools?.dropDb || environment.DROPDB_PATH || "dropdb"),
    psql: String(options.tools?.psql || environment.PSQL_PATH || "psql"),
  };
}

function treePublicSummary(snapshot) {
  return {
    files: snapshot.files,
    directories: snapshot.directories,
    bytes: snapshot.bytes,
    treeSha256: snapshot.treeSha256,
  };
}

function assertTreeSummaryMatches(expected, actual, label) {
  if (!expected
    || expected.files !== actual.files
    || expected.directories !== actual.directories
    || expected.bytes !== actual.bytes
    || expected.treeSha256 !== actual.treeSha256) {
    fail("CANDIDATE_CLONE_CANDIDATE_TREE_CHANGED", label);
  }
}

function snapshotAttemptLimit(value) {
  const attempts = Number(value ?? 3);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    fail("CANDIDATE_CLONE_SNAPSHOT_ATTEMPTS_INVALID");
  }
  return attempts;
}

function retryableSnapshotError(error) {
  return error?.code === "CANDIDATE_CLONE_SOURCE_CHANGED"
    || new Set(["ENOENT", "ESTALE", "EBUSY", "EACCES", "EPERM"]).has(error?.code);
}

async function cloneMutableTreesWithRetry(paths, stagingRoot, options = {}) {
  const maximumAttempts = snapshotAttemptLimit(options.maxSnapshotAttempts);
  const runExclusions = [
    ...DEFAULT_CANDIDATE_RUN_EXCLUSIONS,
    ...(paths.storageExclusion ? [paths.storageExclusion] : []),
  ];
  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    try {
      await options.onSnapshotProgress?.({ phase: "attempt-started", attempt, maximumAttempts });
      const runBefore = await inventoryTree(paths.sourceRunSystemRoot, {
        label: "active-run-system",
        excluded: runExclusions,
      });
      const storageBefore = await inventoryTree(paths.sourceStorageRoot, { label: "active-storage" });
      await copyInventory(runBefore, stagingRoot);
      await copyInventory(storageBefore, stagingRoot, "storage");
      await options.onSnapshotProgress?.({ phase: "copy-complete", attempt, maximumAttempts });
      const runAfter = await inventoryTree(paths.sourceRunSystemRoot, {
        label: "active-run-system",
        excluded: runExclusions,
      });
      const storageAfter = await inventoryTree(paths.sourceStorageRoot, { label: "active-storage" });
      assertMatchingInventory(runBefore, runAfter, "active-run-system");
      assertMatchingInventory(storageBefore, storageAfter, "active-storage");
      const stagedRun = await inventoryTree(stagingRoot, {
        label: "candidate-run-system",
        excluded: ["storage", RECEIPT_FILE],
      });
      const stagedStorage = await inventoryTree(path.join(stagingRoot, "storage"), {
        label: "candidate-storage",
      });
      assertMatchingInventory(runBefore, stagedRun, "candidate-run-system");
      assertMatchingInventory(storageBefore, stagedStorage, "candidate-storage");
      await options.onSnapshotProgress?.({ phase: "verified", attempt, maximumAttempts });
      return { runBefore, storageBefore, stagedRun, stagedStorage, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!retryableSnapshotError(error) || attempt === maximumAttempts) throw error;
    }
  }
  throw lastError;
}

function candidateRuntimeEnvironment(identity, paths) {
  return {
    DATABASE_URL: identity.candidateDatabaseUrl,
    RUN_SYSTEM_ROOT: paths.candidateStateRoot,
    RUN_SYSTEM_SYSTEM_ROOT: path.join(paths.candidateStateRoot, "system"),
    RUN_SYSTEM_STORAGE_ROOT: paths.targetStorageRoot,
    RUN_SYSTEM_ARCHIV_ROOT: path.join(paths.candidateStateRoot, "archiv"),
    BONNI_STORAGE_ROOT: paths.targetStorageRoot,
  };
}

function validateConsistencyProof(proof, paths) {
  if (!proof || !CLONE_ID_PATTERN.test(String(proof.boundaryId || ""))
    || proof.activeSlotId !== paths.active.slotId
    || !Number.isFinite(Date.parse(proof.acquiredAt))) {
    fail("CANDIDATE_CLONE_CONSISTENCY_PROOF_INVALID");
  }
  const mode = String(proof.mode || (proof.writesStopped === true ? "exclusive-write-stop" : "online-verified-snapshot"));
  if (!new Set(["exclusive-write-stop", "online-verified-snapshot", "snapshot-provider"]).has(mode)
    || (mode === "exclusive-write-stop" && proof.writesStopped !== true)) {
    fail("CANDIDATE_CLONE_CONSISTENCY_PROOF_INVALID");
  }
  return {
    boundaryId: proof.boundaryId,
    activeSlotId: proof.activeSlotId,
    acquiredAt: new Date(proof.acquiredAt).toISOString(),
    mode,
  };
}

export async function cloneCandidateData(options = {}) {
  const environment = options.environment || process.env;
  if (options.onSnapshotProgress !== undefined && typeof options.onSnapshotProgress !== "function") {
    fail("CANDIDATE_CLONE_SNAPSHOT_OBSERVER_INVALID");
  }
  if (options.onLifecyclePhase !== undefined && typeof options.onLifecyclePhase !== "function") {
    fail("CANDIDATE_CLONE_LIFECYCLE_OBSERVER_INVALID");
  }
  const signingKey = receiptSigningKey(options.receiptSigningKey);
  const sourceDatabaseUrl = String(options.sourceDatabaseUrl || environment.DATABASE_URL || "").trim();
  const identity = deriveCandidateDatabaseIdentity(sourceDatabaseUrl, {
    cloneId: options.cloneId,
    now: options.now,
  });
  const paths = await resolveCandidateDataClonePaths(options);
  let failureReceiptPath = null;
  if (options.failureReceiptPath) {
    const failureReceiptsRoot = path.join(paths.runRoot, "receipts");
    failureReceiptPath = path.resolve(options.failureReceiptPath);
    if (!isInside(failureReceiptsRoot, failureReceiptPath)) {
      fail("CANDIDATE_CLONE_FAILURE_RECEIPT_PATH_UNSAFE");
    }
    if (await lstatOrNull(failureReceiptPath)) fail("CANDIDATE_CLONE_FAILURE_RECEIPT_EXISTS");
  }
  await assertPlainDirectory(paths.sourceRunSystemRoot, "active-run-system");
  await assertPlainDirectory(paths.sourceStorageRoot, "active-storage");
  await assertNoSymlinkComponents(paths.candidate.slotRoot, "candidate-slot");
  const existingState = await inspectEmptyCandidateState(paths.candidateStateRoot);

  const runner = options.commandRunner || runPostgresCommand;
  const consistencyProvider = typeof options.withConsistencyBoundary === "function"
    ? options.withConsistencyBoundary
    : async (context, operation) => operation({
      boundaryId: `online-${context.cloneId}`,
      activeSlotId: context.activeSlotId,
      writesStopped: false,
      acquiredAt: startedAt,
      mode: "online-verified-snapshot",
    });
  const tools = postgresTools(options, environment);
  const startedAt = identity.createdAt;
  const stagingRoot = path.join(
    path.dirname(paths.candidateStateRoot),
    `.${path.basename(paths.candidateStateRoot)}-${identity.cloneId}.pending`,
  );
  if (!isInside(path.dirname(paths.candidateStateRoot), stagingRoot)) {
    fail("CANDIDATE_CLONE_STAGING_TARGET_UNSAFE");
  }
  if (await lstatOrNull(stagingRoot)) fail("CANDIDATE_CLONE_STAGING_EXISTS", stagingRoot);
  const intentPath = candidateDataCloneIntentPath({
    runRoot: paths.runRoot,
    candidateSlotId: paths.candidate.slotId,
  });
  const previousIntentState = await lstatOrNull(intentPath);
  if (previousIntentState) {
    const previousIntent = await readCandidateDataCloneIntent({
      intentPath,
      receiptSigningKey: signingKey,
      runRoot: paths.runRoot,
      sourceDatabaseUrl,
      sourceRunSystemRoot: paths.sourceRunSystemRoot,
      sourceStorageRoot: paths.sourceStorageRoot,
      sourceSlotId: paths.active.slotId,
      candidateSlotId: paths.candidate.slotId,
      candidateStateRoot: paths.candidateStateRoot,
    });
    fail(
      previousIntent.phase === "cleaned"
        ? "CANDIDATE_CLONE_LIFECYCLE_ALREADY_USED"
        : "CANDIDATE_CLONE_RECOVERY_REQUIRED",
      `${paths.candidate.slotId}:${previousIntent.phase}`,
    );
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-candidate-data-"));
  const dumpFile = path.join(temporaryRoot, "candidate.dump");
  const tocFile = path.join(temporaryRoot, "candidate.toc");
  let databaseCreated = false;
  let stateActivated = false;
  let originalError = null;
  let intent = null;
  let lifecycleOwned = false;
  let databaseCleanupSucceeded = false;
  let stateCleanupSucceeded = true;
  let stagingCleanupSucceeded = true;
  let temporaryCleanupSucceeded = true;

  const sourceEnvironment = postgresEnvironment(environment, sourceDatabaseUrl, identity.sourceDatabaseName);
  const maintenanceDatabase = identity.sourceDatabaseName === "postgres" ? "template1" : "postgres";
  const maintenanceEnvironment = postgresEnvironment(environment, sourceDatabaseUrl, maintenanceDatabase);
  const candidateEnvironment = postgresEnvironment(environment, sourceDatabaseUrl, identity.candidateDatabaseName);

  try {
    let boundaryEntered = false;
    const boundaryResult = await consistencyProvider({
      operation: "candidate-data-clone",
      cloneId: identity.cloneId,
      activeSlotId: paths.active.slotId,
      candidateSlotId: paths.candidate.slotId,
      sourceRunSystemRoot: paths.sourceRunSystemRoot,
      sourceStorageRoot: paths.sourceStorageRoot,
    }, async (proof) => {
      if (boundaryEntered) fail("CANDIDATE_CLONE_CONSISTENCY_BOUNDARY_REENTERED");
      boundaryEntered = true;
      const consistency = validateConsistencyProof(proof, paths);

    // Fail closed on links/special files before creating any Candidate DB. The
    // later retry loop re-inventories because Active remains online.
    await inventoryTree(paths.sourceRunSystemRoot, {
      label: "active-run-system-preflight",
      excluded: [
        ...DEFAULT_CANDIDATE_RUN_EXCLUSIONS,
        ...(paths.storageExclusion ? [paths.storageExclusion] : []),
      ],
    });
    await inventoryTree(paths.sourceStorageRoot, { label: "active-storage-preflight" });

    const sourceProbe = parseDatabaseProbe(await executePostgres(
      runner,
      "verify-source-database",
      tools.psql,
      ["--no-align", "--tuples-only", "--set=ON_ERROR_STOP=1", `--command=${DATABASE_PROBE_SQL}`],
      sourceEnvironment,
    ), identity.sourceDatabaseName, "source");

    await executePostgres(runner, "pg-dump", tools.pgDump, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--serializable-deferrable",
      `--file=${dumpFile}`,
    ], sourceEnvironment);
    const dumpArtifact = await verifyDumpFile(dumpFile);
    await executePostgres(runner, "pg-restore-list", tools.pgRestore, [
      "--list",
      `--file=${tocFile}`,
      dumpFile,
    ], sourceEnvironment);
    const tocArtifact = await verifyTocFile(tocFile);
    intent = authenticatedIntent({
      schema: CANDIDATE_DATA_CLONE_INTENT_SCHEMA,
      cloneId: identity.cloneId,
      phase: "prepared",
      phaseSequence: INTENT_PHASES.indexOf("prepared"),
      createdAt: startedAt,
      updatedAt: nowIso(options.now),
      runRootPathSha256: statePathFingerprint(paths.runRoot),
      source: {
        slotId: paths.active.slotId,
        databaseName: identity.sourceDatabaseName,
        connectionSha256: identity.sourceConnectionSha256,
        runSystemPathSha256: statePathFingerprint(paths.sourceRunSystemRoot),
        storagePathSha256: statePathFingerprint(paths.sourceStorageRoot),
      },
      candidate: {
        slotId: paths.candidate.slotId,
        databaseName: identity.candidateDatabaseName,
        connectionSha256: identity.candidateConnectionSha256,
        statePathSha256: statePathFingerprint(paths.candidateStateRoot),
        stagingPathSha256: statePathFingerprint(stagingRoot),
      },
      temporaryRoot: {
        path: temporaryRoot,
        pathSha256: statePathFingerprint(temporaryRoot),
      },
      completedReceiptSha256: null,
      cleanupStartedIntentSha256: null,
      cleanupReceiptSha256: null,
    }, signingKey);
    await writeJsonExclusive(intentPath, intent);
    lifecycleOwned = true;
    await options.onLifecyclePhase?.({
      phase: "prepared",
      cloneId: intent.cloneId,
      candidateSlotId: intent.candidate.slotId,
      candidateDatabaseName: intent.candidate.databaseName,
      intentPath,
    });
    await executePostgres(runner, "createdb", tools.createDb, [
      "--no-password",
      identity.candidateDatabaseName,
    ], maintenanceEnvironment);
    databaseCreated = true;
    intent = await persistIntentPhase(intentPath, intent, "database-created", signingKey, {
      now: options.now,
      onLifecyclePhase: options.onLifecyclePhase,
    });
    await executePostgres(runner, "pg-restore", tools.pgRestore, [
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      `--dbname=${identity.candidateDatabaseName}`,
      dumpFile,
    ], candidateEnvironment);
    const dumpAfterRestore = await verifyDumpFile(dumpFile);
    if (dumpAfterRestore.size !== dumpArtifact.size || dumpAfterRestore.sha256 !== dumpArtifact.sha256) {
      fail("CANDIDATE_CLONE_DATABASE_DUMP_CHANGED");
    }
    const candidateProbe = parseDatabaseProbe(await executePostgres(
      runner,
      "verify-candidate-database",
      tools.psql,
      ["--no-align", "--tuples-only", "--set=ON_ERROR_STOP=1", `--command=${DATABASE_PROBE_SQL}`],
      candidateEnvironment,
    ), identity.candidateDatabaseName, "candidate");
    compareDatabaseProbes(sourceProbe, candidateProbe);
    intent = await persistIntentPhase(intentPath, intent, "database-restored", signingKey, {
      now: options.now,
      onLifecyclePhase: options.onLifecyclePhase,
    });

    const {
      runBefore,
      storageBefore,
      stagedRun,
      stagedStorage,
      attempts: filesystemAttempts,
    } = await cloneMutableTreesWithRetry(paths, stagingRoot, options);

    if (!options.activeSlot || !options.candidateSlot) {
      const current = await resolveCloneSlots(options, paths.runRoot);
      if (current.active.slotId !== paths.active.slotId || current.candidate.slotId !== paths.candidate.slotId) {
        fail("CANDIDATE_CLONE_SLOT_CHANGED_DURING_COPY");
      }
    }

    const completedAt = nowIso(options.now);
    const receiptBase = {
      schema: CANDIDATE_DATA_CLONE_RECEIPT_SCHEMA,
      cloneId: identity.cloneId,
      state: "completed",
      startedAt,
      completedAt,
      source: {
        slotId: paths.active.slotId,
        databaseName: identity.sourceDatabaseName,
        connectionSha256: identity.sourceConnectionSha256,
        runSystemPathSha256: statePathFingerprint(paths.sourceRunSystemRoot),
        storagePathSha256: statePathFingerprint(paths.sourceStorageRoot),
        runSystem: treePublicSummary(runBefore),
        storage: treePublicSummary(storageBefore),
        databaseArtifact: {
          dumpBytes: dumpArtifact.size,
          dumpSha256: dumpArtifact.sha256,
          tocBytes: tocArtifact.size,
          tocSha256: tocArtifact.sha256,
          probe: sourceProbe,
        },
      },
      candidate: {
        slotId: paths.candidate.slotId,
        databaseName: identity.candidateDatabaseName,
        connectionSha256: identity.candidateConnectionSha256,
        statePathSha256: statePathFingerprint(paths.candidateStateRoot),
        runSystem: treePublicSummary(stagedRun),
        storage: treePublicSummary(stagedStorage),
        databaseProbe: candidateProbe,
      },
      consistency: {
        ...consistency,
        filesystemAttempts,
        volatileExclusions: DEFAULT_CANDIDATE_RUN_EXCLUSIONS,
      },
    };
    const receipt = receiptWithChecksum(receiptBase, signingKey);
    await writeJson(path.join(stagingRoot, RECEIPT_FILE), receipt);
    await removeUnchangedEmptyCandidateState(paths.candidateStateRoot, existingState);
    await fs.rename(stagingRoot, paths.candidateStateRoot);
    stateActivated = true;
    intent = await persistIntentPhase(intentPath, intent, "state-activated", signingKey, {
      now: options.now,
      onLifecyclePhase: options.onLifecyclePhase,
    });
    intent = await persistIntentPhase(intentPath, intent, "completed", signingKey, {
      now: options.now,
      completedReceiptSha256: receipt.receiptSha256,
      onLifecyclePhase: options.onLifecyclePhase,
    });

    return {
      ok: true,
      message: "Isolierter Candidate-Datenstand wurde vollständig und geprüft erstellt.",
      receipt,
      receiptPath: paths.receiptPath,
      candidateDatabaseName: identity.candidateDatabaseName,
      candidateDatabaseUrl: identity.candidateDatabaseUrl,
      candidateStateRoot: paths.candidateStateRoot,
      candidateEnvironment: candidateRuntimeEnvironment(identity, paths),
      intentPath,
    };
    });
    if (!boundaryEntered) fail("CANDIDATE_CLONE_CONSISTENCY_BOUNDARY_NOT_ENTERED");
    return boundaryResult;
  } catch (error) {
    originalError = error;
    if (intent && lifecycleOwned) {
      try {
        intent = await persistIntentPhase(intentPath, intent, "cleanup-started", signingKey, { now: options.now });
      } catch (intentError) {
        error.intentCleanupError = intentError;
      }
    }
    if (stateActivated) {
      try {
        await fs.rm(paths.candidateStateRoot, { recursive: true, force: true });
        await fs.mkdir(paths.candidateStateRoot, { recursive: false, mode: 0o700 });
        stateActivated = false;
      } catch (stateError) {
        stateCleanupSucceeded = false;
        error.stateCleanupError = stateError;
      }
    }
    if (databaseCreated) {
      try {
        await executePostgres(runner, "dropdb-after-failure", tools.dropDb, [
          "--if-exists",
          "--force",
          "--no-password",
          identity.candidateDatabaseName,
        ], maintenanceEnvironment);
        databaseCleanupSucceeded = true;
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
    } else {
      databaseCleanupSucceeded = true;
    }
    throw error;
  } finally {
    try {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    } catch {
      stagingCleanupSucceeded = false;
    }
    if (originalError && existingState && !stateActivated) {
      await fs.mkdir(paths.candidateStateRoot, { recursive: false, mode: 0o700 }).catch(() => undefined);
    }
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    } catch {
      temporaryCleanupSucceeded = false;
    }
    if (originalError && intent && lifecycleOwned && databaseCleanupSucceeded && stateCleanupSucceeded
      && stagingCleanupSucceeded && temporaryCleanupSucceeded) {
      try {
        intent = await persistIntentPhase(intentPath, intent, "cleaned", signingKey, { now: options.now });
      } catch (intentError) {
        originalError.intentFinalizationError = intentError;
      }
    }
    if (originalError && failureReceiptPath) {
      const failure = receiptWithChecksum({
        schema: CANDIDATE_DATA_CLONE_RECEIPT_SCHEMA,
        cloneId: identity.cloneId,
        state: "failed",
        startedAt,
        completedAt: nowIso(options.now),
        errorCode: originalError.code || "CANDIDATE_CLONE_FAILED",
        sourceSlotId: paths.active.slotId,
        candidateSlotId: paths.candidate.slotId,
        candidateDatabaseName: identity.candidateDatabaseName,
        cleanupRequired: Boolean(databaseCreated && originalError.cleanupError),
      }, signingKey);
      await writeJson(failureReceiptPath, failure).catch(() => undefined);
    }
  }
}

export function validateCandidateDataCloneReceipt(receipt, options = {}) {
  if (!receipt || receipt.schema !== CANDIDATE_DATA_CLONE_RECEIPT_SCHEMA || receipt.state !== "completed") {
    fail("CANDIDATE_CLONE_RECEIPT_SCHEMA_INVALID");
  }
  const signingKey = receiptSigningKey(options.receiptSigningKey);
  const { receiptMac: actualMac, receiptSha256, ...base } = receipt;
  if (!HASH_PATTERN.test(String(receiptSha256 || "")) || receiptChecksum(base) !== receiptSha256) {
    fail("CANDIDATE_CLONE_RECEIPT_CHECKSUM_INVALID");
  }
  const expectedMac = receiptMac({ ...base, receiptSha256 }, signingKey);
  if (!HASH_PATTERN.test(String(actualMac || ""))
    || !crypto.timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(actualMac, "hex"))) {
    fail("CANDIDATE_CLONE_RECEIPT_AUTHENTICATION_FAILED");
  }
  if (!CLONE_ID_PATTERN.test(String(receipt.cloneId || ""))
    || !receipt.source?.slotId || !receipt.candidate?.slotId
    || receipt.source.slotId === receipt.candidate.slotId
    || !DATABASE_NAME_PATTERN.test(String(receipt.candidate?.databaseName || ""))
    || !HASH_PATTERN.test(String(receipt.source?.connectionSha256 || ""))
    || !HASH_PATTERN.test(String(receipt.source?.runSystemPathSha256 || ""))
    || !HASH_PATTERN.test(String(receipt.source?.storagePathSha256 || ""))
    || !HASH_PATTERN.test(String(receipt.candidate?.connectionSha256 || ""))
    || !HASH_PATTERN.test(String(receipt.candidate?.statePathSha256 || ""))) {
    fail("CANDIDATE_CLONE_RECEIPT_CONTENT_INVALID");
  }
  for (const tree of [
    receipt.source.runSystem,
    receipt.source.storage,
    receipt.candidate.runSystem,
    receipt.candidate.storage,
  ]) {
    if (!tree || !Number.isInteger(tree.files) || tree.files < 0
      || !Number.isInteger(tree.directories) || tree.directories < 0
      || !Number.isInteger(tree.bytes) || tree.bytes < 0
      || !HASH_PATTERN.test(String(tree.treeSha256 || ""))) {
      fail("CANDIDATE_CLONE_RECEIPT_CONTENT_INVALID", "tree");
    }
  }
  if (receipt.source.runSystem.treeSha256 !== receipt.candidate.runSystem.treeSha256
    || receipt.source.storage.treeSha256 !== receipt.candidate.storage.treeSha256) {
    fail("CANDIDATE_CLONE_RECEIPT_TREE_MISMATCH");
  }
  const artifact = receipt.source.databaseArtifact;
  if (!artifact
    || !Number.isSafeInteger(artifact.dumpBytes) || artifact.dumpBytes <= 0
    || !Number.isSafeInteger(artifact.tocBytes) || artifact.tocBytes <= 0
    || !HASH_PATTERN.test(String(artifact.dumpSha256 || ""))
    || !HASH_PATTERN.test(String(artifact.tocSha256 || ""))) {
    fail("CANDIDATE_CLONE_RECEIPT_DATABASE_ARTIFACT_INVALID");
  }
  const sourceProbe = artifact.probe;
  const candidateProbe = receipt.candidate.databaseProbe;
  if (!sourceProbe || !candidateProbe
    || sourceProbe.database !== receipt.source.databaseName
    || candidateProbe.database !== receipt.candidate.databaseName
    || !["schemas", "tables", "views", "sequences"].every((key) => (
      Number.isInteger(sourceProbe[key]) && sourceProbe[key] >= 0
      && Number.isInteger(candidateProbe[key]) && candidateProbe[key] === sourceProbe[key]
    ))) {
    fail("CANDIDATE_CLONE_RECEIPT_DATABASE_PROBE_INVALID");
  }
  if (!receipt.consistency
    || !CLONE_ID_PATTERN.test(String(receipt.consistency.boundaryId || ""))
    || receipt.consistency.activeSlotId !== receipt.source.slotId
    || !new Set(["exclusive-write-stop", "online-verified-snapshot", "snapshot-provider"])
      .has(receipt.consistency.mode)
    || !Number.isFinite(Date.parse(receipt.consistency.acquiredAt))
    || !Number.isInteger(receipt.consistency.filesystemAttempts)
    || receipt.consistency.filesystemAttempts < 1
    || receipt.consistency.filesystemAttempts > 5
    || stableStringify(receipt.consistency.volatileExclusions) !== stableStringify(DEFAULT_CANDIDATE_RUN_EXCLUSIONS)) {
    fail("CANDIDATE_CLONE_RECEIPT_CONSISTENCY_INVALID");
  }
  if (options.sourceDatabaseUrl) {
    const { connection, databaseName } = parsePostgresUrl(options.sourceDatabaseUrl, "receipt-source");
    if (databaseName !== receipt.source.databaseName
      || connectionFingerprint(connection, databaseName) !== receipt.source.connectionSha256) {
      fail("CANDIDATE_CLONE_RECEIPT_SOURCE_MISMATCH");
    }
  }
  if (options.sourceRunSystemRoot
    && statePathFingerprint(options.sourceRunSystemRoot) !== receipt.source.runSystemPathSha256) {
    fail("CANDIDATE_CLONE_RECEIPT_SOURCE_RUN_SYSTEM_MISMATCH");
  }
  if (options.sourceStorageRoot
    && statePathFingerprint(options.sourceStorageRoot) !== receipt.source.storagePathSha256) {
    fail("CANDIDATE_CLONE_RECEIPT_SOURCE_STORAGE_MISMATCH");
  }
  if (options.sourceSlotId && options.sourceSlotId !== receipt.source.slotId) {
    fail("CANDIDATE_CLONE_RECEIPT_SOURCE_SLOT_MISMATCH");
  }
  if (options.candidateStateRoot
    && statePathFingerprint(options.candidateStateRoot) !== receipt.candidate.statePathSha256) {
    fail("CANDIDATE_CLONE_RECEIPT_STATE_MISMATCH");
  }
  if (options.candidateSlotId && options.candidateSlotId !== receipt.candidate.slotId) {
    fail("CANDIDATE_CLONE_RECEIPT_SLOT_MISMATCH");
  }
  return receipt;
}

export async function readCandidateDataCloneReceipt(options = {}) {
  const receiptPath = options.receiptPath
    ? path.resolve(options.receiptPath)
    : path.join(path.resolve(options.candidateStateRoot || ""), RECEIPT_FILE);
  if (!options.receiptPath && !options.candidateStateRoot) {
    fail("CANDIDATE_CLONE_RECEIPT_PATH_MISSING");
  }
  await assertNoSymlinkComponents(receiptPath, "receipt");
  const state = await lstatOrNull(receiptPath);
  if (!state || state.isSymbolicLink() || !state.isFile() || state.nlink !== 1) {
    fail("CANDIDATE_CLONE_RECEIPT_FILE_UNSAFE");
  }
  const receipt = await readJson(receiptPath);
  return validateCandidateDataCloneReceipt(receipt, options);
}

export function validateCandidateDataCloneCleanupReceipt(receipt, options = {}) {
  if (!receipt || receipt.schema !== CANDIDATE_DATA_CLONE_CLEANUP_SCHEMA || receipt.state !== "completed") {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_SCHEMA_INVALID");
  }
  const signingKey = receiptSigningKey(options.receiptSigningKey);
  const { receiptMac: actualMac, receiptSha256, ...base } = receipt;
  if (!HASH_PATTERN.test(String(receiptSha256 || "")) || receiptChecksum(base) !== receiptSha256) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_CHECKSUM_INVALID");
  }
  const expectedMac = receiptMac({ ...base, receiptSha256 }, signingKey);
  if (!HASH_PATTERN.test(String(actualMac || ""))
    || !crypto.timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(actualMac, "hex"))) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_AUTHENTICATION_FAILED");
  }
  const cloneReceiptSha256 = receipt.cloneReceiptSha256 ?? null;
  const cloneIntentSha256 = receipt.cloneIntentSha256 ?? null;
  if (!CLONE_ID_PATTERN.test(String(receipt.cloneId || ""))
    || !receipt.candidateSlotId
    || !DATABASE_NAME_PATTERN.test(String(receipt.candidateDatabaseName || ""))
    || (cloneReceiptSha256 !== null && !HASH_PATTERN.test(String(cloneReceiptSha256 || "")))
    || (cloneIntentSha256 !== null && !HASH_PATTERN.test(String(cloneIntentSha256 || "")))
    || (cloneReceiptSha256 === null && cloneIntentSha256 === null)
    || !Number.isFinite(Date.parse(receipt.completedAt))) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_CONTENT_INVALID");
  }
  if (options.cloneReceiptSha256 && options.cloneReceiptSha256 !== cloneReceiptSha256) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_CLONE_MISMATCH");
  }
  if (options.cloneIntentSha256 && options.cloneIntentSha256 !== cloneIntentSha256) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_INTENT_MISMATCH");
  }
  return receipt;
}

export async function readCandidateDataCloneCleanupReceipt(options = {}) {
  if (!options.cleanupReceiptPath) fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_PATH_MISSING");
  const cleanupReceiptPath = path.resolve(options.cleanupReceiptPath);
  await assertNoSymlinkComponents(cleanupReceiptPath, "cleanup-receipt");
  const state = await lstatOrNull(cleanupReceiptPath);
  if (!state || state.isSymbolicLink() || !state.isFile() || state.nlink !== 1) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_FILE_UNSAFE");
  }
  return validateCandidateDataCloneCleanupReceipt(await readJson(cleanupReceiptPath), options);
}

async function assertCleanupDirectorySafe(target, label) {
  await assertNoSymlinkComponents(target, label);
  const state = await lstatOrNull(target);
  if (!state) return false;
  if (state.isSymbolicLink() || !state.isDirectory()) {
    fail("CANDIDATE_CLONE_CLEANUP_PATH_UNSAFE", label);
  }
  return true;
}

function stagingRootFromIntent(paths, intent) {
  const stagingRoot = path.join(
    path.dirname(paths.candidateStateRoot),
    `.${path.basename(paths.candidateStateRoot)}-${intent.cloneId}.pending`,
  );
  if (!isInside(path.dirname(paths.candidateStateRoot), stagingRoot)
    || statePathFingerprint(stagingRoot) !== intent.candidate.stagingPathSha256) {
    fail("CANDIDATE_CLONE_INTENT_STAGING_PATH_MISMATCH");
  }
  return stagingRoot;
}

function assertIntentMatchesReceipt(intent, receipt) {
  if (intent.cloneId !== receipt.cloneId
    || intent.createdAt !== receipt.startedAt
    || intent.source.slotId !== receipt.source.slotId
    || intent.source.databaseName !== receipt.source.databaseName
    || intent.source.connectionSha256 !== receipt.source.connectionSha256
    || intent.source.runSystemPathSha256 !== receipt.source.runSystemPathSha256
    || intent.source.storagePathSha256 !== receipt.source.storagePathSha256
    || intent.candidate.slotId !== receipt.candidate.slotId
    || intent.candidate.databaseName !== receipt.candidate.databaseName
    || intent.candidate.connectionSha256 !== receipt.candidate.connectionSha256
    || intent.candidate.statePathSha256 !== receipt.candidate.statePathSha256
    || (intent.completedReceiptSha256 !== null
      && intent.completedReceiptSha256 !== receipt.receiptSha256)) {
    fail("CANDIDATE_CLONE_INTENT_RECEIPT_MISMATCH");
  }
}

function assertCleanupReceiptMatchesLifecycle(cleanupReceipt, lifecycle = {}) {
  const cloneReceiptSha256 = lifecycle.receipt?.receiptSha256
    || lifecycle.completedReceiptSha256
    || null;
  const cloneIntentSha256 = lifecycle.cleanupStartedIntentSha256 || null;
  if (cleanupReceipt.cloneId !== lifecycle.cloneId
    || cleanupReceipt.candidateSlotId !== lifecycle.candidate.slotId
    || cleanupReceipt.candidateDatabaseName !== lifecycle.candidate.databaseName
    || (cleanupReceipt.cloneReceiptSha256 ?? null) !== cloneReceiptSha256
    || (cleanupReceipt.cloneIntentSha256 ?? null) !== cloneIntentSha256) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_LIFECYCLE_MISMATCH");
  }
}

async function assertCleanupPathsCleared(paths, intent) {
  const stateExists = await assertCleanupDirectorySafe(
    paths.candidateStateRoot,
    "candidate-state-cleaned",
  );
  if (!stateExists || (await fs.readdir(paths.candidateStateRoot)).length !== 0) {
    fail("CANDIDATE_CLONE_CLEANUP_STATE_NOT_EMPTY");
  }
  if (!intent) return;
  const stagingRoot = stagingRootFromIntent(paths, intent);
  const temporaryRoot = path.resolve(intent.temporaryRoot.path);
  if (await assertCleanupDirectorySafe(stagingRoot, "candidate-staging-cleaned")) {
    fail("CANDIDATE_CLONE_CLEANUP_STAGING_REMAINS");
  }
  if (await assertCleanupDirectorySafe(temporaryRoot, "candidate-temporary-cleaned")) {
    fail("CANDIDATE_CLONE_CLEANUP_TEMPORARY_REMAINS");
  }
}

async function notifyCleanupMilestone(options, phase, intentPath, lifecycle) {
  await options.onLifecyclePhase?.({
    phase,
    cloneId: lifecycle.cloneId,
    candidateSlotId: lifecycle.candidate.slotId,
    candidateDatabaseName: lifecycle.candidate.databaseName,
    intentPath,
  });
}

export async function cleanupCandidateDataClone(options = {}) {
  if (options.onLifecyclePhase !== undefined && typeof options.onLifecyclePhase !== "function") {
    fail("CANDIDATE_CLONE_LIFECYCLE_OBSERVER_INVALID");
  }
  const environment = options.environment || process.env;
  const signingKey = receiptSigningKey(options.receiptSigningKey);
  const sourceDatabaseUrl = String(options.sourceDatabaseUrl || environment.DATABASE_URL || "").trim();
  const paths = await resolveCandidateDataClonePaths(options);
  if (options.receipt) fail("CANDIDATE_CLONE_DIRECT_RECEIPT_FORBIDDEN");
  const receiptPath = path.resolve(options.receiptPath || paths.receiptPath);
  if (!samePath(receiptPath, paths.receiptPath)) fail("CANDIDATE_CLONE_RECEIPT_PATH_MISMATCH");
  const receiptState = await lstatOrNull(receiptPath);
  let receipt = null;
  if (receiptState) {
    receipt = await readCandidateDataCloneReceipt({
      receiptPath,
      receiptSigningKey: signingKey,
      sourceDatabaseUrl,
      sourceRunSystemRoot: paths.sourceRunSystemRoot,
      sourceStorageRoot: paths.sourceStorageRoot,
      sourceSlotId: paths.active.slotId,
      candidateStateRoot: paths.candidateStateRoot,
      candidateSlotId: paths.candidate.slotId,
    });
  }
  const intentPath = candidateDataCloneIntentPath({
    runRoot: paths.runRoot,
    candidateSlotId: paths.candidate.slotId,
  });
  const intentState = await lstatOrNull(intentPath);
  let intent = null;
  if (intentState) {
    intent = await readCandidateDataCloneIntent({
      intentPath,
      receiptSigningKey: signingKey,
      runRoot: paths.runRoot,
      sourceDatabaseUrl,
      sourceRunSystemRoot: paths.sourceRunSystemRoot,
      sourceStorageRoot: paths.sourceStorageRoot,
      sourceSlotId: paths.active.slotId,
      candidateSlotId: paths.candidate.slotId,
      candidateStateRoot: paths.candidateStateRoot,
    });
  }
  const intentRecovery = options[RECOVERY_INTENT_AUTHORITY] === true;
  if (!receipt && (!intentRecovery || !intent)) {
    fail("CANDIDATE_CLONE_RECEIPT_FILE_UNSAFE");
  }
  if (receipt && intent) assertIntentMatchesReceipt(intent, receipt);
  const cloneId = receipt?.cloneId || intent.cloneId;
  const startedAt = receipt?.startedAt || intent.createdAt;
  const source = receipt?.source || intent.source;
  const candidate = receipt?.candidate || intent.candidate;
  if (candidate.databaseName === source.databaseName) {
    fail("CANDIDATE_CLONE_CLEANUP_SOURCE_DATABASE_FORBIDDEN");
  }
  const expectedIdentity = deriveCandidateDatabaseIdentity(sourceDatabaseUrl, {
    cloneId,
    now: () => new Date(startedAt),
  });
  if (expectedIdentity.candidateDatabaseName !== candidate.databaseName
    || expectedIdentity.candidateConnectionSha256 !== candidate.connectionSha256) {
    fail("CANDIDATE_CLONE_CLEANUP_IDENTITY_MISMATCH");
  }

  const runner = options.commandRunner || runPostgresCommand;
  const tools = postgresTools(options, environment);
  const maintenanceDatabase = source.databaseName === "postgres" ? "template1" : "postgres";
  const maintenanceEnvironment = postgresEnvironment(environment, sourceDatabaseUrl, maintenanceDatabase);
  const cleanupReceiptsRoot = path.join(paths.runRoot, "receipts");
  const defaultCleanupReceiptPath = path.join(
    cleanupReceiptsRoot,
    `candidate-data-clone-cleanup-${cloneId}.json`,
  );
  const cleanupReceiptPath = path.resolve(options.cleanupReceiptPath || defaultCleanupReceiptPath);
  if (!isInside(cleanupReceiptsRoot, cleanupReceiptPath)) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_PATH_UNSAFE");
  }
  if (!samePath(cleanupReceiptPath, defaultCleanupReceiptPath)) {
    fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_PATH_MISMATCH");
  }
  if (await lstatOrNull(cleanupReceiptPath)) {
    const cleanupStartedIntentSha256 = intent?.phase === "cleaned"
      ? (intent.cleanupStartedIntentSha256 || intent.intentSha256)
      : intent?.phase === "cleanup-started"
        ? intent.intentSha256
        : null;
    const existingCleanupReceipt = await readCandidateDataCloneCleanupReceipt({
      cleanupReceiptPath,
      receiptSigningKey: signingKey,
    });
    assertCleanupReceiptMatchesLifecycle(existingCleanupReceipt, {
      cloneId,
      candidate,
      receipt,
      completedReceiptSha256: intent?.completedReceiptSha256 || null,
      cleanupStartedIntentSha256,
    });
    if (!intent || !new Set(["cleanup-started", "cleaned"]).has(intent.phase)) {
      fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_PHASE_MISMATCH", intent?.phase || "receipt-only");
    }
    if (intent.phase === "cleaned" && intent.cleanupReceiptSha256
      && intent.cleanupReceiptSha256 !== existingCleanupReceipt.receiptSha256) {
      fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_INTENT_MISMATCH");
    }
    await assertCleanupPathsCleared(paths, intent);
    const finalizedInterruptedCleanup = intent.phase === "cleanup-started";
    if (finalizedInterruptedCleanup) {
      intent = await persistIntentPhase(intentPath, intent, "cleaned", signingKey, {
        now: options.now,
        completedReceiptSha256: receipt?.receiptSha256 || intent.completedReceiptSha256 || null,
        cleanupStartedIntentSha256: intent.intentSha256,
        cleanupReceiptSha256: existingCleanupReceipt.receiptSha256,
        onLifecyclePhase: options.onLifecyclePhase,
      });
    }
    return {
      ok: true,
      status: finalizedInterruptedCleanup ? "cleaned" : "already-cleaned",
      message: finalizedInterruptedCleanup
        ? "Unterbrochene Candidate-Bereinigung wurde sicher abgeschlossen."
        : "Isolierter Candidate-Datenstand war bereits sicher entfernt.",
      cleanupReceipt: existingCleanupReceipt,
      cleanupReceiptPath,
    };
  }
  if (intent?.phase === "cleaned") {
    if (intent.cleanupReceiptSha256) {
      fail("CANDIDATE_CLONE_CLEANUP_RECEIPT_MISSING");
    }
    await assertCleanupPathsCleared(paths, intent);
    return {
      ok: true,
      status: "already-cleaned",
      message: "Isolierter Candidate-Datenstand war bereits sicher entfernt.",
      cleanupReceipt: null,
      cleanupReceiptPath: null,
    };
  }
  const candidateStateExists = await assertCleanupDirectorySafe(paths.candidateStateRoot, "candidate-state-cleanup");
  let stagingRoot = null;
  let temporaryRoot = null;
  if (intent) {
    stagingRoot = stagingRootFromIntent(paths, intent);
    temporaryRoot = path.resolve(intent.temporaryRoot.path);
    await assertCleanupDirectorySafe(stagingRoot, "candidate-staging-cleanup");
    await assertCleanupDirectorySafe(temporaryRoot, "candidate-temporary-cleanup");
  }
  if (receipt && intent?.phase !== "cleanup-started") {
    if (!candidateStateExists) fail("CANDIDATE_CLONE_CLEANUP_STATE_UNSAFE");
    const currentRunSystem = await inventoryTree(paths.candidateStateRoot, {
      label: "candidate-run-system-cleanup",
      excluded: ["storage", RECEIPT_FILE],
    });
    const currentStorage = await inventoryTree(paths.targetStorageRoot, {
      label: "candidate-storage-cleanup",
    });
    assertTreeSummaryMatches(receipt.candidate.runSystem, currentRunSystem, "run-system");
    assertTreeSummaryMatches(receipt.candidate.storage, currentStorage, "storage");
  }
  if (intent && intent.phase !== "cleanup-started") {
    intent = await persistIntentPhase(intentPath, intent, "cleanup-started", signingKey, {
      now: options.now,
      onLifecyclePhase: options.onLifecyclePhase,
    });
  }
  const cleanupStartedIntentSha256 = intent?.intentSha256 || null;
  await executePostgres(runner, "dropdb-cleanup", tools.dropDb, [
    "--if-exists",
    "--force",
    "--no-password",
    candidate.databaseName,
  ], maintenanceEnvironment);
  await notifyCleanupMilestone(options, "database-dropped", intentPath, { cloneId, candidate });

  if (candidateStateExists) await fs.rm(paths.candidateStateRoot, { recursive: true, force: false });
  if (stagingRoot && await lstatOrNull(stagingRoot)) await fs.rm(stagingRoot, { recursive: true, force: false });
  if (temporaryRoot && await lstatOrNull(temporaryRoot)) await fs.rm(temporaryRoot, { recursive: true, force: false });
  await fs.mkdir(paths.candidateStateRoot, { recursive: false, mode: 0o700 });
  await notifyCleanupMilestone(options, "state-cleared", intentPath, { cloneId, candidate });
  const cleanupBase = {
    schema: CANDIDATE_DATA_CLONE_CLEANUP_SCHEMA,
    cloneId,
    state: "completed",
    completedAt: nowIso(options.now),
    candidateSlotId: candidate.slotId,
    candidateDatabaseName: candidate.databaseName,
    cloneReceiptSha256: receipt?.receiptSha256 || intent?.completedReceiptSha256 || null,
    cloneIntentSha256: cleanupStartedIntentSha256,
  };
  const cleanupReceipt = receiptWithChecksum(cleanupBase, signingKey);
  await writeJson(cleanupReceiptPath, cleanupReceipt);
  await notifyCleanupMilestone(options, "cleanup-receipt-written", intentPath, { cloneId, candidate });
  if (intent) {
    intent = await persistIntentPhase(intentPath, intent, "cleaned", signingKey, {
      now: options.now,
      completedReceiptSha256: receipt?.receiptSha256 || intent.completedReceiptSha256 || null,
      cleanupStartedIntentSha256,
      cleanupReceiptSha256: cleanupReceipt.receiptSha256,
      onLifecyclePhase: options.onLifecyclePhase,
    });
  }
  return {
    ok: true,
    status: "cleaned",
    message: "Isolierter Candidate-Datenstand wurde sicher entfernt.",
    cleanupReceipt,
    cleanupReceiptPath,
  };
}

/**
 * Startup recovery is intentionally narrow: only the state directory resolved
 * from the currently committed Candidate pointer is inspected. No directory
 * scan and no caller-supplied receipt/slot override is accepted.
 */
export async function recoverCandidateDataCloneAtStartup(options = {}) {
  for (const forbidden of [
    "receipt",
    "receiptPath",
    "intentPath",
    "candidateStateRoot",
    "activeSlot",
    "candidateSlot",
  ]) {
    if (options[forbidden] !== undefined) {
      fail("CANDIDATE_CLONE_RECOVERY_OVERRIDE_FORBIDDEN", forbidden);
    }
  }
  const environment = options.environment || process.env;
  const runRoot = path.resolve(options.runRoot || runContainerRoot(environment));
  const candidate = await resolveProgramSlot("candidate", { runRoot, verify: true });
  if (!candidate) {
    return {
      ok: true,
      status: "none",
      reason: "candidate-pointer-missing",
    };
  }
  const boundCandidate = validateSlot(candidate, "candidate", runRoot);
  const receiptPath = path.join(boundCandidate.stateRoot, RECEIPT_FILE);
  const intentPath = candidateDataCloneIntentPath({
    runRoot,
    candidateSlotId: boundCandidate.slotId,
  });
  await assertNoSymlinkComponents(receiptPath, "candidate-recovery-receipt");
  await assertNoSymlinkComponents(intentPath, "candidate-recovery-intent");
  const receiptState = await lstatOrNull(receiptPath);
  const intentState = await lstatOrNull(intentPath);
  if (!receiptState && !intentState) {
    return {
      ok: true,
      status: "none",
      reason: "candidate-clone-lifecycle-missing",
      candidateSlotId: boundCandidate.slotId,
    };
  }
  if (receiptState && (receiptState.isSymbolicLink() || !receiptState.isFile() || receiptState.nlink !== 1)) {
    fail("CANDIDATE_CLONE_RECOVERY_RECEIPT_UNSAFE");
  }
  if (intentState && (intentState.isSymbolicLink() || !intentState.isFile() || intentState.nlink !== 1)) {
    fail("CANDIDATE_CLONE_RECOVERY_INTENT_UNSAFE");
  }
  const active = await resolveProgramSlot("active", { runRoot, verify: true });
  if (!active) fail("CANDIDATE_CLONE_RECOVERY_ACTIVE_POINTER_MISSING");
  const boundActive = validateSlot(active, "active", runRoot);
  const sourceDatabaseUrl = String(options.sourceDatabaseUrl || environment.DATABASE_URL || "").trim();
  const signingKey = receiptSigningKey(options.receiptSigningKey);
  let intent = null;
  if (intentState) {
    intent = await readCandidateDataCloneIntent({
      intentPath,
      receiptSigningKey: signingKey,
      runRoot,
      sourceDatabaseUrl,
      sourceRunSystemRoot: options.sourceRunSystemRoot,
      sourceStorageRoot: options.sourceStorageRoot,
      sourceSlotId: boundActive.slotId,
      candidateSlotId: boundCandidate.slotId,
      candidateStateRoot: boundCandidate.stateRoot,
    });
    stagingRootFromIntent({ candidateStateRoot: boundCandidate.stateRoot }, intent);
    if (intent.phase === "cleaned" && receiptState) {
      fail("CANDIDATE_CLONE_RECOVERY_CLEANED_STATE_CONFLICT");
    }
  }
  let receipt = null;
  if (receiptState) {
    receipt = await readCandidateDataCloneReceipt({
      receiptPath,
      receiptSigningKey: signingKey,
      sourceDatabaseUrl,
      sourceRunSystemRoot: options.sourceRunSystemRoot,
      sourceStorageRoot: options.sourceStorageRoot,
      sourceSlotId: boundActive.slotId,
      candidateStateRoot: boundCandidate.stateRoot,
      candidateSlotId: boundCandidate.slotId,
    });
  }
  if (!receipt && !intent) fail("CANDIDATE_CLONE_RECOVERY_AUTHORITY_MISSING");
  if (receipt && intent) assertIntentMatchesReceipt(intent, receipt);
  const cleaned = await cleanupCandidateDataClone({
    runRoot,
    environment,
    sourceDatabaseUrl,
    sourceRunSystemRoot: options.sourceRunSystemRoot,
    sourceStorageRoot: options.sourceStorageRoot,
    receiptSigningKey: signingKey,
    commandRunner: options.commandRunner,
    tools: options.tools,
    now: options.now,
    ...(receipt ? { receiptPath } : {}),
    [RECOVERY_INTENT_AUTHORITY]: !receipt,
  });
  const lifecycle = receipt || intent;
  if (cleaned.status === "already-cleaned") {
    return {
      ok: true,
      status: "none",
      reason: "candidate-clone-intent-cleaned",
      candidateSlotId: boundCandidate.slotId,
      cloneId: lifecycle.cloneId,
      candidateDatabaseName: lifecycle.candidate.databaseName,
      cleanupReceipt: cleaned.cleanupReceipt,
      cleanupReceiptPath: cleaned.cleanupReceiptPath,
    };
  }
  return {
    ok: true,
    status: "cleaned",
    candidateSlotId: boundCandidate.slotId,
    cloneId: lifecycle.cloneId,
    candidateDatabaseName: lifecycle.candidate.databaseName,
    cleanupReceipt: cleaned.cleanupReceipt,
    cleanupReceiptPath: cleaned.cleanupReceiptPath,
  };
}
