#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  consumePreparedUpdatePackage,
  verifyReadyUpdateTransaction,
} from "./consume-prepared-update-package.mjs";
import {
  loadProductionUpdateVerificationPolicy,
  recordAcceptedUpdateSequence,
} from "./update-package-trust.mjs";

export const READY_UPDATE_INSTALL_SCHEMA = "bonni.update-install/v1";
export const READY_UPDATE_NPM_CI_ARGS = Object.freeze([
  "ci", "--offline", "--no-audit", "--no-fund", "--include=dev",
]);

const INSTALL_DIRECTORY = "update-package-install";
const TRANSACTIONS_DIRECTORY = "transactions";
const FAILED_DIRECTORY = "failed";
const JOURNAL_FILE = "INSTALL.json";
const INSTALLED_FILE = "INSTALLED.json";
const BOOTSTRAP_FILE = "APPLY-WINDOWS-UPDATE.cmd";
const SUPPORTED_COMPONENTS = Object.freeze(["SYSTEM", "WINDOWS"]);
const SUPPORTED_COMPONENT_SET = new Set(SUPPORTED_COMPONENTS);
const SYSTEM_PERSISTENT = Object.freeze({
  backend: [
    ".env", "archives", "backups", "config/keys", "config/secrets", "data",
    "keys", "logs", "secrets", "storage", "uploads", "updates",
  ],
  frontend: ["uploads", "public/uploads"],
});
const RESERVED_PORTS = Object.freeze([
  4000, 4001, 4100, 4101, 4198, 4199, 4201, 4300, 4301, 4302, 4400, 4401, 4402,
]);
const JOURNAL_STATES = new Set([
  "prepared",
  "bootstrap-required",
  "migrating",
  "activating-system",
  "system-live",
  "activating-windows",
  "windows-live",
  "backup-publishing",
  "backup-rotated",
  "publishing-developer-base",
  "developer-base-published",
  "committed",
  "accepted",
  "rolled-back",
]);
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID = /^[a-f0-9]{64}$/u;
const VERSION_DIRECTORY = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DATABASE_ROUTING_FILE_AAD = "bonni-core:database-routing:v1";
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EACCES", "EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM",
]);

export class ReadyUpdateInstallError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "ReadyUpdateInstallError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new ReadyUpdateInstallError(code, detail, options);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => bytewiseCompare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value, code = "READY_UPDATE_INSTALL_TIME_INVALID") {
  if (
    typeof value !== "string"
    || !CANONICAL_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail(code, String(value || ""));
  return value;
}

function manifestView(manifest) {
  if (manifest?.schema !== "bonni.update/v2" || !isPlainObject(manifest.signed)) {
    fail("READY_UPDATE_INSTALL_MANIFEST_V2_REQUIRED");
  }
  const { signed } = manifest;
  if (!Array.isArray(signed.payloads) || !signed.payloads.length) {
    fail("READY_UPDATE_INSTALL_COMPONENTS_EMPTY");
  }
  const components = signed.payloads.map((payload) => payload.component);
  if (new Set(components).size !== components.length) {
    fail("READY_UPDATE_INSTALL_COMPONENT_DUPLICATE");
  }
  const unsupported = components.filter((component) => !SUPPORTED_COMPONENT_SET.has(component));
  if (unsupported.length) fail("READY_UPDATE_INSTALL_COMPONENT_UNSUPPORTED", unsupported.join(","));
  return {
    updateId: signed.updateId,
    channel: signed.channel,
    releaseSequence: signed.releaseSequence,
    createdAt: signed.createdAt,
    payloads: signed.payloads,
    components,
  };
}

function runtimePlatformIdentity(override) {
  const platform = override?.platform ?? process.platform;
  const arch = override?.arch ?? process.arch;
  if (typeof platform !== "string" || !platform || typeof arch !== "string" || !arch) {
    fail("READY_UPDATE_INSTALL_RUNTIME_PLATFORM_INVALID");
  }
  return { platform, arch };
}

function windowsRuntimePlatform(runtime) {
  if (runtime.platform !== "win32") return null;
  const architecture = new Map([
    ["ia32", "windows-x86"],
    ["x64", "windows-x64"],
    ["arm64", "windows-arm64"],
  ]).get(runtime.arch);
  if (!architecture) {
    fail("READY_UPDATE_INSTALL_WINDOWS_ARCH_UNSUPPORTED", runtime.arch);
  }
  return architecture;
}

function assertPayloadPlatforms(view, runtime) {
  for (const payload of view.payloads) {
    if (typeof payload.platform !== "string" || !payload.platform) {
      fail("READY_UPDATE_INSTALL_PLATFORM_REQUIRED", payload.component);
    }
    if (payload.component === "SYSTEM") {
      if (payload.platform !== "any") {
        fail("READY_UPDATE_INSTALL_SYSTEM_PLATFORM_UNSUPPORTED", payload.platform);
      }
      continue;
    }
    if (payload.component === "WINDOWS") {
      const exact = windowsRuntimePlatform(runtime);
      if (!exact) {
        fail("READY_UPDATE_INSTALL_WINDOWS_OS_REQUIRED", `${runtime.platform}:${runtime.arch}`);
      }
      if (payload.platform !== "windows-any" && payload.platform !== exact) {
        fail("READY_UPDATE_INSTALL_WINDOWS_PLATFORM_MISMATCH", `${payload.platform}:${exact}`);
      }
    }
  }
  return view;
}

async function lstatOrNull(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function exists(target) {
  return Boolean(await lstatOrNull(target));
}

async function assertPlainDirectory(target, code = "READY_UPDATE_INSTALL_DIRECTORY_INVALID") {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code, target);
  return state;
}

async function ensurePlainDirectory(target) {
  const state = await lstatOrNull(target);
  if (!state) await fs.mkdir(target, { mode: 0o700 });
  await assertPlainDirectory(target);
  return target;
}

function relativePortable(root, target, { allowSelf = false } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (allowSelf && !relative) return ".";
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("READY_UPDATE_INSTALL_PATH_ESCAPE", target);
  }
  return relative.split(path.sep).join("/");
}

