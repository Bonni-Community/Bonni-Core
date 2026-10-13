import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  compareBonniReleaseVersion,
} from "../../src/system/update-runner/contract.mjs";

const STAGE_SCHEMA = "bonni.candidate-update-stage/v1";
const SOURCE_UPDATE_SCHEMA = "bonni.local-source-update/v1";
const MANIFEST_NAME = "bonni-source-update.json";
const RECEIPT_NAME = "candidate-update-stage.json";
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REPAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 20_000;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_FUTURE_TIMESTAMP_MS = 24 * 60 * 60 * 1000;
const PAYLOAD_LAYOUTS = new Set([
  "tree-full-v1",
  "content-addressed-delta-v1",
  "content-addressed-repair-v1",
]);
const MANAGED_COMPONENT_PATHS = new Set([
  "SYSTEM/backend",
  "SYSTEM/frontend",
  "SYSTEM/app/kontorapp",
]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const FORBIDDEN_STATE_ROOTS = new Set([
  "control-center",
  "locks",
  "logs",
  "requests",
]);

export class CandidateUpdateStageError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CandidateUpdateStageError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new CandidateUpdateStageError(code, detail);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function treeSha256(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.sizeBytes));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function windowsPathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail("CANDIDATE_UPDATE_STAGE_OBJECT_INVALID", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("CANDIDATE_UPDATE_STAGE_UNKNOWN_FIELD", `${label}.${key}`);
  }
}

function canonicalRelativePath(value, label = "path") {
  if (typeof value !== "string" || !value || value.length > 512) {
    fail("CANDIDATE_UPDATE_STAGE_PATH_INVALID", label);
  }
  if (
    value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes(":")
    || /[<>"|?*]/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail("CANDIDATE_UPDATE_STAGE_PATH_UNSAFE", value);
  const segments = value.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) fail("CANDIDATE_UPDATE_STAGE_PATH_UNSAFE", value);
  return segments.join("/");
}

function pathInside(relativePath, root) {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function isProtectedTargetPath(relativePath) {
  const lower = windowsPathKey(relativePath);
  const segments = lower.split("/");
  const basename = segments.at(-1) || "";
  if (segments.some((segment) => [
    ".bonni-source-update",
    ".git",
    "node_modules",
    "run_system",
  ].includes(segment))) return true;
  if (basename.startsWith(".env") && basename !== ".env.example") return true;
  return /\.(?:key|pem|p12|pfx|jwk|secret|secrets|db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/iu.test(basename);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
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
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const state = await lstatOrNull(cursor);
    if (!state) return;
    if (state.isSymbolicLink()) fail("CANDIDATE_UPDATE_STAGE_SYMLINK_FORBIDDEN", `${label}:${cursor}`);
  }
}

async function assertRealDirectory(target, code, { optional = false } = {}) {
  await assertNoSymlinkComponents(target, code);
  const state = await lstatOrNull(target);
  if (!state && optional) return null;
  if (!state?.isDirectory() || state.isSymbolicLink()) fail(code, target);
  const real = await fs.realpath(target);
  if (comparablePath(real) !== comparablePath(target)) fail(code, target);
  return path.resolve(target);
}

async function ensureSafeDirectory(root, relativePath) {
  const canonical = canonicalRelativePath(relativePath, "directory");
  let cursor = path.resolve(root);
  for (const segment of canonical.split("/")) {
    cursor = path.join(cursor, segment);
    const state = await lstatOrNull(cursor);
    if (!state) {
      try {
        await fs.mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const verified = await fs.lstat(cursor);
    if (!verified.isDirectory() || verified.isSymbolicLink()) {
      fail("CANDIDATE_UPDATE_STAGE_DESTINATION_UNSAFE", cursor);
    }
  }
  return cursor;
}

function sameOpenedFile(before, opened) {
  if (!opened.isFile() || opened.nlink > 1) return false;
  if (before.size !== opened.size) return false;
  if (before.dev && opened.dev && before.dev !== opened.dev) return false;
  if (before.ino && opened.ino && before.ino !== opened.ino) return false;
  return true;
}

async function inspectRegularFile(target, label, maximumBytes = MAX_FILE_BYTES) {
  const before = await lstatOrNull(target);
  if (!before?.isFile() || before.isSymbolicLink()) {
    fail("CANDIDATE_UPDATE_STAGE_FILE_UNSAFE", label);
  }
  if (before.nlink > 1) fail("CANDIDATE_UPDATE_STAGE_HARDLINK_FORBIDDEN", label);
  if (before.size > maximumBytes) fail("CANDIDATE_UPDATE_STAGE_FILE_TOO_LARGE", label);
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!sameOpenedFile(before, opened)) fail("CANDIDATE_UPDATE_STAGE_FILE_CHANGED", label);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      !sameOpenedFile(opened, after)
      || after.size !== position
      || after.mtimeMs !== opened.mtimeMs
    ) fail("CANDIDATE_UPDATE_STAGE_FILE_CHANGED", label);
    return { sizeBytes: position, sha256: hash.digest("hex") };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRegularJson(target, label, maximumBytes = MAX_STATE_BYTES) {
  const metadata = await inspectRegularFile(target, label, maximumBytes);
  const source = await fs.readFile(target);
  if (source.length !== metadata.sizeBytes || sha256(source) !== metadata.sha256) {
    fail("CANDIDATE_UPDATE_STAGE_FILE_CHANGED", label);
  }
  try {
    return { value: JSON.parse(source.toString("utf8")), source, ...metadata };
  } catch {
    fail("CANDIDATE_UPDATE_STAGE_JSON_INVALID", label);
  }
}

async function copyRegularFile(source, destination, relativePath, expected) {
  const before = await fs.lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) fail("CANDIDATE_UPDATE_STAGE_FILE_UNSAFE", relativePath);
  if (before.nlink > 1) fail("CANDIDATE_UPDATE_STAGE_HARDLINK_FORBIDDEN", relativePath);
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
    const opened = await sourceHandle.stat();
    if (!sameOpenedFile(before, opened)) fail("CANDIDATE_UPDATE_STAGE_FILE_CHANGED", relativePath);
    destinationHandle = await fs.open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) fail("CANDIDATE_UPDATE_STAGE_COPY_FAILED", relativePath);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
    const digest = hash.digest("hex");
    const after = await sourceHandle.stat();
    if (
      !sameOpenedFile(opened, after)
      || after.size !== position
      || after.mtimeMs !== opened.mtimeMs
      || position !== expected.sizeBytes
      || digest !== expected.sha256
    ) fail("CANDIDATE_UPDATE_STAGE_SOURCE_CHANGED", relativePath);
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = null;
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
  const copied = await fs.lstat(destination);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink > 1) {
    fail("CANDIDATE_UPDATE_STAGE_DESTINATION_UNSAFE", relativePath);
  }
}

