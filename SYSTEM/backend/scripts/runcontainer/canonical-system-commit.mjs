import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { verifyProgramSlot } from "./runcontainer-lib.mjs";

const INTENT_KIND = "bonni-canonical-system-commit-intent";
const RECEIPT_KIND = "bonni-canonical-system-commit-receipt";
const SCHEMA_VERSION = 1;
const MINIMUM_BACKUP_RETENTION_DAYS = 14;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MANAGED_ROOTS = Object.freeze(["SYSTEM/backend", "SYSTEM/frontend"]);
const INTERNAL_FILE_PREFIX = ".bonni-system-commit-";
const PREVIOUS_BACKUP_DIRECTORY = "PREVIOUS";
const PREVIOUS_BACKUP_NEXT_DIRECTORY = ".PREVIOUS.next";
const PREVIOUS_BACKUP_RETIRED_DIRECTORY = ".PREVIOUS.retired";
const LAYOUT_MIGRATION_PREVIOUS_KIND = "bonni.layout-migration-previous";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".bonni-source-update",
  "node_modules",
]);

const EXCLUDED_MANAGED_PREFIXES = Object.freeze([
  "system/backend/archives",
  "system/backend/backups",
  "system/backend/data",
  "system/backend/config/keys",
  "system/backend/config/secrets",
  "system/backend/keys",
  "system/backend/logs",
  "system/backend/run",
  "system/backend/run_install",
  "system/backend/run_system",
  "system/backend/runtime",
  "system/backend/secrets",
  "system/backend/storage",
  "system/backend/updates",
  "system/backend/uploads",
  "system/frontend/uploads",
  "system/frontend/public/uploads",
]);

const SECRET_OR_DATABASE_SUFFIXES = Object.freeze([
  ".db",
  ".db-journal",
  ".db-shm",
  ".db-wal",
  ".jwk",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".secret",
  ".secrets",
  ".sqlite",
  ".sqlite-journal",
  ".sqlite-shm",
  ".sqlite-wal",
  ".sqlite3",
]);

export class CanonicalSystemCommitError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CanonicalSystemCommitError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new CanonicalSystemCommitError(code, detail);
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

function documentWithChecksum(base, field) {
  return { ...base, [field]: sha256(stableStringify(base)) };
}

function validateChecksummedDocument(document, field, code) {
  if (!document || typeof document !== "object") fail(code, "missing");
  const { [field]: checksum, ...base } = document;
  if (!/^[a-f0-9]{64}$/u.test(String(checksum || "")) || sha256(stableStringify(base)) !== checksum) {
    fail(code, "checksum");
  }
  return document;
}

function assertExactKeys(value, expected, code, detail) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, detail);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length
    || actual.some((entry, index) => entry !== canonical[index])) {
    fail(code, detail);
  }
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

function canonicalRelativePath(value, label = "path") {
  const raw = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) {
    fail("CANONICAL_SYSTEM_INVALID_RELATIVE_PATH", `${label}:${raw || "missing"}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail("CANONICAL_SYSTEM_PATH_ESCAPE", `${label}:${raw}`);
  }
  return normalized;
}

function pathIsInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowEqual && relative === "")
    || (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeJoin(root, relative, label = "path") {
  const canonical = canonicalRelativePath(relative, label);
  const joined = path.resolve(root, ...canonical.split("/"));
  if (!pathIsInside(root, joined)) fail("CANONICAL_SYSTEM_PATH_ESCAPE", `${label}:${relative}`);
  return joined;
}

function isManagedPath(relative) {
  return MANAGED_ROOTS.some((root) => relative === root || relative.startsWith(`${root}/`));
}

function isExcludedPath(relative) {
  const canonical = canonicalRelativePath(relative);
  const lower = canonical.toLowerCase();
  const components = lower.split("/");
  const basename = components.at(-1);
  if (basename.startsWith(INTERNAL_FILE_PREFIX)) return true;
  if (basename.startsWith(".env") && basename !== ".env.example") return true;
  if (SECRET_OR_DATABASE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
  if (components.some((component) => EXCLUDED_DIRECTORY_NAMES.has(component))) return true;
  return EXCLUDED_MANAGED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

function canonicalHoldId(value, updateId, manifestSha256) {
  const supplied = value === undefined || value === null ? "" : String(value).trim();
  const holdId = supplied || `${updateId}-${manifestSha256.slice(0, 12)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(holdId) || holdId === "." || holdId === "..") {
    fail("CANONICAL_SYSTEM_HOLD_ID_INVALID", holdId || "missing");
  }
  return holdId;
}

function isoNow(now) {
  const raw = typeof now === "function" ? now() : Date.now();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(date.getTime())) fail("CANONICAL_SYSTEM_CLOCK_INVALID");
  return date.toISOString();
}

function retentionDeadline(createdAt) {
  return new Date(new Date(createdAt).getTime() + MINIMUM_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    const stat = await lstatOrNull(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) fail("CANONICAL_SYSTEM_SYMLINK_FORBIDDEN", `${label}:${cursor}`);
  }
}

async function ensureSafeDirectory(directory, label) {
  await assertNoSymlinkComponents(directory, label);
  await fs.mkdir(directory, { recursive: true });
  await assertNoSymlinkComponents(directory, label);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CANONICAL_SYSTEM_DIRECTORY_UNSAFE", `${label}:${directory}`);
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

async function syncDirectoryTree(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("CANONICAL_SYSTEM_DIRECTORY_UNSAFE", `sync-tree:${directory}`);
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    const childStat = await fs.lstat(child);
    if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
      fail("CANONICAL_SYSTEM_DIRECTORY_UNSAFE", `sync-tree:${child}`);
    }
    await syncDirectoryTree(child);
  }
  await syncDirectory(directory);
}

async function syncDirectoryAncestry(root, directory) {
  const resolvedRoot = path.resolve(root);
  let cursor = path.resolve(directory);
  if (!pathIsInside(resolvedRoot, cursor, true)) fail("CANONICAL_SYSTEM_PATH_ESCAPE", `sync:${directory}`);
  while (true) {
    await syncDirectory(cursor);
    if (cursor === resolvedRoot) return;
    cursor = path.dirname(cursor);
  }
}

