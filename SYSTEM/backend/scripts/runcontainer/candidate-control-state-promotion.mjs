import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const SOURCE_UPDATE_SCHEMA = "bonni.local-source-update/v1";
const LIFECYCLE_SCHEMA = "bonni.local-source-deployment-lifecycle/v1";
const INTENT_SCHEMA = "bonni.candidate-control-state-promotion-intent/v1";
const RECEIPT_SCHEMA = "bonni.candidate-control-state-promotion-receipt/v1";
const PROMOTION_DIRECTORY = "candidate-control-state-promotion";
const INTENT_FILE = "intent.json";
const RECEIPT_FILE = "receipt.json";
const WORK_DIRECTORY = "work";
const LOCK_DIRECTORY = ".lock";
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TREE_FILES = 20_000;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const HOLD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const TRANSACTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/u;
const MANAGED_COMPONENTS = new Set([
  "SYSTEM/backend",
  "SYSTEM/frontend",
  "SYSTEM/app/kontorapp",
]);

export class CandidateControlStatePromotionError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CandidateControlStatePromotionError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new CandidateControlStatePromotionError(code, detail);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function valueSha256(value) {
  return sha256(stableStringify(value));
}

// local-source-update.mjs binds hold metadata to the parsed predecessor with
// JSON.stringify (property order included). Keep that existing wire contract
// separate from the canonical hashes used by this promotion transaction.
function jsonValueSha256(value) {
  return sha256(JSON.stringify(value));
}

function isoTimestamp(value, label) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("CANDIDATE_CONTROL_PROMOTION_TIMESTAMP_INVALID", label);
  }
  return value;
}

function exactIdentity(updateId, manifestSha256) {
  const normalizedId = String(updateId || "");
  const normalizedHash = String(manifestSha256 || "").toLowerCase();
  if (!UPDATE_ID.test(normalizedId)) fail("CANDIDATE_CONTROL_PROMOTION_UPDATE_ID_INVALID");
  if (!SHA256.test(normalizedHash)) fail("CANDIDATE_CONTROL_PROMOTION_MANIFEST_SHA256_INVALID");
  return { updateId: normalizedId, manifestSha256: normalizedHash };
}

function canonicalRelative(value, label = "path") {
  const raw = String(value ?? "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/u.test(raw) || raw.includes("\0")) {
    fail("CANDIDATE_CONTROL_PROMOTION_PATH_INVALID", label);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))) {
    fail("CANDIDATE_CONTROL_PROMOTION_PATH_INVALID", `${label}:${raw}`);
  }
  return segments.join("/");
}

function pathInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowEqual && relative === "")
    || (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function now(options) {
  const value = typeof options.now === "function" ? options.now() : Date.now();
  return new Date(value).toISOString();
}

function uniqueId() {
  return `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
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
    const state = await lstatOrNull(cursor);
    if (!state) return;
    if (state.isSymbolicLink()) fail("CANDIDATE_CONTROL_PROMOTION_SYMLINK_FORBIDDEN", `${label}:${cursor}`);
  }
}

async function ensureSafeDirectory(target, label) {
  await assertNoSymlinkComponents(path.dirname(target), `${label}-parent`);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(target, label);
  const state = await fs.lstat(target);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_DIRECTORY_UNSAFE", label);
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
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(target, content, mode = 0o600) {
  const directory = path.dirname(target);
  await ensureSafeDirectory(directory, "atomic-parent");
  const existing = await lstatOrNull(target);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) {
    fail("CANDIDATE_CONTROL_PROMOTION_ATOMIC_TARGET_UNSAFE", target);
  }
  const temporary = path.join(directory, `.${path.basename(target)}.${uniqueId()}.tmp`);
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      mode,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJsonAtomic(target, value) {
  await atomicWrite(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function readSafeFile(target, code, maximumBytes = MAX_JSON_BYTES) {
  const state = await lstatOrNull(target);
  if (!state) return null;
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1 || state.size > maximumBytes) {
    fail(code, target);
  }
  const bytes = await fs.readFile(target);
  return { bytes, sha256: sha256(bytes), state };
}

async function readSafeJson(target, code, { required = false } = {}) {
  const file = await readSafeFile(target, code);
  if (!file) {
    if (required) fail(code, target);
    return null;
  }
  try {
    return { ...file, value: JSON.parse(file.bytes.toString("utf8")) };
  } catch {
    fail(code, target);
  }
}

async function sha256File(target) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(target, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.nlink > 1) fail("CANDIDATE_CONTROL_PROMOTION_FILE_UNSAFE", target);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function secureCopyFile(source, destination, relativeLabel) {
  const before = await fs.lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
    fail("CANDIDATE_CONTROL_PROMOTION_FILE_UNSAFE", relativeLabel);
  }
  await ensureSafeDirectory(path.dirname(destination), "copy-parent");
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.nlink > 1) {
      fail("CANDIDATE_CONTROL_PROMOTION_FILE_UNSAFE", relativeLabel);
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
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          chunk,
          offset,
          bytesRead - offset,
          position + offset,
        );
        if (bytesWritten <= 0) fail("CANDIDATE_CONTROL_PROMOTION_COPY_FAILED", relativeLabel);
        offset += bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat();
    if (
      after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || (opened.ino && after.ino !== opened.ino)
    ) fail("CANDIDATE_CONTROL_PROMOTION_SOURCE_CHANGED", relativeLabel);
    return { path: relativeLabel, size: position, sha256: hash.digest("hex") };
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }
}

function treeSha256(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function inventoryTree(root, { copyTo = null } = {}) {
  const rootState = await fs.lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_TREE_UNSAFE", root);
  }
  if (copyTo) await ensureSafeDirectory(copyTo, "tree-copy-root");
  const files = [];
  let totalBytes = 0;
  async function visit(relativeDirectory) {
    const sourceDirectory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split("/"))
      : root;
    const destinationDirectory = copyTo
      ? (relativeDirectory ? path.join(copyTo, ...relativeDirectory.split("/")) : copyTo)
      : null;
    if (destinationDirectory) await ensureSafeDirectory(destinationDirectory, "tree-copy-directory");
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = canonicalRelative(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        "tree-entry",
      );
      const source = path.join(sourceDirectory, entry.name);
      const state = await fs.lstat(source);
      if (state.isSymbolicLink()) fail("CANDIDATE_CONTROL_PROMOTION_SYMLINK_FORBIDDEN", relative);
      if (state.isDirectory()) {
        await visit(relative);
        continue;
      }
      if (!state.isFile() || state.nlink > 1) {
        fail("CANDIDATE_CONTROL_PROMOTION_FILE_UNSAFE", relative);
      }
      if (files.length >= MAX_TREE_FILES || totalBytes + state.size > MAX_TREE_BYTES) {
        fail("CANDIDATE_CONTROL_PROMOTION_TREE_TOO_LARGE");
      }
      const record = destinationDirectory
        ? await secureCopyFile(source, path.join(destinationDirectory, entry.name), relative)
        : { path: relative, size: state.size, sha256: await sha256File(source) };
      files.push(record);
      totalBytes += record.size;
    }
  }
  await visit("");
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { files, fileCount: files.length, totalBytes, treeSha256: treeSha256(files) };
}

function validateVersionObject(value, label) {
  if (!isPlainObject(value) || !VERSION.test(String(value.coreVersion || "")) || !VERSION.test(String(value.kontorAppVersion || ""))) {
    fail("CANDIDATE_CONTROL_PROMOTION_VERSION_INVALID", label);
  }
}

function validateLifecycleMarker(value, label) {
  if (value === undefined) return false;
  if (
    !isPlainObject(value)
    || value.schemaVersion !== LIFECYCLE_SCHEMA
    || value.mode !== "local-source"
    || value.required !== true
  ) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_MARKER_INVALID", label);
  return true;
}

function validateActiveDocument(value, identity, label) {
  if (
    !isPlainObject(value)
    || value.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || value.updateId !== identity.updateId
    || value.manifestSha256 !== identity.manifestSha256
    || !Array.isArray(value.components)
    || !Array.isArray(value.files)
  ) fail("CANDIDATE_CONTROL_PROMOTION_ACTIVE_INVALID", label);
  isoTimestamp(value.completedAt, `${label}.completedAt`);
  validateVersionObject(value.versions, `${label}.versions`);
  const lifecycleRequired = validateLifecycleMarker(value.localDeploymentLifecycle, `${label}.localDeploymentLifecycle`);
  const componentPaths = new Set();
  for (const [index, component] of value.components.entries()) {
    const componentPath = canonicalRelative(component?.path, `${label}.components[${index}]`);
    const key = componentPath.toLocaleLowerCase("en-US");
    if (
      !isPlainObject(component)
      || component.mode !== "managed"
      || typeof component.key !== "string"
      || !MANAGED_COMPONENTS.has(componentPath)
      || componentPaths.has(key)
    ) fail("CANDIDATE_CONTROL_PROMOTION_ACTIVE_INVALID", `${label}.components[${index}]`);
    componentPaths.add(key);
  }
  const filePaths = new Set();
  for (const [index, file] of value.files.entries()) {
    const filePath = canonicalRelative(file?.path, `${label}.files[${index}]`);
    const key = filePath.toLocaleLowerCase("en-US");
    if (
      !isPlainObject(file)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
      || !SHA256.test(String(file.sha256 || ""))
      || ![...componentPaths].some((component) => key === component || key.startsWith(`${component}/`))
      || filePaths.has(key)
    ) fail("CANDIDATE_CONTROL_PROMOTION_ACTIVE_INVALID", `${label}.files[${index}]`);
    filePaths.add(key);
  }
  return { lifecycleRequired };
}

function activeSnapshot(value) {
  return {
    schemaVersion: value.schemaVersion,
    updateId: value.updateId,
    manifestSha256: value.manifestSha256,
    completedAt: value.completedAt,
    versions: value.versions,
    ...(value.localDeploymentLifecycle === undefined
      ? {}
      : { localDeploymentLifecycle: value.localDeploymentLifecycle }),
    components: value.components,
    files: value.files,
  };
}

function validateHistoryDocument(value, active, identity) {
  validateActiveDocument(value, identity, "candidate-history");
  if (value.status !== "COMPLETED" || stableStringify(activeSnapshot(value)) !== stableStringify(activeSnapshot(active))) {
    fail("CANDIDATE_CONTROL_PROMOTION_HISTORY_MISMATCH", identity.updateId);
  }
  const metadata = value.updateMetadata;
  if (metadata !== undefined && metadata !== null) {
    if (!isPlainObject(metadata)) fail("CANDIDATE_CONTROL_PROMOTION_HISTORY_INVALID", "updateMetadata");
    validateVersionObject(metadata.from, "candidate-history.updateMetadata.from");
    validateVersionObject(metadata.to, "candidate-history.updateMetadata.to");
    if (stableStringify(metadata.to) !== stableStringify(active.versions)) {
      fail("CANDIDATE_CONTROL_PROMOTION_HISTORY_MISMATCH", "versions");
    }
  }
  return {
    coreTransition: Boolean(
      metadata?.from?.coreVersion
      && metadata?.to?.coreVersion
      && metadata.from.coreVersion !== metadata.to.coreVersion
    ),
    fromVersion: metadata?.from?.coreVersion || null,
  };
}

function validateLifecycle(value, active, identity) {
  if (!isPlainObject(value)) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_INVALID");
  const activatedAt = Date.parse(String(value.activatedAt || ""));
  const holdUntil = Date.parse(String(value.holdUntil || ""));
  if (
    value.schemaVersion !== LIFECYCLE_SCHEMA
    || value.protocol !== "bonni-deployment-lifecycle/1"
    || value.mode !== "local-source"
    || !["holding", "rolling-back", "rolled-back", "finalized"].includes(value.status)
    || value.state !== value.status
    || !Number.isSafeInteger(value.generation)
    || value.generation <= 0
    || !HOLD_ID.test(String(value.holdId || ""))
    || value.holdDays !== 14
    || !Number.isFinite(activatedAt)
    || !Number.isFinite(holdUntil)
    || holdUntil - activatedAt !== 14 * 24 * 60 * 60_000
    || !VERSION.test(String(value.previousVersion || ""))
    || !VERSION.test(String(value.targetVersion || ""))
    || !VERSION.test(String(value.activeVersion || ""))
    || !UPDATE_ID.test(String(value.sourceUpdateId || ""))
    || !SHA256.test(String(value.sourceManifestSha256 || ""))
    || !UPDATE_ID.test(String(value.rollbackUpdateId || ""))
    || !SHA256.test(String(value.rollbackManifestSha256 || ""))
    || value.holdPath !== `deployment-holds/${value.holdId}`
    || typeof value.blocksUpdates !== "boolean"
    || typeof value.followUpdatesBlocked !== "boolean"
    || typeof value.canFinalize !== "boolean"
    || typeof value.canRollback !== "boolean"
    || (value.rollbackIntentId !== undefined
      && value.rollbackIntentId !== null
      && !HOLD_ID.test(String(value.rollbackIntentId)))
  ) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_INVALID");
  const forward = value.sourceUpdateId === identity.updateId
    && value.sourceManifestSha256 === identity.manifestSha256;
  const rollback = value.rollbackUpdateId === identity.updateId
    && value.rollbackManifestSha256 === identity.manifestSha256;
  if (!forward && !rollback) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_IDENTITY_MISMATCH");
  if (
    (forward && active.versions.coreVersion !== value.targetVersion)
    || (rollback && value.status === "rolled-back" && active.versions.coreVersion !== value.previousVersion)
  ) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_ACTIVE_MISMATCH");
  if (
    (value.status === "holding" && (
      !forward
      || value.activeVersion !== value.targetVersion
      || !value.blocksUpdates
      || !value.followUpdatesBlocked
      || !value.canFinalize
      || !value.canRollback
      || typeof value.blockReason !== "string"
      || !value.blockReason
    ))
    || (value.status === "rolling-back" && (
      value.activeVersion !== value.targetVersion
      || !value.blocksUpdates
      || !value.followUpdatesBlocked
      || value.canFinalize
      || value.canRollback
      || typeof value.blockReason !== "string"
      || !value.blockReason
      || !Number.isFinite(Date.parse(String(value.rollbackRequestedAt || "")))
    ))
    || (value.status === "finalized" && (
      !forward
      || value.activeVersion !== value.targetVersion
      || value.blocksUpdates
      || value.followUpdatesBlocked
      || value.canFinalize
      || value.canRollback
      || value.blockReason !== null
      || !["developer", "automatic-14-day-expiry"].includes(value.finalizeReason)
      || !Number.isFinite(Date.parse(String(value.finalizedAt || "")))
    ))
    || (value.status === "rolled-back" && (
      !rollback
      || value.activeVersion !== value.previousVersion
      || value.blocksUpdates
      || value.followUpdatesBlocked
      || value.canFinalize
      || value.canRollback
      || value.blockReason !== null
      || !Number.isFinite(Date.parse(String(value.rolledBackAt || "")))
    ))
  ) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_INVALID", value.status);
  return { value, forward, rollback, holdRequired: ["holding", "rolling-back"].includes(value.status) };
}

async function validateHold(candidateStateRoot, lifecycle, active, identity) {
  const holdRoot = path.join(candidateStateRoot, "deployment-holds", lifecycle.holdId);
  const [metadata, previousActive, rollbackManifest] = await Promise.all([
    readSafeJson(path.join(holdRoot, "hold.json"), "CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", { required: true }),
    readSafeJson(path.join(holdRoot, "previous-active-manifest.json"), "CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", { required: true }),
    readSafeJson(path.join(holdRoot, "package", "bonni-source-update.json"), "CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", { required: true }),
  ]);
  if (
    metadata.value.schemaVersion !== LIFECYCLE_SCHEMA
    || metadata.value.holdId !== lifecycle.holdId
    || metadata.value.generation !== lifecycle.generation
    || metadata.value.sourceUpdateId !== lifecycle.sourceUpdateId
    || metadata.value.sourceManifestSha256 !== lifecycle.sourceManifestSha256
    || metadata.value.rollbackUpdateId !== lifecycle.rollbackUpdateId
    || metadata.value.rollbackManifestSha256 !== lifecycle.rollbackManifestSha256
    || metadata.value.previousActiveSha256 !== jsonValueSha256(previousActive.value)
    || rollbackManifest.sha256 !== lifecycle.rollbackManifestSha256
    || rollbackManifest.value.updateId !== lifecycle.rollbackUpdateId
    || rollbackManifest.value.requires?.updateId !== identity.updateId
    || rollbackManifest.value.requires?.manifestSha256 !== identity.manifestSha256
    || rollbackManifest.value.from?.coreVersion !== active.versions.coreVersion
    || rollbackManifest.value.to?.coreVersion !== lifecycle.previousVersion
  ) fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", lifecycle.holdId);
  const inventory = await inventoryTree(holdRoot);
  const rollbackComponents = new Set();
  if (
    rollbackManifest.value.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || rollbackManifest.value.status !== "UNPUBLISHED_TEST_UPDATE"
    || rollbackManifest.value.channel !== "development"
    || rollbackManifest.value.payloadLayout !== "content-addressed-delta-v1"
    || !Array.isArray(rollbackManifest.value.components)
    || !rollbackManifest.value.components.length
    || !Array.isArray(rollbackManifest.value.files)
    || !Array.isArray(rollbackManifest.value.delete)
  ) fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", "rollback-manifest");
  for (const [index, component] of rollbackManifest.value.components.entries()) {
    const componentPath = canonicalRelative(component?.path, `rollback.components[${index}]`);
    const key = componentPath.toLocaleLowerCase("en-US");
    if (
      !isPlainObject(component)
      || component.mode !== "managed"
      || typeof component.key !== "string"
      || !MANAGED_COMPONENTS.has(componentPath)
      || rollbackComponents.has(key)
    ) fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", `rollback.components[${index}]`);
    rollbackComponents.add(key);
  }
  const payloadObjects = new Map();
  const rollbackPaths = new Set();
  for (const [index, file] of rollbackManifest.value.files.entries()) {
    const filePath = canonicalRelative(file?.path, `rollback.files[${index}]`);
    const pathKey = filePath.toLocaleLowerCase("en-US");
    if (
      !isPlainObject(file)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
      || !SHA256.test(String(file.sha256 || ""))
      || (file.expectedPreviousSha256 !== null
        && !SHA256.test(String(file.expectedPreviousSha256 || "")))
      || ![...rollbackComponents].some(
        (component) => pathKey === component || pathKey.startsWith(`${component}/`),
      )
      || rollbackPaths.has(pathKey)
    ) fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", `rollback.files[${index}]`);
    rollbackPaths.add(pathKey);
    if (file.expectedPreviousSha256 !== file.sha256) {
      const objectName = `${file.sha256}.bin`;
      const existing = payloadObjects.get(objectName);
      if (existing && (existing.sha256 !== file.sha256 || existing.sizeBytes !== file.sizeBytes)) {
        fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", "payload-collision");
      }
      payloadObjects.set(objectName, { sha256: file.sha256, sizeBytes: file.sizeBytes });
    }
  }
  for (const [index, deletion] of rollbackManifest.value.delete.entries()) {
    const deletePath = canonicalRelative(deletion?.path, `rollback.delete[${index}]`);
    const pathKey = deletePath.toLocaleLowerCase("en-US");
    if (
      !isPlainObject(deletion)
      || !SHA256.test(String(deletion.expectedSha256 || ""))
      || typeof deletion.reason !== "string"
      || !deletion.reason.trim()
      || ![...rollbackComponents].some(
        (component) => pathKey === component || pathKey.startsWith(`${component}/`),
      )
      || rollbackPaths.has(pathKey)
    ) fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", `rollback.delete[${index}]`);
    rollbackPaths.add(pathKey);
  }
  const expectedHoldFiles = new Set([
    "hold.json",
    "previous-active-manifest.json",
    "package/bonni-source-update.json",
    ...[...payloadObjects.keys()].map((objectName) => `package/payload/${objectName}`),
  ]);
  if (
    inventory.files.length !== expectedHoldFiles.size
    || inventory.files.some((file) => !expectedHoldFiles.has(file.path))
  ) fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", "unexpected-file");
  for (const [objectName, expected] of payloadObjects) {
    const file = inventory.files.find((entry) => entry.path === `package/payload/${objectName}`);
    if (!file || file.size !== expected.sizeBytes || file.sha256 !== expected.sha256) {
      fail("CANDIDATE_CONTROL_PROMOTION_HOLD_INVALID", `payload:${objectName}`);
    }
  }
  return {
    root: holdRoot,
    metadata: metadata.value,
    previousActive: previousActive.value,
    inventory,
  };
}

async function exactHistoryPath(stateRoot, updateId) {
  const directory = path.join(stateRoot, "history");
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const expected = `${updateId}.json`.toLocaleLowerCase("en-US");
  const matches = entries.filter((entry) => entry.name.toLocaleLowerCase("en-US") === expected);
  if (matches.length !== 1 || !matches[0].isFile() || matches[0].isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_HISTORY_MISSING", updateId);
  }
  return path.join(directory, matches[0].name);
}

async function readCandidateBundle(candidateProductRoot, identity) {
  const candidateRoot = path.resolve(candidateProductRoot);
  const stateRoot = path.join(candidateRoot, "SYSTEM", ".bonni-source-update");
  await assertNoSymlinkComponents(stateRoot, "candidate-state-root");
  const state = await fs.lstat(stateRoot).catch(() => null);
  if (!state?.isDirectory() || state.isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_CANDIDATE_STATE_MISSING");
  }
  const historyPath = await exactHistoryPath(stateRoot, identity.updateId);
  const [active, history, lifecycleFile] = await Promise.all([
    readSafeJson(path.join(stateRoot, "active-manifest.json"), "CANDIDATE_CONTROL_PROMOTION_ACTIVE_INVALID", { required: true }),
    readSafeJson(historyPath, "CANDIDATE_CONTROL_PROMOTION_HISTORY_INVALID", { required: true }),
    readSafeJson(path.join(stateRoot, "deployment-lifecycle.json"), "CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_INVALID"),
  ]);
  const activeValidation = validateActiveDocument(active.value, identity, "candidate-active");
  const historyValidation = validateHistoryDocument(history.value, active.value, identity);
  let lifecycle = null;
  let hold = null;
  if (activeValidation.lifecycleRequired || lifecycleFile) {
    if (!lifecycleFile) fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_MISSING");
    const validated = validateLifecycle(lifecycleFile.value, active.value, identity);
    if (!activeValidation.lifecycleRequired && !validated.rollback) {
      fail("CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_UNBOUND");
    }
    lifecycle = { ...lifecycleFile, ...validated };
    if (validated.holdRequired) {
      hold = await validateHold(stateRoot, validated.value, active.value, identity);
    }
  }
  if (historyValidation.coreTransition && !lifecycle) {
    fail(activeValidation.lifecycleRequired
      ? "CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_MISSING"
      : "CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_MARKER_MISSING");
  }
  return {
    candidateRoot,
    stateRoot,
    active,
    history,
    historyPath,
    lifecycle,
    hold,
    historyValidation,
  };
}

function promotionPaths(installationRoot) {
  const root = path.resolve(installationRoot);
  const stateRoot = path.join(root, "SYSTEM", ".bonni-source-update");
  const promotionRoot = path.join(stateRoot, PROMOTION_DIRECTORY);
  return {
    installationRoot: root,
    stateRoot,
    promotionRoot,
    intentPath: path.join(promotionRoot, INTENT_FILE),
    receiptPath: path.join(promotionRoot, RECEIPT_FILE),
    workRoot: path.join(promotionRoot, WORK_DIRECTORY),
    lockPath: path.join(promotionRoot, LOCK_DIRECTORY),
  };
}

function checksumDocument(value, checksumKey) {
  const { [checksumKey]: _ignored, ...base } = value;
  return sha256(stableStringify(base));
}

function withChecksum(value, checksumKey) {
  return { ...value, [checksumKey]: checksumDocument(value, checksumKey) };
}

function validateReceipt(value) {
  const publishedValid = value?.outcome === "committed"
    ? isPlainObject(value.published)
      && SHA256.test(String(value.published.activeSha256 || ""))
      && SHA256.test(String(value.published.historySha256 || ""))
      && (value.published.lifecycleSha256 === null
        || SHA256.test(String(value.published.lifecycleSha256 || "")))
      && (value.published.holdTreeSha256 === null
        || SHA256.test(String(value.published.holdTreeSha256 || "")))
      && (value.published.holdId === null || HOLD_ID.test(String(value.published.holdId || "")))
    : value?.published === null;
  if (
    !isPlainObject(value)
    || value.schemaVersion !== RECEIPT_SCHEMA
    || !Number.isSafeInteger(value.generation)
    || value.generation <= 0
    || !TRANSACTION_ID.test(String(value.transactionId || ""))
    || !["committed", "rolled-back"].includes(value.outcome)
    || !UPDATE_ID.test(String(value.updateId || ""))
    || !SHA256.test(String(value.manifestSha256 || ""))
    || !SHA256.test(String(value.intentSha256 || ""))
    || !SHA256.test(String(value.receiptSha256 || ""))
    || checksumDocument(value, "receiptSha256") !== value.receiptSha256
    || !publishedValid
    || (value.outcome === "committed"
      && ((value.published.holdTreeSha256 === null) !== (value.published.holdId === null)))
  ) fail("CANDIDATE_CONTROL_PROMOTION_RECEIPT_INVALID");
  isoTimestamp(value.completedAt, "promotion-receipt.completedAt");
  return value;
}

function validateIntent(value) {
  const validBackupFile = (entry) => isPlainObject(entry)
    && entry.kind === "file"
    && typeof entry.present === "boolean"
    && (entry.present ? SHA256.test(String(entry.sha256 || "")) : entry.sha256 === null);
  const validBackupTree = (entry) => isPlainObject(entry)
    && entry.kind === "tree"
    && typeof entry.present === "boolean"
    && (entry.present ? SHA256.test(String(entry.treeSha256 || "")) : entry.treeSha256 === null);
  if (
    !isPlainObject(value)
    || value.schemaVersion !== INTENT_SCHEMA
    || !Number.isSafeInteger(value.generation)
    || value.generation <= 0
    || !TRANSACTION_ID.test(String(value.transactionId || ""))
    || !UPDATE_ID.test(String(value.updateId || ""))
    || !SHA256.test(String(value.manifestSha256 || ""))
    || !["prepared", "active-published", "history-published", "lifecycle-published", "hold-published", "committing", "rolling-back"].includes(value.phase)
    || !SHA256.test(String(value.intentSha256 || ""))
    || checksumDocument(value, "intentSha256") !== value.intentSha256
    || !isPlainObject(value.source)
    || !SHA256.test(String(value.source.activeSha256 || ""))
    || !SHA256.test(String(value.source.historySha256 || ""))
    || (value.source.lifecycleSha256 !== null && !SHA256.test(String(value.source.lifecycleSha256 || "")))
    || (value.source.holdTreeSha256 !== null && !SHA256.test(String(value.source.holdTreeSha256 || "")))
    || !isPlainObject(value.backup)
    || !validBackupFile(value.backup.active)
    || !validBackupFile(value.backup.history)
    || !validBackupFile(value.backup.lifecycle)
    || !validBackupTree(value.backup.hold)
    || typeof value.workPath !== "string"
    || ((value.source.holdTreeSha256 === null) !== (value.source.holdId === null))
    || (value.source.holdId !== null && !HOLD_ID.test(String(value.source.holdId || "")))
  ) fail("CANDIDATE_CONTROL_PROMOTION_INTENT_INVALID");
  isoTimestamp(value.createdAt, "promotion-intent.createdAt");
  const canonicalWorkPath = canonicalRelative(value.workPath, "promotion-intent.workPath");
  if (canonicalWorkPath !== `${WORK_DIRECTORY}/generation-${value.generation}-${value.transactionId}`) {
    fail("CANDIDATE_CONTROL_PROMOTION_INTENT_INVALID", "workPath-generation");
  }
  return value;
}

async function readIntent(paths) {
  const result = await readSafeJson(paths.intentPath, "CANDIDATE_CONTROL_PROMOTION_INTENT_INVALID");
  return result ? validateIntent(result.value) : null;
}

async function readReceipt(paths) {
  const result = await readSafeJson(paths.receiptPath, "CANDIDATE_CONTROL_PROMOTION_RECEIPT_INVALID");
  return result ? validateReceipt(result.value) : null;
}

async function writeIntent(paths, intent, phase = intent.phase) {
  const next = withChecksum({ ...intent, phase }, "intentSha256");
  await writeJsonAtomic(paths.intentPath, next);
  return next;
}

async function checkpoint(options, step) {
  if (typeof options.onCheckpoint === "function") await options.onCheckpoint(step);
  if (options.simulateCrashAfter === step) {
    const error = new CandidateControlStatePromotionError(
      "CANDIDATE_CONTROL_PROMOTION_SIMULATED_CRASH",
      step,
    );
    error.simulatedCrash = true;
    throw error;
  }
  if (options.failAfter === step) {
    fail("CANDIDATE_CONTROL_PROMOTION_INJECTED_FAILURE", step);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLockOwner(lockPath) {
  const lockState = await lstatOrNull(lockPath);
  if (!lockState?.isDirectory() || lockState.isSymbolicLink()) return null;
  const owner = await readSafeJson(
    path.join(lockPath, "owner.json"),
    "CANDIDATE_CONTROL_PROMOTION_LOCK_UNSAFE",
  );
  if (
    !owner
    || !isPlainObject(owner.value)
    || !Number.isSafeInteger(owner.value.pid)
    || owner.value.pid <= 0
    || !TRANSACTION_ID.test(String(owner.value.token || ""))
  ) return null;
  isoTimestamp(owner.value.startedAt, "promotion-lock.startedAt");
  return owner.value;
}

async function acquireLock(paths) {
  await ensureSafeDirectory(paths.promotionRoot, "promotion-root");
  const token = crypto.randomUUID();
  const temporaryLock = path.join(paths.promotionRoot, `.lock-${token}`);
  await fs.mkdir(temporaryLock, { mode: 0o700 });
  await writeJsonAtomic(path.join(temporaryLock, "owner.json"), {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  });
  try {
    await fs.rename(temporaryLock, paths.lockPath);
    await syncDirectory(paths.promotionRoot);
    return { token };
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
  } finally {
    await fs.rm(temporaryLock, { recursive: true, force: true }).catch(() => {});
  }

  const observed = await readLockOwner(paths.lockPath);
  if (!observed || processIsAlive(observed.pid)) {
    fail("CANDIDATE_CONTROL_PROMOTION_LOCKED");
  }
  const stalePath = path.join(paths.promotionRoot, `.stale-lock-${observed.token}`);
  try {
    await fs.rename(paths.lockPath, stalePath);
  } catch (error) {
    if (error?.code === "ENOENT") return acquireLock(paths);
    throw error;
  }
  const moved = await readLockOwner(stalePath);
  if (!moved || moved.token !== observed.token || moved.pid !== observed.pid) {
    // A changed lock is never deleted. Put it back when possible and stop.
    if (!await lstatOrNull(paths.lockPath)) await fs.rename(stalePath, paths.lockPath).catch(() => {});
    fail("CANDIDATE_CONTROL_PROMOTION_LOCK_UNSAFE");
  }
  await fs.rm(stalePath, { recursive: true, force: true });
  await syncDirectory(paths.promotionRoot);
  return acquireLock(paths);
}

async function releaseLock(paths, ownership) {
  const owner = await readLockOwner(paths.lockPath).catch(() => null);
  if (!owner || owner.token !== ownership?.token || owner.pid !== process.pid) return;
  await fs.rm(paths.lockPath, { recursive: true, force: true });
  await syncDirectory(paths.promotionRoot);
}

async function centralFileSnapshot(source, backupTarget, label) {
  const state = await lstatOrNull(source);
  if (!state) return { present: false, kind: "file", sha256: null };
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
    fail("CANDIDATE_CONTROL_PROMOTION_CENTRAL_STATE_UNSAFE", label);
  }
  const copied = await secureCopyFile(source, backupTarget, label);
  return { present: true, kind: "file", sha256: copied.sha256 };
}

async function centralTreeSnapshot(source, backupTarget, label) {
  const state = await lstatOrNull(source);
  if (!state) return { present: false, kind: "tree", treeSha256: null };
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_CENTRAL_STATE_UNSAFE", label);
  }
  const inventory = await inventoryTree(source, { copyTo: backupTarget });
  return { present: true, kind: "tree", treeSha256: inventory.treeSha256 };
}

async function validateCentralGeneration(paths, bundle, identity) {
  const centralHistoryDirectory = path.join(paths.stateRoot, "history");
  const centralHistoryEntries = await fs.readdir(centralHistoryDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const expectedHistoryName = `${identity.updateId}.json`;
  const caseMatches = centralHistoryEntries.filter(
    (entry) => entry.name.toLocaleLowerCase("en-US") === expectedHistoryName.toLocaleLowerCase("en-US"),
  );
  if (
    caseMatches.length > 1
    || (caseMatches.length === 1
      && (!caseMatches[0].isFile() || caseMatches[0].isSymbolicLink() || caseMatches[0].name !== expectedHistoryName))
  ) fail("CANDIDATE_CONTROL_PROMOTION_HISTORY_COLLISION", identity.updateId);
  const centralActive = await readSafeJson(
    path.join(paths.stateRoot, "active-manifest.json"),
    "CANDIDATE_CONTROL_PROMOTION_CENTRAL_ACTIVE_INVALID",
  );
  const centralHistory = await readSafeJson(
    path.join(centralHistoryDirectory, expectedHistoryName),
    "CANDIDATE_CONTROL_PROMOTION_CENTRAL_HISTORY_INVALID",
  );
  if (centralHistory && valueSha256(centralHistory.value) !== valueSha256(bundle.history.value)) {
    fail("CANDIDATE_CONTROL_PROMOTION_HISTORY_COLLISION", identity.updateId);
  }
  const centralLifecycle = await readSafeJson(
    path.join(paths.stateRoot, "deployment-lifecycle.json"),
    "CANDIDATE_CONTROL_PROMOTION_CENTRAL_LIFECYCLE_INVALID",
  );
  if (bundle.lifecycle) {
    const sameLifecycle = centralLifecycle
      && valueSha256(centralLifecycle.value) === valueSha256(bundle.lifecycle.value);
    if (!sameLifecycle) {
      const previousGeneration = centralLifecycle?.value?.generation;
      const sameLifecycleFamily = centralLifecycle
        && bundle.lifecycle.value.generation === previousGeneration
        && [
          "holdId",
          "previousVersion",
          "targetVersion",
          "sourceUpdateId",
          "sourceManifestSha256",
          "rollbackUpdateId",
          "rollbackManifestSha256",
          "holdPath",
        ].every((key) => centralLifecycle.value[key] === bundle.lifecycle.value[key]);
      const validSameGenerationTransition = sameLifecycleFamily && (
        (centralLifecycle.value.status === "holding"
          && ["rolling-back", "rolled-back", "finalized"].includes(bundle.lifecycle.value.status))
        || (centralLifecycle.value.status === "rolling-back"
          && bundle.lifecycle.value.status === "rolled-back")
      );
      const expectedGeneration = Number.isSafeInteger(previousGeneration) ? previousGeneration + 1 : 1;
      if (!validSameGenerationTransition && bundle.lifecycle.value.generation !== expectedGeneration) {
        fail(
          "CANDIDATE_CONTROL_PROMOTION_LIFECYCLE_GENERATION_MISMATCH",
          `${bundle.lifecycle.value.generation}:${expectedGeneration}`,
        );
      }
    }
  }
  const centralAlreadyTarget = centralActive
    && valueSha256(centralActive.value) === valueSha256(bundle.active.value);
  if (!centralAlreadyTarget && bundle.hold) {
    if (jsonValueSha256(centralActive?.value ?? null) !== bundle.hold.metadata.previousActiveSha256) {
      fail("CANDIDATE_CONTROL_PROMOTION_PREDECESSOR_MISMATCH", identity.updateId);
    }
  } else if (!centralAlreadyTarget && bundle.historyValidation.fromVersion) {
    if (centralActive?.value?.versions?.coreVersion !== bundle.historyValidation.fromVersion) {
      fail("CANDIDATE_CONTROL_PROMOTION_PREDECESSOR_MISMATCH", identity.updateId);
    }
  }
  return { centralActive, centralHistory, centralLifecycle, centralAlreadyTarget };
}

async function prepareIntent(paths, bundle, identity, previousReceipt, options) {
  await validateCentralGeneration(paths, bundle, identity);
  const generation = Number(previousReceipt?.generation || 0) + 1;
  const transactionId = crypto.randomUUID();
  const workName = `generation-${generation}-${transactionId}`;
  const workRoot = path.join(paths.workRoot, workName);
  const stageRoot = path.join(workRoot, "stage");
  const backupRoot = path.join(workRoot, "backup");
  let visibleIntent = null;
  await ensureSafeDirectory(stageRoot, "promotion-stage");
  await ensureSafeDirectory(backupRoot, "promotion-backup");
  try {
    const activeCopy = await secureCopyFile(
      path.join(bundle.stateRoot, "active-manifest.json"),
      path.join(stageRoot, "active-manifest.json"),
      "active-manifest.json",
    );
    const historyCopy = await secureCopyFile(
      bundle.historyPath,
      path.join(stageRoot, "history.json"),
      `history/${identity.updateId}.json`,
    );
    let lifecycleCopy = null;
    if (bundle.lifecycle) {
      lifecycleCopy = await secureCopyFile(
        path.join(bundle.stateRoot, "deployment-lifecycle.json"),
        path.join(stageRoot, "deployment-lifecycle.json"),
        "deployment-lifecycle.json",
      );
    }
    let holdCopy = null;
    if (bundle.hold) {
      holdCopy = await inventoryTree(bundle.hold.root, { copyTo: path.join(stageRoot, "hold") });
      if (holdCopy.treeSha256 !== bundle.hold.inventory.treeSha256) {
        fail("CANDIDATE_CONTROL_PROMOTION_SOURCE_CHANGED", "deployment-hold");
      }
    }

    const centralHoldTarget = bundle.lifecycle
      ? path.join(paths.stateRoot, "deployment-holds", bundle.lifecycle.value.holdId)
      : null;
    const backup = {
      active: await centralFileSnapshot(
        path.join(paths.stateRoot, "active-manifest.json"),
        path.join(backupRoot, "active-manifest.json"),
        "central-active",
      ),
      history: await centralFileSnapshot(
        path.join(paths.stateRoot, "history", `${identity.updateId}.json`),
        path.join(backupRoot, "history.json"),
        "central-history",
      ),
      lifecycle: await centralFileSnapshot(
        path.join(paths.stateRoot, "deployment-lifecycle.json"),
        path.join(backupRoot, "deployment-lifecycle.json"),
        "central-lifecycle",
      ),
      hold: centralHoldTarget
        ? await centralTreeSnapshot(centralHoldTarget, path.join(backupRoot, "hold"), "central-hold")
        : { present: false, kind: "tree", treeSha256: null },
    };
    const intent = withChecksum({
      schemaVersion: INTENT_SCHEMA,
      generation,
      transactionId,
      updateId: identity.updateId,
      manifestSha256: identity.manifestSha256,
      phase: "prepared",
      createdAt: now(options),
      workPath: `${WORK_DIRECTORY}/${workName}`,
      source: {
        activeSha256: activeCopy.sha256,
        historySha256: historyCopy.sha256,
        lifecycleSha256: lifecycleCopy?.sha256 || null,
        holdTreeSha256: holdCopy?.treeSha256 || null,
        holdId: bundle.lifecycle?.value?.holdId || null,
      },
      backup,
    }, "intentSha256");
    await writeJsonAtomic(path.join(backupRoot, "snapshot.json"), backup);
    await writeJsonAtomic(paths.intentPath, intent);
    visibleIntent = intent;
    await checkpoint(options, "intent-written");
    return intent;
  } catch (error) {
    if (!error?.simulatedCrash && visibleIntent) {
      try {
        await rollbackIntent(paths, visibleIntent, options);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "CANDIDATE_CONTROL_PROMOTION_ROLLBACK_FAILED",
        );
      }
    } else if (!error?.simulatedCrash) {
      await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

function workPaths(paths, intent) {
  const canonical = canonicalRelative(intent.workPath, "intent.workPath");
  if (!canonical.startsWith(`${WORK_DIRECTORY}/`)) {
    fail("CANDIDATE_CONTROL_PROMOTION_INTENT_INVALID", "workPath");
  }
  const workRoot = path.join(paths.promotionRoot, ...canonical.split("/"));
  if (!pathInside(paths.workRoot, workRoot)) {
    fail("CANDIDATE_CONTROL_PROMOTION_INTENT_INVALID", "workPath");
  }
  return {
    workRoot,
    stageRoot: path.join(workRoot, "stage"),
    backupRoot: path.join(workRoot, "backup"),
  };
}

async function assertFileHash(target, expected, code) {
  const state = await lstatOrNull(target);
  if (!state?.isFile() || state.isSymbolicLink() || state.nlink > 1 || await sha256File(target) !== expected) {
    fail(code, target);
  }
}

async function publishFile(stage, target, expectedSha256, predecessor = null) {
  const current = await readSafeFile(target, "CANDIDATE_CONTROL_PROMOTION_CENTRAL_STATE_UNSAFE", MAX_TREE_BYTES);
  if (current?.sha256 === expectedSha256) return;
  if (predecessor) {
    const currentMatchesPredecessor = predecessor.present
      ? current?.sha256 === predecessor.sha256
      : current === null;
    if (!currentMatchesPredecessor) {
      fail("CANDIDATE_CONTROL_PROMOTION_PUBLISH_CONFLICT", target);
    }
  }
  await assertFileHash(stage, expectedSha256, "CANDIDATE_CONTROL_PROMOTION_STAGE_INVALID");
  const directory = path.dirname(target);
  await ensureSafeDirectory(directory, "publish-parent");
  const temporary = path.join(directory, `.${path.basename(target)}.${uniqueId()}.publish`);
  try {
    await secureCopyFile(stage, temporary, path.basename(target));
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  await assertFileHash(target, expectedSha256, "CANDIDATE_CONTROL_PROMOTION_PUBLISH_FAILED");
}

async function currentTreeMatches(target, expectedTree) {
  const state = await lstatOrNull(target);
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_CENTRAL_STATE_UNSAFE", target);
  }
  return (await inventoryTree(target)).treeSha256 === expectedTree;
}

async function publishHold(paths, intent, work) {
  if (!intent.source.holdTreeSha256) return;
  const holdId = String(intent.source.holdId || "");
  if (!HOLD_ID.test(holdId)) fail("CANDIDATE_CONTROL_PROMOTION_INTENT_INVALID", "holdId");
  const target = path.join(paths.stateRoot, "deployment-holds", holdId);
  if (await currentTreeMatches(target, intent.source.holdTreeSha256)) return;
  const stage = path.join(work.stageRoot, "hold");
  const stageState = await lstatOrNull(stage);
  if (!stageState?.isDirectory() || stageState.isSymbolicLink()) {
    fail("CANDIDATE_CONTROL_PROMOTION_STAGE_INVALID", "hold");
  }
  if ((await inventoryTree(stage)).treeSha256 !== intent.source.holdTreeSha256) {
    fail("CANDIDATE_CONTROL_PROMOTION_STAGE_INVALID", "hold");
  }
  await ensureSafeDirectory(path.dirname(target), "holds-root");
  const existing = await lstatOrNull(target);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail("CANDIDATE_CONTROL_PROMOTION_CENTRAL_STATE_UNSAFE", "hold");
    }
    const displaced = path.join(work.backupRoot, "displaced-hold");
    if (await lstatOrNull(displaced)) {
      fail("CANDIDATE_CONTROL_PROMOTION_PUBLISH_CONFLICT", "hold-displaced");
    }
    if (
      !intent.backup.hold.present
      || !await currentTreeMatches(target, intent.backup.hold.treeSha256)
    ) fail("CANDIDATE_CONTROL_PROMOTION_PUBLISH_CONFLICT", "hold");
    await fs.rename(target, displaced);
  }
  await fs.rename(stage, target);
  await syncDirectory(path.dirname(target));
  if (!await currentTreeMatches(target, intent.source.holdTreeSha256)) {
    fail("CANDIDATE_CONTROL_PROMOTION_PUBLISH_FAILED", "hold");
  }
}

async function verifyPublished(paths, intent) {
  await assertFileHash(
    path.join(paths.stateRoot, "active-manifest.json"),
    intent.source.activeSha256,
    "CANDIDATE_CONTROL_PROMOTION_PUBLISHED_STATE_INVALID",
  );
  await assertFileHash(
    path.join(paths.stateRoot, "history", `${intent.updateId}.json`),
    intent.source.historySha256,
    "CANDIDATE_CONTROL_PROMOTION_PUBLISHED_STATE_INVALID",
  );
  if (intent.source.lifecycleSha256) {
    await assertFileHash(
      path.join(paths.stateRoot, "deployment-lifecycle.json"),
      intent.source.lifecycleSha256,
      "CANDIDATE_CONTROL_PROMOTION_PUBLISHED_STATE_INVALID",
    );
  }
  if (intent.source.holdTreeSha256) {
    const hold = path.join(paths.stateRoot, "deployment-holds", intent.source.holdId);
    if (!await currentTreeMatches(hold, intent.source.holdTreeSha256)) {
      fail("CANDIDATE_CONTROL_PROMOTION_PUBLISHED_STATE_INVALID", "hold");
    }
  }
}

async function writeReceipt(paths, intent, outcome, options) {
  const receipt = withChecksum({
    schemaVersion: RECEIPT_SCHEMA,
    generation: intent.generation,
    transactionId: intent.transactionId,
    updateId: intent.updateId,
    manifestSha256: intent.manifestSha256,
    intentSha256: intent.intentSha256,
    outcome,
    completedAt: now(options),
    published: outcome === "committed" ? { ...intent.source } : null,
  }, "receiptSha256");
  await writeJsonAtomic(paths.receiptPath, receipt);
  return receipt;
}

async function removeFileIfExpected(target, expectedSha256) {
  const state = await lstatOrNull(target);
  if (!state) return;
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1 || await sha256File(target) !== expectedSha256) {
    fail("CANDIDATE_CONTROL_PROMOTION_ROLLBACK_CONFLICT", target);
  }
  await fs.rm(target);
  await syncDirectory(path.dirname(target));
}

async function restoreFile(target, backup, metadata, publishedSha256, label) {
  if (metadata.present) {
    const current = await readSafeFile(
      target,
      "CANDIDATE_CONTROL_PROMOTION_CENTRAL_STATE_UNSAFE",
      MAX_TREE_BYTES,
    );
    if (current?.sha256 === metadata.sha256) return;
    if (current?.sha256 !== publishedSha256) {
      fail("CANDIDATE_CONTROL_PROMOTION_ROLLBACK_CONFLICT", label);
    }
    await publishFile(backup, target, metadata.sha256, {
      present: true,
      sha256: publishedSha256,
    });
    return;
  }
  await removeFileIfExpected(target, publishedSha256).catch((error) => {
    if (error?.code === "ENOENT") return;
    throw error;
  });
}

async function rollbackIntent(paths, intent, options) {
  const work = workPaths(paths, intent);
  intent = await writeIntent(paths, intent, "rolling-back");
  await checkpoint(options, "rollback-started");
  // active-manifest.json is the externally observed commit marker. Restore it
  // first so a failed transaction stops advertising the Candidate generation.
  await restoreFile(
    path.join(paths.stateRoot, "active-manifest.json"),
    path.join(work.backupRoot, "active-manifest.json"),
    intent.backup.active,
    intent.source.activeSha256,
    "active",
  );
  if (intent.source.holdTreeSha256) {
    const target = path.join(paths.stateRoot, "deployment-holds", intent.source.holdId);
    const current = await lstatOrNull(target);
    if (intent.backup.hold.present) {
      if (current && await currentTreeMatches(target, intent.backup.hold.treeSha256)) {
        // A previous recovery attempt already restored the predecessor hold.
      } else {
        if (current && !await currentTreeMatches(target, intent.source.holdTreeSha256)) {
          fail("CANDIDATE_CONTROL_PROMOTION_ROLLBACK_CONFLICT", "hold");
        }
        if (current) await fs.rm(target, { recursive: true, force: true });
        const displaced = path.join(work.backupRoot, "displaced-hold");
        if (await lstatOrNull(displaced)) await fs.rename(displaced, target);
        else {
          const backupHold = path.join(work.backupRoot, "hold");
          await inventoryTree(backupHold, { copyTo: target });
        }
      }
      if (!await currentTreeMatches(target, intent.backup.hold.treeSha256)) {
        fail("CANDIDATE_CONTROL_PROMOTION_ROLLBACK_FAILED", "hold");
      }
    } else if (current) {
      if (!await currentTreeMatches(target, intent.source.holdTreeSha256)) {
        fail("CANDIDATE_CONTROL_PROMOTION_ROLLBACK_CONFLICT", "hold");
      }
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  if (intent.source.lifecycleSha256) {
    await restoreFile(
      path.join(paths.stateRoot, "deployment-lifecycle.json"),
      path.join(work.backupRoot, "deployment-lifecycle.json"),
      intent.backup.lifecycle,
      intent.source.lifecycleSha256,
      "lifecycle",
    );
  }
  await restoreFile(
    path.join(paths.stateRoot, "history", `${intent.updateId}.json`),
    path.join(work.backupRoot, "history.json"),
    intent.backup.history,
    intent.source.historySha256,
    "history",
  );
  const receipt = await writeReceipt(paths, intent, "rolled-back", options);
  await fs.rm(paths.intentPath, { force: true });
  await fs.rm(work.workRoot, { recursive: true, force: true });
  return receipt;
}

async function publishIntent(paths, intent, options, recoveryRun = false) {
  const work = workPaths(paths, intent);
  const resumedTransaction = recoveryRun || intent.phase !== "prepared";
  const existingReceipt = await readReceipt(paths);
  if (
    existingReceipt?.outcome === "committed"
    && existingReceipt.generation === intent.generation
    && existingReceipt.transactionId === intent.transactionId
  ) {
    await verifyPublished(paths, intent);
    await fs.rm(paths.intentPath, { force: true });
    await fs.rm(work.workRoot, { recursive: true, force: true });
    return { receipt: existingReceipt, idempotent: true, recovered: true };
  }
  if (intent.phase === "rolling-back") {
    await rollbackIntent(paths, intent, options);
    return { rolledBack: true };
  }
  try {
    // Publish support receipts first. active-manifest.json is deliberately the
    // final commit marker, keeping readers on the prior generation until all
    // lifecycle and rollback material is durable.
    await publishFile(
      path.join(work.stageRoot, "history.json"),
      path.join(paths.stateRoot, "history", `${intent.updateId}.json`),
      intent.source.historySha256,
      intent.backup.history,
    );
    intent = await writeIntent(paths, intent, "history-published");
    await checkpoint(options, "history-published");

    if (intent.source.lifecycleSha256) {
      await publishFile(
        path.join(work.stageRoot, "deployment-lifecycle.json"),
        path.join(paths.stateRoot, "deployment-lifecycle.json"),
        intent.source.lifecycleSha256,
        intent.backup.lifecycle,
      );
    }
    intent = await writeIntent(paths, intent, "lifecycle-published");
    await checkpoint(options, "lifecycle-published");

    await publishHold(paths, intent, work);
    intent = await writeIntent(paths, intent, "hold-published");
    await checkpoint(options, "hold-published");

    await publishFile(
      path.join(work.stageRoot, "active-manifest.json"),
      path.join(paths.stateRoot, "active-manifest.json"),
      intent.source.activeSha256,
      intent.backup.active,
    );
    intent = await writeIntent(paths, intent, "active-published");
    await checkpoint(options, "active-published");

    await verifyPublished(paths, intent);
    intent = await writeIntent(paths, intent, "committing");
    await checkpoint(options, "before-receipt");
    const receipt = await writeReceipt(paths, intent, "committed", options);
    await checkpoint(options, "receipt-written");
    await fs.rm(paths.intentPath, { force: true });
    await fs.rm(work.workRoot, { recursive: true, force: true });
    return { receipt, idempotent: false, recovered: resumedTransaction };
  } catch (error) {
    if (error?.simulatedCrash) throw error;
    try {
      await rollbackIntent(paths, intent, options);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "CANDIDATE_CONTROL_PROMOTION_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
}

async function cleanupUnreferencedWork(paths, intent) {
  await ensureSafeDirectory(paths.workRoot, "promotion-work-root");
  const referenced = intent ? path.basename(workPaths(paths, intent).workRoot) : null;
  const entries = await fs.readdir(paths.workRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === referenced) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail("CANDIDATE_CONTROL_PROMOTION_WORK_UNSAFE", entry.name);
    }
    await fs.rm(path.join(paths.workRoot, entry.name), { recursive: true, force: true });
  }
}

function validateIntentGeneration(intent, receipt) {
  const sameTransaction = receipt
    && receipt.generation === intent.generation
    && receipt.transactionId === intent.transactionId;
  if (sameTransaction) return;
  const expectedGeneration = Number(receipt?.generation || 0) + 1;
  if (intent.generation !== expectedGeneration) {
    fail(
      "CANDIDATE_CONTROL_PROMOTION_GENERATION_MISMATCH",
      `${intent.generation}:${expectedGeneration}`,
    );
  }
}

function publicResult(receipt, { idempotent = false, recovered = false } = {}) {
  return {
    ok: true,
    updateId: receipt.updateId,
    manifestSha256: receipt.manifestSha256,
    generation: receipt.generation,
    outcome: receipt.outcome,
    idempotent,
    recovered,
    receipt,
  };
}

/**
 * Publish only the update control receipts produced and verified inside an
 * isolated Candidate. Runtime ownership remains central: control-center,
 * monitor, logs, locks and UPDATE are deliberately outside this allowlist.
 */
export async function promoteCandidateControlState(options = {}) {
  const identity = exactIdentity(options.updateId, options.manifestSha256);
  if (!options.installationRoot || !options.candidateProductRoot) {
    fail("CANDIDATE_CONTROL_PROMOTION_ROOT_MISSING");
  }
  const paths = promotionPaths(options.installationRoot);
  const candidateStateRoot = path.join(
    path.resolve(options.candidateProductRoot),
    "SYSTEM",
    ".bonni-source-update",
  );
  if (path.resolve(candidateStateRoot) === path.resolve(paths.stateRoot)) {
    fail("CANDIDATE_CONTROL_PROMOTION_CANDIDATE_NOT_ISOLATED");
  }
  await assertNoSymlinkComponents(paths.stateRoot, "central-state-root");
  await ensureSafeDirectory(paths.stateRoot, "central-state-root");
  const lockOwnership = await acquireLock(paths);
  try {
    let intent = await readIntent(paths);
    let previousReceipt = await readReceipt(paths);
    await cleanupUnreferencedWork(paths, intent);
    if (intent) {
      validateIntentGeneration(intent, previousReceipt);
      if (
        previousReceipt?.outcome === "rolled-back"
        && previousReceipt.generation === intent.generation
        && previousReceipt.transactionId === intent.transactionId
      ) {
        await fs.rm(paths.intentPath, { force: true });
        await fs.rm(workPaths(paths, intent).workRoot, { recursive: true, force: true });
        intent = null;
      }
    }
    if (intent) {
      if (intent.updateId !== identity.updateId || intent.manifestSha256 !== identity.manifestSha256) {
        await rollbackIntent(paths, intent, options);
        fail("CANDIDATE_CONTROL_PROMOTION_RECOVERED_OTHER_GENERATION", intent.updateId);
      }
      const resumed = await publishIntent(paths, intent, options, true);
      if (resumed.rolledBack) {
        intent = null;
      } else {
        return publicResult(resumed.receipt, resumed);
      }
    }

    const bundle = await readCandidateBundle(options.candidateProductRoot, identity);
    previousReceipt = await readReceipt(paths);
    if (
      previousReceipt?.outcome === "committed"
      && previousReceipt.updateId === identity.updateId
      && previousReceipt.manifestSha256 === identity.manifestSha256
      && previousReceipt.published?.activeSha256 === bundle.active.sha256
      && previousReceipt.published?.historySha256 === bundle.history.sha256
      && previousReceipt.published?.lifecycleSha256 === (bundle.lifecycle?.sha256 || null)
      && previousReceipt.published?.holdTreeSha256 === (bundle.hold?.inventory.treeSha256 || null)
    ) {
      const syntheticIntent = {
        updateId: identity.updateId,
        source: previousReceipt.published,
      };
      await verifyPublished(paths, syntheticIntent);
      return publicResult(previousReceipt, { idempotent: true, recovered: false });
    }

    intent = await prepareIntent(paths, bundle, identity, previousReceipt, options);
    const published = await publishIntent(paths, intent, options);
    return publicResult(published.receipt, published);
  } finally {
    await releaseLock(paths, lockOwnership);
  }
}

export function candidateControlPromotionPaths(installationRoot) {
  return promotionPaths(installationRoot);
}