function validateVersionPair(value, label) {
  assertExactKeys(value, new Set(["coreVersion", "kontorAppVersion"]), label);
  if (
    typeof value.coreVersion !== "string"
    || typeof value.kontorAppVersion !== "string"
    || value.coreVersion.length > 128
    || value.kontorAppVersion.length > 128
  ) fail("CANDIDATE_UPDATE_STAGE_VERSION_INVALID", label);
  try {
    compareBonniReleaseVersion(value.coreVersion, value.coreVersion);
    compareBonniReleaseVersion(value.kontorAppVersion, value.kontorAppVersion);
  } catch {
    fail("CANDIDATE_UPDATE_STAGE_VERSION_INVALID", label);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string"
    || !CANONICAL_UTC_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) fail("CANDIDATE_UPDATE_STAGE_TIMESTAMP_INVALID", label);
  return value;
}

function validateManifest(raw, updateId) {
  assertExactKeys(raw, new Set([
    "schemaVersion", "status", "updateId", "channel", "createdAt", "payloadLayout", "requires",
    "releaseNotes", "from", "to", "components", "files", "delete",
  ]), "manifest");
  if (
    raw.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || raw.status !== "UNPUBLISHED_TEST_UPDATE"
    || raw.channel !== "development"
    || raw.updateId !== updateId
  ) fail("CANDIDATE_UPDATE_STAGE_MANIFEST_IDENTITY_INVALID", updateId);
  const createdAt = canonicalTimestamp(raw.createdAt, "manifest.createdAt");
  if (Date.parse(createdAt) > Date.now() + MAX_FUTURE_TIMESTAMP_MS) {
    fail("CANDIDATE_UPDATE_STAGE_TIMESTAMP_TOO_FAR_IN_FUTURE", "manifest.createdAt");
  }
  const payloadLayout = raw.payloadLayout ?? "tree-full-v1";
  if (!PAYLOAD_LAYOUTS.has(payloadLayout)) fail("CANDIDATE_UPDATE_STAGE_PAYLOAD_LAYOUT_INVALID", String(payloadLayout));
  validateVersionPair(raw.from, "manifest.from");
  validateVersionPair(raw.to, "manifest.to");

  let requires = null;
  if (raw.requires !== null && raw.requires !== undefined) {
    assertExactKeys(raw.requires, new Set(["updateId", "manifestSha256"]), "manifest.requires");
    if (!UPDATE_ID.test(raw.requires.updateId) || !SHA256.test(raw.requires.manifestSha256)) {
      fail("CANDIDATE_UPDATE_STAGE_PREDECESSOR_INVALID");
    }
    requires = { updateId: raw.requires.updateId, manifestSha256: raw.requires.manifestSha256 };
  }

  if (!Array.isArray(raw.components) || !raw.components.length) {
    fail("CANDIDATE_UPDATE_STAGE_COMPONENTS_INVALID");
  }
  const componentKeys = new Set();
  const componentPaths = new Set();
  const components = raw.components.map((entry, index) => {
    assertExactKeys(entry, new Set(["key", "path", "mode"]), `manifest.components[${index}]`);
    const componentPath = canonicalRelativePath(entry.path, `manifest.components[${index}].path`);
    const pathKey = windowsPathKey(componentPath);
    if (
      typeof entry.key !== "string"
      || !/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(entry.key)
      || entry.mode !== "managed"
      || !MANAGED_COMPONENT_PATHS.has(componentPath)
      || componentKeys.has(entry.key)
      || componentPaths.has(pathKey)
    ) fail("CANDIDATE_UPDATE_STAGE_COMPONENT_INVALID", componentPath);
    componentKeys.add(entry.key);
    componentPaths.add(pathKey);
    return { key: entry.key, path: componentPath, mode: "managed" };
  });

  const assertManagedTarget = (target, label) => {
    const canonical = canonicalRelativePath(target, label);
    if (!components.some((component) => pathInside(canonical, component.path)) || isProtectedTargetPath(canonical)) {
      fail("CANDIDATE_UPDATE_STAGE_MANAGED_PATH_INVALID", canonical);
    }
    return canonical;
  };
  if (!Array.isArray(raw.files) || raw.files.length > MAX_FILES) {
    fail("CANDIDATE_UPDATE_STAGE_FILE_COUNT_INVALID");
  }
  const targetPaths = new Set();
  const expectedPayload = new Map();
  let totalBytes = 0;
  const files = raw.files.map((entry, index) => {
    assertExactKeys(entry, new Set([
      "path", "sizeBytes", "sha256", "expectedPreviousSha256",
    ]), `manifest.files[${index}]`);
    const filePath = assertManagedTarget(entry.path, `manifest.files[${index}].path`);
    const targetKey = windowsPathKey(filePath);
    if (targetPaths.has(targetKey)) fail("CANDIDATE_UPDATE_STAGE_TARGET_COLLISION", filePath);
    targetPaths.add(targetKey);
    if (
      !Number.isSafeInteger(entry.sizeBytes)
      || entry.sizeBytes < 0
      || entry.sizeBytes > MAX_FILE_BYTES
      || !SHA256.test(String(entry.sha256 || ""))
      || !Object.hasOwn(entry, "expectedPreviousSha256")
      || !(entry.expectedPreviousSha256 === null || SHA256.test(String(entry.expectedPreviousSha256 || "")))
    ) fail("CANDIDATE_UPDATE_STAGE_FILE_ENTRY_INVALID", filePath);
    totalBytes += entry.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail("CANDIDATE_UPDATE_STAGE_PACKAGE_TOO_LARGE");
    const payloadObject = payloadLayout === "tree-full-v1"
      ? filePath
      : payloadLayout === "content-addressed-repair-v1"
        ? `${entry.sha256}.bin`
        : entry.expectedPreviousSha256 === entry.sha256
          ? null
          : `${entry.sha256}.bin`;
    if (payloadObject) {
      const canonicalPayload = canonicalRelativePath(payloadObject, `manifest.files[${index}].payload`);
      const key = windowsPathKey(canonicalPayload);
      const existing = expectedPayload.get(key);
      if (existing && (existing.sha256 !== entry.sha256 || existing.sizeBytes !== entry.sizeBytes)) {
        fail("CANDIDATE_UPDATE_STAGE_PAYLOAD_COLLISION", canonicalPayload);
      }
      expectedPayload.set(key, {
        path: canonicalPayload,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      });
    }
    return { ...entry, path: filePath, payloadObject };
  });
  if (payloadLayout !== "tree-full-v1") {
    for (let index = 1; index < files.length; index += 1) {
      if (bytewiseCompare(files[index - 1].path, files[index].path) >= 0) {
        fail("CANDIDATE_UPDATE_STAGE_FILE_ORDER_INVALID", files[index].path);
      }
    }
  }
  if (!Array.isArray(raw.delete) || raw.delete.length > MAX_FILES) {
    fail("CANDIDATE_UPDATE_STAGE_DELETE_INVALID");
  }
  for (let index = 0; index < raw.delete.length; index += 1) {
    const entry = raw.delete[index];
    assertExactKeys(entry, new Set(["path", "expectedSha256", "reason"]), `manifest.delete[${index}]`);
    const target = assertManagedTarget(entry.path, `manifest.delete[${index}].path`);
    const key = windowsPathKey(target);
    if (
      targetPaths.has(key)
      || !SHA256.test(String(entry.expectedSha256 || ""))
      || typeof entry.reason !== "string"
      || !entry.reason.trim()
      || entry.reason.length > 240
    ) fail("CANDIDATE_UPDATE_STAGE_DELETE_INVALID", target);
    targetPaths.add(key);
  }
  return { ...raw, payloadLayout, requires, components, files, expectedPayload };
}