async function atomicWrite(file, bytes, mode = 0o600) {
  const directory = path.dirname(file);
  await ensureSafeDirectory(directory, "atomic-parent");
  const existing = await lstatOrNull(file);
  if (existing?.isSymbolicLink() || (existing && (!existing.isFile() || existing.nlink !== 1))) {
    fail("CANONICAL_SYSTEM_ATOMIC_TARGET_UNSAFE", file);
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    await handle.writeFile(bytes);
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

async function atomicWriteJson(file, document) {
  await atomicWrite(file, `${stableStringify(document)}\n`, 0o600);
}

async function readSecureJson(file, missingCode) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
      || opened.dev !== named.dev || opened.ino !== named.ino
      || opened.nlink !== 1 || named.nlink !== 1
      || opened.size < 2 || opened.size > MAX_JSON_BYTES) {
      fail("CANONICAL_SYSTEM_JSON_UNSAFE", file);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(file).catch(() => null);
    if (!current || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1 || current.nlink !== 1) {
      fail("CANONICAL_SYSTEM_JSON_CHANGED", file);
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (missingCode) fail(missingCode, file);
      return null;
    }
    if (error instanceof SyntaxError) fail("CANONICAL_SYSTEM_JSON_INVALID", file);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectRegularFile(file, relative, { allowMissing = false } = {}) {
  const named = await lstatOrNull(file);
  if (!named) {
    if (allowMissing) return null;
    fail("CANONICAL_SYSTEM_FILE_MISSING", relative);
  }
  if (named.isSymbolicLink()) fail("CANONICAL_SYSTEM_SYMLINK_FORBIDDEN", relative);
  if (!named.isFile()) fail("CANONICAL_SYSTEM_SPECIAL_FILE_FORBIDDEN", relative);
  if (named.nlink !== 1) fail("CANONICAL_SYSTEM_HARDLINK_FORBIDDEN", relative);
  await assertNoSymlinkComponents(path.dirname(file), `file-parent:${relative}`);

  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) {
      fail(opened.nlink !== 1 ? "CANONICAL_SYSTEM_HARDLINK_FORBIDDEN" : "CANONICAL_SYSTEM_FILE_RACE", relative);
    }
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
    const current = await fs.lstat(file).catch(() => null);
    if (!current || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.nlink !== 1 || current.nlink !== 1) {
      fail("CANONICAL_SYSTEM_FILE_CHANGED_DURING_READ", relative);
    }
    return { path: relative, size: position, sha256: hash.digest("hex"), mode: opened.mode & 0o777 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameFile(left, right) {
  return Boolean(left && right
    && left.size === right.size
    && left.sha256 === right.sha256
    && left.mode === right.mode);
}

async function copyVerifiedFile(source, destination, expected, label) {
  await assertNoSymlinkComponents(source, `source:${label}`);
  const sourceBefore = await inspectRegularFile(source, label);
  if (!sameFile(sourceBefore, expected)) fail("CANONICAL_SYSTEM_CANDIDATE_FILE_MISMATCH", label);
  await ensureSafeDirectory(path.dirname(destination), `destination-parent:${label}`);
  const existing = await lstatOrNull(destination);
  if (existing) fail("CANONICAL_SYSTEM_COPY_TARGET_EXISTS", destination);

  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.nlink !== 1) fail("CANONICAL_SYSTEM_SOURCE_UNSAFE", label);
    destinationHandle = await fs.open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      expected.mode,
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
        if (result.bytesWritten <= 0) fail("CANONICAL_SYSTEM_COPY_WRITE_FAILED", label);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (process.platform !== "win32") await destinationHandle.chmod(expected.mode);
    await destinationHandle.sync();
    const after = await sourceHandle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1
      || position !== expected.size || hash.digest("hex") !== expected.sha256) {
      fail("CANONICAL_SYSTEM_SOURCE_CHANGED_DURING_COPY", label);
    }
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = null;
    await sourceHandle?.close().catch(() => undefined);
    sourceHandle = null;
    await fs.unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
  const copied = await inspectRegularFile(destination, label);
  if (!sameFile(copied, expected)) fail("CANONICAL_SYSTEM_COPY_VERIFY_FAILED", label);
  return copied;
}

function validateProgramSlotReceipt(receipt, expected) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "bonni-local-program-slot") {
    fail("CANONICAL_SYSTEM_CANDIDATE_RECEIPT_INVALID");
  }
  const { receiptSha256, ...base } = receipt;
  if (!/^[a-f0-9]{64}$/u.test(String(receiptSha256 || "")) || sha256(stableStringify(base)) !== receiptSha256) {
    fail("CANONICAL_SYSTEM_CANDIDATE_RECEIPT_INTEGRITY_FAILED");
  }
  if (!/^slot-[a-f0-9-]{36}$/u.test(String(receipt.slotId || ""))) {
    fail("CANONICAL_SYSTEM_CANDIDATE_SLOT_INVALID", receipt.slotId || "missing");
  }
  if (receipt.stagedForRole !== "candidate") {
    fail("CANONICAL_SYSTEM_CANDIDATE_ROLE_INVALID", receipt.stagedForRole || "missing");
  }
  if (!Array.isArray(receipt.files) || receipt.treeSha256 !== treeChecksum(receipt.files)
    || receipt.fileCount !== receipt.files.length
    || receipt.totalBytes !== receipt.files.reduce((sum, file) => sum + file.size, 0)) {
    fail("CANONICAL_SYSTEM_CANDIDATE_TREE_RECEIPT_INVALID", receipt.slotId);
  }
  if (receipt.source?.updateId !== expected.updateId
    || String(receipt.source?.manifestSha256 || "").toLowerCase() !== expected.manifestSha256) {
    fail("CANONICAL_SYSTEM_CANDIDATE_BINDING_MISMATCH", receipt.slotId);
  }

  let previous = null;
  const caseFolded = new Set();
  for (const file of receipt.files) {
    const relative = canonicalRelativePath(file.path, "candidate-receipt-file");
    if (relative !== file.path || (previous !== null && relative.localeCompare(previous) <= 0)
      || !Number.isSafeInteger(file.size) || file.size < 0
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || !/^[a-f0-9]{64}$/u.test(String(file.sha256 || ""))) {
      fail("CANONICAL_SYSTEM_CANDIDATE_FILE_ENTRY_INVALID", relative);
    }
    const folded = relative.toLowerCase();
    if (caseFolded.has(folded)) fail("CANONICAL_SYSTEM_CASE_COLLISION", relative);
    caseFolded.add(folded);
    previous = relative;
  }
  return receipt;
}

function validateConfirmation(confirmation, expected, candidateReceipt) {
  const proof = confirmation?.receipt?.state === "confirmed" ? confirmation.receipt : confirmation;
  const confirmed = proof?.confirmed === true || proof?.state === "confirmed";
  if (!confirmed) fail("CANONICAL_SYSTEM_CONFIRMATION_REQUIRED");
  const binding = proof.binding && typeof proof.binding === "object" ? proof.binding : proof;
  if (binding.updateId !== expected.updateId
    || String(binding.manifestSha256 || "").toLowerCase() !== expected.manifestSha256
    || binding.slotId !== candidateReceipt.slotId) {
    fail("CANONICAL_SYSTEM_CONFIRMATION_BINDING_MISMATCH");
  }
  if (binding.candidateReceiptSha256 !== candidateReceipt.receiptSha256) {
    fail("CANONICAL_SYSTEM_CONFIRMATION_RECEIPT_MISMATCH");
  }
}

async function candidateManagedFiles(candidateRoot, receipt) {
  const files = [];
  for (const entry of receipt.files) {
    if (!isManagedPath(entry.path)) continue;
    if (isExcludedPath(entry.path)) fail("CANONICAL_SYSTEM_FORBIDDEN_CANDIDATE_PATH", entry.path);
    const actual = await inspectRegularFile(safeJoin(candidateRoot, entry.path, "candidate-file"), entry.path);
    if (!sameFile(actual, entry)) fail("CANONICAL_SYSTEM_CANDIDATE_FILE_MISMATCH", entry.path);
    files.push({ path: entry.path, size: entry.size, sha256: entry.sha256, mode: entry.mode });
  }
  if (!files.some((file) => file.path.startsWith("SYSTEM/backend/"))) {
    fail("CANONICAL_SYSTEM_BACKEND_MISSING");
  }
  if (!files.some((file) => file.path.startsWith("SYSTEM/frontend/"))) {
    fail("CANONICAL_SYSTEM_FRONTEND_MISSING");
  }
  return files;
}