async function assertSafePathChain(root, target, finalKind = "directory") {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = relativePortable(resolvedRoot, resolvedTarget, { allowSelf: true });
  let cursor = resolvedRoot;
  const rootState = await lstatOrNull(cursor);
  if (!rootState || !rootState.isDirectory() || rootState.isSymbolicLink()) {
    fail("READY_UPDATE_INSTALL_PATH_UNSAFE", cursor);
  }
  if (relative === ".") return;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const state = await lstatOrNull(cursor);
    if (!state || state.isSymbolicLink()) fail("READY_UPDATE_INSTALL_PATH_UNSAFE", cursor);
    const last = index === segments.length - 1;
    if (!last && !state.isDirectory()) fail("READY_UPDATE_INSTALL_PATH_UNSAFE", cursor);
    if (last && finalKind === "directory" && !state.isDirectory()) {
      fail("READY_UPDATE_INSTALL_PATH_UNSAFE", cursor);
    }
    if (last && finalKind === "file" && (!state.isFile() || state.nlink !== 1)) {
      fail("READY_UPDATE_INSTALL_PATH_UNSAFE", cursor);
    }
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(process.platform === "win32" && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncFile(file) {
  const handle = await fs.open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonAtomic(file, value) {
  const parent = path.dirname(file);
  await assertPlainDirectory(parent);
  const temporary = path.join(
    parent,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function removeTree(target) {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

function windowsFold(relativePath) {
  return relativePath
    .normalize("NFKC")
    .split("/")
    .map((segment) => segment.replace(/[. ]+$/gu, "").toLocaleLowerCase("en-US"))
    .join("/");
}

async function inventoryTree(root, relativeDirectory = "") {
  const directory = relativeDirectory
    ? path.join(root, ...relativeDirectory.split("/"))
    : root;
  const state = await lstatOrNull(directory);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) {
    fail("READY_UPDATE_INSTALL_TREE_UNSAFE", directory);
  }
  const result = [];
  const folded = new Map();

  async function visit(current, relative) {
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const foldedPath = windowsFold(itemRelative);
      const prior = folded.get(foldedPath);
      if (prior && prior !== itemRelative) {
        fail("READY_UPDATE_INSTALL_WINDOWS_PATH_COLLISION", `${prior}:${itemRelative}`);
      }
      folded.set(foldedPath, itemRelative);
      const absolute = path.join(current, entry.name);
      const itemState = await fs.lstat(absolute);
      if (itemState.isSymbolicLink()) fail("READY_UPDATE_INSTALL_TREE_UNSAFE", itemRelative);
      if (itemState.isDirectory()) {
        await visit(absolute, itemRelative);
      } else if (itemState.isFile()) {
        if (itemState.nlink !== 1) fail("READY_UPDATE_INSTALL_HARDLINK_REJECTED", itemRelative);
        const bytes = await fs.readFile(absolute);
        result.push({ path: itemRelative, sizeBytes: bytes.length, sha256: sha256(bytes) });
      } else {
        fail("READY_UPDATE_INSTALL_TREE_UNSAFE", itemRelative);
      }
    }
  }

  await visit(directory, relativeDirectory);
  return result.sort((left, right) => bytewiseCompare(left.path, right.path));
}

function inventoryReceipt(files) {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    treeSha256: sha256(stableStringify(files)),
    files,
  };
}

async function treeReceipt(root) {
  return inventoryReceipt(await inventoryTree(root));
}

async function verifyTreeReceipt(root, expected, code = "READY_UPDATE_INSTALL_CANDIDATE_CHANGED") {
  const actual = await treeReceipt(root);
  if (stableStringify(actual) !== stableStringify(expected)) fail(code, root);
  return actual;
}

async function copyRegularFile(source, target, mode) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let sourceHandle;
  let targetHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail("READY_UPDATE_INSTALL_SOURCE_UNSAFE", source);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    targetHandle = await fs.open(target, "wx", mode & 0o777);
    const hash = crypto.createHash("sha256");
    let copied = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      await targetHandle.write(chunk);
      copied += chunk.length;
    }
    await targetHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(copied) !== before.size
    ) fail("READY_UPDATE_INSTALL_SOURCE_CHANGED", source);
    return { sizeBytes: copied, sha256: hash.digest("hex") };
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

async function copyTreeStrict(source, target, { optional = false, replace = false } = {}) {
  const sourceState = await lstatOrNull(source);
  if (!sourceState) {
    if (optional) return false;
    fail("READY_UPDATE_INSTALL_SOURCE_MISSING", source);
  }
  if (sourceState.isSymbolicLink()) fail("READY_UPDATE_INSTALL_SOURCE_UNSAFE", source);
  if (replace) await removeTree(target);
  if (sourceState.isFile()) {
    if (sourceState.nlink !== 1) fail("READY_UPDATE_INSTALL_HARDLINK_REJECTED", source);
    await copyRegularFile(source, target, sourceState.mode);
    return true;
  }
  if (!sourceState.isDirectory()) fail("READY_UPDATE_INSTALL_SOURCE_UNSAFE", source);
  const targetState = await lstatOrNull(target);
  if (targetState && (!targetState.isDirectory() || targetState.isSymbolicLink())) {
    fail("READY_UPDATE_INSTALL_TARGET_UNSAFE", target);
  }
  if (!targetState) await fs.mkdir(target, { recursive: true, mode: sourceState.mode & 0o777 });
  const entries = (await fs.readdir(source, { withFileTypes: true }))
    .sort((left, right) => bytewiseCompare(left.name, right.name));
  for (const entry of entries) {
    await copyTreeStrict(path.join(source, entry.name), path.join(target, entry.name));
  }
  await syncDirectory(target);
  return true;
}

async function copyExactTree(source, target) {
  const expected = await treeReceipt(source);
  await copyTreeStrict(source, target);
  await verifyTreeReceipt(target, expected, "READY_UPDATE_INSTALL_COPY_MISMATCH");
  return expected;
}

async function preserveSystemData(liveSystem, candidateSystem) {
  if (!await exists(liveSystem)) fail("READY_UPDATE_INSTALL_LIVE_SYSTEM_MISSING", liveSystem);
  await assertPlainDirectory(liveSystem);
  for (const entry of (await fs.readdir(liveSystem, { withFileTypes: true }))
    .sort((left, right) => bytewiseCompare(left.name, right.name))) {
    if (["backend", "frontend", ".bonni-source-update"].includes(entry.name)) continue;
    await copyTreeStrict(
      path.join(liveSystem, entry.name),
      path.join(candidateSystem, entry.name),
      { replace: true },
    );
  }
  for (const [programRoot, relativePaths] of Object.entries(SYSTEM_PERSISTENT)) {
    for (const relativePath of relativePaths) {
      await copyTreeStrict(
        path.join(liveSystem, programRoot, ...relativePath.split("/")),
        path.join(candidateSystem, programRoot, ...relativePath.split("/")),
        { optional: true, replace: true },
      );
    }
  }
}

function probePort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function assertBonniStopped() {
  const open = [];
  for (const port of RESERVED_PORTS) {
    if (await probePort("127.0.0.1", port) || await probePort("::1", port)) open.push(port);
  }
  if (open.length) fail("READY_UPDATE_INSTALL_BONNI_RUNNING", open.join(","));
}

async function resolveInvocation(command, args) {
  if (process.platform !== "win32" || command !== "npm") return { command, args };
  for (const candidate of [
    process.env.npm_execpath,
    process.env.NPM_CLI_JS,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean)) {
    const state = await lstatOrNull(path.resolve(candidate));
    if (state?.isFile() && !state.isSymbolicLink()) {
      return { command: process.execPath, args: [path.resolve(candidate), ...args] };
    }
  }
  return {
    command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...args],
  };
}

async function run(command, args, cwd, environment = process.env) {
  const invocation = await resolveInvocation(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new ReadyUpdateInstallError(
        "READY_UPDATE_INSTALL_COMMAND_FAILED",
        `${command} ${args.join(" ")} (${signal || code})`,
      ));
    });
  });
}

async function resolveVerificationPolicy(productRoot, verificationPolicy) {
  if (verificationPolicy === undefined) {
    return loadProductionUpdateVerificationPolicy(productRoot);
  }
  if (
    verificationPolicy?.verificationMode !== "development"
    || verificationPolicy.allowUnsignedDevelopment !== true
    || verificationPolicy.packageSource !== "local"
    || !new Set(["development", "test"]).has(
      String(verificationPolicy.nodeEnv || process.env.NODE_ENV || "production").toLowerCase(),
    )
  ) fail("READY_UPDATE_INSTALL_DEVELOPMENT_POLICY_INVALID");
  return { ...verificationPolicy };
}

function assertVerifiedMode(verified, policy) {
  const view = manifestView(verified.manifest);
  if (policy.verificationMode === "production") {
    if (view.channel !== "stable" || verified.receipt?.source?.authenticated !== true) {
      fail("READY_UPDATE_INSTALL_PRODUCTION_AUTHENTICATION_REQUIRED");
    }
    const required = new Set(["RELEASE", ...view.components]);
    const observed = new Set(verified.receipt?.source?.verifiedScopes || []);
    for (const scope of required) {
      if (!observed.has(scope)) fail("READY_UPDATE_INSTALL_PRODUCTION_SCOPE_REQUIRED", scope);
    }
  } else if (
    view.channel !== "development"
    || verified.receipt?.source?.authenticated !== false
    || verified.receipt?.source?.legacyManualBootstrap !== false
  ) fail("READY_UPDATE_INSTALL_DEVELOPMENT_PACKAGE_REQUIRED");
  return view;
}

function bindingFromVerified(verified, view, preparedReceiptFile, productRoot) {
  return {
    transactionId: verified.transactionId,
    readyReceiptSha256: verified.readyReceiptSha256,
    preparedReceiptPath: relativePortable(productRoot, path.resolve(preparedReceiptFile)),
    readyTransactionPath: relativePortable(productRoot, verified.transactionRoot),
    updateId: view.updateId,
    channel: view.channel,
    releaseSequence: view.releaseSequence,
    createdAt: view.createdAt,
    components: verified.receipt.components.map((entry) => ({
      component: entry.component,
      ...(entry.platform === undefined ? {} : { platform: entry.platform }),
      version: entry.version,
      fileCount: entry.fileCount,
      totalBytes: entry.totalBytes,
      treeSha256: entry.treeSha256,
    })),
  };
}

function assertBinding(actual, expected) {
  if (stableStringify(actual) !== stableStringify(expected)) {
    fail("READY_UPDATE_INSTALL_BINDING_MISMATCH");
  }
}

function exactJournal(journal, journalFile) {
  const keys = [
    "schema", "state", "transactionId", "createdAt", "updatedAt", "binding",
    "candidates", "developerBase", "missingBefore", "databaseSnapshot", "failure",
  ];
  if (
    !isPlainObject(journal)
    || Object.keys(journal).sort().join("\0") !== keys.sort().join("\0")
    || journal.schema !== READY_UPDATE_INSTALL_SCHEMA
    || !JOURNAL_STATES.has(journal.state)
    || !TRANSACTION_ID.test(journal.transactionId || "")
    || !isPlainObject(journal.binding)
    || journal.binding.transactionId !== journal.transactionId
    || !Array.isArray(journal.binding.components)
    || !Array.isArray(journal.missingBefore)
    || !isPlainObject(journal.candidates)
  ) fail("READY_UPDATE_INSTALL_JOURNAL_INVALID", journalFile);
  canonicalTimestamp(journal.createdAt);
  canonicalTimestamp(journal.updatedAt);
  const componentNames = journal.binding.components.map((entry) => entry.component);
  const developerBaseValid = journal.developerBase === null || (
    isPlainObject(journal.developerBase)
    && componentNames.includes("SYSTEM")
    && VERSION_DIRECTORY.test(journal.developerBase.version || "")
    && isPlainObject(journal.developerBase.systemReceipt)
    && isPlainObject(journal.developerBase.envelopeReceipt)
    && typeof journal.developerBase.publishedByTransaction === "boolean"
    && typeof journal.developerBase.reusedExisting === "boolean"
  );
  if (
    componentNames.some((entry) => !SUPPORTED_COMPONENT_SET.has(entry))
    || new Set(componentNames).size !== componentNames.length
    || journal.missingBefore.some((entry) => !["SYSTEM", "RUN_SYSTEM", "WINDOWS", "PREVIOUS"].includes(entry))
    || new Set(journal.missingBefore).size !== journal.missingBefore.length
    || !developerBaseValid
  ) fail("READY_UPDATE_INSTALL_JOURNAL_INVALID", journalFile);
  return journal;
}

async function readJournal(transactionRoot) {
  const journalFile = path.join(transactionRoot, JOURNAL_FILE);
  await assertSafePathChain(transactionRoot, journalFile, "file");
  let journal;
  try { journal = JSON.parse(await fs.readFile(journalFile, "utf8")); } catch {
    fail("READY_UPDATE_INSTALL_JOURNAL_INVALID", journalFile);
  }
  return { journal: exactJournal(journal, journalFile), journalFile };
}