async function collectPayloadInventory(packageRoot, expectedPayload) {
  const topEntries = await fs.readdir(packageRoot, { withFileTypes: true });
  const topNames = topEntries.map((entry) => entry.name).sort(bytewiseCompare);
  if (JSON.stringify(topNames) !== JSON.stringify([MANIFEST_NAME, "payload"].sort(bytewiseCompare))) {
    fail("CANDIDATE_UPDATE_STAGE_PACKAGE_INVENTORY_INVALID", topNames.join(","));
  }
  const payloadRoot = await assertRealDirectory(
    path.join(packageRoot, "payload"),
    "CANDIDATE_UPDATE_STAGE_PAYLOAD_ROOT_UNSAFE",
  );
  const files = [];
  const directories = ["payload"];
  const seen = new Set();
  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const relative = canonicalRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        "payload",
      );
      const absolute = path.join(directory, entry.name);
      const state = await fs.lstat(absolute);
      if (state.isSymbolicLink()) fail("CANDIDATE_UPDATE_STAGE_SYMLINK_FORBIDDEN", `payload/${relative}`);
      if (state.isDirectory()) {
        directories.push(`payload/${relative}`);
        await visit(absolute, relative);
        continue;
      }
      if (!state.isFile()) fail("CANDIDATE_UPDATE_STAGE_FILE_UNSAFE", `payload/${relative}`);
      const key = windowsPathKey(relative);
      const expected = expectedPayload.get(key);
      if (!expected || expected.path !== relative || seen.has(key)) {
        fail("CANDIDATE_UPDATE_STAGE_UNDECLARED_PAYLOAD", relative);
      }
      const actual = await inspectRegularFile(absolute, `payload/${relative}`);
      if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
        fail("CANDIDATE_UPDATE_STAGE_PAYLOAD_MISMATCH", relative);
      }
      seen.add(key);
      files.push({ source: absolute, path: `payload/${relative}`, ...actual });
    }
  }
  await visit(payloadRoot, "");
  for (const [key, expected] of expectedPayload) {
    if (!seen.has(key)) fail("CANDIDATE_UPDATE_STAGE_PAYLOAD_MISSING", expected.path);
  }
  files.sort((left, right) => bytewiseCompare(left.path, right.path));
  directories.sort(bytewiseCompare);
  return { files, directories };
}

