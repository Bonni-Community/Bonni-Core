import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const RECEIPT_SCHEMA_VERSION = 1;
const POINTER_SCHEMA_VERSION = 1;
const SLOT_ROLES = Object.freeze(["active", "candidate", "previous"]);
const SLOT_ROLE_SET = new Set(SLOT_ROLES);
const RECEIPT_FILE = "program-slot.json";
const POINTER_FILE = "slot-pointers.json";
const LOCK_DIRECTORY = ".program-slot.lock";
const STAGING_DIRECTORY = ".staging";
const RETIRED_DIRECTORY = ".retired";
const SLOTS_DIRECTORY = "slots";
const STATE_DIRECTORY = "state";
const PROMOTION_FILE = "promotion-transaction.json";
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAXIMUM_RUN_JSON_BYTES = 16 * 1024 * 1024;
const LEGACY_START_REPAIR_FRONTEND_TRANSACTION_PATH =
  /^SYSTEM\/frontend\/\.bonni-bonni-core-0120-start-automation-v2-frontend-dist-[a-f0-9]{24}$/u;

const DEFAULT_EXCLUDED_PATHS = Object.freeze([
  ".git",
  ".env",
  "BACKUP",
  "GITHUB",
  "UPDATE",
  "run_system",
  "runtime",
  "storage",
  ".bonni-source-update",
  "SYSTEM/.bonni-source-update",
  "SYSTEM/backend/archives",
  "SYSTEM/backend/backups",
  "SYSTEM/backend/data",
  "SYSTEM/backend/config/keys",
  "SYSTEM/backend/config/secrets",
  "SYSTEM/backend/keys",
  "SYSTEM/backend/logs",
  "SYSTEM/backend/secrets",
  "SYSTEM/backend/storage",
  "SYSTEM/backend/uploads",
  "SYSTEM/backend/updates",
  "SYSTEM/backend/.bonni-source-update",
  "SYSTEM/backend/run_system",
  "SYSTEM/frontend/uploads",
  "SYSTEM/frontend/public/uploads",
]);
const MANAGED_CORE_PROGRAM_ROOTS = Object.freeze([
  "SYSTEM/backend",
  "SYSTEM/frontend",
]);

export class RunSlotError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "RunSlotError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new RunSlotError(code, detail);
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

function canonicalRelativePath(value, label = "path") {
  const raw = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) {
    fail("RUN_SLOT_INVALID_RELATIVE_PATH", label);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    fail("RUN_SLOT_PATH_ESCAPE", `${label}:${raw}`);
  }
  return normalized;
}

function canonicalRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  if (!SLOT_ROLE_SET.has(role)) fail("RUN_SLOT_ROLE_INVALID", role || "missing");
  return role;
}

function pathIsInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowEqual && relative === "")
    || (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativePortable(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function now() {
  return new Date().toISOString();
}

function uniqueSuffix() {
  return `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
}

export function projectRoot(environment = process.env) {
  return environment.BONNI_PROJECT_ROOT
    ? path.resolve(environment.BONNI_PROJECT_ROOT)
    : path.resolve(process.cwd(), "../..");
}

export function runContainerRoot(environment = process.env) {
  return environment.BONNI_PROGRAM_SLOTS_ROOT
    ? path.resolve(environment.BONNI_PROGRAM_SLOTS_ROOT)
    : environment.RUNCONTAINER_ROOT
    ? path.resolve(environment.RUNCONTAINER_ROOT)
    : environment.RUN_SYSTEM_SYSTEM_ROOT
      ? path.resolve(environment.RUN_SYSTEM_SYSTEM_ROOT)
      : path.join(projectRoot(environment), "run_system", "system");
}

function canonicalSlotId(value) {
  const slotId = String(value ?? "").trim();
  if (!/^slot-[a-f0-9-]{36}$/u.test(slotId)) fail("RUN_SLOT_ID_INVALID", slotId || "missing");
  return slotId;
}

export function slotPath(slotId, options = {}) {
  const canonical = canonicalSlotId(slotId);
  const root = options.runRoot ? path.resolve(options.runRoot) : runContainerRoot(options.environment);
  return path.join(root, SLOTS_DIRECTORY, canonical);
}

export function slotProgramPath(slotId, options = {}) {
  return path.join(slotPath(slotId, options), "program");
}

export function slotReceiptPath(slotId, options = {}) {
  return path.join(slotPath(slotId, options), RECEIPT_FILE);
}

export function pointerFilePath(options = {}) {
  const root = options.runRoot ? path.resolve(options.runRoot) : runContainerRoot(options.environment);
  return path.join(root, POINTER_FILE);
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(target, label = "path") {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    const stat = await lstatOrNull(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) fail("RUN_SLOT_SYMLINK_FORBIDDEN", `${label}:${cursor}`);
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

async function atomicWrite(file, content, mode = 0o600) {
  const directory = path.dirname(file);
  await ensureDir(directory);
  await assertNoSymlinkComponents(directory, "atomic-parent");
  const existing = await lstatOrNull(file);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    fail("RUN_SLOT_ATOMIC_TARGET_UNSAFE", file);
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${uniqueSuffix()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readJson(file) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (!opened.isFile() || named.isSymbolicLink() || !named.isFile()
      || opened.dev !== named.dev || opened.ino !== named.ino
      || opened.nlink !== 1 || named.nlink !== 1
      || opened.size < 2 || opened.size > MAXIMUM_RUN_JSON_BYTES) {
      fail("RUN_SLOT_JSON_FILE_UNSAFE", file);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const renamed = await fs.lstat(file).catch(() => null);
    if (!renamed || renamed.dev !== opened.dev || renamed.ino !== opened.ino
      || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.nlink !== 1 || renamed.nlink !== 1) {
      fail("RUN_SLOT_JSON_OWNER_RACE", file);
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withFoundationLock(root, operation) {
  const lock = path.join(root, LOCK_DIRECTORY);
  await ensureDir(root);
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (error?.code === "EEXIST") fail("RUN_SLOT_OPERATION_LOCKED", lock);
    throw error;
  }
  try {
    await writeJson(path.join(lock, "owner.json"), { pid: process.pid, host: os.hostname(), startedAt: now() });
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

function blankPointerRoles() {
  return { active: null, candidate: null, previous: null };
}

function pointerChecksum(pointerBase) {
  return sha256(stableStringify(pointerBase));
}

function pointerFromReceipt(role, receipt) {
  if (!receipt) return null;
  const slotRoot = `${SLOTS_DIRECTORY}/${receipt.slotId}`;
  const stateRoot = `${STATE_DIRECTORY}/${receipt.slotId}`;
  return {
    role,
    slotId: receipt.slotId,
    slotRoot,
    programRoot: `${slotRoot}/program`,
    stateRoot,
    receipt: `${slotRoot}/${RECEIPT_FILE}`,
    receiptSha256: receipt.receiptSha256,
    version: receipt.source.version,
    updateId: receipt.source.updateId,
  };
}

async function writePointersUnlocked(root, roles, previousDocument = null) {
  const base = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    revision: Number(previousDocument?.revision || 0) + 1,
    updatedAt: now(),
    roles: {
      active: roles.active ?? null,
      candidate: roles.candidate ?? null,
      previous: roles.previous ?? null,
    },
  };
  const document = { ...base, checksum: pointerChecksum(base) };
  await writeJson(path.join(root, POINTER_FILE), document);
  return document;
}

export async function readSlotPointers(options = {}) {
  const root = options.runRoot ? path.resolve(options.runRoot) : runContainerRoot(options.environment);
  const document = await readJson(path.join(root, POINTER_FILE));
  if (!document) return null;
  const { checksum, ...base } = document;
  if (base.schemaVersion !== POINTER_SCHEMA_VERSION || checksum !== pointerChecksum(base)) {
    fail("RUN_SLOT_POINTER_INTEGRITY_FAILED", POINTER_FILE);
  }
  for (const role of SLOT_ROLES) {
    const pointer = base.roles?.[role];
    if (!pointer) continue;
    const expectedSlotRoot = `${SLOTS_DIRECTORY}/${pointer.slotId}`;
    if (pointer.role !== role
      || pointer.slotRoot !== expectedSlotRoot
      || pointer.programRoot !== `${expectedSlotRoot}/program`
      || pointer.stateRoot !== `${STATE_DIRECTORY}/${pointer.slotId}`) {
      fail("RUN_SLOT_POINTER_INVALID", role);
    }
    canonicalRelativePath(pointer.receipt, `pointer-${role}-receipt`);
  }
  return document;
}

export async function ensureRunSlotFoundation(options = {}) {
  const root = options.runRoot ? path.resolve(options.runRoot) : runContainerRoot(options.environment);
  await assertNoSymlinkComponents(root, "run-root");
  await ensureDir(root);
  await assertNoSymlinkComponents(root, "run-root");
  await Promise.all([
    ensureDir(path.join(root, SLOTS_DIRECTORY)),
    ensureDir(path.join(root, STATE_DIRECTORY)),
    ensureDir(path.join(root, STAGING_DIRECTORY)),
    ensureDir(path.join(root, RETIRED_DIRECTORY)),
  ]);
  let pointers = await readSlotPointers({ runRoot: root });
  if (!pointers) pointers = await writePointersUnlocked(root, blankPointerRoles());
  return { root, pointers };
}

function receiptChecksum(base) {
  return sha256(stableStringify(base));
}

function treeChecksum(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.mode));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function validateReceiptDocument(receipt, expectedRole = null) {
  if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt.kind !== "bonni-local-program-slot") {
    fail("RUN_SLOT_RECEIPT_INVALID", expectedRole || "unknown");
  }
  const { receiptSha256, ...base } = receipt;
  if (!/^[a-f0-9]{64}$/u.test(String(receiptSha256 || "")) || receiptChecksum(base) !== receiptSha256) {
    fail("RUN_SLOT_RECEIPT_INTEGRITY_FAILED", expectedRole || receipt.slotId || "unknown");
  }
  if (!/^slot-[a-f0-9-]{36}$/u.test(String(receipt.slotId || ""))) {
    fail("RUN_SLOT_RECEIPT_INVALID_SLOT_ID", receipt.slotId || "missing");
  }
  canonicalRole(receipt.stagedForRole);
  if (!Array.isArray(receipt.files) || receipt.treeSha256 !== treeChecksum(receipt.files)) {
    fail("RUN_SLOT_TREE_RECEIPT_INVALID", expectedRole || receipt.slotId);
  }
  let previousPath = null;
  for (const file of receipt.files) {
    const relative = canonicalRelativePath(file.path, "receipt-file");
    if (relative !== file.path || (previousPath !== null && relative.localeCompare(previousPath) <= 0)) {
      fail("RUN_SLOT_RECEIPT_FILE_ORDER_INVALID", relative);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      fail("RUN_SLOT_RECEIPT_FILE_INVALID", relative);
    }
    previousPath = relative;
  }
  return receipt;
}

async function readReceiptBySlotId(slotId, options = {}) {
  const canonical = canonicalSlotId(slotId);
  const receipt = await readJson(slotReceiptPath(canonical, options));
  if (!receipt) return null;
  if (receipt.slotId !== canonical) fail("RUN_SLOT_RECEIPT_SLOT_ID_MISMATCH", canonical);
  return validateReceiptDocument(receipt, canonical);
}

export async function resolveProgramSlot(slot, options = {}) {
  const role = canonicalRole(slot);
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  const pointers = await readSlotPointers({ runRoot: root });
  const pointer = pointers?.roles?.[role] || null;
  if (!pointer) return null;
  const receipt = await readReceiptBySlotId(pointer.slotId, { runRoot: root });
  if (!receipt) fail("RUN_SLOT_RECEIPT_MISSING", role);
  if (pointer.receiptSha256 !== receipt.receiptSha256) fail("RUN_SLOT_POINTER_RECEIPT_MISMATCH", role);
  const slotRoot = slotPath(pointer.slotId, { runRoot: root });
  const resolved = {
    role,
    slotId: pointer.slotId,
    slotRoot,
    programRoot: path.join(slotRoot, "program"),
    stateRoot: path.join(root, STATE_DIRECTORY, pointer.slotId),
    receipt,
    pointer,
  };
  if (options.verify === true) await verifyProgramSlot(role, { ...options, runRoot: root });
  return resolved;
}

export async function readSlotReceipt(slot, options = {}) {
  return (await resolveProgramSlot(slot, options))?.receipt || null;
}

/**
 * Detach the immutable Active program generation from startup without
 * deleting or rewriting that generation.  Host repairs use this only after
 * the runtime exclusion lease and the closed-port proof have established
 * that no old Active process can still be executing the detached tree.
 *
 * The returned pointer is a durable, receipt-bound rollback authority.  A
 * caller may pass it to restoreInvalidatedActiveProgramSlot when an outer
 * repair transaction has to roll back before its commit receipt exists.
 */
export async function invalidateActiveProgramSlot(options = {}) {
  if (options.offlineExclusion !== true) {
    fail("RUN_SLOT_INVALIDATE_OFFLINE_EXCLUSION_REQUIRED");
  }
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  await ensureRunSlotFoundation({ runRoot: root });
  return withFoundationLock(root, async () => {
    const promotion = await readPromotionTransaction(root);
    if (promotion && !new Set(["committed", "rolled-back"]).has(promotion.state)) {
      fail("RUN_SLOT_PROMOTION_DECISION_REQUIRED", promotion.transactionId);
    }
    const pointers = await readSlotPointers({ runRoot: root });
    const active = pointers?.roles?.active || null;
    if (!active) {
      return Object.freeze({ changed: false, beforeRevision: pointers.revision, afterRevision: pointers.revision, active: null });
    }
    if (options.expectedRevision !== undefined && pointers.revision !== options.expectedRevision) {
      fail("RUN_SLOT_INVALIDATE_POINTER_RACE", `${options.expectedRevision}:${pointers.revision}`);
    }
    if (options.expectedSlotId && active.slotId !== options.expectedSlotId) {
      fail("RUN_SLOT_INVALIDATE_ACTIVE_RACE", `${options.expectedSlotId}:${active.slotId}`);
    }
    const receipt = await readReceiptBySlotId(active.slotId, { runRoot: root });
    if (!receipt || receipt.receiptSha256 !== active.receiptSha256) {
      fail("RUN_SLOT_POINTER_RECEIPT_MISMATCH", "active");
    }
    await verifyProgramSlot("active", { runRoot: root });
    const committed = await writePointersUnlocked(root, { ...pointers.roles, active: null }, pointers);
    return Object.freeze({
      changed: true,
      beforeRevision: pointers.revision,
      afterRevision: committed.revision,
      active: Object.freeze({ ...active }),
    });
  });
}

/** Restore only the exact Active pointer detached by invalidateActiveProgramSlot. */
export async function restoreInvalidatedActiveProgramSlot(options = {}) {
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  const expected = options.active;
  if (!expected || expected.role !== "active" || !expected.slotId || !expected.receiptSha256) {
    fail("RUN_SLOT_RESTORE_ACTIVE_POINTER_INVALID");
  }
  await ensureRunSlotFoundation({ runRoot: root });
  return withFoundationLock(root, async () => {
    const promotion = await readPromotionTransaction(root);
    if (promotion && !new Set(["committed", "rolled-back"]).has(promotion.state)) {
      fail("RUN_SLOT_PROMOTION_DECISION_REQUIRED", promotion.transactionId);
    }
    const pointers = await readSlotPointers({ runRoot: root });
    if (options.expectedRevision !== undefined && pointers.revision !== options.expectedRevision) {
      fail("RUN_SLOT_RESTORE_POINTER_RACE", `${options.expectedRevision}:${pointers.revision}`);
    }
    if (pointers.roles.active) fail("RUN_SLOT_RESTORE_ACTIVE_ALREADY_PRESENT");
    const receipt = await readReceiptBySlotId(expected.slotId, { runRoot: root });
    if (!receipt || receipt.receiptSha256 !== expected.receiptSha256) {
      fail("RUN_SLOT_POINTER_RECEIPT_MISMATCH", "restore-active");
    }
    const canonical = {
      ...pointerFromReceipt("active", receipt),
      ...(Object.hasOwn(expected, "retainUntil") ? { retainUntil: expected.retainUntil } : {}),
    };
    if (JSON.stringify(canonical) !== JSON.stringify(expected)) {
      fail("RUN_SLOT_RESTORE_ACTIVE_POINTER_INVALID");
    }
    await verifyProgramSlotTree(root, "active", expected.slotId, receipt);
    const committed = await writePointersUnlocked(root, { ...pointers.roles, active: canonical }, pointers);
    return Object.freeze({ beforeRevision: pointers.revision, afterRevision: committed.revision, active: canonical });
  });
}

function exclusionMatcher(excludedPaths) {
  const canonical = [...new Set(excludedPaths.map((entry) => canonicalRelativePath(entry, "excluded-path").toLowerCase()))];
  return (relative) => {
    const normalized = relative.toLowerCase();
    return canonical.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`));
  };
}