async function writeJournal(journalFile, journal, state, changes = {}) {
  const next = {
    ...journal,
    ...changes,
    state,
    updatedAt: new Date().toISOString(),
  };
  exactJournal(next, journalFile);
  await writeJsonAtomic(journalFile, next);
  return next;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireInstallLock(installRoot) {
  const lockRoot = path.join(installRoot, "LOCK");
  const nonce = crypto.randomBytes(16).toString("hex");
  const temporary = path.join(installRoot, `.LOCK.${process.pid}.${nonce}.tmp`);
  await fs.mkdir(temporary, { mode: 0o700 });
  await fs.writeFile(
    path.join(temporary, "OWNER.json"),
    `${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await syncDirectory(temporary);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rename(temporary, lockRoot);
      await syncDirectory(installRoot);
      return async () => {
        const owner = await fs.readFile(path.join(lockRoot, "OWNER.json"), "utf8")
          .then(JSON.parse).catch(() => null);
        if (owner?.nonce === nonce && owner?.pid === process.pid) await removeTree(lockRoot);
      };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      const ownerFile = path.join(lockRoot, "OWNER.json");
      const owner = await fs.readFile(ownerFile, "utf8").then(JSON.parse).catch(() => null);
      if (processIsAlive(owner?.pid)) {
        await removeTree(temporary).catch(() => undefined);
        fail("READY_UPDATE_INSTALL_BUSY", String(owner.pid));
      }
      const stale = path.join(installRoot, `.LOCK.stale.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`);
      try { await fs.rename(lockRoot, stale); } catch (renameError) {
        if (!["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(renameError?.code)) throw renameError;
      }
      await removeTree(stale).catch(() => undefined);
    }
  }
  await removeTree(temporary).catch(() => undefined);
  fail("READY_UPDATE_INSTALL_BUSY");
}

async function notifyPhase(onPhase, phase, details = {}) {
  if (typeof onPhase === "function") await onPhase(phase, details);
}

async function buildSystemCandidate(candidateSystem) {
  for (const programRoot of ["backend", "frontend"]) {
    const root = path.join(candidateSystem, programRoot);
    await assertPlainDirectory(root, "READY_UPDATE_INSTALL_PROGRAM_ROOT_MISSING");
    await assertSafePathChain(root, path.join(root, "package.json"), "file");
    await assertSafePathChain(root, path.join(root, "package-lock.json"), "file");
    await run("npm", READY_UPDATE_NPM_CI_ARGS, root);
    await run("npm", ["run", "build"], root);
  }
  const setupFile = path.join(candidateSystem, "backend", "scripts", "setup", "setup-system.mjs");
  await assertSafePathChain(candidateSystem, setupFile, "file");
  const setup = await import(`${pathToFileURL(setupFile).href}?ready-install=${Date.now()}`);
  if (typeof setup.publishFrontend !== "function") {
    fail("READY_UPDATE_INSTALL_FRONTEND_PUBLISHER_MISSING", setupFile);
  }
  await setup.publishFrontend({
    systemDirectory: candidateSystem,
    backendDirectory: path.join(candidateSystem, "backend"),
    buildDirectory: path.join(candidateSystem, "frontend", "dist"),
    publishedDirectory: path.join(candidateSystem, "backend", "public", "system"),
  });
}

async function prepareRunSystem({
  productRoot,
  candidateSystem,
  candidateRunSystem,
  componentVersion,
  updateId,
}) {
  await fs.mkdir(candidateRunSystem, { recursive: true, mode: 0o700 });
  const liveRuntime = path.join(productRoot, "RUN_SYSTEM", "runtime");
  await copyTreeStrict(liveRuntime, path.join(candidateRunSystem, "runtime"), { optional: true });
  const runcontainerFile = path.join(
    candidateSystem,
    "backend",
    "scripts",
    "runcontainer",
    "runcontainer-lib.mjs",
  );
  const layoutFile = path.join(
    candidateSystem,
    "backend",
    "scripts",
    "runcontainer",
    "run-layout.mjs",
  );
  await assertSafePathChain(candidateSystem, runcontainerFile, "file");
  await assertSafePathChain(candidateSystem, layoutFile, "file");
  const [{ stageProgramTree }, { resolveRunLayout, createRunLayoutReceipt }] = await Promise.all([
    import(`${pathToFileURL(runcontainerFile).href}?ready-install=${Date.now()}`),
    import(`${pathToFileURL(layoutFile).href}?ready-install=${Date.now()}`),
  ]);
  if (
    typeof stageProgramTree !== "function"
    || typeof resolveRunLayout !== "function"
    || typeof createRunLayoutReceipt !== "function"
  ) fail("READY_UPDATE_INSTALL_RUN_SYSTEM_BUILDER_INVALID");
  await stageProgramTree({
    role: "active",
    sourceRoot: path.dirname(candidateSystem),
    runRoot: path.join(candidateRunSystem, "program-slots"),
    stagingRoot: path.join(candidateRunSystem, "T"),
    excludePaths: [
      "SYSTEM/backend/legal/core-license-predecessors",
      "SYSTEM/backend/node_modules/.bin",
    ],
    includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
    version: componentVersion,
    updateId,
  });
  await removeTree(path.join(candidateRunSystem, "T"));
  const layout = resolveRunLayout({ productRoot, environment: {} });
  await fs.writeFile(
    path.join(candidateRunSystem, "layout-receipt.json"),
    `${JSON.stringify(createRunLayoutReceipt(layout), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await syncFile(path.join(candidateRunSystem, "layout-receipt.json"));
  await syncDirectory(candidateRunSystem);
}

function validateMigrationDatabaseUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch {
    fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_INVALID", label);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hash) {
    fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_INVALID", label);
  }
  let databaseName;
  try { databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, "")); } catch {
    fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_INVALID", label);
  }
  if (!databaseName || databaseName.includes("/") || databaseName.includes("\0")) {
    fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_INVALID", label);
  }
  return parsed.toString();
}

function decryptDatabaseRoutingSecret(value, masterKey, label) {
  if (!value) return "";
  try {
    const parts = String(value).split(".");
    if (parts.length !== 3 || parts.some((entry) => !entry)) throw new Error("format");
    const [ivValue, tagValue, encryptedValue] = parts;
    const key = crypto.createHash("sha256")
      .update(masterKey, "utf8")
      .update(DATABASE_ROUTING_FILE_AAD, "utf8")
      .digest();
    const iv = Buffer.from(ivValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const encrypted = Buffer.from(encryptedValue, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw new Error("length");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(DATABASE_ROUTING_FILE_AAD, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_DECRYPT_FAILED", label);
  }
}

async function resolveDatabaseTargets(candidateSystem, productRoot) {
  const envFile = path.join(candidateSystem, "backend", ".env");
  await assertSafePathChain(candidateSystem, envFile, "file");
  let definitions;
  try { definitions = parseEnv(await fs.readFile(envFile, "utf8")); } catch {
    fail("READY_UPDATE_INSTALL_DATABASE_CONFIGURATION_INVALID", envFile);
  }
  const bootDatabaseUrl = validateMigrationDatabaseUrl(
    definitions.SERVER_DATABASE_URL || definitions.DATABASE_URL,
    "primary",
  );
  const masterKey = String(definitions.MASTER_KEY || "");
  const configuredRoots = [definitions.BONNI_RUNTIME_STATE_ROOT, definitions.RUN_SYSTEM_ROOT]
    .filter((entry) => typeof entry === "string" && path.isAbsolute(entry));
  const runtimeRoots = [
    ...configuredRoots,
    path.join(productRoot, "RUN_SYSTEM", "runtime"),
    path.join(productRoot, "run_system"),
  ];
  let routingFile = null;
  for (const runtimeRoot of runtimeRoots) {
    const candidate = path.join(runtimeRoot, "system", "database-routing.json");
    const state = await lstatOrNull(candidate);
    if (!state) continue;
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_FILE_UNSAFE", candidate);
    }
    routingFile = candidate;
    break;
  }
  if (!routingFile) {
    return {
      databaseUrl: bootDatabaseUrl,
      redundantDatabaseUrl: "",
      includeCanonicalRedundantIfExists: true,
      verifyRedundantDatabaseFromStoredSetting: false,
    };
  }
  if (!masterKey) fail("READY_UPDATE_INSTALL_DATABASE_MASTER_KEY_MISSING", routingFile);
  let routing;
  try { routing = JSON.parse(await fs.readFile(routingFile, "utf8")); } catch {
    fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_INVALID", routingFile);
  }
  const allowedKeys = new Set([
    "version", "mode", "jsonEmergencyEnabled", "normalUrlEncrypted",
    "redundantUrlEncrypted", "updatedAt", "lastFullSync",
  ]);
  if (
    !isPlainObject(routing)
    || Object.keys(routing).some((key) => !allowedKeys.has(key))
    || routing.version !== 1
    || !["normal", "redundant", "both"].includes(routing.mode)
    || typeof routing.normalUrlEncrypted !== "string"
    || typeof routing.redundantUrlEncrypted !== "string"
  ) fail("READY_UPDATE_INSTALL_DATABASE_ROUTING_INVALID", routingFile);
  const databaseUrl = validateMigrationDatabaseUrl(
    decryptDatabaseRoutingSecret(routing.normalUrlEncrypted, masterKey, "primary") || bootDatabaseUrl,
    "primary",
  );
  const redundantSecret = decryptDatabaseRoutingSecret(
    routing.redundantUrlEncrypted,
    masterKey,
    "redundant",
  );
  if (["redundant", "both"].includes(routing.mode) && !redundantSecret) {
    fail("READY_UPDATE_INSTALL_REDUNDANT_DATABASE_MISSING", routingFile);
  }
  return {
    databaseUrl,
    redundantDatabaseUrl: redundantSecret
      ? validateMigrationDatabaseUrl(redundantSecret, "redundant")
      : "",
    includeCanonicalRedundantIfExists: !redundantSecret,
    verifyRedundantDatabaseFromStoredSetting: routing.mode === "normal" && Boolean(redundantSecret),
  };
}

async function createDefaultMigrationController({ candidateSystem, productRoot }) {
  const runnerFile = path.join(
    candidateSystem,
    "backend",
    "scripts",
    "database",
    "run-ops-migrations.mjs",
  );
  await assertSafePathChain(candidateSystem, runnerFile, "file");
  const runner = await import(`${pathToFileURL(runnerFile).href}?ready-install=${Date.now()}`);
  for (const name of [
    "loadOpsMigrations", "planOpsMigrationTargets", "preflightOpsMigrationsTarget",
    "databaseExists", "runOpsMigrations",
  ]) {
    if (typeof runner[name] !== "function") {
      fail("READY_UPDATE_INSTALL_MIGRATION_RUNNER_INVALID", name);
    }
  }
  const routing = await resolveDatabaseTargets(candidateSystem, productRoot);
  let redundantDatabaseUrl = routing.redundantDatabaseUrl;
  let includeCanonicalRedundantIfExists = routing.includeCanonicalRedundantIfExists;
  if (routing.verifyRedundantDatabaseFromStoredSetting) {
    if (typeof runner.resolveStoredRedundantDatabaseUrl !== "function") {
      fail("READY_UPDATE_INSTALL_MIGRATION_RUNNER_INVALID", "resolveStoredRedundantDatabaseUrl");
    }
    const [primary] = runner.planOpsMigrationTargets({ databaseUrl: routing.databaseUrl });
    redundantDatabaseUrl = await runner.resolveStoredRedundantDatabaseUrl({
      primaryConnectionString: primary.connectionString,
      candidateRedundantDatabaseUrl: redundantDatabaseUrl,
    });
    includeCanonicalRedundantIfExists = !redundantDatabaseUrl;
  }
  const migrations = await runner.loadOpsMigrations();
  const planned = runner.planOpsMigrationTargets({
    databaseUrl: routing.databaseUrl,
    includeCanonicalRedundantIfExists,
    redundantDatabaseUrl,
  });
  const selected = [planned[0]];
  if (planned[1]?.required === true) selected.push(planned[1]);
  else if (planned[1] && await runner.databaseExists({
    connectionString: planned[0].connectionString,
    database: planned[1].database,
  })) selected.push(planned[1]);

  return {
    async preflight() {
      const results = [];
      for (const target of selected) {
        results.push({
          role: target.role,
          database: target.database,
          ...await runner.preflightOpsMigrationsTarget({ target, migrations }),
        });
      }
      return {
        pending: results.reduce((sum, entry) => sum + entry.pending, 0),
        targets: results,
      };
    },
    async apply() {
      return runner.runOpsMigrations({
        databaseUrl: routing.databaseUrl,
        includeCanonicalRedundantIfExists,
        redundantDatabaseUrl,
        verifyRedundantDatabaseFromStoredSetting: false,
        migrations,
      });
    },
  };
}

function normalizeSnapshotReceipt(receipt) {
  if (
    !isPlainObject(receipt)
    || receipt.schema !== "bonni.update-database-snapshot/v1"
    || typeof receipt.snapshotId !== "string"
    || !receipt.snapshotId
    || !SHA256_HEX.test(receipt.manifestSha256 || "")
  ) fail("READY_UPDATE_INSTALL_DATABASE_SNAPSHOT_INVALID");
  return {
    schema: receipt.schema,
    snapshotId: receipt.snapshotId,
    manifestSha256: receipt.manifestSha256,
  };
}

function transactionPaths(productRoot, transactionId) {
  const runInstallRoot = path.join(productRoot, "RUN_INSTALL");
  const installRoot = path.join(runInstallRoot, INSTALL_DIRECTORY);
  const transactionsRoot = path.join(installRoot, TRANSACTIONS_DIRECTORY);
  const transactionRoot = path.join(transactionsRoot, transactionId);
  return {
    runInstallRoot,
    installRoot,
    transactionsRoot,
    transactionRoot,
    nextRoot: path.join(transactionRoot, "NEXT"),
    holdRoot: path.join(transactionRoot, "HOLD"),
    journalFile: path.join(transactionRoot, JOURNAL_FILE),
  };
}

async function ensureInstallRoots(productRoot) {
  await assertPlainDirectory(productRoot, "READY_UPDATE_INSTALL_PRODUCT_ROOT_INVALID");
  const runInstallRoot = path.join(productRoot, "RUN_INSTALL");
  await assertSafePathChain(productRoot, runInstallRoot, "directory");
  const installRoot = path.join(runInstallRoot, INSTALL_DIRECTORY);
  if (!await exists(installRoot)) await fs.mkdir(installRoot, { mode: 0o700 });
  await assertSafePathChain(runInstallRoot, installRoot, "directory");
  const transactionsRoot = path.join(installRoot, TRANSACTIONS_DIRECTORY);
  if (!await exists(transactionsRoot)) await fs.mkdir(transactionsRoot, { mode: 0o700 });
  await assertSafePathChain(installRoot, transactionsRoot, "directory");
  const failedRoot = path.join(installRoot, FAILED_DIRECTORY);
  if (!await exists(failedRoot)) await fs.mkdir(failedRoot, { mode: 0o700 });
  await assertSafePathChain(installRoot, failedRoot, "directory");
  return { runInstallRoot, installRoot, transactionsRoot, failedRoot };
}

async function writeBootstrapLauncher(transactionRoot) {
  const launcher = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "for %%I in (\"%~dp0..\\..\\..\\..\") do set \"BONNI_PRODUCT_ROOT=%%~fI\"",
    "where node >nul 2>nul || (echo Node.js wurde nicht gefunden. & exit /b 31)",
    "node \"%BONNI_PRODUCT_ROOT%\\SYSTEM\\backend\\scripts\\setup\\install-ready-update-package.mjs\" --apply-bootstrap --product-root \"%BONNI_PRODUCT_ROOT%\" --transaction-root \"%~dp0.\"",
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
  const file = path.join(transactionRoot, BOOTSTRAP_FILE);
  await fs.writeFile(file, launcher, { flag: "wx", mode: 0o700 });
  await syncFile(file);
  return file;
}

async function prepareTransaction({
  productRoot,
  verified,
  view,
  binding,
  preparedReceiptFile,
  onPhase,
  _testHooks,
}) {
  const roots = await ensureInstallRoots(productRoot);
  const finalRoot = path.join(roots.transactionsRoot, verified.transactionId);
  if (await exists(finalRoot)) {
    const { journal } = await readJournal(finalRoot);
    assertBinding(journal.binding, binding);
    return { ...roots, ...transactionPaths(productRoot, verified.transactionId), journal, reused: true };
  }
  const temporaryRoot = path.join(
    roots.installRoot,
    `.stage-${verified.transactionId}-${process.pid}-${crypto.randomBytes(12).toString("hex")}`,
  );
  const temporaryNext = path.join(temporaryRoot, "NEXT");
  await fs.mkdir(temporaryNext, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(temporaryRoot, "HOLD"), { mode: 0o700 });
  try {
    const candidates = {};
    let developerBase = null;
    for (const component of view.components) {
      await notifyPhase(onPhase, "candidate-copy", { component, transactionId: verified.transactionId });
      const source = path.join(verified.transactionRoot, "COMPONENTS", component);
      const target = path.join(temporaryNext, component);
      await copyExactTree(source, target);
      if (component === "SYSTEM") {
        const systemPayload = view.payloads.find((payload) => payload.component === "SYSTEM");
        if (!VERSION_DIRECTORY.test(systemPayload.version || "")) {
          fail("READY_UPDATE_INSTALL_DEVELOPER_BASE_VERSION_INVALID", String(systemPayload.version || ""));
        }
        const developerBaseRoot = path.join(temporaryNext, "DEVELOPMENT_BASE");
        const cleanBaseSystem = path.join(developerBaseRoot, "SYSTEM");
        const systemReceipt = await copyExactTree(source, cleanBaseSystem);
        const baseMetadata = {
          schema: "bonni.development-base/v1",
          version: systemPayload.version,
          system: {
            fileCount: systemReceipt.fileCount,
            totalBytes: systemReceipt.totalBytes,
            treeSha256: systemReceipt.treeSha256,
          },
        };
        await fs.writeFile(
          path.join(developerBaseRoot, "BASE.json"),
          `${JSON.stringify(baseMetadata, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        await syncFile(path.join(developerBaseRoot, "BASE.json"));
        await syncDirectory(developerBaseRoot);
        developerBase = {
          version: systemPayload.version,
          systemReceipt,
          envelopeReceipt: await treeReceipt(developerBaseRoot),
          publishedByTransaction: false,
          reusedExisting: false,
        };
        await preserveSystemData(path.join(productRoot, "SYSTEM"), target);
        const candidateRunSystem = path.join(temporaryNext, "RUN_SYSTEM");
        if (typeof _testHooks.prepareSystemCandidate === "function") {
          await _testHooks.prepareSystemCandidate({
            productRoot,
            candidateSystem: target,
            candidateRunSystem,
            componentVersion: systemPayload.version,
            updateId: view.updateId,
          });
        } else {
          await buildSystemCandidate(target);
          await prepareRunSystem({
            productRoot,
            candidateSystem: target,
            candidateRunSystem,
            componentVersion: systemPayload.version,
            updateId: view.updateId,
          });
        }
        candidates.SYSTEM = await treeReceipt(target);
        candidates.RUN_SYSTEM = await treeReceipt(candidateRunSystem);
      } else {
        candidates.WINDOWS = await treeReceipt(target);
      }
      await notifyPhase(onPhase, "candidate-ready", { component, transactionId: verified.transactionId });
    }

    const now = new Date().toISOString();
    const missingBefore = [];
    for (const name of [
      ...(view.components.includes("SYSTEM") ? ["SYSTEM", "RUN_SYSTEM"] : []),
      ...(view.components.includes("WINDOWS") ? ["WINDOWS"] : []),
      "PREVIOUS",
    ]) {
      const target = name === "PREVIOUS"
        ? path.join(productRoot, "BACKUP", "PREVIOUS")
        : path.join(productRoot, name);
      if (!await exists(target)) missingBefore.push(name);
    }
    const journal = {
      schema: READY_UPDATE_INSTALL_SCHEMA,
      state: view.components.includes("WINDOWS") ? "bootstrap-required" : "prepared",
      transactionId: verified.transactionId,
      createdAt: now,
      updatedAt: now,
      binding,
      candidates,
      developerBase,
      missingBefore,
      databaseSnapshot: null,
      failure: null,
    };
    exactJournal(journal, path.join(temporaryRoot, JOURNAL_FILE));
    await fs.writeFile(
      path.join(temporaryRoot, JOURNAL_FILE),
      `${JSON.stringify(journal, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await syncFile(path.join(temporaryRoot, JOURNAL_FILE));
    if (view.components.includes("WINDOWS")) await writeBootstrapLauncher(temporaryRoot);
    await _testHooks.beforePublish?.({ temporaryRoot, finalRoot, journal });
    await syncDirectory(temporaryRoot);
    try { await fs.rename(temporaryRoot, finalRoot); } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      const existing = await readJournal(finalRoot);
      assertBinding(existing.journal.binding, binding);
      return { ...roots, ...transactionPaths(productRoot, verified.transactionId), journal: existing.journal, reused: true };
    }
    await syncDirectory(roots.transactionsRoot);
    return {
      ...roots,
      ...transactionPaths(productRoot, verified.transactionId),
      journal,
      reused: false,
    };
  } finally {
    await removeTree(temporaryRoot).catch(() => undefined);
  }
}

function managedLiveNames(journal) {
  const components = new Set(journal.binding.components.map((entry) => entry.component));
  return [
    ...(components.has("SYSTEM") ? ["SYSTEM", "RUN_SYSTEM"] : []),
    ...(components.has("WINDOWS") ? ["WINDOWS"] : []),
  ];
}

function fixedTransactionLocations(productRoot, journal) {
  const roots = transactionPaths(productRoot, journal.transactionId);
  const backupRoot = path.join(productRoot, "BACKUP");
  return {
    ...roots,
    backupRoot,
    previousRoot: path.join(backupRoot, "PREVIOUS"),
    nextPreviousRoot: path.join(backupRoot, `.PREVIOUS.${journal.transactionId}.next`),
    retiredPreviousRoot: path.join(backupRoot, `.PREVIOUS.${journal.transactionId}.retired`),
  };
}

function developerBasePaths(productRoot, journal) {
  if (!journal.developerBase) return null;
  if (!VERSION_DIRECTORY.test(journal.developerBase.version || "")) {
    fail("READY_UPDATE_INSTALL_DEVELOPER_BASE_VERSION_INVALID");
  }
  const developmentRoot = path.join(productRoot, "DEVELOPMENT");
  const basesRoot = path.join(developmentRoot, "BASES");
  return {
    developmentRoot,
    basesRoot,
    candidateRoot: path.join(
      transactionPaths(productRoot, journal.transactionId).nextRoot,
      "DEVELOPMENT_BASE",
    ),
    finalRoot: path.join(basesRoot, journal.developerBase.version),
  };
}

async function ensureDeveloperBasesRoot(productRoot) {
  const developmentRoot = path.join(productRoot, "DEVELOPMENT");
  if (!await exists(developmentRoot)) await fs.mkdir(developmentRoot, { mode: 0o700 });
  await assertSafePathChain(productRoot, developmentRoot, "directory");
  const basesRoot = path.join(developmentRoot, "BASES");
  if (!await exists(basesRoot)) await fs.mkdir(basesRoot, { mode: 0o700 });
  await assertSafePathChain(developmentRoot, basesRoot, "directory");
  return basesRoot;
}

async function verifyDeveloperBaseEnvelope(root, developerBase, code) {
  await verifyTreeReceipt(root, developerBase.envelopeReceipt, code);
  await verifyTreeReceipt(path.join(root, "SYSTEM"), developerBase.systemReceipt, code);
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(root, "BASE.json"), "utf8")); } catch {
    fail(code, path.join(root, "BASE.json"));
  }
  const expected = {
    schema: "bonni.development-base/v1",
    version: developerBase.version,
    system: {
      fileCount: developerBase.systemReceipt.fileCount,
      totalBytes: developerBase.systemReceipt.totalBytes,
      treeSha256: developerBase.systemReceipt.treeSha256,
    },
  };
  if (stableStringify(metadata) !== stableStringify(expected)) fail(code, root);
}

async function preflightDeveloperBase(productRoot, journal) {
  if (!journal.developerBase) return { exists: false };
  const locations = developerBasePaths(productRoot, journal);
  await verifyDeveloperBaseEnvelope(
    locations.candidateRoot,
    journal.developerBase,
    "READY_UPDATE_INSTALL_DEVELOPER_BASE_CANDIDATE_CHANGED",
  );
  await ensureDeveloperBasesRoot(productRoot);
  if (!await exists(locations.finalRoot)) return { exists: false, locations };
  await verifyDeveloperBaseEnvelope(
    locations.finalRoot,
    journal.developerBase,
    "READY_UPDATE_INSTALL_DEVELOPER_BASE_CONFLICT",
  );
  return { exists: true, locations };
}

async function publishDeveloperBase(productRoot, journal, journalFile) {
  if (!journal.developerBase) return journal;
  const preflight = await preflightDeveloperBase(productRoot, journal);
  journal = await writeJournal(journalFile, journal, "publishing-developer-base");
  if (preflight.exists) {
    journal = await writeJournal(journalFile, journal, "publishing-developer-base", {
      developerBase: {
        ...journal.developerBase,
        reusedExisting: true,
        publishedByTransaction: false,
      },
    });
    await removeTree(preflight.locations.candidateRoot);
    return writeJournal(journalFile, journal, "developer-base-published");
  }
  try {
    await renameAndSync(
      preflight.locations.candidateRoot,
      preflight.locations.finalRoot,
      preflight.locations.basesRoot,
    );
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
    await verifyDeveloperBaseEnvelope(
      preflight.locations.finalRoot,
      journal.developerBase,
      "READY_UPDATE_INSTALL_DEVELOPER_BASE_CONFLICT",
    );
    journal = await writeJournal(journalFile, journal, "publishing-developer-base", {
      developerBase: {
        ...journal.developerBase,
        reusedExisting: true,
        publishedByTransaction: false,
      },
    });
    await removeTree(preflight.locations.candidateRoot);
    return writeJournal(journalFile, journal, "developer-base-published");
  }
  return writeJournal(journalFile, journal, "developer-base-published", {
    developerBase: {
      ...journal.developerBase,
      reusedExisting: false,
      publishedByTransaction: true,
    },
  });
}

async function verifyPublishedDeveloperBase(productRoot, journal) {
  if (!journal.developerBase) return;
  const locations = developerBasePaths(productRoot, journal);
  await verifyDeveloperBaseEnvelope(
    locations.finalRoot,
    journal.developerBase,
    "READY_UPDATE_INSTALL_DEVELOPER_BASE_CHANGED",
  );
}

async function rollbackDeveloperBase(productRoot, journal) {
  if (!journal.developerBase) return;
  const locations = developerBasePaths(productRoot, journal);
  const candidateExists = await exists(locations.candidateRoot);
  if (candidateExists) {
    await removeTree(locations.candidateRoot);
    return;
  }
  const mayHavePublished = journal.developerBase.publishedByTransaction
    || journal.state === "publishing-developer-base";
  if (!mayHavePublished || journal.developerBase.reusedExisting) return;
  if (!await exists(locations.finalRoot)) return;
  await verifyDeveloperBaseEnvelope(
    locations.finalRoot,
    journal.developerBase,
    "READY_UPDATE_INSTALL_DEVELOPER_BASE_ROLLBACK_UNSAFE",
  );
  await removeTree(locations.finalRoot);
  await syncDirectory(locations.basesRoot);
}

async function renameAndSync(source, target, parentToSync = path.dirname(target)) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code === "EXDEV") fail("READY_UPDATE_INSTALL_CROSS_DEVICE_RENAME", `${source}:${target}`);
    throw error;
  }
  await syncDirectory(parentToSync);
}

async function verifyCandidates(paths, journal) {
  for (const [name, receipt] of Object.entries(journal.candidates)) {
    if (!new Set(["SYSTEM", "RUN_SYSTEM", "WINDOWS"]).has(name) || !isPlainObject(receipt)) {
      fail("READY_UPDATE_INSTALL_JOURNAL_INVALID", paths.journalFile);
    }
    await verifyTreeReceipt(
      path.join(paths.nextRoot, name),
      receipt,
      "READY_UPDATE_INSTALL_CANDIDATE_CHANGED",
    );
  }
}

async function verifyLiveCandidates(productRoot, journal) {
  for (const name of managedLiveNames(journal)) {
    const receipt = journal.candidates[name];
    if (!receipt) fail("READY_UPDATE_INSTALL_JOURNAL_INVALID", name);
    await verifyTreeReceipt(
      path.join(productRoot, name),
      receipt,
      "READY_UPDATE_INSTALL_LIVE_VERIFICATION_FAILED",
    );
  }
}

async function reverifyBoundReady({ productRoot, journal, policy, runtime }) {
  const preparedReceiptFile = path.resolve(
    productRoot,
    ...String(journal.binding.preparedReceiptPath || "").split("/"),
  );
  const readyTransactionRoot = path.resolve(
    productRoot,
    ...String(journal.binding.readyTransactionPath || "").split("/"),
  );
  relativePortable(productRoot, preparedReceiptFile);
  relativePortable(productRoot, readyTransactionRoot);
  const verified = await verifyReadyUpdateTransaction({
    productRoot,
    preparedReceiptFile,
    transactionRoot: readyTransactionRoot,
    verificationPolicy: policy,
  });
  const view = assertPayloadPlatforms(assertVerifiedMode(verified, policy), runtime);
  assertBinding(
    bindingFromVerified(verified, view, preparedReceiptFile, productRoot),
    journal.binding,
  );
  return { verified, view, preparedReceiptFile };
}

async function preparePreviousBackup(productRoot, journal) {
  const paths = fixedTransactionLocations(productRoot, journal);
  await assertPlainDirectory(paths.backupRoot, "READY_UPDATE_INSTALL_BACKUP_ROOT_INVALID");
  if (await exists(paths.nextPreviousRoot)) {
    fail("READY_UPDATE_INSTALL_BACKUP_STAGE_EXISTS", paths.nextPreviousRoot);
  }
  await fs.mkdir(paths.nextPreviousRoot, { mode: 0o700 });
  const components = [];
  for (const name of managedLiveNames(journal)) {
    const hold = path.join(paths.holdRoot, name);
    const holdState = await lstatOrNull(hold);
    if (!holdState) {
      if (!journal.missingBefore.includes(name)) {
        fail("READY_UPDATE_INSTALL_OLD_ROOT_MISSING", name);
      }
      components.push({ name, existed: false, receipt: null });
      continue;
    }
    if (!holdState.isDirectory() || holdState.isSymbolicLink()) {
      fail("READY_UPDATE_INSTALL_OLD_ROOT_UNSAFE", hold);
    }
    const destination = path.join(paths.nextPreviousRoot, name);
    await copyTreeStrict(hold, destination);
    components.push({ name, existed: true, receipt: await treeReceipt(destination) });
  }
  const receipt = {
    schema: "bonni.previous-components/v1",
    transactionId: journal.transactionId,
    updateId: journal.binding.updateId,
    createdAt: new Date().toISOString(),
    components,
  };
  await writeJsonAtomic(path.join(paths.nextPreviousRoot, "PREVIOUS.json"), receipt);
  await syncDirectory(paths.nextPreviousRoot);
  return { paths, receipt };
}

async function rotatePreviousBackup(paths, journal) {
  if (await exists(paths.retiredPreviousRoot)) {
    fail("READY_UPDATE_INSTALL_RETIRED_BACKUP_EXISTS", paths.retiredPreviousRoot);
  }
  if (await exists(paths.previousRoot)) {
    await renameAndSync(paths.previousRoot, paths.retiredPreviousRoot, paths.backupRoot);
  } else if (!journal.missingBefore.includes("PREVIOUS")) {
    fail("READY_UPDATE_INSTALL_PREVIOUS_BACKUP_MISSING");
  }
  await renameAndSync(paths.nextPreviousRoot, paths.previousRoot, paths.backupRoot);
}

async function restorePreviousBackup(paths, journal) {
  if (await exists(paths.retiredPreviousRoot)) {
    await removeTree(paths.previousRoot);
    await renameAndSync(paths.retiredPreviousRoot, paths.previousRoot, paths.backupRoot);
  } else if (journal.missingBefore.includes("PREVIOUS")) {
    await removeTree(paths.previousRoot);
  }
  await removeTree(paths.nextPreviousRoot);
}

async function restoreLiveRoots(productRoot, journal) {
  const paths = fixedTransactionLocations(productRoot, journal);
  for (const name of [...managedLiveNames(journal)].reverse()) {
    const live = path.join(productRoot, name);
    const hold = path.join(paths.holdRoot, name);
    if (await exists(hold)) {
      await removeTree(live);
      await renameAndSync(hold, live, productRoot);
    } else if (journal.missingBefore.includes(name)) {
      await removeTree(live);
    }
  }
  await restorePreviousBackup(paths, journal);
}

async function restoreDatabaseSnapshotIfNeeded({ journal, databaseSnapshotController }) {
  if (!journal.databaseSnapshot) return;
  if (typeof databaseSnapshotController?.restore !== "function") {
    fail("READY_UPDATE_INSTALL_DATABASE_RESTORE_REQUIRED", journal.databaseSnapshot.snapshotId);
  }
  await databaseSnapshotController.restore(journal.databaseSnapshot);
}

async function recoverInterruptedTransaction({
  productRoot,
  transactionRoot,
  journal,
  databaseSnapshotController,
}) {
  if (["prepared", "bootstrap-required", "rolled-back", "committed", "accepted"].includes(journal.state)) {
    return journal;
  }
  await restoreLiveRoots(productRoot, journal);
  await rollbackDeveloperBase(productRoot, journal);
  await restoreDatabaseSnapshotIfNeeded({ journal, databaseSnapshotController });
  const failure = {
    code: "READY_UPDATE_INSTALL_INTERRUPTED_RECOVERED",
    at: new Date().toISOString(),
  };
  return writeJournal(
    path.join(transactionRoot, JOURNAL_FILE),
    journal,
    "rolled-back",
    { failure },
  );
}

async function archiveRolledBackTransaction(installRoot, transactionRoot, transactionId) {
  const failedRoot = path.join(installRoot, FAILED_DIRECTORY);
  await assertPlainDirectory(failedRoot);
  const target = path.join(
    failedRoot,
    `${transactionId}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
  );
  await renameAndSync(transactionRoot, target, failedRoot);
  return target;
}

async function writeInstalledReceipt(transactionRoot, productRoot, journal) {
  const live = {};
  for (const name of managedLiveNames(journal)) live[name] = await treeReceipt(path.join(productRoot, name));
  const receipt = {
    schema: "bonni.update-installed/v1",
    transactionId: journal.transactionId,
    updateId: journal.binding.updateId,
    channel: journal.binding.channel,
    releaseSequence: journal.binding.releaseSequence,
    readyReceiptSha256: journal.binding.readyReceiptSha256,
    installedAt: new Date().toISOString(),
    components: journal.binding.components,
    developerBase: journal.developerBase
      ? {
        version: journal.developerBase.version,
        systemReceipt: journal.developerBase.systemReceipt,
        envelopeReceipt: journal.developerBase.envelopeReceipt,
      }
      : null,
    live,
  };
  await writeJsonAtomic(path.join(transactionRoot, INSTALLED_FILE), receipt);
  return receipt;
}

async function verifyInstalledReceipt(transactionRoot, productRoot, journal) {
  const installedFile = path.join(transactionRoot, INSTALLED_FILE);
  await assertSafePathChain(transactionRoot, installedFile, "file");
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(installedFile, "utf8")); } catch {
    fail("READY_UPDATE_INSTALL_COMMIT_RECEIPT_INVALID", installedFile);
  }
  if (
    !isPlainObject(receipt)
    || receipt.schema !== "bonni.update-installed/v1"
    || receipt.transactionId !== journal.transactionId
    || receipt.updateId !== journal.binding.updateId
    || receipt.channel !== journal.binding.channel
    || receipt.releaseSequence !== journal.binding.releaseSequence
    || receipt.readyReceiptSha256 !== journal.binding.readyReceiptSha256
    || stableStringify(receipt.components) !== stableStringify(journal.binding.components)
    || stableStringify(receipt.developerBase) !== stableStringify(journal.developerBase
      ? {
        version: journal.developerBase.version,
        systemReceipt: journal.developerBase.systemReceipt,
        envelopeReceipt: journal.developerBase.envelopeReceipt,
      }
      : null)
    || !isPlainObject(receipt.live)
  ) fail("READY_UPDATE_INSTALL_COMMIT_RECEIPT_INVALID", installedFile);
  canonicalTimestamp(receipt.installedAt, "READY_UPDATE_INSTALL_COMMIT_RECEIPT_INVALID");
  for (const name of managedLiveNames(journal)) {
    if (stableStringify(receipt.live[name]) !== stableStringify(journal.candidates[name])) {
      fail("READY_UPDATE_INSTALL_COMMIT_RECEIPT_INVALID", name);
    }
  }
  await verifyLiveCandidates(productRoot, journal);
  await verifyPublishedDeveloperBase(productRoot, journal);
  return receipt;
}

async function readAcceptedSequence(policy) {
  const state = await fs.lstat(policy.sequenceFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return null;
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 1024 * 1024) {
    fail("READY_UPDATE_INSTALL_SEQUENCE_STATE_INVALID", policy.sequenceFile);
  }
  try { return JSON.parse(await fs.readFile(policy.sequenceFile, "utf8")); } catch {
    fail("READY_UPDATE_INSTALL_SEQUENCE_STATE_INVALID", policy.sequenceFile);
  }
}

async function finishCommittedTransaction({
  productRoot,
  transactionRoot,
  journal,
  verificationPolicy,
  runtime = runtimePlatformIdentity(),
}) {
  assertPayloadPlatforms({ payloads: journal.binding.components }, runtime);
  await verifyInstalledReceipt(transactionRoot, productRoot, journal);
  const policy = await resolveVerificationPolicy(productRoot, verificationPolicy);
  if (policy.verificationMode === "production") {
    if (journal.binding.channel !== "stable") fail("READY_UPDATE_INSTALL_COMMIT_RECEIPT_INVALID");
    if (policy.lastAcceptedReleaseSequence < journal.binding.releaseSequence) {
      await reverifyBoundReady({ productRoot, journal, policy, runtime });
      await recordAcceptedUpdateSequence({
        productRoot,
        manifest: (await reverifyBoundReady({ productRoot, journal, policy, runtime })).verified.manifest,
      });
    } else if (policy.lastAcceptedReleaseSequence === journal.binding.releaseSequence) {
      const sequence = await readAcceptedSequence(policy);
      if (sequence?.updateId !== journal.binding.updateId) {
        fail("READY_UPDATE_INSTALL_SEQUENCE_COMMIT_MISMATCH");
      }
    } else {
      fail("READY_UPDATE_INSTALL_SEQUENCE_AHEAD");
    }
  }
  if (journal.state !== "accepted") {
    journal = await writeJournal(
      path.join(transactionRoot, JOURNAL_FILE),
      journal,
      "accepted",
    );
  }
  const paths = fixedTransactionLocations(productRoot, journal);
  await removeTree(paths.holdRoot);
  await removeTree(paths.nextRoot);
  await removeTree(paths.retiredPreviousRoot);
  return {
    status: "installed",
    transactionId: journal.transactionId,
    transactionRoot,
    components: journal.binding.components,
  };
}

async function activatePreparedTransaction({
  productRoot,
  transactionRoot,
  policy,
  requireBootstrap,
  databaseSnapshotController,
  onPhase,
  _testHooks,
}) {
  const runtime = runtimePlatformIdentity(_testHooks.runtimePlatform);
  let { journal, journalFile } = await readJournal(transactionRoot);
  if (journal.state === "accepted" || journal.state === "committed") {
    return finishCommittedTransaction({
      productRoot,
      transactionRoot,
      journal,
      verificationPolicy: policy.verificationMode === "development" ? policy : undefined,
      runtime,
    });
  }
  if (journal.state === "rolled-back") {
    fail("READY_UPDATE_INSTALL_TRANSACTION_ROLLED_BACK", transactionRoot);
  }
  journal = await recoverInterruptedTransaction({
    productRoot,
    transactionRoot,
    journal,
    databaseSnapshotController,
  });
  if (journal.state === "rolled-back") {
    fail("READY_UPDATE_INSTALL_TRANSACTION_RECOVERED", transactionRoot);
  }
  if (journal.binding.components.some((entry) => entry.component === "WINDOWS") && !requireBootstrap) {
    if (journal.state !== "bootstrap-required") {
      journal = await writeJournal(journalFile, journal, "bootstrap-required");
    }
    return {
      status: "bootstrap-required",
      transactionId: journal.transactionId,
      transactionRoot,
      bootstrapFile: path.join(transactionRoot, BOOTSTRAP_FILE),
      components: journal.binding.components,
    };
  }
  if (requireBootstrap && !journal.binding.components.some((entry) => entry.component === "WINDOWS")) {
    fail("READY_UPDATE_INSTALL_BOOTSTRAP_NOT_REQUIRED");
  }

  const paths = fixedTransactionLocations(productRoot, journal);
  await verifyCandidates(paths, journal);
  await preflightDeveloperBase(productRoot, journal);
  await reverifyBoundReady({ productRoot, journal, policy, runtime });
  await (_testHooks.assertStopped || assertBonniStopped)();
  await notifyPhase(onPhase, "preflight", { transactionId: journal.transactionId });

  let migrationController = null;
  let migrationsApplied = false;
  try {
    if (journal.binding.components.some((entry) => entry.component === "SYSTEM")) {
      migrationController = _testHooks.migrationController
        || await createDefaultMigrationController({
          candidateSystem: path.join(paths.nextRoot, "SYSTEM"),
          productRoot,
        });
      if (
        typeof migrationController?.preflight !== "function"
        || typeof migrationController?.apply !== "function"
      ) fail("READY_UPDATE_INSTALL_MIGRATION_CONTROLLER_INVALID");
      const preflight = await migrationController.preflight();
      if (!isPlainObject(preflight) || !Number.isSafeInteger(preflight.pending) || preflight.pending < 0) {
        fail("READY_UPDATE_INSTALL_MIGRATION_PREFLIGHT_INVALID");
      }
      if (preflight.pending > 0) {
        if (
          typeof databaseSnapshotController?.createAndVerify !== "function"
          || typeof databaseSnapshotController?.restore !== "function"
        ) fail("READY_UPDATE_INSTALL_DATABASE_SNAPSHOT_REQUIRED", String(preflight.pending));
        const snapshot = normalizeSnapshotReceipt(await databaseSnapshotController.createAndVerify({
          transactionId: journal.transactionId,
          updateId: journal.binding.updateId,
          productRoot,
          preflight,
        }));
        journal = await writeJournal(journalFile, journal, "migrating", { databaseSnapshot: snapshot });
      } else {
        journal = await writeJournal(journalFile, journal, "migrating");
      }
      await migrationController.apply();
      migrationsApplied = preflight.pending > 0;
    }

    // This is intentionally repeated after candidate preparation, migration
    // preflight and the stop check. No live root is touched unless the exact
    // READY transaction and its trust policy still verify at cutover time.
    await verifyCandidates(paths, journal);
    await reverifyBoundReady({ productRoot, journal, policy, runtime });
    await (_testHooks.assertStopped || assertBonniStopped)();
    await _testHooks.beforeFirstLiveMutation?.({ journal, transactionRoot });

    for (const name of managedLiveNames(journal)) {
      const component = name === "RUN_SYSTEM" ? "SYSTEM" : name;
      const state = name === "WINDOWS" ? "activating-windows" : "activating-system";
      journal = await writeJournal(journalFile, journal, state);
      const live = path.join(productRoot, name);
      const hold = path.join(paths.holdRoot, name);
      if (await exists(live)) await renameAndSync(live, hold, productRoot);
      else if (!journal.missingBefore.includes(name)) fail("READY_UPDATE_INSTALL_LIVE_ROOT_MISSING", name);
      await _testHooks.afterOldHeld?.({ name, component, journal });
      await renameAndSync(path.join(paths.nextRoot, name), live, productRoot);
      journal = await writeJournal(
        journalFile,
        journal,
        name === "WINDOWS" ? "windows-live" : "system-live",
      );
      await verifyTreeReceipt(
        live,
        journal.candidates[name],
        "READY_UPDATE_INSTALL_LIVE_VERIFICATION_FAILED",
      );
      await _testHooks.afterNewLive?.({ name, component, journal });
    }

    journal = await writeJournal(journalFile, journal, "backup-publishing");
    const backup = await preparePreviousBackup(productRoot, journal);
    await rotatePreviousBackup(backup.paths, journal);
    journal = await writeJournal(journalFile, journal, "backup-rotated");
    await verifyLiveCandidates(productRoot, journal);
    await _testHooks.afterBackupRotated?.({ journal, transactionRoot });
    journal = await publishDeveloperBase(productRoot, journal, journalFile);
    await verifyPublishedDeveloperBase(productRoot, journal);
    await _testHooks.afterDeveloperBasePublished?.({ journal, transactionRoot });
    await writeInstalledReceipt(transactionRoot, productRoot, journal);
    journal = await writeJournal(journalFile, journal, "committed");
  } catch (error) {
    if (!["committed", "accepted"].includes(journal.state)) {
      try {
        await restoreLiveRoots(productRoot, journal);
        await rollbackDeveloperBase(productRoot, journal);
        if (journal.databaseSnapshot && (migrationsApplied || journal.state === "migrating")) {
          await restoreDatabaseSnapshotIfNeeded({ journal, databaseSnapshotController });
        }
        journal = await writeJournal(journalFile, journal, "rolled-back", {
          failure: {
            code: error?.code || "READY_UPDATE_INSTALL_FAILED",
            at: new Date().toISOString(),
          },
        });
      } catch (rollbackError) {
        fail(
          "READY_UPDATE_INSTALL_ROLLBACK_FAILED",
          `${error?.code || error?.message}; ${rollbackError?.code || rollbackError?.message}`,
          { cause: rollbackError },
        );
      }
    }
    throw error;
  }

  return finishCommittedTransaction({
    productRoot,
    transactionRoot,
    journal,
    verificationPolicy: policy.verificationMode === "development" ? policy : undefined,
    runtime,
  });
}

async function findCommittedForReceipt(productRoot, preparedReceiptFile) {
  const roots = await ensureInstallRoots(productRoot);
  const expectedReceipt = relativePortable(productRoot, path.resolve(preparedReceiptFile));
  const entries = (await fs.readdir(roots.transactionsRoot, { withFileTypes: true }))
    .sort((left, right) => bytewiseCompare(left.name, right.name));
  const matches = [];
  for (const entry of entries) {
    if (!TRANSACTION_ID.test(entry.name) || !entry.isDirectory()) continue;
    const transactionRoot = path.join(roots.transactionsRoot, entry.name);
    const loaded = await readJournal(transactionRoot);
    if (
      loaded.journal.binding.preparedReceiptPath === expectedReceipt
      && ["committed", "accepted"].includes(loaded.journal.state)
    ) matches.push({ transactionRoot, ...loaded });
  }
  if (matches.length > 1) fail("READY_UPDATE_INSTALL_COMMIT_AMBIGUOUS", expectedReceipt);
  return matches[0] || null;
}

/**
 * Consumes and installs one already PREPARED package. A declared WINDOWS
 * component is never replaced in this process: the function publishes a
 * bootstrap request and returns `bootstrap-required` while all live roots are
 * still unchanged. `applyReadyUpdateBootstrap()` must then be launched after
 * the Windows Center has closed.
 */
export async function installReadyUpdatePackage({
  productRoot,
  preparedReceiptFile,
  verificationPolicy,
  databaseSnapshotController,
  onPhase,
  _testHooks = {},
} = {}) {
  if (typeof productRoot !== "string" || !productRoot) fail("READY_UPDATE_INSTALL_PRODUCT_ROOT_REQUIRED");
  if (typeof preparedReceiptFile !== "string" || !preparedReceiptFile) {
    fail("READY_UPDATE_INSTALL_PREPARED_RECEIPT_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  const runtime = runtimePlatformIdentity(_testHooks.runtimePlatform);
  const resolvedPreparedReceipt = path.resolve(preparedReceiptFile);
  relativePortable(resolvedProductRoot, resolvedPreparedReceipt);
  const alreadyCommitted = await findCommittedForReceipt(
    resolvedProductRoot,
    resolvedPreparedReceipt,
  );
  if (alreadyCommitted) {
    return finishCommittedTransaction({
      productRoot: resolvedProductRoot,
      transactionRoot: alreadyCommitted.transactionRoot,
      journal: alreadyCommitted.journal,
      verificationPolicy,
      runtime,
    });
  }
  const roots = await ensureInstallRoots(resolvedProductRoot);
  const releaseLock = await acquireInstallLock(roots.installRoot);
  try {
    const policy = await resolveVerificationPolicy(resolvedProductRoot, verificationPolicy);
    await (_testHooks.assertStopped || assertBonniStopped)();
    const ready = await consumePreparedUpdatePackage({
      productRoot: resolvedProductRoot,
      preparedReceiptFile: resolvedPreparedReceipt,
      verificationPolicy: policy,
    });
    const verified = await verifyReadyUpdateTransaction({
      productRoot: resolvedProductRoot,
      preparedReceiptFile: resolvedPreparedReceipt,
      transactionRoot: ready.transactionRoot,
      verificationPolicy: policy,
    });
    const view = assertPayloadPlatforms(assertVerifiedMode(verified, policy), runtime);
    const binding = bindingFromVerified(
      verified,
      view,
      resolvedPreparedReceipt,
      resolvedProductRoot,
    );
    let prepared = await prepareTransaction({
      productRoot: resolvedProductRoot,
      verified,
      view,
      binding,
      preparedReceiptFile: resolvedPreparedReceipt,
      onPhase,
      _testHooks,
    });
    if (prepared.journal.state === "rolled-back") {
      await archiveRolledBackTransaction(
        prepared.installRoot,
        prepared.transactionRoot,
        prepared.journal.transactionId,
      );
      prepared = await prepareTransaction({
        productRoot: resolvedProductRoot,
        verified,
        view,
        binding,
        preparedReceiptFile: resolvedPreparedReceipt,
        onPhase,
        _testHooks,
      });
    }
    // Await inside the try. Returning the still-pending promise would run the
    // asynchronous lock cleanup first and could leave a fast fail-closed
    // rejection temporarily unobserved (`PromiseRejectionHandledWarning`).
    return await activatePreparedTransaction({
      productRoot: resolvedProductRoot,
      transactionRoot: prepared.transactionRoot,
      policy,
      requireBootstrap: false,
      databaseSnapshotController,
      onPhase,
      _testHooks,
    });
  } finally {
    await releaseLock();
  }
}

/**
 * Privileged second process used when WINDOWS is declared. It re-verifies the
 * exact READY transaction and performs the component-bound journaled cutover.
 */
export async function applyReadyUpdateBootstrap({
  productRoot,
  transactionRoot,
  verificationPolicy,
  databaseSnapshotController,
  onPhase,
  _testHooks = {},
} = {}) {
  if (typeof productRoot !== "string" || !productRoot) fail("READY_UPDATE_INSTALL_PRODUCT_ROOT_REQUIRED");
  if (typeof transactionRoot !== "string" || !transactionRoot) {
    fail("READY_UPDATE_INSTALL_TRANSACTION_ROOT_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  const runtime = runtimePlatformIdentity(_testHooks.runtimePlatform);
  const roots = await ensureInstallRoots(resolvedProductRoot);
  const resolvedTransactionRoot = path.resolve(transactionRoot);
  relativePortable(roots.transactionsRoot, resolvedTransactionRoot);
  await assertSafePathChain(roots.transactionsRoot, resolvedTransactionRoot, "directory");
  const loaded = await readJournal(resolvedTransactionRoot);
  const expectedRoot = path.join(roots.transactionsRoot, loaded.journal.transactionId);
  if (resolvedTransactionRoot !== expectedRoot) {
    fail("READY_UPDATE_INSTALL_TRANSACTION_PATH_INVALID", resolvedTransactionRoot);
  }
  if (["committed", "accepted"].includes(loaded.journal.state)) {
    return finishCommittedTransaction({
      productRoot: resolvedProductRoot,
      transactionRoot: resolvedTransactionRoot,
      journal: loaded.journal,
      verificationPolicy,
      runtime,
    });
  }
  const releaseLock = await acquireInstallLock(roots.installRoot);
  try {
    const policy = await resolveVerificationPolicy(resolvedProductRoot, verificationPolicy);
    // See the matching primary path above: the rejection must be observed
    // before the asynchronous finally block releases the installer lock.
    return await activatePreparedTransaction({
      productRoot: resolvedProductRoot,
      transactionRoot: resolvedTransactionRoot,
      policy,
      requireBootstrap: true,
      databaseSnapshotController,
      onPhase,
      _testHooks,
    });
  } finally {
    await releaseLock();
  }
}

function parseArguments(argv) {
  const options = {
    productRoot: "",
    preparedReceiptFile: "",
    transactionRoot: "",
    developmentLocal: false,
    applyBootstrap: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--product-root") options.productRoot = argv[++index] || "";
    else if (argument === "--prepared-receipt") options.preparedReceiptFile = argv[++index] || "";
    else if (argument === "--transaction-root") options.transactionRoot = argv[++index] || "";
    else if (argument === "--development-local") options.developmentLocal = true;
    else if (argument === "--apply-bootstrap") options.applyBootstrap = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else fail("READY_UPDATE_INSTALL_ARGUMENT_UNKNOWN", argument);
  }
  if (!options.help && !options.productRoot) fail("READY_UPDATE_INSTALL_PRODUCT_ROOT_REQUIRED");
  if (!options.help && options.applyBootstrap && !options.transactionRoot) {
    fail("READY_UPDATE_INSTALL_TRANSACTION_ROOT_REQUIRED");
  }
  if (!options.help && !options.applyBootstrap && !options.preparedReceiptFile) {
    fail("READY_UPDATE_INSTALL_PREPARED_RECEIPT_REQUIRED");
  }
  return options;
}

function usage() {
  return [
    "Bonni PAYLOAD aus einer gebundenen READY-Transaktion sicher installieren.",
    "",
    "Produktion:",
    "  node install-ready-update-package.mjs --product-root <Hauptordner> --prepared-receipt <Datei>",
    "",
    "Windows-Bootstrap nach dem Schliessen des Centers:",
    "  node install-ready-update-package.mjs --apply-bootstrap --product-root <Hauptordner> --transaction-root <Ordner>",
    "",
    "Entwicklung (nur NODE_ENV=development/test und lokales unsigned development-v2):",
    "  zusaetzlich --development-local",
    "",
    "Produktiv werden ausschliesslich signierte bonni.update/v2 stable-Pakete",
    "mit RELEASE- und komponentenspezifischen Vertrauenssignaturen akzeptiert.",
    "LINUX und CONTAINER werden in dieser Version sicher abgelehnt.",
  ].join("\n");
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const verificationPolicy = options.developmentLocal
      ? {
        verificationMode: "development",
        allowUnsignedDevelopment: true,
        packageSource: "local",
        nodeEnv: process.env.NODE_ENV,
      }
      : undefined;
    const result = options.applyBootstrap
      ? await applyReadyUpdateBootstrap({
        productRoot: options.productRoot,
        transactionRoot: options.transactionRoot,
        verificationPolicy,
      })
      : await installReadyUpdatePackage({
        productRoot: options.productRoot,
        preparedReceiptFile: options.preparedReceiptFile,
        verificationPolicy,
      });
    if (result.status === "bootstrap-required") {
      console.log(`[bonni-update] Windows-Bootstrap erforderlich: ${result.bootstrapFile}`);
    } else {
      console.log(`[bonni-update] Update sicher installiert: ${result.transactionId}`);
    }
  } catch (error) {
    console.error(`[bonni-update] SICHER ABGEBROCHEN: ${error?.code || "READY_UPDATE_INSTALL_FAILED"}`);
    if (error?.detail) console.error(`[bonni-update] ${error.detail}`);
    process.exitCode = 23;
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedFile === import.meta.url) runCli();