function validateActiveManifest(value) {
  if (
    !isPlainObject(value)
    || value.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || !UPDATE_ID.test(String(value.updateId || ""))
    || !SHA256.test(String(value.manifestSha256 || ""))
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))
    || !isPlainObject(value.versions)
    || !Array.isArray(value.components)
    || !Array.isArray(value.files)
  ) fail("CANDIDATE_UPDATE_STAGE_ACTIVE_MANIFEST_INVALID");
  return value;
}

function validateOfflineFoundation(value, manifest) {
  assertExactKeys(value, new Set([
    "schema",
    "installId",
    "version",
    "completedAt",
    "imageCreatedAt",
    "imageTreeSha256",
    "note",
  ]), "offline-full-install");
  if (
    value.schema !== "bonni.offline-full-install/v1"
    || !UPDATE_ID.test(String(value.installId || ""))
    || typeof value.version !== "string"
    || value.version.length > 128
    || !SHA256.test(String(value.imageTreeSha256 || ""))
    || typeof value.note !== "string"
    || !value.note.trim()
    || value.note.length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.note)
  ) fail("CANDIDATE_UPDATE_STAGE_OFFLINE_FOUNDATION_INVALID");
  try {
    compareBonniReleaseVersion(value.version, value.version);
  } catch {
    fail("CANDIDATE_UPDATE_STAGE_OFFLINE_FOUNDATION_INVALID", "version");
  }
  if (value.version !== manifest.from.coreVersion) {
    fail(
      "CANDIDATE_UPDATE_STAGE_OFFLINE_FOUNDATION_VERSION_MISMATCH",
      `${value.version}:${manifest.from.coreVersion}`,
    );
  }
  const completedAt = canonicalTimestamp(
    value.completedAt,
    "offline-full-install.completedAt",
  );
  const imageCreatedAt = canonicalTimestamp(
    value.imageCreatedAt,
    "offline-full-install.imageCreatedAt",
  );
  if (Date.parse(imageCreatedAt) > Date.parse(completedAt)) {
    fail("CANDIDATE_UPDATE_STAGE_OFFLINE_FOUNDATION_TIMESTAMP_INVALID");
  }
  return value;
}

function predecessorMatches(value, predecessor) {
  return isPlainObject(value)
    && value.updateId === predecessor.updateId
    && value.manifestSha256 === predecessor.manifestSha256;
}

async function collectRepairReceipts(stateRoot, predecessor) {
  if (!predecessor) return [];
  const repairsRoot = await assertRealDirectory(
    path.join(stateRoot, "repairs"),
    "CANDIDATE_UPDATE_STAGE_REPAIRS_ROOT_UNSAFE",
    { optional: true },
  );
  if (!repairsRoot) return [];
  const groups = new Map();
  const entries = await fs.readdir(repairsRoot, { withFileTypes: true });
  entries.sort((left, right) => bytewiseCompare(left.name, right.name));
  for (const entry of entries) {
    const type = entry.name.endsWith(".intent.json")
      ? "intent"
      : entry.name.endsWith(".json")
        ? "receipt"
        : null;
    if (!type) continue;
    const repairId = type === "intent"
      ? entry.name.slice(0, -".intent.json".length)
      : entry.name.slice(0, -".json".length);
    if (!REPAIR_ID.test(repairId)) fail("CANDIDATE_UPDATE_STAGE_REPAIR_NAME_INVALID", entry.name);
    const target = path.join(repairsRoot, entry.name);
    const parsed = await readRegularJson(target, `repairs/${entry.name}`);
    if (parsed.value?.repairId !== repairId) {
      fail("CANDIDATE_UPDATE_STAGE_REPAIR_ID_MISMATCH", entry.name);
    }
    if (!predecessorMatches(parsed.value?.predecessor, predecessor)) continue;
    const group = groups.get(repairId) || {};
    if (group[type]) fail("CANDIDATE_UPDATE_STAGE_REPAIR_DUPLICATE", repairId);
    group[type] = {
      source: target,
      path: `repairs/${entry.name}`,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256,
      value: parsed.value,
    };
    groups.set(repairId, group);
  }
  const selected = [];
  for (const [repairId, group] of [...groups.entries()].sort(([left], [right]) => bytewiseCompare(left, right))) {
    if (!group.intent || !group.receipt) {
      fail("CANDIDATE_UPDATE_STAGE_REPAIR_PAIR_INCOMPLETE", repairId);
    }
    if (group.receipt.value.intentSha256 !== group.intent.sha256) {
      fail("CANDIDATE_UPDATE_STAGE_REPAIR_RECEIPT_UNBOUND", repairId);
    }
    selected.push(group.intent, group.receipt);
  }
  return selected.map(({ value: _value, ...entry }) => entry)
    .sort((left, right) => bytewiseCompare(left.path, right.path));
}