function inclusionMatcher(includedPaths) {
  if (!includedPaths?.length) return () => true;
  const canonical = [...new Set(includedPaths.map((entry) => (
    canonicalRelativePath(entry, "included-path").toLowerCase()
  )))];
  return (relative) => {
    const normalized = relative.toLowerCase();
    return canonical.some((included) => (
      normalized === included
      || normalized.startsWith(`${included}/`)
      || included.startsWith(`${normalized}/`)
    ));
  };
}

function nodeModulesInclusionMatcher(includedPaths, includeAll = false) {
  if (includeAll) return () => true;
  if (!Array.isArray(includedPaths)) fail("RUN_SLOT_NODE_MODULES_INCLUDE_INVALID", "array-required");
  const canonical = [...new Set(includedPaths.map((entry) => {
    const relative = canonicalRelativePath(entry, "node-modules-include");
    if (path.posix.basename(relative).toLowerCase() !== "node_modules") {
      fail("RUN_SLOT_NODE_MODULES_INCLUDE_INVALID", relative);
    }
    return relative.toLowerCase();
  }))];
  return (relative) => {
    const normalized = relative.toLowerCase();
    return canonical.some((included) => (
      normalized === included || normalized.startsWith(`${included}/`)
    ));
  };
}

function isNodeModulesCommandShimPath(relative) {
  const components = relative.toLowerCase().split("/");
  return components.some((component, index) => (
    component === "node_modules" && components[index + 1] === ".bin"
  ));
}

function isLegacyStartRepairFrontendTransactionPath(relative) {
  return LEGACY_START_REPAIR_FRONTEND_TRANSACTION_PATH.test(relative);
}

async function secureCopyRegularFile(source, destination, relative, {
  allowSourceHardlinks = false,
} = {}) {
  const before = await fs.lstat(source);
  if (before.isSymbolicLink()) fail("RUN_SLOT_SYMLINK_FORBIDDEN", relative);
  if (!before.isFile()) fail("RUN_SLOT_SPECIAL_FILE_FORBIDDEN", relative);
  if (before.nlink > 1 && !allowSourceHardlinks) fail("RUN_SLOT_HARDLINK_FORBIDDEN", relative);

  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || (opened.nlink > 1 && !allowSourceHardlinks)) {
      fail(
        opened.nlink > 1 ? "RUN_SLOT_HARDLINK_FORBIDDEN" : "RUN_SLOT_SPECIAL_FILE_FORBIDDEN",
        relative,
      );
    }
    destinationHandle = await fs.open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      opened.mode & 0o777,
    );
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) fail("RUN_SLOT_COPY_WRITE_FAILED", relative);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat();
    if (
      after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || (opened.ino && after.ino !== opened.ino)
      || (after.nlink > 1 && !allowSourceHardlinks)
    ) {
      fail("RUN_SLOT_SOURCE_CHANGED_DURING_COPY", relative);
    }
    return { path: relative, size: position, sha256: hash.digest("hex"), mode: opened.mode & 0o777 };
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