async function enumerateCanonicalManagedFiles(installationRoot) {
  const files = [];
  const caseFolded = new Set();

  async function visit(relativeDirectory) {
    const directory = safeJoin(installationRoot, relativeDirectory, "canonical-directory");
    const directoryStat = await lstatOrNull(directory);
    if (!directoryStat) return;
    if (directoryStat.isSymbolicLink()) fail("CANONICAL_SYSTEM_SYMLINK_FORBIDDEN", relativeDirectory);
    if (!directoryStat.isDirectory()) fail("CANONICAL_SYSTEM_SPECIAL_FILE_FORBIDDEN", relativeDirectory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = `${relativeDirectory}/${entry.name}`;
      if (isExcludedPath(relative)) continue;
      const folded = relative.toLowerCase();
      if (caseFolded.has(folded)) fail("CANONICAL_SYSTEM_CASE_COLLISION", relative);
      caseFolded.add(folded);
      const target = safeJoin(installationRoot, relative, "canonical-entry");
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) fail("CANONICAL_SYSTEM_SYMLINK_FORBIDDEN", relative);
      if (stat.isDirectory()) {
        await visit(relative);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) fail("CANONICAL_SYSTEM_HARDLINK_FORBIDDEN", relative);
        files.push(await inspectRegularFile(target, relative));
      } else {
        fail("CANONICAL_SYSTEM_SPECIAL_FILE_FORBIDDEN", relative);
      }
    }
  }

  for (const root of MANAGED_ROOTS) await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function transactionFileNames(intent, operation) {
  const token = sha256(intent.transactionId).slice(0, 16);
  const index = String(operation.index).padStart(6, "0");
  const target = safeJoin(intent.absoluteInstallationRoot, operation.path, "operation-target");
  return {
    target,
    temporary: path.join(path.dirname(target), `${INTERNAL_FILE_PREFIX}${token}-${index}.new`),
    building: path.join(path.dirname(target), `${INTERNAL_FILE_PREFIX}${token}-${index}.building`),
    displaced: path.join(path.dirname(target), `${INTERNAL_FILE_PREFIX}${token}-${index}.old`),
  };
}

function expectedFileState(operation, side) {
  const value = operation[side];
  return value ? { path: operation.path, ...value } : null;
}

async function inspectOperationArtifact(file, operation, expected, label) {
  const actual = await inspectRegularFile(file, operation.path, { allowMissing: true });
  if (actual && !sameFile(actual, expectedFileState(operation, expected))) {
    fail("CANONICAL_SYSTEM_TRANSACTION_ARTIFACT_CHANGED", `${operation.path}:${label}`);
  }
  return actual;
}

async function verifyBackup(transactionRoot, operation) {
  if (!operation.backup) return;
  const file = safeJoin(transactionRoot, operation.backup.path, "backup-file");
  const actual = await inspectRegularFile(file, operation.path);
  if (!sameFile(actual, expectedFileState(operation, "previous"))) {
    fail("CANONICAL_SYSTEM_BACKUP_INTEGRITY_FAILED", operation.path);
  }
}

async function restoreUnexpectedDisplaced(names, operation) {
  const displaced = await inspectRegularFile(names.displaced, operation.path, { allowMissing: true });
  if (!displaced) return null;
  const target = await inspectRegularFile(names.target, operation.path, { allowMissing: true });
  if (target) fail("CANONICAL_SYSTEM_TRANSACTION_ARTIFACT_CONFLICT", operation.path);
  await fs.rename(names.displaced, names.target);
  await syncDirectory(path.dirname(names.target));
  return displaced;
}

async function unlinkOwnedFile(file) {
  if (process.platform === "win32") await fs.chmod(file, 0o600).catch(() => undefined);
  await fs.unlink(file);
}

async function displaceVerifiedTarget(names, operation, previous, label) {
  await fs.rename(names.target, names.displaced);
  await syncDirectory(path.dirname(names.target));
  let captured;
  try {
    captured = await inspectRegularFile(names.displaced, operation.path);
  } catch (error) {
    if (!await lstatOrNull(names.target)) {
      await fs.rename(names.displaced, names.target).catch(() => undefined);
      await syncDirectory(path.dirname(names.target)).catch(() => undefined);
    }
    throw error;
  }
  if (!sameFile(captured, previous)) {
    if (!await lstatOrNull(names.target)) {
      await fs.rename(names.displaced, names.target);
      await syncDirectory(path.dirname(names.target));
    }
    fail("CANONICAL_SYSTEM_TARGET_CHANGED", `${operation.path}:${label}`);
  }
  return captured;
}

async function applyOperation(intent, transactionRoot, candidateRoot, operation) {
  const names = transactionFileNames(intent, operation);
  await ensureSafeDirectory(path.dirname(names.target), `target-parent:${operation.path}`);
  await syncDirectoryAncestry(intent.absoluteInstallationRoot, path.dirname(names.target));
  await verifyBackup(transactionRoot, operation);

  const targetKind = await lstatOrNull(names.target);
  if (targetKind?.isDirectory()) {
    if (operation.previous || !operation.desired) fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
    await removeEmptyDirectoryTree(names.target, intent.absoluteInstallationRoot, operation.path);
  }

  let current = await inspectRegularFile(names.target, operation.path, { allowMissing: true });
  const desired = expectedFileState(operation, "desired");
  const previous = expectedFileState(operation, "previous");
  let displaced = await inspectOperationArtifact(names.displaced, operation, "previous", "displaced");

  if (current && desired && sameFile(current, desired)) {
    if (displaced) await unlinkOwnedFile(names.displaced);
    const temporary = await inspectOperationArtifact(names.temporary, operation, "desired", "temporary");
    if (temporary) await unlinkOwnedFile(names.temporary);
    const building = await inspectRegularFile(names.building, operation.path, { allowMissing: true });
    if (building) await unlinkOwnedFile(names.building);
    await syncDirectory(path.dirname(names.target));
    return;
  }
  if (!current && !desired) {
    if (displaced) await unlinkOwnedFile(names.displaced);
    const temporary = await inspectRegularFile(names.temporary, operation.path, { allowMissing: true });
    if (temporary) fail("CANONICAL_SYSTEM_TRANSACTION_ARTIFACT_CONFLICT", operation.path);
    const building = await inspectRegularFile(names.building, operation.path, { allowMissing: true });
    if (building) fail("CANONICAL_SYSTEM_TRANSACTION_ARTIFACT_CONFLICT", operation.path);
    await syncDirectory(path.dirname(names.target));
    return;
  }

  if (!current && previous && displaced) {
    // Recovery after the old target was atomically displaced.
  } else if (current && previous && sameFile(current, previous) && !displaced) {
    // Normal pending replacement/deletion.
  } else if (!current && !previous && !displaced) {
    // Normal pending creation.
  } else {
    if (displaced && (!previous || !sameFile(displaced, previous))) {
      await restoreUnexpectedDisplaced(names, operation).catch(() => undefined);
    }
    fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
  }

  if (desired) {
    let temporary = await inspectOperationArtifact(names.temporary, operation, "desired", "temporary");
    if (!temporary) {
      let building = await inspectRegularFile(names.building, operation.path, { allowMissing: true });
      if (building && !sameFile(building, desired)) {
        // A process can die during the streaming copy. This deterministic,
        // transaction-owned artifact is never authoritative and is rebuilt.
        await unlinkOwnedFile(names.building);
        building = null;
      }
      if (!building) {
        const source = safeJoin(candidateRoot, operation.path, "candidate-operation-source");
        await copyVerifiedFile(source, names.building, desired, operation.path);
      }
      await fs.rename(names.building, names.temporary);
      await syncDirectory(path.dirname(names.temporary));
      temporary = desired;
    }

    current = await inspectRegularFile(names.target, operation.path, { allowMissing: true });
    displaced = await inspectOperationArtifact(names.displaced, operation, "previous", "displaced");
    if (current && previous && sameFile(current, previous) && !displaced) {
      displaced = await displaceVerifiedTarget(names, operation, previous, "replace-displace");
    } else if (current || (previous && !displaced) || (!previous && displaced)) {
      fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
    }

    await fs.rename(names.temporary, names.target);
    await syncDirectory(path.dirname(names.target));
    const installed = await inspectRegularFile(names.target, operation.path);
    if (!sameFile(installed, desired)) fail("CANONICAL_SYSTEM_INSTALL_VERIFY_FAILED", operation.path);
    if (displaced) await unlinkOwnedFile(names.displaced);
    await syncDirectory(path.dirname(names.target));
    return;
  }

  // A deletion is an atomic rename out of the canonical namespace. The backup
  // was already checksummed and durable before this point.
  if (current && previous && sameFile(current, previous) && !displaced) {
    displaced = await displaceVerifiedTarget(names, operation, previous, "delete-displace");
  }
  if (!displaced) fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
  await unlinkOwnedFile(names.displaced);
  await syncDirectory(path.dirname(names.target));
}