async function collectPrerequisiteState(installationRoot, manifest) {
  const stateRoot = await assertRealDirectory(
    path.join(installationRoot, "SYSTEM", ".bonni-source-update"),
    "CANDIDATE_UPDATE_STAGE_STATE_ROOT_UNSAFE",
  );
  const activePath = path.join(stateRoot, "active-manifest.json");
  const activeState = await lstatOrNull(activePath);
  if (!activeState) {
    if (manifest.requires) {
      fail("CANDIDATE_UPDATE_STAGE_PREDECESSOR_MISMATCH", manifest.requires.updateId);
    }
    const foundationPath = path.join(stateRoot, "offline-full-install.json");
    if (!await lstatOrNull(foundationPath)) {
      fail("CANDIDATE_UPDATE_STAGE_OFFLINE_FOUNDATION_MISSING");
    }
    const foundationSource = await readRegularJson(
      foundationPath,
      "offline-full-install.json",
    );
    const foundation = validateOfflineFoundation(foundationSource.value, manifest);
    return {
      active: null,
      foundation,
      files: [{
        source: foundationPath,
        path: "offline-full-install.json",
        sizeBytes: foundationSource.sizeBytes,
        sha256: foundationSource.sha256,
      }],
    };
  }
  const activeSource = await readRegularJson(activePath, "active-manifest.json");
  const active = validateActiveManifest(activeSource.value);
  if (manifest.requires && !predecessorMatches(active, manifest.requires)) {
    fail("CANDIDATE_UPDATE_STAGE_PREDECESSOR_MISMATCH", manifest.requires.updateId);
  }
  const files = [{
    source: activePath,
    path: "active-manifest.json",
    sizeBytes: activeSource.sizeBytes,
    sha256: activeSource.sha256,
  }];
  if (manifest.requires) {
    const historyRelative = `history/${manifest.requires.updateId}.json`;
    const historyPath = path.join(stateRoot, "history", `${manifest.requires.updateId}.json`);
    const historySource = await readRegularJson(historyPath, historyRelative);
    const history = historySource.value;
    if (
      !predecessorMatches(history, manifest.requires)
      || history.status !== "COMPLETED"
      || history.completedAt !== active.completedAt
      || stableStringify(history.versions) !== stableStringify(active.versions)
      || stableStringify(history.components) !== stableStringify(active.components)
      || stableStringify(history.files) !== stableStringify(active.files)
    ) fail("CANDIDATE_UPDATE_STAGE_HISTORY_RECEIPT_INVALID", manifest.requires.updateId);
    files.push({
      source: historyPath,
      path: historyRelative,
      sizeBytes: historySource.sizeBytes,
      sha256: historySource.sha256,
    });
    files.push(...await collectRepairReceipts(stateRoot, manifest.requires));
  }
  files.sort((left, right) => bytewiseCompare(left.path, right.path));
  for (const entry of files) {
    const root = entry.path.split("/")[0];
    if (FORBIDDEN_STATE_ROOTS.has(windowsPathKey(root))) {
      fail("CANDIDATE_UPDATE_STAGE_FORBIDDEN_STATE", entry.path);
    }
  }
  return { active, foundation: null, files };
}

async function writeExclusiveJson(target, value) {
  let handle;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function publicFileEntries(files) {
  return files.map(({ path: filePath, sizeBytes, sha256: fileSha256 }) => ({
    path: filePath,
    sizeBytes,
    sha256: fileSha256,
  }));
}

function directoryInventory(files, explicit = []) {
  const directories = new Set(explicit);
  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let cursor = "";
    for (const segment of segments) {
      cursor = cursor ? `${cursor}/${segment}` : segment;
      directories.add(cursor);
    }
  }
  return [...directories].sort(bytewiseCompare);
}