async function copyProgramTree(sourceRoot, destinationRoot, excludedPaths, includedPaths = null, {
  includeNodeModulesPaths = [],
  includeAllNodeModules = false,
} = {}) {
  const isExcluded = exclusionMatcher(excludedPaths);
  const isIncluded = inclusionMatcher(includedPaths);
  const isIncludedNodeModules = nodeModulesInclusionMatcher(
    includeNodeModulesPaths,
    includeAllNodeModules,
  );
  const files = [];
  async function visit(relativeDirectory) {
    const sourceDirectory = relativeDirectory ? path.join(sourceRoot, ...relativeDirectory.split("/")) : sourceRoot;
    const destinationDirectory = relativeDirectory ? path.join(destinationRoot, ...relativeDirectory.split("/")) : destinationRoot;
    await ensureDir(destinationDirectory);
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const canonical = canonicalRelativePath(relative, "source-entry");
      const basename = path.posix.basename(canonical).toLowerCase();
      const source = path.join(sourceDirectory, entry.name);
      if (!isIncluded(canonical)) continue;
      if (isLegacyStartRepairFrontendTransactionPath(canonical)) {
        const transactionState = await fs.lstat(source);
        if (transactionState.isSymbolicLink() || !transactionState.isDirectory()) {
          fail("RUN_SLOT_LEGACY_FRONTEND_TRANSACTION_UNSAFE", canonical);
        }
        continue;
      }
      if (
        isExcluded(canonical)
        || isNodeModulesCommandShimPath(canonical)
        || (basename === "node_modules" && !isIncludedNodeModules(canonical))
        || (basename.startsWith(".env") && basename !== ".env.example")
      ) continue;
      const destination = path.join(destinationDirectory, entry.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) fail("RUN_SLOT_SYMLINK_FORBIDDEN", canonical);
      if (stat.isDirectory()) {
        await ensureDir(destination);
        if (process.platform !== "win32") await fs.chmod(destination, stat.mode & 0o777);
        await visit(canonical);
      } else if (stat.isFile()) {
        files.push(await secureCopyRegularFile(source, destination, canonical, {
          // npm may legitimately hardlink files from its content store or
          // between platform packages. The source is a freshly prepared,
          // explicitly allowlisted dependency tree; the destination is still
          // a new regular file whose bytes and metadata are reverified.
          allowSourceHardlinks: isIncludedNodeModules(canonical),
        }));
      } else {
        fail("RUN_SLOT_SPECIAL_FILE_FORBIDDEN", canonical);
      }
    }
  }
  await visit("");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function normalizeSourceMetadata(options, sourceRoot) {
  const version = String(options.version || "unknown").trim();
  const updateId = options.updateId === undefined || options.updateId === null ? null : String(options.updateId).trim();
  const manifestSha256 = options.manifestSha256 === undefined || options.manifestSha256 === null
    ? null
    : String(options.manifestSha256).trim().toLowerCase();
  if (manifestSha256 && !/^[a-f0-9]{64}$/u.test(manifestSha256)) {
    fail("RUN_SLOT_MANIFEST_SHA256_INVALID", manifestSha256);
  }
  return { root: sourceRoot, version: version || "unknown", updateId: updateId || null, manifestSha256 };
}

async function commitStagedSlot(root, role, stagingSlot, receipt, options) {
  const target = slotPath(receipt.slotId, { runRoot: root });
  const pointers = await readSlotPointers({ runRoot: root }) || await writePointersUnlocked(root, blankPointerRoles());
  const existingPointer = pointers.roles[role];
  if (existingPointer && !options.replace) fail("RUN_SLOT_ALREADY_EXISTS", role);
  if (role === "active" && existingPointer && !options.allowReplaceActive) {
    fail("RUN_SLOT_ACTIVE_REPLACEMENT_REQUIRES_EXPLICIT_PERMISSION");
  }
  if (await lstatOrNull(target)) fail("RUN_SLOT_GENERATION_ALREADY_EXISTS", receipt.slotId);
  try {
    await fs.rename(stagingSlot, target);
    const roles = { ...pointers.roles, [role]: pointerFromReceipt(role, receipt) };
    await writePointersUnlocked(root, roles, pointers);
  } catch (error) {
    // Once copied, a generation remains immutable. If the pointer commit fails,
    // the unreferenced generation is intentionally kept for safe diagnosis/GC.
    throw error;
  }
  return existingPointer;
}