async function verifyCanonicalResult(installationRoot, desiredFiles) {
  const desiredByPath = new Map(desiredFiles.map((file) => [file.path, file]));
  const actualFiles = await enumerateCanonicalManagedFiles(installationRoot);
  if (actualFiles.length !== desiredFiles.length) fail("CANONICAL_SYSTEM_FINAL_TREE_MISMATCH", "file-count");
  for (const actual of actualFiles) {
    const desired = desiredByPath.get(actual.path);
    if (!desired || !sameFile(actual, desired)) fail("CANONICAL_SYSTEM_FINAL_TREE_MISMATCH", actual.path);
  }
  return treeChecksum(actualFiles);
}

async function removeEmptyDirectoryTree(directory, installationRoot, relative) {
  if (!pathIsInside(installationRoot, directory)) fail("CANONICAL_SYSTEM_PATH_ESCAPE", relative);
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("CANONICAL_SYSTEM_TARGET_CHANGED", relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const childRelative = `${relative}/${entry.name}`;
    const childStat = await fs.lstat(child);
    if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
      fail("CANONICAL_SYSTEM_TARGET_CHANGED", childRelative);
    }
    await removeEmptyDirectoryTree(child, installationRoot, childRelative);
  }
  await fs.rmdir(directory);
  await syncDirectory(path.dirname(directory));
}

async function preflightCanonicalState(installationRoot, desiredFiles, operations) {
  const desiredByPath = new Map(desiredFiles.map((file) => [file.path, file]));
  const operationByPath = new Map(operations.map((operation) => [operation.path, operation]));
  const actualFiles = await enumerateCanonicalManagedFiles(installationRoot);
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));

  for (const actual of actualFiles) {
    const operation = operationByPath.get(actual.path);
    if (!operation) {
      const desired = desiredByPath.get(actual.path);
      if (!desired || !sameFile(actual, desired)) fail("CANONICAL_SYSTEM_TARGET_CHANGED", actual.path);
      continue;
    }
    const previous = expectedFileState(operation, "previous");
    const desired = expectedFileState(operation, "desired");
    if ((!previous || !sameFile(actual, previous)) && (!desired || !sameFile(actual, desired))) {
      fail("CANONICAL_SYSTEM_TARGET_CHANGED", actual.path);
    }
  }

  for (const desired of desiredFiles) {
    if (operationByPath.has(desired.path)) continue;
    const actual = actualByPath.get(desired.path);
    if (!actual || !sameFile(actual, desired)) fail("CANONICAL_SYSTEM_TARGET_CHANGED", desired.path);
  }
}

async function preflightOperationStates(intent, transactionRoot, operations) {
  for (const operation of operations) {
    await verifyBackup(transactionRoot, operation);
    const names = transactionFileNames(intent, operation);
    await assertNoSymlinkComponents(path.dirname(names.target), `preflight-parent:${operation.path}`);
    const named = await lstatOrNull(names.target);
    if (named?.isDirectory()) {
      if (operation.action !== "create" || operation.previous !== null) {
        fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
      }
    } else {
      const current = await inspectRegularFile(names.target, operation.path, { allowMissing: true });
      const previous = expectedFileState(operation, "previous");
      const desired = expectedFileState(operation, "desired");
      if (current && (!sameFile(current, previous) && !sameFile(current, desired))) {
        fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
      }
      const displaced = await inspectOperationArtifact(names.displaced, operation, "previous", "preflight-displaced");
      if (!current && previous && operation.action !== "delete" && !displaced) {
        fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
      }
      if (current && displaced && !desired) fail("CANONICAL_SYSTEM_TRANSACTION_ARTIFACT_CONFLICT", operation.path);
    }
    await inspectOperationArtifact(names.temporary, operation, "desired", "preflight-temporary");
    // A building file is deliberately allowed to be partial, but it must
    // remain an ordinary transaction-owned file rather than a link/device.
    await inspectRegularFile(names.building, operation.path, { allowMissing: true });
  }
}

async function copyBackupsIntoStage(stageRoot, installationRoot, operations) {
  for (const operation of operations) {
    if (!operation.previous) continue;
    const source = safeJoin(installationRoot, operation.path, "backup-source");
    const destination = safeJoin(stageRoot, operation.backup.path, "backup-destination");
    await copyVerifiedFile(source, destination, expectedFileState(operation, "previous"), operation.path);
  }
}

async function recheckPreparedTargets(installationRoot, operations) {
  for (const operation of operations) {
    const actual = await inspectRegularFile(
      safeJoin(installationRoot, operation.path, "prepared-target"),
      operation.path,
      { allowMissing: true },
    );
    const previous = expectedFileState(operation, "previous");
    if ((!actual && previous) || (actual && !previous) || (actual && previous && !sameFile(actual, previous))) {
      fail("CANONICAL_SYSTEM_TARGET_CHANGED", operation.path);
    }
  }
}