function createReceipt({
  updateId,
  manifestSha256,
  manifest,
  packageFiles,
  packageDirectories,
  stateFiles,
  active,
  foundation,
}) {
  const packageEntries = publicFileEntries(packageFiles).sort((left, right) => bytewiseCompare(left.path, right.path));
  const stateEntries = publicFileEntries(stateFiles).sort((left, right) => bytewiseCompare(left.path, right.path));
  const base = {
    schemaVersion: STAGE_SCHEMA,
    updateId,
    manifestSha256,
    packagePath: `UPDATE/inbox/${updateId}`,
    statePath: "SYSTEM/.bonni-source-update",
    createdAt: new Date().toISOString(),
    activeManifest: active ? {
      updateId: active.updateId,
      manifestSha256: active.manifestSha256,
      sha256: stateEntries.find((entry) => entry.path === "active-manifest.json")?.sha256,
    } : null,
    offlineFoundation: foundation ? {
      installId: foundation.installId,
      version: foundation.version,
      completedAt: foundation.completedAt,
      imageCreatedAt: foundation.imageCreatedAt,
      imageTreeSha256: foundation.imageTreeSha256,
      sha256: stateEntries.find((entry) => entry.path === "offline-full-install.json")?.sha256,
    } : null,
    requiredPredecessor: manifest.requires,
    packageDirectories: [...packageDirectories].sort(bytewiseCompare),
    packageFiles: packageEntries,
    packageTreeSha256: treeSha256(packageEntries),
    stateDirectories: directoryInventory(stateEntries),
    stateFiles: stateEntries,
    stateTreeSha256: treeSha256(stateEntries),
  };
  return { ...base, receiptSha256: sha256(stableStringify(base)) };
}

function validateReceipt(receipt, updateId, manifestSha256) {
  assertExactKeys(receipt, new Set([
    "schemaVersion", "updateId", "manifestSha256", "packagePath", "statePath", "createdAt",
    "activeManifest", "offlineFoundation", "requiredPredecessor", "packageDirectories", "packageFiles",
    "packageTreeSha256", "stateDirectories", "stateFiles", "stateTreeSha256", "receiptSha256",
  ]), "candidate-stage-receipt");
  const { receiptSha256, ...base } = receipt;
  if (
    receipt.schemaVersion !== STAGE_SCHEMA
    || receipt.updateId !== updateId
    || receipt.manifestSha256 !== manifestSha256
    || receipt.packagePath !== `UPDATE/inbox/${updateId}`
    || receipt.statePath !== "SYSTEM/.bonni-source-update"
    || typeof receipt.createdAt !== "string"
    || !Number.isFinite(Date.parse(receipt.createdAt))
    || !SHA256.test(String(receiptSha256 || ""))
    || sha256(stableStringify(base)) !== receiptSha256
    || !Array.isArray(receipt.packageDirectories)
    || !Array.isArray(receipt.packageFiles)
    || !Array.isArray(receipt.stateDirectories)
    || !Array.isArray(receipt.stateFiles)
    || treeSha256(receipt.packageFiles) !== receipt.packageTreeSha256
    || treeSha256(receipt.stateFiles) !== receipt.stateTreeSha256
  ) fail("CANDIDATE_UPDATE_STAGE_RECEIPT_INVALID", updateId);
  const activeStateEntry = receipt.stateFiles.find((entry) => entry.path === "active-manifest.json");
  const foundationStateEntry = receipt.stateFiles.find((entry) => entry.path === "offline-full-install.json");
  const hasActive = receipt.activeManifest !== null && receipt.activeManifest !== undefined;
  const hasFoundation = receipt.offlineFoundation !== null && receipt.offlineFoundation !== undefined;
  if (hasActive === hasFoundation) fail("CANDIDATE_UPDATE_STAGE_RECEIPT_INVALID", "prerequisite");
  if (hasActive) {
    assertExactKeys(
      receipt.activeManifest,
      new Set(["updateId", "manifestSha256", "sha256"]),
      "candidate-stage-receipt.activeManifest",
    );
    if (
      !UPDATE_ID.test(String(receipt.activeManifest.updateId || ""))
      || !SHA256.test(String(receipt.activeManifest.manifestSha256 || ""))
      || !SHA256.test(String(receipt.activeManifest.sha256 || ""))
      || activeStateEntry?.sha256 !== receipt.activeManifest.sha256
      || foundationStateEntry
    ) fail("CANDIDATE_UPDATE_STAGE_RECEIPT_INVALID", "active-manifest");
  } else {
    assertExactKeys(
      receipt.offlineFoundation,
      new Set([
        "installId",
        "version",
        "completedAt",
        "imageCreatedAt",
        "imageTreeSha256",
        "sha256",
      ]),
      "candidate-stage-receipt.offlineFoundation",
    );
    if (
      receipt.requiredPredecessor !== null
      || !UPDATE_ID.test(String(receipt.offlineFoundation.installId || ""))
      || typeof receipt.offlineFoundation.version !== "string"
      || receipt.offlineFoundation.version.length > 128
      || !CANONICAL_UTC_TIMESTAMP.test(String(receipt.offlineFoundation.completedAt || ""))
      || !CANONICAL_UTC_TIMESTAMP.test(String(receipt.offlineFoundation.imageCreatedAt || ""))
      || !SHA256.test(String(receipt.offlineFoundation.imageTreeSha256 || ""))
      || !SHA256.test(String(receipt.offlineFoundation.sha256 || ""))
      || foundationStateEntry?.sha256 !== receipt.offlineFoundation.sha256
      || activeStateEntry
    ) fail("CANDIDATE_UPDATE_STAGE_RECEIPT_INVALID", "offline-foundation");
    try {
      compareBonniReleaseVersion(
        receipt.offlineFoundation.version,
        receipt.offlineFoundation.version,
      );
      canonicalTimestamp(
        receipt.offlineFoundation.completedAt,
        "candidate-stage-receipt.offlineFoundation.completedAt",
      );
      canonicalTimestamp(
        receipt.offlineFoundation.imageCreatedAt,
        "candidate-stage-receipt.offlineFoundation.imageCreatedAt",
      );
    } catch {
      fail("CANDIDATE_UPDATE_STAGE_RECEIPT_INVALID", "offline-foundation");
    }
    if (
      Date.parse(receipt.offlineFoundation.imageCreatedAt)
      > Date.parse(receipt.offlineFoundation.completedAt)
    ) fail("CANDIDATE_UPDATE_STAGE_RECEIPT_INVALID", "offline-foundation-timestamp");
  }
  return receipt;
}