export async function stageProgramTree(options = {}) {
  const role = canonicalRole(options.role || "candidate");
  const sourceRoot = path.resolve(options.sourceRoot || projectRoot(options.environment));
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  const explicitStagingRoot = options.stagingRoot ? path.resolve(options.stagingRoot) : null;
  const sourceSystemRoot = path.join(sourceRoot, "SYSTEM");
  if (pathIsInside(root, sourceRoot, true)) fail("RUN_SLOT_SOURCE_INSIDE_RUN_ROOT", sourceRoot);
  if (explicitStagingRoot && pathIsInside(sourceSystemRoot, explicitStagingRoot, true)) {
    fail("RUN_SLOT_STAGING_INSIDE_SYSTEM", explicitStagingRoot);
  }
  await assertNoSymlinkComponents(sourceRoot, "source-root");
  const sourceStat = await fs.lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) fail("RUN_SLOT_SOURCE_ROOT_UNSAFE", sourceRoot);
  await ensureRunSlotFoundation({ runRoot: root });

  const stagingRoot = explicitStagingRoot || path.join(root, STAGING_DIRECTORY);
  await assertNoSymlinkComponents(stagingRoot, "staging-root");
  await ensureDir(stagingRoot);
  await assertNoSymlinkComponents(stagingRoot, "staging-root");

  const excluded = [...DEFAULT_EXCLUDED_PATHS, ...(options.excludePaths || [])];
  if (pathIsInside(sourceRoot, root)) excluded.push(relativePortable(sourceRoot, root));
  if (pathIsInside(sourceRoot, stagingRoot)) excluded.push(relativePortable(sourceRoot, stagingRoot));
  const included = options.includePaths
    || (explicitStagingRoot ? MANAGED_CORE_PROGRAM_ROOTS : null);

  return withFoundationLock(root, async () => {
    const pendingPromotion = await readPromotionTransaction(root);
    if (pendingPromotion && !new Set(["committed", "rolled-back"]).has(pendingPromotion.state)) {
      fail("RUN_SLOT_PROMOTION_DECISION_REQUIRED", pendingPromotion.transactionId);
    }
    const slotId = `slot-${crypto.randomUUID()}`;
    const stagingSlot = path.join(stagingRoot, `${role}-${slotId}`);
    const program = path.join(stagingSlot, "program");
    await fs.mkdir(stagingSlot);
    try {
      const files = await copyProgramTree(sourceRoot, program, excluded, included, {
        includeNodeModulesPaths: options.includeNodeModulesPaths || [],
      });
      const base = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        kind: "bonni-local-program-slot",
        slotId,
        stagedForRole: role,
        createdAt: now(),
        source: normalizeSourceMetadata(options, sourceRoot),
        programRoot: "program",
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        treeSha256: treeChecksum(files),
        files,
      };
      const receipt = { ...base, receiptSha256: receiptChecksum(base) };
      await writeJson(path.join(stagingSlot, RECEIPT_FILE), receipt);
      await commitStagedSlot(root, role, stagingSlot, receipt, {
        replace: options.replace === true,
        allowReplaceActive: options.allowReplaceActive === true,
      });
      const slotRoot = slotPath(slotId, { runRoot: root });
      const stateRoot = path.join(root, STATE_DIRECTORY, slotId);
      await ensureDir(stateRoot);
      return {
        role,
        slotId,
        slotRoot,
        programRoot: path.join(slotRoot, "program"),
        stateRoot,
        receipt,
      };
    } catch (error) {
      await fs.rm(stagingSlot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function cloneProgramSlot(options = {}) {
  const fromRole = canonicalRole(options.fromRole || "active");
  const toRole = canonicalRole(options.toRole || "candidate");
  if (fromRole === toRole) fail("RUN_SLOT_CLONE_ROLE_CONFLICT", fromRole);
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  await ensureRunSlotFoundation({ runRoot: root });
  return withFoundationLock(root, async () => {
    const pendingPromotion = await readPromotionTransaction(root);
    if (pendingPromotion && !new Set(["committed", "rolled-back"]).has(pendingPromotion.state)) {
      fail("RUN_SLOT_PROMOTION_DECISION_REQUIRED", pendingPromotion.transactionId);
    }
    const source = await verifyProgramSlot(fromRole, { runRoot: root });
    if (options.expectedSourceSlotId && source.slotId !== options.expectedSourceSlotId) {
      fail("RUN_SLOT_CLONE_SOURCE_CHANGED", `${options.expectedSourceSlotId}:${source.slotId}`);
    }
    const slotId = `slot-${crypto.randomUUID()}`;
    const stagingSlot = path.join(root, STAGING_DIRECTORY, `${toRole}-${slotId}`);
    const stagingProgram = path.join(stagingSlot, "program");
    await fs.mkdir(stagingSlot);
    try {
      // The source slot is already sealed and verified. An exact clone must
      // therefore retain receipt-bound runtime dependencies instead of
      // applying the untrusted-source node_modules filter a second time.
      const files = await copyProgramTree(source.programRoot, stagingProgram, [], null, {
        includeAllNodeModules: true,
      });
      const copiedTreeSha256 = treeChecksum(files);
      if (files.length !== source.receipt.files.length || copiedTreeSha256 !== source.receipt.treeSha256) {
        fail("RUN_SLOT_CLONE_SOURCE_MISMATCH", source.slotId);
      }
      const sourceMetadata = normalizeSourceMetadata({
        version: options.version || source.receipt.source.version,
        updateId: options.updateId,
        manifestSha256: options.manifestSha256,
      }, source.programRoot);
      sourceMetadata.clonedFrom = {
        role: fromRole,
        slotId: source.slotId,
        receiptSha256: source.receipt.receiptSha256,
        treeSha256: source.receipt.treeSha256,
      };
      const base = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        kind: "bonni-local-program-slot",
        slotId,
        stagedForRole: toRole,
        createdAt: now(),
        source: sourceMetadata,
        programRoot: "program",
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        treeSha256: copiedTreeSha256,
        files,
      };
      const receipt = { ...base, receiptSha256: receiptChecksum(base) };
      await writeJson(path.join(stagingSlot, RECEIPT_FILE), receipt);
      await commitStagedSlot(root, toRole, stagingSlot, receipt, {
        replace: options.replace === true,
        allowReplaceActive: options.allowReplaceActive === true,
      });
      const resolved = await resolveProgramSlot(toRole, { runRoot: root });
      await ensureDir(resolved.stateRoot);
      return resolved;
    } catch (error) {
      await fs.rm(stagingSlot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function hashRegularFile(target, relative) {
  const before = await fs.lstat(target);
  if (before.isSymbolicLink()) fail("RUN_SLOT_SYMLINK_FORBIDDEN", relative);
  if (!before.isFile()) fail("RUN_SLOT_SPECIAL_FILE_FORBIDDEN", relative);
  if (before.nlink > 1) fail("RUN_SLOT_HARDLINK_FORBIDDEN", relative);
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile()) fail("RUN_SLOT_SPECIAL_FILE_FORBIDDEN", relative);
    if (opened.nlink > 1) fail("RUN_SLOT_HARDLINK_FORBIDDEN", relative);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || (opened.ino && opened.ino !== after.ino)) {
      fail("RUN_SLOT_SOURCE_CHANGED_DURING_READ", relative);
    }
    return { path: relative, size: position, sha256: hash.digest("hex"), mode: opened.mode & 0o777 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function enumerateProgramFiles(programRoot) {
  const files = [];
  async function visit(relativeDirectory) {
    const directory = relativeDirectory ? path.join(programRoot, ...relativeDirectory.split("/")) : programRoot;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = canonicalRelativePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) fail("RUN_SLOT_SYMLINK_FORBIDDEN", relative);
      if (stat.isDirectory()) await visit(relative);
      else if (stat.isFile()) {
        files.push(await hashRegularFile(target, relative));
      } else fail("RUN_SLOT_SPECIAL_FILE_FORBIDDEN", relative);
    }
  }
  await visit("");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

export async function resealProgramSlot(slot, options = {}) {
  const role = canonicalRole(slot);
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  await ensureRunSlotFoundation({ runRoot: root });
  return withFoundationLock(root, async () => {
    const pendingPromotion = await readPromotionTransaction(root);
    if (pendingPromotion && !new Set(["committed", "rolled-back"]).has(pendingPromotion.state)) {
      fail("RUN_SLOT_PROMOTION_DECISION_REQUIRED", pendingPromotion.transactionId);
    }
    const pointers = await readSlotPointers({ runRoot: root });
    const pointer = pointers?.roles?.[role];
    if (!pointer) fail("RUN_SLOT_RECEIPT_MISSING", role);
    if (!options.expectedSlotId) fail("RUN_SLOT_RESEAL_EXPECTED_SLOT_REQUIRED", role);
    if (pointer.slotId !== options.expectedSlotId) {
      fail("RUN_SLOT_RESEAL_SLOT_RACE", `${options.expectedSlotId}:${pointer.slotId}`);
    }
    if (options.expectedPointerRevision !== undefined && pointers.revision !== options.expectedPointerRevision) {
      fail("RUN_SLOT_RESEAL_POINTER_RACE", `${options.expectedPointerRevision}:${pointers.revision}`);
    }
    const existing = await readReceiptBySlotId(pointer.slotId, { runRoot: root });
    if (!existing) fail("RUN_SLOT_RECEIPT_MISSING", role);
    const slotRoot = slotPath(pointer.slotId, { runRoot: root });
    const programRoot = path.join(slotRoot, "program");
    const files = await enumerateProgramFiles(programRoot);
    const source = {
      ...existing.source,
      version: String(options.version || existing.source.version || "unknown").trim(),
      updateId: options.updateId === undefined ? existing.source.updateId : String(options.updateId || "").trim() || null,
      manifestSha256: options.manifestSha256 === undefined
        ? existing.source.manifestSha256
        : String(options.manifestSha256 || "").trim().toLowerCase() || null,
    };
    if (source.manifestSha256 && !/^[a-f0-9]{64}$/u.test(source.manifestSha256)) {
      fail("RUN_SLOT_MANIFEST_SHA256_INVALID", source.manifestSha256);
    }
    const base = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      kind: "bonni-local-program-slot",
      slotId: existing.slotId,
      stagedForRole: existing.stagedForRole,
      createdAt: existing.createdAt,
      sealedAt: now(),
      sealSequence: Number(existing.sealSequence || 0) + 1,
      source,
      programRoot: "program",
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      treeSha256: treeChecksum(files),
      files,
    };
    const receipt = { ...base, receiptSha256: receiptChecksum(base) };
    await writeJson(path.join(slotRoot, RECEIPT_FILE), receipt);
    const latestPointers = await readSlotPointers({ runRoot: root });
    if (latestPointers.revision !== pointers.revision || latestPointers.roles[role]?.slotId !== pointer.slotId) {
      fail("RUN_SLOT_RESEAL_POINTER_RACE", role);
    }
    await writePointersUnlocked(root, {
      ...latestPointers.roles,
      [role]: { ...pointerFromReceipt(role, receipt), retainUntil: pointer.retainUntil || null },
    }, latestPointers);
    return resolveProgramSlot(role, { runRoot: root });
  });
}

async function verifyProgramSlotTree(root, role, slotId, receipt) {
  const slotRoot = slotPath(slotId, { runRoot: root });
  const programRoot = path.join(slotRoot, "program");
  await assertNoSymlinkComponents(slotRoot, `slot-${role}`);
  const actualFiles = await enumerateProgramFiles(programRoot).catch((error) => {
    if (error?.code === "ENOENT") fail("RUN_SLOT_PROGRAM_TREE_MISMATCH", role);
    throw error;
  });
  if (actualFiles.length !== receipt.files.length || treeChecksum(actualFiles) !== receipt.treeSha256) {
    fail("RUN_SLOT_PROGRAM_TREE_MISMATCH", role);
  }
  for (let index = 0; index < actualFiles.length; index += 1) {
    const actual = actualFiles[index];
    const expected = receipt.files[index];
    if (actual.path !== expected.path || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      fail("RUN_SLOT_PROGRAM_FILE_MISMATCH", `${role}:${actual.path}`);
    }
  }
  return { slotRoot, programRoot };
}

export async function verifyProgramSlot(slot, options = {}) {
  const role = canonicalRole(slot);
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  const resolved = await resolveProgramSlot(role, { runRoot: root });
  if (!resolved) fail("RUN_SLOT_RECEIPT_MISSING", role);
  const { receipt, pointer } = resolved;
  await verifyProgramSlotTree(root, role, resolved.slotId, receipt);
  return { ok: true, ...resolved, receipt, pointer };
}

function parsePort(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) fail("RUN_SLOT_PORT_INVALID", label);
  return parsed;
}

function validateDatabaseUrls(databaseUrls) {
  if (!databaseUrls) return null;
  const values = SLOT_ROLES.map((role) => String(databaseUrls[role] || "").trim());
  if (values.some((value) => !value)) fail("RUN_SLOT_DATABASE_URL_MISSING");
  if (new Set(values).size !== values.length) fail("RUN_SLOT_DATABASE_NOT_ISOLATED");
  return Object.fromEntries(SLOT_ROLES.map((role, index) => [role, values[index]]));
}

export function planSlotRuntimeEnvironments(options = {}) {
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  const inherited = options.environment || process.env;
  const installationRoot = path.resolve(options.installationRoot || projectRoot(inherited));
  const explicitServer = options.serverPorts || {};
  const explicitLocal = options.localAuthPorts || {};
  const explicitModule = options.moduleManagerPorts || {};
  const serverPorts = {
    active: parsePort(explicitServer.active ?? options.activeServerPort ?? inherited.PORT, 4100, "active-server"),
    candidate: parsePort(explicitServer.candidate, 4300, "candidate-server"),
    previous: parsePort(explicitServer.previous, 4400, "previous-server"),
  };
  const localAuthPorts = {
    active: parsePort(explicitLocal.active ?? options.activeLocalAuthPort ?? inherited.LOCAL_AUTH_PORT, 4101, "active-local-auth"),
    candidate: parsePort(explicitLocal.candidate, 4301, "candidate-local-auth"),
    previous: parsePort(explicitLocal.previous, 4401, "previous-local-auth"),
  };
  const moduleManagerPorts = {
    active: parsePort(explicitModule.active ?? inherited.MODULE_MANAGER_PORT, 4201, "active-module-manager"),
    candidate: parsePort(explicitModule.candidate, 4302, "candidate-module-manager"),
    previous: parsePort(explicitModule.previous, 4402, "previous-module-manager"),
  };
  const allPorts = [...Object.values(serverPorts), ...Object.values(localAuthPorts), ...Object.values(moduleManagerPorts)];
  const reservedPorts = new Set((options.reservedPorts || [inherited.BONNI_INSTALLATION_MONITOR_PORT || 4198])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => parsePort(value, null, "reserved")));
  if (new Set(allPorts).size !== allPorts.length) fail("RUN_SLOT_PORT_COLLISION", allPorts.join(","));
  for (const port of allPorts) if (reservedPorts.has(port)) fail("RUN_SLOT_RESERVED_PORT_COLLISION", String(port));
  const databaseUrls = validateDatabaseUrls(options.databaseUrls);
  const bind = String(options.bind || inherited.LOCAL_AUTH_BIND || "127.0.0.1").trim();
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(bind)) fail("RUN_SLOT_NON_LOOPBACK_BIND_FORBIDDEN", bind);

  const slots = {};
  for (const role of SLOT_ROLES) {
    const resolved = options.resolvedSlots?.[role] || null;
    const slotRoot = resolved?.slotRoot || null;
    const programRoot = resolved?.programRoot || null;
    const generationStateRoot = resolved?.stateRoot || null;
    const productionRunSystemRoot = path.resolve(
      options.productionRunSystemRoot
        || inherited.BONNI_RUNTIME_STATE_ROOT
        || inherited.RUN_SYSTEM_ROOT
        || path.join(installationRoot, "run_system"),
    );
    const stateRoot = role === "active" ? productionRunSystemRoot : generationStateRoot;
    const storageRoot = role === "active"
      ? path.resolve(options.productionStorageRoot || inherited.BONNI_STORAGE_ROOT || path.join(productionRunSystemRoot, "storage"))
      : generationStateRoot ? path.join(generationStateRoot, "storage") : null;
    const mediaStorageRoot = role === "active"
      ? path.resolve(options.productionMediaStorageRoot || inherited.MEDIA_STORAGE_ROOT || path.join(storageRoot, "media"))
      : generationStateRoot ? path.join(generationStateRoot, "media") : null;
    const productRoot = role === "active" ? installationRoot : programRoot;
    const pathEnvironment = programRoot && stateRoot && productRoot
      ? {
        BONNI_PROJECT_ROOT: programRoot,
        BONNI_PROGRAM_ROOT: programRoot,
        BONNI_PRODUCT_ROOT: productRoot,
        // Apps/Module sind produktweiter Bestand und werden nicht als Teil
        // eines Core-only-Slots kopiert oder durch ein Core-Update ersetzt.
        BONNI_MODULE_PACKAGE_ROOT: path.join(installationRoot, "SYSTEM"),
        BONNI_PROGRAM_SLOTS_ROOT: root,
        BONNI_RUNTIME_STATE_ROOT: stateRoot,
        RUN_SYSTEM_ROOT: stateRoot,
        RUN_SYSTEM_SYSTEM_ROOT: path.join(stateRoot, "system"),
        RUN_SYSTEM_STORAGE_ROOT: storageRoot,
        RUN_SYSTEM_ARCHIV_ROOT: role === "active"
          ? path.resolve(options.productionArchivRoot || path.join(productionRunSystemRoot, "archiv"))
          : path.join(stateRoot, "archiv"),
        RUNCONTAINER_ROOT: root,
        BONNI_STORAGE_ROOT: storageRoot,
        MEDIA_STORAGE_ROOT: mediaStorageRoot,
        FRONTEND_DIST_ROOT: path.join(programRoot, "SYSTEM", "backend", "public"),
        BONNI_PROGRAM_SLOT_ROOT: slotRoot,
      }
      : {};
    slots[role] = {
      role,
      serverPort: serverPorts[role],
      localAuthPort: localAuthPorts[role],
      moduleManagerPort: moduleManagerPorts[role],
      slotRoot,
      programRoot,
      backendRoot: programRoot ? path.join(programRoot, "SYSTEM", "backend") : null,
      stateRoot,
      databaseIsolationRequired: role !== "active",
      env: {
        ...pathEnvironment,
        SYSTEM_SLOT_NAME: `backend-${role}`,
        SYSTEM_SLOT_ROLE: role,
        PORT: String(serverPorts[role]),
        LOCAL_AUTH_PORT: String(localAuthPorts[role]),
        MODULE_MANAGER_PORT: String(moduleManagerPorts[role]),
        SYSTEM_SERVER_BIND: bind,
        LOCAL_AUTH_BIND: bind,
        BONNI_PROGRAM_SLOT_ROLE: role,
        ...(databaseUrls ? { DATABASE_URL: databaseUrls[role] } : {}),
      },
    };
  }
  return {
    schemaVersion: 1,
    root,
    installationRoot,
    bind,
    reservedPorts: [...reservedPorts].sort((left, right) => left - right),
    databaseIsolationConfigured: Boolean(databaseUrls),
    slots,
  };
}

export async function buildSlotLaunchPlan(role, options = {}) {
  const canonical = canonicalRole(role);
  const verified = await verifyProgramSlot(canonical, options);
  const runtimePlan = planSlotRuntimeEnvironments({
    ...options,
    resolvedSlots: { ...(options.resolvedSlots || {}), [canonical]: verified },
  });
  const slot = runtimePlan.slots[canonical];
  const serverEntry = path.join(slot.backendRoot, "dist", "system", "server", "run-server.js");
  const supervisorEntry = path.join(slot.backendRoot, "scripts", "setup", "local-source-update-supervisor.mjs");
  const backendBootstrapEntry = path.join(slot.backendRoot, "scripts", "runtime", "start-backend.mjs");
  for (const [label, entry] of Object.entries({ serverEntry, supervisorEntry, backendBootstrapEntry })) {
    await assertNoSymlinkComponents(entry, label);
    const stat = await lstatOrNull(entry);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail("RUN_SLOT_LAUNCH_ENTRY_INVALID", label);
  }
  return {
    role: canonical,
    slotId: verified.receipt.slotId,
    receiptSha256: verified.receipt.receiptSha256,
    command: process.execPath,
    args: [serverEntry],
    cwd: slot.backendRoot,
    programRoot: slot.programRoot,
    backendRoot: slot.backendRoot,
    serverEntry,
    supervisorEntry,
    backendBootstrapEntry,
    supervisor: { command: process.execPath, args: [supervisorEntry], cwd: slot.backendRoot },
    env: {
      ...slot.env,
      BONNI_PROGRAM_SLOT_ID: verified.receipt.slotId,
      BONNI_PROGRAM_SLOT_RECEIPT_SHA256: verified.receipt.receiptSha256,
    },
    health: {
      host: slot.env.SYSTEM_SERVER_BIND,
      serverPort: slot.serverPort,
      localAuthPort: slot.localAuthPort,
      moduleManagerPort: slot.moduleManagerPort,
    },
    databaseIsolationRequired: slot.databaseIsolationRequired,
    databaseIsolationConfigured: runtimePlan.databaseIsolationConfigured,
  };
}

export async function promoteCandidateProgramSlot(options = {}) {
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  await ensureRunSlotFoundation({ runRoot: root });
  return withFoundationLock(root, async () => {
    const pendingPromotion = await readPromotionTransaction(root);
    if (pendingPromotion && !new Set(["committed", "rolled-back"]).has(pendingPromotion.state)) {
      fail("RUN_SLOT_PROMOTION_DECISION_REQUIRED", pendingPromotion.transactionId);
    }
    const candidate = await verifyProgramSlot("candidate", { runRoot: root });
    const active = await verifyProgramSlot("active", { runRoot: root });
    if (options.expectedCandidateSlotId && options.expectedCandidateSlotId !== candidate.slotId) {
      fail("RUN_SLOT_PROMOTION_CANDIDATE_RACE", `${options.expectedCandidateSlotId}:${candidate.slotId}`);
    }
    const pointers = await readSlotPointers({ runRoot: root });
    if (pointers.roles.active?.slotId !== active.slotId || pointers.roles.candidate?.slotId !== candidate.slotId) {
      fail("RUN_SLOT_PROMOTION_POINTER_RACE");
    }
    const retentionDays = Number(options.retentionDays ?? 14);
    if (!Number.isInteger(retentionDays) || retentionDays < 14 || retentionDays > 365) {
      fail("RUN_SLOT_RETENTION_INVALID", String(retentionDays));
    }
    const promotedAt = now();
    const retainUntil = new Date(Date.parse(promotedAt) + retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const intendedRoles = {
      active: { ...pointerFromReceipt("active", candidate.receipt), promotedAt },
      candidate: null,
      previous: { ...pointerFromReceipt("previous", active.receipt), promotedAt, retainUntil },
    };
    const transactionBase = {
      schemaVersion: 1,
      transactionId: crypto.randomUUID(),
      startedAt: promotedAt,
      state: "prepared",
      oldActiveSlotId: active.receipt.slotId,
      newActiveSlotId: candidate.receipt.slotId,
      beforeRevision: pointers.revision,
      beforeRoles: pointers.roles,
      intendedRoles,
      retentionDays,
      retainUntil,
    };
    await writeJson(path.join(root, PROMOTION_FILE), transactionBase);
    const promotedPointers = await writePointersUnlocked(root, intendedRoles, pointers);
    const transaction = {
      ...transactionBase,
      state: "pointer-promoted",
      pointerPromotedAt: now(),
      pointerRevision: promotedPointers.revision,
    };
    await writeJson(path.join(root, PROMOTION_FILE), transaction);
    return { active: candidate.receipt, previous: active.receipt, transaction };
  });
}

function pointerRolesMatch(left, right) {
  return stableStringify(left) === stableStringify(right);
}

async function readPromotionTransaction(root) {
  const transaction = await readJson(path.join(root, PROMOTION_FILE));
  if (!transaction) return null;
  if (transaction.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/u.test(String(transaction.transactionId || ""))) {
    fail("RUN_SLOT_PROMOTION_TRANSACTION_INVALID");
  }
  return transaction;
}

export async function finalizeProgramSlotPromotion(options = {}) {
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  return withFoundationLock(root, async () => {
    const transaction = await readPromotionTransaction(root);
    if (!transaction || transaction.transactionId !== options.transactionId) {
      fail("RUN_SLOT_PROMOTION_TRANSACTION_MISMATCH");
    }
    if (transaction.state === "committed") return transaction;
    if (!new Set(["pointer-promoted", "commit-decided"]).has(transaction.state)) {
      fail("RUN_SLOT_PROMOTION_NOT_FINALIZABLE", transaction.state);
    }
    const pointers = await readSlotPointers({ runRoot: root });
    if (!pointerRolesMatch(pointers.roles, transaction.intendedRoles)) {
      fail("RUN_SLOT_PROMOTION_POINTER_RACE");
    }
    const decided = { ...transaction, state: "commit-decided", decisionAt: transaction.decisionAt || now() };
    await writeJson(path.join(root, PROMOTION_FILE), decided);
    const committed = { ...decided, state: "committed", committedAt: now() };
    await writeJson(path.join(root, PROMOTION_FILE), committed);
    return committed;
  });
}

async function applyRollbackDecision(root, transaction) {
  const pointers = await readSlotPointers({ runRoot: root });
  if (!pointerRolesMatch(pointers.roles, transaction.intendedRoles)) {
    if (pointerRolesMatch(pointers.roles, transaction.rollbackRoles)) return pointers;
    fail("RUN_SLOT_PROMOTION_POINTER_RACE");
  }
  return writePointersUnlocked(root, transaction.rollbackRoles, pointers);
}

export async function rollbackCandidatePromotion(options = {}) {
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  return withFoundationLock(root, async () => {
    const transaction = await readPromotionTransaction(root);
    if (!transaction || transaction.transactionId !== options.transactionId) {
      fail("RUN_SLOT_PROMOTION_TRANSACTION_MISMATCH");
    }
    if (transaction.state === "rolled-back") return transaction;
    if (!new Set(["pointer-promoted", "rollback-decided"]).has(transaction.state)) {
      fail("RUN_SLOT_PROMOTION_NOT_ROLLBACKABLE", transaction.state);
    }
    if (options.expectedNewActiveSlotId && options.expectedNewActiveSlotId !== transaction.newActiveSlotId) {
      fail("RUN_SLOT_PROMOTION_TARGET_MISMATCH");
    }
    const rollbackRoles = {
      ...transaction.beforeRoles,
      candidate: options.quarantine === true ? null : transaction.beforeRoles.candidate,
    };
    const decided = {
      ...transaction,
      state: "rollback-decided",
      decisionAt: transaction.decisionAt || now(),
      quarantine: options.quarantine === true,
      quarantinedSlotId: options.quarantine === true ? transaction.newActiveSlotId : null,
      rollbackRoles,
    };
    await writeJson(path.join(root, PROMOTION_FILE), decided);
    const restoredPointers = await applyRollbackDecision(root, decided);
    const rolledBack = {
      ...decided,
      state: "rolled-back",
      rolledBackAt: now(),
      rollbackPointerRevision: restoredPointers.revision,
    };
    await writeJson(path.join(root, PROMOTION_FILE), rolledBack);
    return rolledBack;
  });
}

export async function recoverProgramSlotPromotion(options = {}) {
  const root = path.resolve(options.runRoot || runContainerRoot(options.environment));
  await ensureRunSlotFoundation({ runRoot: root });
  return withFoundationLock(root, async () => {
    let transaction = await readPromotionTransaction(root);
    if (!transaction) return { status: "none", recovered: false };
    if (new Set(["committed", "rolled-back"]).has(transaction.state)) {
      return { status: transaction.state, recovered: false, transaction };
    }
    const pointers = await readSlotPointers({ runRoot: root });
    if (transaction.state === "prepared") {
      if (pointerRolesMatch(pointers.roles, transaction.beforeRoles)) {
        transaction = { ...transaction, state: "rolled-back", rolledBackAt: now(), recovery: "pointer-not-promoted" };
        await writeJson(path.join(root, PROMOTION_FILE), transaction);
        return { status: "rolled-back", recovered: true, transaction };
      }
      if (pointerRolesMatch(pointers.roles, transaction.intendedRoles)) {
        transaction = {
          ...transaction,
          state: "pointer-promoted",
          pointerPromotedAt: transaction.pointerPromotedAt || now(),
          pointerRevision: pointers.revision,
          recovery: "pointer-commit-confirmed",
        };
        await writeJson(path.join(root, PROMOTION_FILE), transaction);
      } else {
        fail("RUN_SLOT_PROMOTION_RECOVERY_AMBIGUOUS");
      }
    }
    if (transaction.state === "rollback-decided") {
      const restoredPointers = await applyRollbackDecision(root, transaction);
      transaction = {
        ...transaction,
        state: "rolled-back",
        rolledBackAt: now(),
        rollbackPointerRevision: restoredPointers.revision,
        recovery: "rollback-decision-completed",
      };
      await writeJson(path.join(root, PROMOTION_FILE), transaction);
      return { status: "rolled-back", recovered: true, transaction };
    }
    if (transaction.state === "commit-decided") {
      if (!pointerRolesMatch((await readSlotPointers({ runRoot: root })).roles, transaction.intendedRoles)) {
        fail("RUN_SLOT_PROMOTION_RECOVERY_AMBIGUOUS");
      }
      transaction = { ...transaction, state: "committed", committedAt: now(), recovery: "commit-decision-completed" };
      await writeJson(path.join(root, PROMOTION_FILE), transaction);
      return { status: "committed", recovered: true, transaction };
    }
    return {
      status: "decision-required",
      recovered: transaction.recovery === "pointer-commit-confirmed",
      transaction,
    };
  });
}

// Compatibility helpers for the existing maintenance commands.
export function publicIdentity(receipt) {
  if (!receipt) return null;
  return {
    slotId: receipt.slotId,
    createdAt: receipt.createdAt,
    systemVersion: receipt.source?.version || "unknown",
    treeSha256: receipt.treeSha256,
    fileCount: receipt.fileCount,
  };
}

export async function ensureRunContainer(options = {}) {
  const foundation = await ensureRunSlotFoundation(options);
  return readSlotReceipt("active", { runRoot: foundation.root });
}

export { DEFAULT_EXCLUDED_PATHS, SLOT_ROLES };