function buildOperations(currentFiles, desiredFiles) {
  const spellingByFoldedPath = new Map();
  for (const file of [...currentFiles, ...desiredFiles]) {
    const folded = file.path.toLowerCase();
    const previousSpelling = spellingByFoldedPath.get(folded);
    if (previousSpelling && previousSpelling !== file.path) {
      fail("CANONICAL_SYSTEM_CASE_COLLISION", `${previousSpelling}:${file.path}`);
    }
    spellingByFoldedPath.set(folded, file.path);
  }
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  const desiredByPath = new Map(desiredFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...currentByPath.keys(), ...desiredByPath.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const operations = [];
  for (const relative of paths) {
    const current = currentByPath.get(relative) || null;
    const desired = desiredByPath.get(relative) || null;
    if (sameFile(current, desired)) continue;
    operations.push({
      index: -1,
      path: relative,
      action: desired ? (current ? "replace" : "create") : "delete",
      previous: current ? { size: current.size, sha256: current.sha256, mode: current.mode } : null,
      desired: desired ? { size: desired.size, sha256: desired.sha256, mode: desired.mode } : null,
      backup: current
        ? { path: `files/${relative}`, size: current.size, sha256: current.sha256, mode: current.mode }
        : null,
    });
  }
  operations.sort((left, right) => {
    const leftDelete = left.desired === null;
    const rightDelete = right.desired === null;
    if (leftDelete !== rightDelete) return leftDelete ? -1 : 1;
    const leftDepth = left.path.split("/").length;
    const rightDepth = right.path.split("/").length;
    if (leftDepth !== rightDepth) return leftDelete ? rightDepth - leftDepth : leftDepth - rightDepth;
    return left.path.localeCompare(right.path);
  });
  return operations.map((operation, index) => ({ ...operation, index }));
}

function validateIntent(intent, expected, holdId, installationRoot, candidateReceipt) {
  validateChecksummedDocument(intent, "intentSha256", "CANONICAL_SYSTEM_INTENT_INTEGRITY_FAILED");
  if (intent.schemaVersion !== SCHEMA_VERSION || intent.kind !== INTENT_KIND
    || intent.holdId !== holdId || intent.installationRootSha256 !== sha256(path.resolve(installationRoot))
    || intent.candidate?.slotId !== candidateReceipt.slotId
    || intent.candidate?.receiptSha256 !== candidateReceipt.receiptSha256
    || intent.candidate?.updateId !== expected.updateId
    || intent.candidate?.manifestSha256 !== expected.manifestSha256
    || !Array.isArray(intent.operations)
    || !/^[a-f0-9-]{36}$/u.test(String(intent.transactionId || ""))) {
    fail("CANONICAL_SYSTEM_INTENT_BINDING_MISMATCH", holdId);
  }
  const createdAt = new Date(intent.createdAt).getTime();
  const retainUntil = new Date(intent.retainUntil).getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(retainUntil)
    || intent.minimumRetentionDays !== MINIMUM_BACKUP_RETENTION_DAYS
    || retainUntil - createdAt < MINIMUM_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
    fail("CANONICAL_SYSTEM_INTENT_RETENTION_INVALID", holdId);
  }
  const operationPaths = new Set();
  function validateState(state, relative, side) {
    if (state === null) return null;
    if (!state || !Number.isSafeInteger(state.size) || state.size < 0
      || !Number.isSafeInteger(state.mode) || state.mode < 0 || state.mode > 0o777
      || !/^[a-f0-9]{64}$/u.test(String(state.sha256 || ""))) {
      fail("CANONICAL_SYSTEM_INTENT_OPERATION_INVALID", `${relative}:${side}`);
    }
    return state;
  }
  for (let index = 0; index < intent.operations.length; index += 1) {
    const operation = intent.operations[index];
    const relative = canonicalRelativePath(operation.path, "intent-operation");
    if (!isManagedPath(relative) || isExcludedPath(relative)
      || operation.index !== index || relative !== operation.path || operationPaths.has(relative.toLowerCase())
      || !new Set(["create", "replace", "delete"]).has(operation.action)) {
      fail("CANONICAL_SYSTEM_INTENT_OPERATION_INVALID", relative);
    }
    const previous = validateState(operation.previous, relative, "previous");
    const desired = validateState(operation.desired, relative, "desired");
    const expectedAction = desired ? (previous ? "replace" : "create") : (previous ? "delete" : null);
    if (!expectedAction || operation.action !== expectedAction) {
      fail("CANONICAL_SYSTEM_INTENT_OPERATION_INVALID", `${relative}:action`);
    }
    if (previous) {
      const backup = operation.backup;
      if (!backup || backup.path !== `files/${relative}`
        || backup.size !== previous.size || backup.mode !== previous.mode || backup.sha256 !== previous.sha256) {
        fail("CANONICAL_SYSTEM_INTENT_OPERATION_INVALID", `${relative}:backup`);
      }
    } else if (operation.backup !== null) {
      fail("CANONICAL_SYSTEM_INTENT_OPERATION_INVALID", `${relative}:unexpected-backup`);
    }
    operationPaths.add(relative.toLowerCase());
  }
  return intent;
}

function validateIntentCandidateOperations(intent, desiredFiles) {
  const desiredByPath = new Map(desiredFiles.map((file) => [file.path, file]));
  for (const operation of intent.operations) {
    const candidate = desiredByPath.get(operation.path) || null;
    const declared = expectedFileState(operation, "desired");
    if ((candidate === null) !== (declared === null)
      || (candidate && declared && !sameFile(candidate, declared))) {
      fail("CANONICAL_SYSTEM_INTENT_CANDIDATE_OPERATION_MISMATCH", operation.path);
    }
  }
}

function validateCommitReceipt(receipt, intent) {
  validateChecksummedDocument(receipt, "receiptSha256", "CANONICAL_SYSTEM_RECEIPT_INTEGRITY_FAILED");
  if (receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== RECEIPT_KIND
    || receipt.transactionId !== intent.transactionId || receipt.intentSha256 !== intent.intentSha256
    || receipt.holdId !== intent.holdId || receipt.candidate?.receiptSha256 !== intent.candidate.receiptSha256
    || receipt.operationCount !== intent.operations.length) {
    fail("CANONICAL_SYSTEM_RECEIPT_BINDING_MISMATCH", intent.holdId);
  }
  return receipt;
}

async function removeOwnedBackupDirectory(directory, backupRoot, label, removeImpl = fs.rm) {
  const stat = await lstatOrNull(directory);
  if (!stat) return false;
  if (!pathIsInside(backupRoot, directory) || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("CANONICAL_SYSTEM_BACKUP_ROTATION_UNSAFE", `${label}:${directory}`);
  }
  await assertNoSymlinkComponents(directory, label);
  await removeImpl(directory, { recursive: true, force: false });
  await syncDirectory(backupRoot);
  return true;
}

function validateCompletedPreviousIntent(intent, receipt, installationRoot) {
  validateChecksummedDocument(intent, "intentSha256", "CANONICAL_SYSTEM_PREVIOUS_INTENT_INVALID");
  if (intent.schemaVersion !== SCHEMA_VERSION || intent.kind !== INTENT_KIND
    || intent.installationRootSha256 !== sha256(path.resolve(installationRoot))
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(String(intent.holdId || ""))
    || !Array.isArray(intent.operations)
    || stableStringify(intent.managedRoots) !== stableStringify([...MANAGED_ROOTS])) {
    fail("CANONICAL_SYSTEM_PREVIOUS_INTENT_INVALID", intent?.holdId || "missing");
  }
  validateCommitReceipt(receipt, intent);
  if (!/^[a-f0-9]{64}$/u.test(String(receipt.finalManagedTreeSha256 || ""))) {
    fail("CANONICAL_SYSTEM_PREVIOUS_RECEIPT_INVALID", intent.holdId);
  }
  return { intent, receipt };
}

function layoutMigrationId(installationRoot) {
  return `layout-v2-${sha256(path.resolve(installationRoot).normalize("NFC")).slice(0, 20)}`;
}

function layoutMigrationSlotBinding(slot) {
  return {
    slotId: slot.slotId,
    receiptSha256: slot.receipt.receiptSha256,
    treeSha256: slot.receipt.treeSha256,
    version: slot.receipt.source.version,
  };
}