async function enumerateTree(root, label) {
  await assertRealDirectory(root, "CANDIDATE_UPDATE_STAGE_DESTINATION_UNSAFE");
  const files = [];
  const directories = [];
  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const relative = canonicalRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        label,
      );
      const target = path.join(directory, entry.name);
      const state = await fs.lstat(target);
      if (state.isSymbolicLink()) fail("CANDIDATE_UPDATE_STAGE_SYMLINK_FORBIDDEN", `${label}:${relative}`);
      if (state.isDirectory()) {
        directories.push(relative);
        await visit(target, relative);
      } else if (state.isFile()) {
        const metadata = await inspectRegularFile(target, `${label}:${relative}`, MAX_STATE_BYTES);
        files.push({ path: relative, ...metadata });
      } else fail("CANDIDATE_UPDATE_STAGE_FILE_UNSAFE", `${label}:${relative}`);
    }
  }
  await visit(root, "");
  files.sort((left, right) => bytewiseCompare(left.path, right.path));
  directories.sort(bytewiseCompare);
  return { files, directories };
}

function assertSameInventory(actual, expected, code) {
  if (stableStringify(actual) !== stableStringify(expected)) fail(code);
}

async function verifyCommittedStage({ packageRoot, stateRoot, receipt, updateId, manifestSha256 }) {
  validateReceipt(receipt, updateId, manifestSha256);
  const [packageInventory, stateInventory] = await Promise.all([
    enumerateTree(packageRoot, "candidate-package"),
    enumerateTree(stateRoot, "candidate-state"),
  ]);
  const receiptFile = stateInventory.files.find((entry) => entry.path === RECEIPT_NAME);
  if (!receiptFile) fail("CANDIDATE_UPDATE_STAGE_RECEIPT_MISSING", updateId);
  const stateFiles = stateInventory.files.filter((entry) => entry.path !== RECEIPT_NAME);
  assertSameInventory(packageInventory.files, receipt.packageFiles, "CANDIDATE_UPDATE_STAGE_PACKAGE_CHANGED");
  assertSameInventory(packageInventory.directories, receipt.packageDirectories, "CANDIDATE_UPDATE_STAGE_PACKAGE_CHANGED");
  assertSameInventory(stateFiles, receipt.stateFiles, "CANDIDATE_UPDATE_STAGE_STATE_CHANGED");
  assertSameInventory(stateInventory.directories, receipt.stateDirectories, "CANDIDATE_UPDATE_STAGE_STATE_CHANGED");
  if (
    packageInventory.files.find((entry) => entry.path === MANIFEST_NAME)?.sha256 !== manifestSha256
  ) fail("CANDIDATE_UPDATE_STAGE_MANIFEST_CHANGED", updateId);
  return receipt;
}

async function readExistingReceipt(stateRoot, updateId, manifestSha256) {
  const receiptPath = path.join(stateRoot, RECEIPT_NAME);
  const parsed = await readRegularJson(receiptPath, RECEIPT_NAME);
  return validateReceipt(parsed.value, updateId, manifestSha256);
}

async function copyEntries(entries, destinationRoot, { defer = new Set() } = {}) {
  for (const entry of entries) {
    if (defer.has(entry.path)) continue;
    const parent = path.posix.dirname(entry.path);
    if (parent !== ".") await ensureSafeDirectory(destinationRoot, parent);
    await copyRegularFile(
      entry.source,
      path.join(destinationRoot, ...entry.path.split("/")),
      entry.path,
      entry,
    );
  }
}

async function buildSourcePlan({ installationRoot, updateId, manifestSha256 }) {
  const packageRoot = await assertRealDirectory(
    path.join(installationRoot, "UPDATE", "inbox", updateId),
    "CANDIDATE_UPDATE_STAGE_PACKAGE_ROOT_UNSAFE",
  );
  const manifestPath = path.join(packageRoot, MANIFEST_NAME);
  const manifestSource = await readRegularJson(manifestPath, MANIFEST_NAME, MAX_MANIFEST_BYTES);
  if (manifestSource.sha256 !== manifestSha256) {
    fail("CANDIDATE_UPDATE_STAGE_MANIFEST_HASH_MISMATCH", updateId);
  }
  const manifest = validateManifest(manifestSource.value, updateId);
  const payload = await collectPayloadInventory(packageRoot, manifest.expectedPayload);
  const packageFiles = [
    { source: manifestPath, path: MANIFEST_NAME, sizeBytes: manifestSource.sizeBytes, sha256: manifestSource.sha256 },
    ...payload.files,
  ].sort((left, right) => bytewiseCompare(left.path, right.path));
  const prerequisite = await collectPrerequisiteState(installationRoot, manifest);
  return {
    manifest,
    packageFiles,
    packageDirectories: payload.directories,
    active: prerequisite.active,
    foundation: prerequisite.foundation,
    stateFiles: prerequisite.files,
  };
}

/**
 * Stages one receipt-bound local source package and only its prerequisite
 * updater state into an isolated candidate program tree.
 */
export async function stageCandidateUpdatePackage({
  installationRoot,
  candidateProgramRoot,
  updateId,
  manifestSha256,
}) {
  if (typeof installationRoot !== "string" || !installationRoot.trim()) {
    fail("CANDIDATE_UPDATE_STAGE_ARGUMENT_REQUIRED", "installationRoot");
  }
  if (typeof candidateProgramRoot !== "string" || !candidateProgramRoot.trim()) {
    fail("CANDIDATE_UPDATE_STAGE_ARGUMENT_REQUIRED", "candidateProgramRoot");
  }
  if (!UPDATE_ID.test(String(updateId || ""))) fail("CANDIDATE_UPDATE_STAGE_UPDATE_ID_INVALID", String(updateId || ""));
  if (!SHA256.test(String(manifestSha256 || ""))) {
    fail("CANDIDATE_UPDATE_STAGE_MANIFEST_SHA256_INVALID", String(manifestSha256 || ""));
  }
  const centralRoot = await assertRealDirectory(
    path.resolve(installationRoot),
    "CANDIDATE_UPDATE_STAGE_INSTALLATION_ROOT_UNSAFE",
  );
  const candidateRoot = await assertRealDirectory(
    path.resolve(candidateProgramRoot),
    "CANDIDATE_UPDATE_STAGE_CANDIDATE_ROOT_UNSAFE",
  );
  if (comparablePath(centralRoot) === comparablePath(candidateRoot)) {
    fail("CANDIDATE_UPDATE_STAGE_ROOTS_NOT_ISOLATED");
  }
  const sourcePlan = await buildSourcePlan({
    installationRoot: centralRoot,
    updateId,
    manifestSha256,
  });
  const packageRoot = path.join(candidateRoot, "UPDATE", "inbox", updateId);
  const stateRoot = path.join(candidateRoot, "SYSTEM", ".bonni-source-update");
  await ensureSafeDirectory(candidateRoot, "UPDATE/inbox");
  await ensureSafeDirectory(candidateRoot, "SYSTEM");
  const lock = path.join(candidateRoot, "UPDATE", ".candidate-update-stage.lock");
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("CANDIDATE_UPDATE_STAGE_LOCKED", updateId);
    throw error;
  }

  let createdPackage = false;
  let createdState = false;
  try {
    const [existingPackage, existingState] = await Promise.all([
      lstatOrNull(packageRoot),
      lstatOrNull(stateRoot),
    ]);
    if (existingPackage || existingState) {
      if (
        !existingPackage?.isDirectory()
        || existingPackage.isSymbolicLink()
        || !existingState?.isDirectory()
        || existingState.isSymbolicLink()
      ) fail("CANDIDATE_UPDATE_STAGE_EXISTING_STATE_CONFLICT", updateId);
      const receipt = await readExistingReceipt(stateRoot, updateId, manifestSha256);
      await verifyCommittedStage({ packageRoot, stateRoot, receipt, updateId, manifestSha256 });
      return { candidateProgramRoot: candidateRoot, packageRoot, stateRoot, receipt, alreadyStaged: true };
    }

    const receipt = createReceipt({
      updateId,
      manifestSha256,
      manifest: sourcePlan.manifest,
      packageFiles: sourcePlan.packageFiles,
      packageDirectories: sourcePlan.packageDirectories,
      stateFiles: sourcePlan.stateFiles,
      active: sourcePlan.active,
      foundation: sourcePlan.foundation,
    });
    await fs.mkdir(stateRoot, { mode: 0o700 });
    createdState = true;
    await fs.mkdir(packageRoot, { mode: 0o700 });
    createdPackage = true;
    await copyEntries(sourcePlan.stateFiles, stateRoot);
    await writeExclusiveJson(path.join(stateRoot, RECEIPT_NAME), receipt);
    await ensureSafeDirectory(packageRoot, "payload");
    await copyEntries(sourcePlan.packageFiles, packageRoot, { defer: new Set([MANIFEST_NAME]) });
    const manifestEntry = sourcePlan.packageFiles.find((entry) => entry.path === MANIFEST_NAME);
    await copyRegularFile(
      manifestEntry.source,
      path.join(packageRoot, MANIFEST_NAME),
      MANIFEST_NAME,
      manifestEntry,
    );
    await verifyCommittedStage({ packageRoot, stateRoot, receipt, updateId, manifestSha256 });
    return { candidateProgramRoot: candidateRoot, packageRoot, stateRoot, receipt, alreadyStaged: false };
  } catch (error) {
    if (createdPackage) await fs.rm(packageRoot, { recursive: true, force: true }).catch(() => undefined);
    if (createdState) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}