async function readVerifiedLayoutMigrationPrevious(paths, installationRoot) {
  const code = "CANONICAL_SYSTEM_PREVIOUS_LAYOUT_INVALID";
  const receiptPath = path.join(paths.holdRoot, "backup-receipt.json");
  const receipt = await readSecureJson(receiptPath, null);
  if (!receipt) fail("CANONICAL_SYSTEM_PREVIOUS_BACKUP_UNKNOWN", paths.holdRoot);

  assertExactKeys(receipt, [
    "schemaVersion", "kind", "migrationId", "createdAt", "source", "active",
    "legacyLayout", "checksum",
  ], code, "root-shape");
  assertExactKeys(receipt.source, ["slotId", "receiptSha256", "treeSha256", "version"], code, "source-shape");
  assertExactKeys(receipt.active, ["slotId", "receiptSha256", "treeSha256", "version"], code, "active-shape");
  assertExactKeys(receipt.legacyLayout, ["runPresent"], code, "legacy-shape");
  assertExactKeys(receipt.checksum, ["algorithm", "value"], code, "checksum-shape");
  const { checksum, ...payload } = receipt;
  if (receipt.schemaVersion !== 1
    || receipt.kind !== LAYOUT_MIGRATION_PREVIOUS_KIND
    || receipt.migrationId !== layoutMigrationId(installationRoot)
    || !Number.isFinite(Date.parse(receipt.createdAt))
    || new Date(receipt.createdAt).toISOString() !== receipt.createdAt
    || receipt.checksum.algorithm !== "sha256"
    || receipt.checksum.value !== sha256(stableStringify(payload))
    || typeof receipt.legacyLayout.runPresent !== "boolean") {
    fail(code, "binding");
  }
  for (const binding of [receipt.source, receipt.active]) {
    if (!/^slot-[a-f0-9-]{36}$/u.test(String(binding.slotId || ""))
      || !/^[a-f0-9]{64}$/u.test(String(binding.receiptSha256 || ""))
      || !/^[a-f0-9]{64}$/u.test(String(binding.treeSha256 || ""))
      || !String(binding.version || "").trim()) {
      fail(code, "slot-binding");
    }
  }

  const allowedEntries = new Set([".staging", "backup-receipt.json", "layout-v1", "program-slots"]);
  for (const entry of await fs.readdir(paths.holdRoot, { withFileTypes: true })) {
    if (!allowedEntries.has(entry.name) || entry.isSymbolicLink()) fail(code, `foreign-entry:${entry.name}`);
  }
  const programSlotsRoot = path.join(paths.holdRoot, "program-slots");
  const programSlotsState = await lstatOrNull(programSlotsRoot);
  if (!programSlotsState?.isDirectory() || programSlotsState.isSymbolicLink()) {
    fail(code, "program-slots");
  }

  let active;
  try {
    active = await verifyProgramSlot("active", { runRoot: programSlotsRoot });
  } catch (error) {
    fail(code, `active:${error?.code || error?.message || "invalid"}`);
  }
  if (stableStringify(receipt.active) !== stableStringify(layoutMigrationSlotBinding(active))
    || receipt.source.treeSha256 !== receipt.active.treeSha256
    || receipt.source.version !== receipt.active.version) {
    fail(code, "active-binding");
  }

  const legacyRoot = path.join(paths.holdRoot, "layout-v1");
  const legacyRootState = await lstatOrNull(legacyRoot);
  if (legacyRootState && (!legacyRootState.isDirectory() || legacyRootState.isSymbolicLink())) {
    fail(code, "legacy-root");
  }
  const legacyRun = path.join(legacyRoot, "RUN");
  const legacyRunState = await lstatOrNull(legacyRun);
  if (legacyRunState && (!legacyRunState.isDirectory() || legacyRunState.isSymbolicLink())) {
    fail(code, "legacy-run");
  }
  if (Boolean(legacyRunState) !== receipt.legacyLayout.runPresent) {
    fail(code, "legacy-binding");
  }

  // A checksummed migration receipt alone is insufficient: prove that its
  // immutable Active copy really is the canonical program base about to be
  // replaced. This prevents rotating away an unrelated but well-formed slot.
  const [backupManagedFiles, currentManagedFiles] = await Promise.all([
    candidateManagedFiles(active.programRoot, active.receipt),
    enumerateCanonicalManagedFiles(installationRoot),
  ]);
  if (treeChecksum(backupManagedFiles) !== treeChecksum(currentManagedFiles)) {
    fail(code, "canonical-base-mismatch");
  }
  return { receipt, active };
}

async function readPublishedPrevious({
  paths,
  expected,
  holdId,
  installationRoot,
  candidateReceipt,
  desiredFiles,
}) {
  const stat = await lstatOrNull(paths.holdRoot);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("CANONICAL_SYSTEM_PREVIOUS_BACKUP_UNSAFE", paths.holdRoot);
  }
  await assertNoSymlinkComponents(paths.holdRoot, "previous-backup");
  let intent = await readSecureJson(paths.intentPath, null);
  const receipt = await readSecureJson(paths.receiptPath, null);
  if (!intent) {
    if (receipt) fail("CANONICAL_SYSTEM_PREVIOUS_RECEIPT_ORPHANED", paths.receiptPath);
    const migration = await readVerifiedLayoutMigrationPrevious(paths, installationRoot);
    return { kind: "previous-layout-migration", ...migration };
  }
  if (intent.holdId === holdId) {
    intent = validateIntent(intent, expected, holdId, installationRoot, candidateReceipt);
    if (intent.desiredManagedTreeSha256 !== treeChecksum(desiredFiles)) {
      fail("CANONICAL_SYSTEM_INTENT_CANDIDATE_TREE_MISMATCH", holdId);
    }
    validateIntentCandidateOperations(intent, desiredFiles);
    return {
      kind: "current",
      intent,
      receipt: receipt ? validateCommitReceipt(receipt, intent) : null,
    };
  }
  if (!receipt) {
    // Never discard an unfinished previous commit merely to make room for a
    // newer update.  Its exact confirmed decision has to be recovered first.
    fail("CANONICAL_SYSTEM_PREVIOUS_COMMIT_PENDING", intent.holdId || "unknown");
  }
  validateCompletedPreviousIntent(intent, receipt, installationRoot);
  const currentTreeSha256 = treeChecksum(await enumerateCanonicalManagedFiles(installationRoot));
  if (receipt.finalManagedTreeSha256 !== currentTreeSha256) {
    fail("CANONICAL_SYSTEM_PREVIOUS_BASE_CHANGED", intent.holdId);
  }
  return { kind: "previous", intent, receipt };
}

async function readPreparedNext({
  paths,
  expected,
  holdId,
  installationRoot,
  candidateReceipt,
  desiredFiles,
}) {
  const stat = await lstatOrNull(paths.nextRoot);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("CANONICAL_SYSTEM_BACKUP_ROTATION_UNSAFE", `next:${paths.nextRoot}`);
  }
  await assertNoSymlinkComponents(paths.nextRoot, "previous-backup-next");
  const nextIntentPath = path.join(paths.nextTransactionRoot, "intent.json");
  const intent = await readSecureJson(nextIntentPath, null);
  if (!intent) return { complete: false, intent: null };
  const validated = validateIntent(intent, expected, holdId, installationRoot, candidateReceipt);
  if (validated.desiredManagedTreeSha256 !== treeChecksum(desiredFiles)) {
    fail("CANONICAL_SYSTEM_INTENT_CANDIDATE_TREE_MISMATCH", holdId);
  }
  validateIntentCandidateOperations(validated, desiredFiles);
  if (await readSecureJson(path.join(paths.nextTransactionRoot, "receipt.json"), null)) {
    fail("CANONICAL_SYSTEM_BACKUP_ROTATION_UNSAFE", "next-receipt-unexpected");
  }
  await preflightOperationStates(
    { ...validated, absoluteInstallationRoot: installationRoot },
    paths.nextTransactionRoot,
    validated.operations,
  );
  await recheckPreparedTargets(installationRoot, validated.operations);
  return { complete: true, intent: validated };
}

async function recoverInterruptedPreviousRotation(context) {
  const { paths } = context;
  await ensureSafeDirectory(paths.backupRoot, "backup-root");
  for (const [label, directory] of [
    ["previous-backup", paths.holdRoot],
    ["previous-backup-next", paths.nextRoot],
    ["previous-backup-retired", paths.retiredRoot],
  ]) await assertNoSymlinkComponents(directory, label);

  const [published, retired, prepared] = await Promise.all([
    lstatOrNull(paths.holdRoot),
    lstatOrNull(paths.retiredRoot),
    readPreparedNext(context),
  ]);
  if (!published && retired) {
    if (retired.isSymbolicLink() || !retired.isDirectory()) {
      fail("CANONICAL_SYSTEM_BACKUP_ROTATION_UNSAFE", "retired");
    }
    if (prepared?.complete) {
      await fs.rename(paths.nextRoot, paths.holdRoot);
      await syncDirectory(paths.backupRoot);
    } else {
      if (prepared) {
        await removeOwnedBackupDirectory(paths.nextRoot, paths.backupRoot, "previous-backup-next");
      }
      await fs.rename(paths.retiredRoot, paths.holdRoot);
      await syncDirectory(paths.backupRoot);
    }
    return;
  }
  if (!published && prepared?.complete) {
    await fs.rename(paths.nextRoot, paths.holdRoot);
    await syncDirectory(paths.backupRoot);
    return;
  }
  if (!published && prepared && !prepared.complete) {
    await removeOwnedBackupDirectory(paths.nextRoot, paths.backupRoot, "previous-backup-next");
  }
}

async function prepareIntent({
  installationRoot,
  candidateReceipt,
  desiredFiles,
  expected,
  holdId,
  paths,
  now,
}) {
  const prepared = await readPreparedNext({
    paths,
    expected,
    holdId,
    installationRoot,
    candidateReceipt,
    desiredFiles,
  });
  if (prepared?.complete) return prepared.intent;
  if (prepared) {
    await removeOwnedBackupDirectory(paths.nextRoot, paths.backupRoot, "previous-backup-next");
  }
  const currentFiles = await enumerateCanonicalManagedFiles(installationRoot);
  const operations = buildOperations(currentFiles, desiredFiles);
  const createdAt = isoNow(now);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    kind: INTENT_KIND,
    transactionId: crypto.randomUUID(),
    holdId,
    createdAt,
    retainUntil: retentionDeadline(createdAt),
    minimumRetentionDays: MINIMUM_BACKUP_RETENTION_DAYS,
    installationRootSha256: sha256(path.resolve(installationRoot)),
    managedRoots: [...MANAGED_ROOTS],
    candidate: {
      slotId: candidateReceipt.slotId,
      receiptSha256: candidateReceipt.receiptSha256,
      treeSha256: candidateReceipt.treeSha256,
      updateId: expected.updateId,
      manifestSha256: expected.manifestSha256,
    },
    desiredManagedTreeSha256: treeChecksum(desiredFiles),
    operations,
  };
  const intent = documentWithChecksum(base, "intentSha256");
  await ensureSafeDirectory(paths.backupRoot, "backup-root");
  await syncDirectoryAncestry(installationRoot, paths.backupRoot);
  if (await lstatOrNull(paths.nextRoot)) {
    fail("CANONICAL_SYSTEM_TRANSACTION_COLLISION", paths.nextRoot);
  }
  await fs.mkdir(paths.nextRoot);
  await fs.mkdir(paths.nextTransactionRoot);
  try {
    await copyBackupsIntoStage(paths.nextTransactionRoot, installationRoot, operations);
    await recheckPreparedTargets(installationRoot, operations);
    await atomicWriteJson(path.join(paths.nextTransactionRoot, "intent.json"), intent);
    await syncDirectoryTree(paths.nextRoot);
    return intent;
  } catch (error) {
    await removeOwnedBackupDirectory(
      paths.nextRoot,
      paths.backupRoot,
      "previous-backup-next",
    ).catch(() => undefined);
    throw error;
  }
}

async function publishPreparedPrevious(paths) {
  const current = await lstatOrNull(paths.holdRoot);
  const retired = await lstatOrNull(paths.retiredRoot);
  if (retired) fail("CANONICAL_SYSTEM_BACKUP_ROTATION_UNSAFE", "retired-already-present");
  if (current) {
    if (current.isSymbolicLink() || !current.isDirectory()) {
      fail("CANONICAL_SYSTEM_PREVIOUS_BACKUP_UNSAFE", paths.holdRoot);
    }
    await fs.rename(paths.holdRoot, paths.retiredRoot);
    await syncDirectory(paths.backupRoot);
  }
  try {
    await fs.rename(paths.nextRoot, paths.holdRoot);
    await syncDirectory(paths.backupRoot);
  } catch (error) {
    if (!await lstatOrNull(paths.holdRoot) && await lstatOrNull(paths.retiredRoot)) {
      await fs.rename(paths.retiredRoot, paths.holdRoot).catch(() => undefined);
      await syncDirectory(paths.backupRoot).catch(() => undefined);
    }
    throw error;
  }
  // On Windows a recently stopped process or virus scanner can briefly hold a
  // file in the retired tree. PREVIOUS is already complete and authoritative;
  // cleanup therefore belongs after the canonical commit receipt and must not
  // turn a confirmed, functional installation into a failed update.
}

async function cleanupRotationArtifactsBestEffort(paths, removeImpl = fs.rm) {
  const pending = [];
  for (const [label, directory] of [
    ["previous-backup-retired", paths.retiredRoot],
    ["previous-backup-next", paths.nextRoot],
  ]) {
    if (!await lstatOrNull(directory)) continue;
    try {
      await removeOwnedBackupDirectory(directory, paths.backupRoot, label, removeImpl);
    } catch (error) {
      pending.push({
        path: directory,
        error: String(error?.code || error?.message || error).slice(0, 160),
      });
    }
  }
  return { cleanupPending: pending.length > 0, pending };
}

async function readOwnedLock(lockPath) {
  try {
    return await readSecureJson(lockPath, null);
  } catch (error) {
    return null;
  }
}

function processAppearsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function withCommitLock(lockPath, callback) {
  await ensureSafeDirectory(path.dirname(lockPath), "commit-lock-parent");
  const token = crypto.randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(`${stableStringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readOwnedLock(lockPath);
      if (owner && processAppearsAlive(owner.pid)) fail("CANONICAL_SYSTEM_COMMIT_BUSY", String(owner.pid));
      const stat = await lstatOrNull(lockPath);
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        fail("CANONICAL_SYSTEM_LOCK_UNSAFE", lockPath);
      }
      // A second process can observe the O_EXCL file in the tiny interval
      // before its owner document has been fsynced. An unreadable fresh lock is
      // therefore busy, never stale. A valid dead-PID lock can recover at once.
      if (!owner && Date.now() - stat.mtimeMs < 30_000) {
        fail("CANONICAL_SYSTEM_COMMIT_BUSY", "lock-initializing");
      }
      await fs.unlink(lockPath);
    }
  }
  if (!acquired) fail("CANONICAL_SYSTEM_COMMIT_BUSY", "lock-retry-exhausted");
  try {
    return await callback();
  } finally {
    const owner = await readOwnedLock(lockPath);
    if (owner?.token === token) await fs.unlink(lockPath).catch(() => undefined);
  }
}

export function canonicalSystemCommitPaths({ installationRoot, holdId }) {
  const root = path.resolve(installationRoot || ".");
  if (root === path.parse(root).root) fail("CANONICAL_SYSTEM_INSTALLATION_ROOT_UNSAFE", root);
  const canonicalHold = String(holdId || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(canonicalHold) || /[. ]$/u.test(canonicalHold)) {
    fail("CANONICAL_SYSTEM_HOLD_ID_INVALID", canonicalHold || "missing");
  }
  const backupRoot = path.join(root, "BACKUP");
  // BACKUP is deliberately a singleton.  A new, completely prepared previous
  // version replaces this directory atomically; version-named sibling folders
  // must never accumulate indefinitely.
  const holdRoot = path.join(backupRoot, PREVIOUS_BACKUP_DIRECTORY);
  const transactionRoot = path.join(holdRoot, "canonical-system-commit");
  return {
    backupRoot,
    holdRoot,
    transactionRoot,
    intentPath: path.join(transactionRoot, "intent.json"),
    receiptPath: path.join(transactionRoot, "receipt.json"),
    nextRoot: path.join(backupRoot, PREVIOUS_BACKUP_NEXT_DIRECTORY),
    nextTransactionRoot: path.join(
      backupRoot,
      PREVIOUS_BACKUP_NEXT_DIRECTORY,
      "canonical-system-commit",
    ),
    retiredRoot: path.join(backupRoot, PREVIOUS_BACKUP_RETIRED_DIRECTORY),
    lockPath: path.join(backupRoot, ".canonical-system-commit.lock"),
  };
}

/**
 * Commits a verified candidate program tree into canonical SYSTEM after a
 * separately persisted confirmation. The immutable intent plus exact hashes
 * make the same call the crash-recovery entrypoint as well.
 */
export async function commitCanonicalSystem(options = {}) {
  const installationRoot = path.resolve(options.installationRoot || "");
  const candidateProgramRoot = path.resolve(options.candidateProgramRoot || "");
  if (!options.installationRoot || !options.candidateProgramRoot
    || installationRoot === path.parse(installationRoot).root
    || candidateProgramRoot === path.parse(candidateProgramRoot).root
    || installationRoot === candidateProgramRoot
    || pathIsInside(candidateProgramRoot, installationRoot, true)) {
    fail("CANONICAL_SYSTEM_ROOTS_UNSAFE");
  }
  for (const managedRoot of MANAGED_ROOTS) {
    if (pathIsInside(path.join(installationRoot, ...managedRoot.split("/")), candidateProgramRoot, true)) {
      fail("CANONICAL_SYSTEM_CANDIDATE_INSIDE_MANAGED_SYSTEM", managedRoot);
    }
  }
  await assertNoSymlinkComponents(installationRoot, "installation-root");
  await assertNoSymlinkComponents(candidateProgramRoot, "candidate-root");
  const [installationStat, candidateStat] = await Promise.all([
    fs.lstat(installationRoot),
    fs.lstat(candidateProgramRoot),
  ]);
  if (!installationStat.isDirectory() || installationStat.isSymbolicLink()
    || !candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    fail("CANONICAL_SYSTEM_ROOTS_UNSAFE");
  }

  const expected = {
    updateId: String(options.updateId || "").trim(),
    manifestSha256: String(options.manifestSha256 || "").trim().toLowerCase(),
  };
  if (!expected.updateId || !/^[a-f0-9]{64}$/u.test(expected.manifestSha256)) {
    fail("CANONICAL_SYSTEM_UPDATE_BINDING_INVALID");
  }
  const candidateReceipt = validateProgramSlotReceipt(options.candidateReceipt, expected);
  validateConfirmation(options.confirmation, expected, candidateReceipt);
  const holdId = canonicalHoldId(options.holdId, expected.updateId, expected.manifestSha256);
  const paths = canonicalSystemCommitPaths({ installationRoot, holdId });
  const desiredFiles = await candidateManagedFiles(candidateProgramRoot, candidateReceipt);

  return withCommitLock(paths.lockPath, async () => {
    const context = {
      paths,
      expected,
      holdId,
      installationRoot,
      candidateReceipt,
      desiredFiles,
    };
    await recoverInterruptedPreviousRotation(context);
    let published = await readPublishedPrevious(context);
    if (!published || published.kind === "previous" || published.kind === "previous-layout-migration") {
      // A completed earlier update may have left only this hidden retirement
      // cleanup pending because Windows still held a file. Retry it before
      // rotating again; failure remains pre-mutation and therefore safe.
      if (await lstatOrNull(paths.retiredRoot)) {
        await removeOwnedBackupDirectory(
          paths.retiredRoot,
          paths.backupRoot,
          "previous-backup-retired",
        ).catch(() => undefined);
      }
      const preparedIntent = await prepareIntent({
        installationRoot,
        candidateReceipt,
        desiredFiles,
        expected,
        holdId,
        paths,
        now: options.now,
      });
      await options.testHooks?.afterIntentCommitted?.({ intent: preparedIntent, paths });
      await publishPreparedPrevious(paths);
      published = await readPublishedPrevious(context);
    }
    if (!published || published.kind !== "current") {
      fail("CANONICAL_SYSTEM_PREVIOUS_BACKUP_NOT_PUBLISHED", holdId);
    }
    const { intent } = published;
    const existingReceipt = published.receipt;
    // The absolute path is deliberately not serialized. It is derived again
    // only after the installation-root binding on the checksummed intent passed.
    const executableIntent = { ...intent, absoluteInstallationRoot: installationRoot };
    if (existingReceipt) {
      const receipt = validateCommitReceipt(existingReceipt, intent);
      const finalTreeSha256 = await verifyCanonicalResult(installationRoot, desiredFiles);
      if (receipt.finalManagedTreeSha256 !== finalTreeSha256) {
        fail("CANONICAL_SYSTEM_RECEIPT_FINAL_TREE_MISMATCH", holdId);
      }
      const cleanup = await cleanupRotationArtifactsBestEffort(
        paths,
        options.testHooks?.removeBackupDirectory || fs.rm,
      );
      return { ok: true, idempotent: true, recovered: false, holdId, paths, intent, receipt, ...cleanup };
    }

    await preflightCanonicalState(installationRoot, desiredFiles, intent.operations);
    await preflightOperationStates(executableIntent, paths.transactionRoot, intent.operations);

    for (const operation of intent.operations) {
      await applyOperation(executableIntent, paths.transactionRoot, candidateProgramRoot, operation);
      await options.testHooks?.afterOperationApplied?.({ intent, operation, paths });
    }

    const finalManagedTreeSha256 = await verifyCanonicalResult(installationRoot, desiredFiles);
    await options.testHooks?.beforeReceiptWritten?.({ intent, paths });
    const committedAt = isoNow(options.now);
    const receiptBase = {
      schemaVersion: SCHEMA_VERSION,
      kind: RECEIPT_KIND,
      transactionId: intent.transactionId,
      holdId,
      committedAt,
      retainUntil: intent.retainUntil,
      intentSha256: intent.intentSha256,
      candidate: intent.candidate,
      operationCount: intent.operations.length,
      backupCount: intent.operations.filter((operation) => operation.backup).length,
      finalManagedTreeSha256,
    };
    const receipt = documentWithChecksum(receiptBase, "receiptSha256");
    await atomicWriteJson(paths.receiptPath, receipt);
    const cleanup = await cleanupRotationArtifactsBestEffort(
      paths,
      options.testHooks?.removeBackupDirectory || fs.rm,
    );
    return {
      ok: true,
      idempotent: false,
      recovered: Boolean(options.recovery === true),
      holdId,
      paths,
      intent,
      receipt,
      ...cleanup,
    };
  });
}

export async function recoverCanonicalSystemCommit(options = {}) {
  return commitCanonicalSystem({ ...options, recovery: true });
}

export const canonicalSystemCommitContract = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  managedRoots: MANAGED_ROOTS,
  minimumBackupRetentionDays: MINIMUM_BACKUP_RETENTION_DAYS,
});
