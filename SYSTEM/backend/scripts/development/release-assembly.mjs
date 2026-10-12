import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractUpdateZip } from "../setup/safe-update-zip.mjs";
import {
  DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA,
  detectDevelopmentBranchConflicts,
  normalizeDevelopmentMetadata,
  stableDevelopmentVersioningJson,
} from "../setup/development-versioning.mjs";

export const DEVELOPMENT_PACKAGE_SCHEMA = "bonni.development-package/v1";
export { DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA };
export const DEVELOPMENT_PACKAGE_MANIFEST_NAME = "DEVELOPMENT-MANIFEST.json";
export const DEVELOPMENT_CHAIN_SCHEMA = "bonni.development-chain/v1";

const SHA256 = /^[a-f0-9]{64}$/u;
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONS = 100_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_WRITE_BYTES = 1024 * 1024 * 1024;

export class DevelopmentReleaseAssemblyError extends Error {
  constructor(code, detail = "", options = {}) {
    super(detail ? `${code}: ${detail}` : code, options.cause ? { cause: options.cause } : undefined);
    this.name = "DevelopmentReleaseAssemblyError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options) {
  throw new DevelopmentReleaseAssemblyError(code, detail, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("DEVELOPMENT_ASSEMBLY_INVALID_OBJECT", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("DEVELOPMENT_ASSEMBLY_UNKNOWN_FIELD", `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("DEVELOPMENT_ASSEMBLY_REQUIRED_FIELD_MISSING", `${label}.${key}`);
  }
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => bytewiseCompare(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function windowsPathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    fail("DEVELOPMENT_ASSEMBLY_PATH_INVALID", label);
  }
  if (
    value !== value.normalize("NFC")
    || value.includes("\\")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("//")
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail("DEVELOPMENT_ASSEMBLY_PATH_UNSAFE", `${label}:${value}`);

  for (const segment of value.split("/")) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || Buffer.byteLength(segment, "utf8") > 255
      || WINDOWS_INVALID_PATH_CHARACTER.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)
    ) fail("DEVELOPMENT_ASSEMBLY_PATH_UNSAFE", `${label}:${value}`);
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("DEVELOPMENT_ASSEMBLY_HASH_INVALID", label);
  }
  return value;
}

function normalizeCandidateId(value, label) {
  if (typeof value !== "string" || !CANDIDATE_ID.test(value)) {
    fail("DEVELOPMENT_ASSEMBLY_CANDIDATE_ID_INVALID", label);
  }
  return value;
}

function normalizeDependency(entry, label) {
  assertExactKeys(
    entry,
    new Set(["candidateId", "packageSha256"]),
    new Set(["candidateId", "packageSha256"]),
    label,
  );
  return {
    candidateId: normalizeCandidateId(entry.candidateId, `${label}.candidateId`),
    packageSha256: assertSha256(entry.packageSha256, `${label}.packageSha256`),
  };
}

function normalizeDependencies(value, label) {
  if (!Array.isArray(value)) fail("DEVELOPMENT_ASSEMBLY_DEPENDENCIES_INVALID", label);
  const used = new Set();
  const normalized = value.map((entry, index) => {
    const normalized = normalizeDependency(entry, `${label}[${index}]`);
    if (used.has(normalized.candidateId)) {
      fail("DEVELOPMENT_ASSEMBLY_DEPENDENCY_DUPLICATE", normalized.candidateId);
    }
    used.add(normalized.candidateId);
    return normalized;
  });
  return normalized.sort((left, right) => {
    const candidateOrder = bytewiseCompare(left.candidateId, right.candidateId);
    return candidateOrder || bytewiseCompare(left.packageSha256, right.packageSha256);
  });
}

function normalizeTimestamp(value, label) {
  if (
    typeof value !== "string"
    || !CANONICAL_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) fail("DEVELOPMENT_ASSEMBLY_TIMESTAMP_INVALID", label);
  return value;
}

function assertNoPathCollisions(entries) {
  const used = new Map();
  for (const entry of entries) {
    const key = windowsPathKey(entry.path);
    if (used.has(key)) {
      fail("DEVELOPMENT_ASSEMBLY_OPERATION_PATH_COLLISION", `${used.get(key)}:${entry.path}`);
    }
    const segments = key.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = used.get(segments.slice(0, length).join("/"));
      if (ancestor) {
        fail("DEVELOPMENT_ASSEMBLY_OPERATION_PATH_COLLISION", `${ancestor}:${entry.path}`);
      }
    }
    for (const [existingKey, existingPath] of used) {
      if (existingKey.startsWith(`${key}/`)) {
        fail("DEVELOPMENT_ASSEMBLY_OPERATION_PATH_COLLISION", `${existingPath}:${entry.path}`);
      }
    }
    used.set(key, entry.path);
  }
}

export function parseDevelopmentPackageManifest(raw) {
  const versioned = raw?.schema === DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA;
  assertExactKeys(
    raw,
    versioned
      ? new Set([
        "schema", "candidateId", "targetVersion", "baseVersion", "branch", "devNumber",
        "displayVersion", "createdAt", "requires", "dependencies", "operations",
        "changedFiles", "conflicts", "resultingTreeSha256",
      ])
      : new Set([
        "schema", "candidateId", "targetVersion", "createdAt", "requires",
        "operations", "resultingTreeSha256",
      ]),
    versioned
      ? new Set([
        "schema", "candidateId", "targetVersion", "baseVersion", "branch", "devNumber",
        "displayVersion", "createdAt", "requires", "dependencies", "operations",
        "changedFiles", "conflicts", "resultingTreeSha256",
      ])
      : new Set([
        "schema", "candidateId", "targetVersion", "createdAt", "requires",
        "operations", "resultingTreeSha256",
      ]),
    "manifest",
  );
  if (raw.schema !== DEVELOPMENT_PACKAGE_SCHEMA && !versioned) {
    fail("DEVELOPMENT_ASSEMBLY_PACKAGE_SCHEMA_UNSUPPORTED", String(raw.schema));
  }
  const candidateId = normalizeCandidateId(raw.candidateId, "manifest.candidateId");
  if (typeof raw.targetVersion !== "string" || !VERSION.test(raw.targetVersion)) {
    fail("DEVELOPMENT_ASSEMBLY_TARGET_VERSION_INVALID", candidateId);
  }
  const createdAt = normalizeTimestamp(raw.createdAt, "manifest.createdAt");
  const requires = normalizeDependencies(raw.requires, "manifest.requires");
  if (!Array.isArray(raw.operations) || !raw.operations.length || raw.operations.length > MAX_OPERATIONS) {
    fail("DEVELOPMENT_ASSEMBLY_OPERATIONS_INVALID", candidateId);
  }

  let totalWriteBytes = 0;
  const operations = raw.operations.map((entry, index) => {
    const label = `manifest.operations[${index}]`;
    if (!isPlainObject(entry)) fail("DEVELOPMENT_ASSEMBLY_INVALID_OBJECT", label);
    const action = entry.action;
    const filePath = normalizeRelativePath(entry.path, `${label}.path`);
    if (action === "delete") {
      assertExactKeys(
        entry,
        new Set(["action", "path", "expectedPreviousSha256"]),
        new Set(["action", "path", "expectedPreviousSha256"]),
        label,
      );
      if (entry.expectedPreviousSha256 === null) {
        fail("DEVELOPMENT_ASSEMBLY_DELETE_PREVIOUS_HASH_REQUIRED", filePath);
      }
      return {
        action,
        path: filePath,
        expectedPreviousSha256: assertSha256(entry.expectedPreviousSha256, `${label}.expectedPreviousSha256`),
      };
    }
    if (action !== "add" && action !== "replace") {
      fail("DEVELOPMENT_ASSEMBLY_ACTION_INVALID", `${candidateId}:${String(action)}`);
    }
    assertExactKeys(
      entry,
      new Set(["action", "path", "expectedPreviousSha256", "sizeBytes", "sha256"]),
      new Set(["action", "path", "expectedPreviousSha256", "sizeBytes", "sha256"]),
      label,
    );
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_FILE_BYTES) {
      fail("DEVELOPMENT_ASSEMBLY_FILE_SIZE_INVALID", filePath);
    }
    totalWriteBytes += entry.sizeBytes;
    if (!Number.isSafeInteger(totalWriteBytes) || totalWriteBytes > MAX_TOTAL_WRITE_BYTES) {
      fail("DEVELOPMENT_ASSEMBLY_PACKAGE_TOO_LARGE", candidateId);
    }
    const targetSha256 = assertSha256(entry.sha256, `${label}.sha256`);
    if (action === "add" && entry.expectedPreviousSha256 !== null) {
      fail("DEVELOPMENT_ASSEMBLY_ADD_PREVIOUS_HASH_MUST_BE_NULL", filePath);
    }
    if (action === "replace" && entry.expectedPreviousSha256 === null) {
      fail("DEVELOPMENT_ASSEMBLY_REPLACE_PREVIOUS_HASH_REQUIRED", filePath);
    }
    const expectedPreviousSha256 = entry.expectedPreviousSha256 === null
      ? null
      : assertSha256(entry.expectedPreviousSha256, `${label}.expectedPreviousSha256`);
    if (action === "replace" && expectedPreviousSha256 === targetSha256) {
      fail("DEVELOPMENT_ASSEMBLY_REPLACE_NO_CHANGE", filePath);
    }
    return {
      action,
      path: filePath,
      expectedPreviousSha256,
      sizeBytes: entry.sizeBytes,
      sha256: targetSha256,
    };
  });
  assertNoPathCollisions(operations);
  for (let index = 1; index < operations.length; index += 1) {
    if (bytewiseCompare(operations[index - 1].path, operations[index].path) >= 0) {
      fail("DEVELOPMENT_ASSEMBLY_OPERATION_ORDER_INVALID", operations[index].path);
    }
  }

  const basic = {
    schema: versioned ? DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA : DEVELOPMENT_PACKAGE_SCHEMA,
    candidateId,
    targetVersion: raw.targetVersion,
    createdAt,
    requires,
    operations,
    resultingTreeSha256: assertSha256(raw.resultingTreeSha256, "manifest.resultingTreeSha256"),
  };
  if (!versioned) return Object.freeze(basic);
  let development;
  try {
    development = normalizeDevelopmentMetadata({
      baseVersion: raw.baseVersion,
      branch: raw.branch,
      devNumber: raw.devNumber,
      displayVersion: raw.displayVersion,
      targetVersion: raw.targetVersion,
      requires,
      dependencies: raw.dependencies,
      operations,
      changedFiles: raw.changedFiles,
      conflicts: raw.conflicts,
    }, { requireChangedFiles: true });
  } catch (error) {
    fail(error?.code || "DEVELOPMENT_VERSION_METADATA_INVALID", error?.detail || error?.message || "manifest");
  }
  if (development.displayVersion !== raw.targetVersion) {
    fail("DEVELOPMENT_ASSEMBLY_DEVELOPMENT_VERSION_MISMATCH", candidateId);
  }
  if (stableDevelopmentVersioningJson(development.dependencies)
    !== stableDevelopmentVersioningJson(requires)) {
    fail("DEVELOPMENT_ASSEMBLY_DEPENDENCIES_MISMATCH", candidateId);
  }
  return Object.freeze({
    ...basic,
    baseVersion: development.baseVersion,
    branch: development.branch,
    devNumber: development.devNumber,
    displayVersion: development.displayVersion,
    changedFiles: development.changedFiles,
    dependencies: development.dependencies,
    conflicts: development.conflicts,
    development,
  });
}

export function parseApprovedDevelopmentChain(raw, { allowUnresolvedFinal = false } = {}) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "targetVersion", "baseVersion", "baseTreeSha256", "entries",
      "finalTreeSha256", "updatedAt", "chainMac", "chainSha256",
    ]),
    new Set([
      "schema", "targetVersion", "baseVersion", "baseTreeSha256", "entries",
      "finalTreeSha256", "updatedAt", "chainMac", "chainSha256",
    ]),
    "chain",
  );
  if (raw.schema !== DEVELOPMENT_CHAIN_SCHEMA) {
    fail("DEVELOPMENT_ASSEMBLY_CHAIN_SCHEMA_UNSUPPORTED", String(raw.schema));
  }
  for (const [label, value] of [["targetVersion", raw.targetVersion], ["baseVersion", raw.baseVersion]]) {
    if (typeof value !== "string" || !VERSION.test(value)) {
      fail("DEVELOPMENT_ASSEMBLY_VERSION_INVALID", `chain.${label}`);
    }
  }
  if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_OPERATIONS) {
    fail("DEVELOPMENT_ASSEMBLY_CHAIN_ENTRIES_INVALID");
  }
  const used = new Set();
  const entries = raw.entries.map((entry, index) => {
    const label = `chain.entries[${index}]`;
    assertExactKeys(
      entry,
      new Set([
        "candidateId", "packageSha256", "receiptSha256", "manifestSha256",
        "requires", "resultingTreeSha256",
      ]),
      new Set([
        "candidateId", "packageSha256", "receiptSha256", "manifestSha256",
        "requires", "resultingTreeSha256",
      ]),
      label,
    );
    const candidateId = normalizeCandidateId(entry.candidateId, `${label}.candidateId`);
    if (used.has(candidateId)) fail("DEVELOPMENT_ASSEMBLY_CHAIN_ENTRY_DUPLICATE", candidateId);
    used.add(candidateId);
    return {
      candidateId,
      packageSha256: assertSha256(entry.packageSha256, `${label}.packageSha256`),
      receiptSha256: assertSha256(entry.receiptSha256, `${label}.receiptSha256`),
      manifestSha256: assertSha256(entry.manifestSha256, `${label}.manifestSha256`),
      requires: normalizeDependencies(entry.requires, `${label}.requires`),
      resultingTreeSha256: assertSha256(entry.resultingTreeSha256, `${label}.resultingTreeSha256`),
    };
  });
  const finalTreeSha256 = raw.finalTreeSha256 === null && allowUnresolvedFinal
    ? null
    : assertSha256(raw.finalTreeSha256, "chain.finalTreeSha256");
  if (finalTreeSha256 !== null && entries.at(-1).resultingTreeSha256 !== finalTreeSha256) {
    fail("DEVELOPMENT_ASSEMBLY_CHAIN_FINAL_ENTRY_MISMATCH", entries.at(-1).candidateId);
  }
  return Object.freeze({
    schema: DEVELOPMENT_CHAIN_SCHEMA,
    targetVersion: raw.targetVersion,
    baseVersion: raw.baseVersion,
    baseTreeSha256: assertSha256(raw.baseTreeSha256, "chain.baseTreeSha256"),
    entries,
    finalTreeSha256,
    updatedAt: normalizeTimestamp(raw.updatedAt, "chain.updatedAt"),
    chainMac: assertSha256(raw.chainMac, "chain.chainMac"),
    chainSha256: assertSha256(raw.chainSha256, "chain.chainSha256"),
  });
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRealDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code, target);
  return state;
}

export async function collectDevelopmentTree(root, { onProgress } = {}) {
  const resolvedRoot = path.resolve(root);
  await assertRealDirectory(resolvedRoot, "DEVELOPMENT_ASSEMBLY_TREE_ROOT_INVALID");
  const pending = [];
  const files = [];
  const usedPaths = new Map();
  const progress = (phase, count, total, bytes) => onProgress?.({phase, files:count, total, bytes});
  progress('scan', 0, 0, 0);
  const visit = async (directory, relativeDirectory = "") => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const normalizedPath = normalizeRelativePath(relativePath, "tree.path");
      const key = windowsPathKey(normalizedPath);
      const previous = usedPaths.get(key);
      if (previous) fail("DEVELOPMENT_ASSEMBLY_TREE_PATH_COLLISION", `${previous}:${normalizedPath}`);
      usedPaths.set(key, normalizedPath);
      const absolutePath = path.join(directory, child.name);
      const state = await fs.lstat(absolutePath);
      if (state.isSymbolicLink()) fail("DEVELOPMENT_ASSEMBLY_TREE_SYMLINK_FORBIDDEN", normalizedPath);
      if (state.isDirectory()) { await visit(absolutePath, normalizedPath); continue; }
      if (!state.isFile() || state.nlink > 1) fail("DEVELOPMENT_ASSEMBLY_TREE_FILE_UNSAFE", normalizedPath);
      pending.push({absolutePath, normalizedPath, state});
      if (pending.length % 128 === 0) progress('scan', pending.length, 0, 0);
    }
  };
  await visit(resolvedRoot);
  progress('hash', 0, pending.length, 0);
  let next = 0, bytes = 0, failure;
  const stable = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1
    && a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  await Promise.all(Array.from({length:Math.min(4, pending.length)}, async () => {
    while (!failure && next < pending.length) {
      const {absolutePath, normalizedPath, state} = pending[next++];
      let handle;
      try {
        handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        if (!stable(state, await handle.stat())) fail('DEVELOPMENT_ASSEMBLY_TREE_CHANGED_DURING_READ', normalizedPath);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let length = 0;
        for (;;) {
          const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          length += bytesRead;
          if (length > state.size) fail('DEVELOPMENT_ASSEMBLY_TREE_CHANGED_DURING_READ', normalizedPath);
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (length !== state.size || !stable(state, await handle.stat()) || !stable(state, await fs.lstat(absolutePath))) {
          fail('DEVELOPMENT_ASSEMBLY_TREE_CHANGED_DURING_READ', normalizedPath);
        }
        files.push({path:normalizedPath, sizeBytes:length, sha256:hash.digest('hex')});
        bytes += length;
        if (files.length % 64 === 0 || files.length === pending.length) progress('hash', files.length, pending.length, bytes);
      } catch (error) { failure ||= error; }
      finally { try { await handle?.close(); } catch (error) { failure ||= error; } }
    }
  }));
  if (failure) throw failure;
  files.sort((left, right) => bytewiseCompare(left.path, right.path));
  return Object.freeze({root:resolvedRoot, files:Object.freeze(files.map(entry => Object.freeze(entry))), treeSha256:sha256(stableStringify(files))});
}

function payloadObjectRelativePath(digest) {
  return `payload/sha256/${digest.slice(0, 2)}/${digest}`;
}

async function findSinglePackageManifest(extractedRoot) {
  const matches = [];
  const visit = async (directory) => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const target = path.join(directory, child.name);
      if (child.isDirectory()) await visit(target);
      else if (child.isFile() && child.name === DEVELOPMENT_PACKAGE_MANIFEST_NAME) matches.push(target);
    }
  };
  await visit(extractedRoot);
  if (matches.length !== 1) {
    fail("DEVELOPMENT_ASSEMBLY_PACKAGE_MANIFEST_COUNT_INVALID", String(matches.length));
  }
  return matches[0];
}

async function readManifestFile(manifestPath) {
  const state = await fs.lstat(manifestPath);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1 || state.size > MAX_MANIFEST_BYTES) {
    fail("DEVELOPMENT_ASSEMBLY_PACKAGE_MANIFEST_FILE_INVALID", manifestPath);
  }
  const bytes = await fs.readFile(manifestPath);
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    fail("DEVELOPMENT_ASSEMBLY_PACKAGE_MANIFEST_JSON_INVALID", manifestPath, { cause });
  }
  return { manifest: parseDevelopmentPackageManifest(raw), manifestSha256: sha256(bytes) };
}

async function verifyPackageEnvelope(packageRoot, manifest) {
  const inventory = await collectDevelopmentTree(packageRoot);
  const expectedFiles = new Set([DEVELOPMENT_PACKAGE_MANIFEST_NAME]);
  for (const operation of manifest.operations) {
    if (operation.action !== "delete") expectedFiles.add(payloadObjectRelativePath(operation.sha256));
  }
  const actualFiles = new Set(inventory.files.map((entry) => entry.path));
  for (const expected of expectedFiles) {
    if (!actualFiles.has(expected)) fail("DEVELOPMENT_ASSEMBLY_PAYLOAD_OBJECT_MISSING", expected);
  }
  for (const actual of actualFiles) {
    if (!expectedFiles.has(actual)) fail("DEVELOPMENT_ASSEMBLY_PACKAGE_ENTRY_UNDECLARED", actual);
  }
  const actualByPath = new Map(inventory.files.map((entry) => [entry.path, entry]));
  for (const operation of manifest.operations) {
    if (operation.action === "delete") continue;
    const payloadPath = payloadObjectRelativePath(operation.sha256);
    const payload = actualByPath.get(payloadPath);
    if (payload.sha256 !== operation.sha256 || payload.sizeBytes !== operation.sizeBytes) {
      fail("DEVELOPMENT_ASSEMBLY_PAYLOAD_OBJECT_INVALID", `${manifest.candidateId}:${operation.path}`);
    }
  }
  return inventory;
}

export async function readDevelopmentPackageDescriptor(packagePath, options = {}) {
  const resolvedPackagePath = path.resolve(packagePath);
  const state = await lstatOrNull(resolvedPackagePath);
  if (!state || state.isSymbolicLink()) fail("DEVELOPMENT_ASSEMBLY_PACKAGE_INVALID", resolvedPackagePath);

  let packageRoot;
  let packageSha256;
  let temporaryRoot = null;
  let cleanupRoot = null;
  if (state.isFile()) {
    if (state.nlink > 1) fail("DEVELOPMENT_ASSEMBLY_PACKAGE_FILE_UNSAFE", resolvedPackagePath);
    packageSha256 = await sha256File(resolvedPackagePath);
    if (options.temporaryRoot) {
      temporaryRoot = path.resolve(options.temporaryRoot);
      cleanupRoot = temporaryRoot;
    } else {
      cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-development-package-"));
      temporaryRoot = path.join(cleanupRoot, "extracted");
    }
    if (options.temporaryRoot) {
      if (await lstatOrNull(temporaryRoot)) fail("DEVELOPMENT_ASSEMBLY_TEMPORARY_ROOT_EXISTS", temporaryRoot);
    }
    try {
      await extractUpdateZip(resolvedPackagePath, temporaryRoot);
      if (await sha256File(resolvedPackagePath) !== packageSha256) {
        fail("DEVELOPMENT_ASSEMBLY_PACKAGE_CHANGED_DURING_READ", resolvedPackagePath);
      }
      const manifestPath = await findSinglePackageManifest(temporaryRoot);
      packageRoot = path.dirname(manifestPath);
    } catch (error) {
      await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } else if (state.isDirectory()) {
    packageRoot = resolvedPackagePath;
    packageSha256 = options.packageSha256 || null;
    if (packageSha256 !== null) assertSha256(packageSha256, "options.packageSha256");
  } else {
    fail("DEVELOPMENT_ASSEMBLY_PACKAGE_INVALID", resolvedPackagePath);
  }

  try {
    const manifestPath = path.join(packageRoot, DEVELOPMENT_PACKAGE_MANIFEST_NAME);
    const { manifest, manifestSha256 } = await readManifestFile(manifestPath);
    const packageInventory = await verifyPackageEnvelope(packageRoot, manifest);
    if (temporaryRoot) {
      const extractedInventory = await collectDevelopmentTree(temporaryRoot);
      const relativePackageRoot = path.relative(temporaryRoot, packageRoot).split(path.sep).join("/");
      const expectedExtractedPaths = packageInventory.files.map((entry) => (
        relativePackageRoot ? `${relativePackageRoot}/${entry.path}` : entry.path
      ));
      if (
        expectedExtractedPaths.length !== extractedInventory.files.length
        || expectedExtractedPaths.some((entry, index) => entry !== extractedInventory.files[index].path)
      ) fail("DEVELOPMENT_ASSEMBLY_PACKAGE_OUTER_ENTRY_UNDECLARED");
    }
    return Object.freeze({
      candidateId: manifest.candidateId,
      packagePath: resolvedPackagePath,
      packageRoot,
      packageSha256,
      manifestSha256,
      manifest,
      async dispose() {
        if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function copyInventory(sourceRoot, targetRoot, inventory) {
  await fs.mkdir(targetRoot, { recursive: false });
  for (const entry of inventory.files) {
    const source = path.join(sourceRoot, ...entry.path.split("/"));
    const target = path.join(targetRoot, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    await fs.chmod(target, 0o644).catch(() => {});
    const state = await fs.lstat(target);
    if (!state.isFile() || state.isSymbolicLink() || state.size !== entry.sizeBytes || await sha256File(target) !== entry.sha256) {
      fail("DEVELOPMENT_ASSEMBLY_BASE_COPY_INVALID", entry.path);
    }
  }
}

function descriptorFor(descriptors, candidateId) {
  const descriptor = descriptors instanceof Map
    ? descriptors.get(candidateId)
    : descriptors?.[candidateId];
  if (!descriptor) fail("DEVELOPMENT_ASSEMBLY_PACKAGE_NOT_AVAILABLE", candidateId);
  return descriptor;
}

function dependenciesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function resolveApplicationOrder(chain, descriptors) {
  const chainById = new Map(chain.entries.map((entry) => [entry.candidateId, entry]));
  const applied = new Set();
  const visiting = new Set();
  const order = [];

  const visit = (candidateId, expectedPackageSha256, dependencyOf = null) => {
    if (applied.has(candidateId)) {
      const existing = order.find((entry) => entry.candidateId === candidateId);
      if (existing.packageSha256 !== expectedPackageSha256) {
        fail("DEVELOPMENT_ASSEMBLY_DEPENDENCY_HASH_CONFLICT", candidateId);
      }
      return;
    }
    if (visiting.has(candidateId)) fail("DEVELOPMENT_ASSEMBLY_DEPENDENCY_CYCLE", candidateId);
    visiting.add(candidateId);
    const descriptor = descriptorFor(descriptors, candidateId);
    if (descriptor.packageSha256 !== expectedPackageSha256) {
      fail("DEVELOPMENT_ASSEMBLY_PACKAGE_HASH_MISMATCH", candidateId);
    }
    if (descriptor.manifest.candidateId !== candidateId) {
      fail("DEVELOPMENT_ASSEMBLY_PACKAGE_ID_MISMATCH", candidateId);
    }
    const versioned = descriptor.manifest.schema === DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA;
    if (versioned && descriptor.manifest.baseVersion !== chain.baseVersion) {
      fail(
        "DEVELOPMENT_ASSEMBLY_BASE_VERSION_MISMATCH",
        `${candidateId}:${descriptor.manifest.baseVersion}:${chain.baseVersion}`,
      );
    }
    if (!versioned && descriptor.manifest.targetVersion !== chain.targetVersion) {
      fail(
        "DEVELOPMENT_ASSEMBLY_PACKAGE_TARGET_VERSION_MISMATCH",
        `${candidateId}:${descriptor.manifest.targetVersion}:${chain.targetVersion}`,
      );
    }
    const chainEntry = chainById.get(candidateId);
    if (chainEntry) {
      if (descriptor.status !== "approved") {
        fail("DEVELOPMENT_ASSEMBLY_CHAIN_PACKAGE_NOT_APPROVED", candidateId);
      }
      if (
        descriptor.receiptSha256 !== chainEntry.receiptSha256
        || descriptor.manifestSha256 !== chainEntry.manifestSha256
        || descriptor.manifest.resultingTreeSha256 !== chainEntry.resultingTreeSha256
        || !dependenciesEqual(descriptor.manifest.requires, chainEntry.requires)
      ) fail("DEVELOPMENT_ASSEMBLY_CHAIN_BINDING_MISMATCH", candidateId);
    } else {
      if (!dependencyOf) fail("DEVELOPMENT_ASSEMBLY_UNAPPROVED_PACKAGE_NOT_EXPLICIT_DEPENDENCY", candidateId);
      if (!new Set(["approved", "rejected", "failed"]).has(descriptor.status)) {
        fail("DEVELOPMENT_ASSEMBLY_DEPENDENCY_STATUS_INVALID", `${candidateId}:${String(descriptor.status)}`);
      }
    }
    for (const dependency of descriptor.manifest.requires) {
      visit(dependency.candidateId, dependency.packageSha256, candidateId);
    }
    visiting.delete(candidateId);
    applied.add(candidateId);
    order.push({
      candidateId,
      packageSha256: expectedPackageSha256,
      descriptor,
      status: descriptor.status,
      includedAs: chainEntry ? "approved" : "explicit-dependency",
      dependencyOf,
    });
  };

  for (const entry of chain.entries) visit(entry.candidateId, entry.packageSha256);
  const resolvedApprovedOrder = order
    .filter((entry) => entry.includedAs === "approved")
    .map((entry) => entry.candidateId);
  if (stableStringify(resolvedApprovedOrder) !== stableStringify(chain.entries.map((entry) => entry.candidateId))) {
    fail("DEVELOPMENT_ASSEMBLY_APPROVED_ORDER_CHANGED_BY_DEPENDENCY");
  }
  return order;
}

async function applyPackage(stagingRoot, descriptor, { validateResultTree = true } = {}) {
  const manifest = descriptor.manifest;
  for (const operation of manifest.operations) {
    const target = path.join(stagingRoot, ...operation.path.split("/"));
    const state = await lstatOrNull(target);
    if (state && (!state.isFile() || state.isSymbolicLink() || state.nlink > 1)) {
      fail("DEVELOPMENT_ASSEMBLY_TARGET_FILE_UNSAFE", operation.path);
    }
    if (operation.action === "add") {
      if (state) fail("DEVELOPMENT_ASSEMBLY_ADD_TARGET_EXISTS", operation.path);
    } else {
      if (!state) fail("DEVELOPMENT_ASSEMBLY_PREVIOUS_FILE_MISSING", operation.path);
      const previousSha256 = await sha256File(target);
      if (previousSha256 !== operation.expectedPreviousSha256) {
        fail("DEVELOPMENT_ASSEMBLY_PREVIOUS_HASH_MISMATCH", `${manifest.candidateId}:${operation.path}`);
      }
    }

    if (operation.action === "delete") {
      await fs.unlink(target);
      continue;
    }
    const payload = path.join(descriptor.packageRoot, ...payloadObjectRelativePath(operation.sha256).split("/"));
    const payloadState = await fs.lstat(payload);
    if (
      !payloadState.isFile()
      || payloadState.isSymbolicLink()
      || payloadState.nlink > 1
      || payloadState.size !== operation.sizeBytes
      || await sha256File(payload) !== operation.sha256
    ) fail("DEVELOPMENT_ASSEMBLY_PAYLOAD_OBJECT_INVALID", `${manifest.candidateId}:${operation.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporaryTarget = `${target}.bonni-${randomUUID()}.partial`;
    try {
      await fs.copyFile(payload, temporaryTarget, fsConstants.COPYFILE_EXCL);
      await fs.chmod(temporaryTarget, 0o644).catch(() => {});
      if (operation.action === "replace") await fs.unlink(target);
      await fs.rename(temporaryTarget, target);
    } catch (error) {
      await fs.rm(temporaryTarget, { force: true }).catch(() => {});
      throw error;
    }
  }
  const result = await collectDevelopmentTree(stagingRoot);
  if (validateResultTree && result.treeSha256 !== manifest.resultingTreeSha256) {
    fail("DEVELOPMENT_ASSEMBLY_PACKAGE_RESULT_TREE_MISMATCH", manifest.candidateId);
  }
  return result;
}

function assertSeparateRoots(baseRoot, stagingRoot, expectedFinalRoot) {
  const base = path.resolve(baseRoot);
  const staging = path.resolve(stagingRoot);
  const expected = expectedFinalRoot ? path.resolve(expectedFinalRoot) : null;
  const overlaps = (left, right) => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
  if (overlaps(base, staging) || (expected && overlaps(staging, expected))) {
    fail("DEVELOPMENT_ASSEMBLY_ROOTS_OVERLAP");
  }
}

async function assembleDevelopmentTree({
  baseRoot,
  baseInventory = null,
  stagingRoot,
  chain: rawChain,
  packageDescriptors,
  expectedFinalRoot = null,
}, { requireReviewedTree }) {
  if (requireReviewedTree && !expectedFinalRoot) fail("DEVELOPMENT_ASSEMBLY_REVIEWED_TREE_REQUIRED");
  const chain = parseApprovedDevelopmentChain(rawChain, { allowUnresolvedFinal: !requireReviewedTree });
  assertSeparateRoots(baseRoot, stagingRoot, expectedFinalRoot);
  const resolvedStaging = path.resolve(stagingRoot);
  if (await lstatOrNull(resolvedStaging)) fail("DEVELOPMENT_ASSEMBLY_STAGING_EXISTS", resolvedStaging);
  const base = baseInventory && path.resolve(baseInventory.root || "") === path.resolve(baseRoot)
    ? baseInventory
    : await collectDevelopmentTree(baseRoot);
  if (base.treeSha256 !== chain.baseTreeSha256) {
    fail("DEVELOPMENT_ASSEMBLY_BASE_TREE_MISMATCH", `${base.treeSha256}:${chain.baseTreeSha256}`);
  }
  const applicationOrder = resolveApplicationOrder(chain, packageDescriptors);
  const versionedPackages = applicationOrder
    .filter((entry) => entry.descriptor.manifest.schema === DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA)
    .map((entry) => ({
      ...entry.descriptor,
      candidateId: entry.candidateId,
      packageSha256: entry.packageSha256,
    }));
  const developmentMerge = versionedPackages.length
    ? detectDevelopmentBranchConflicts(versionedPackages, { baseVersion: chain.baseVersion })
    : null;
  if (developmentMerge && !developmentMerge.mergeable) {
    const detail = developmentMerge.conflicts
      .map((entry) => `${entry.path}[${entry.branches.join(",")}]`)
      .join(",");
    fail("DEVELOPMENT_ASSEMBLY_BRANCH_CONFLICT", detail);
  }
  const temporaryStaging = path.join(
    path.dirname(resolvedStaging),
    `.${path.basename(resolvedStaging)}.${randomUUID()}.partial`,
  );
  let branchValidationRoot = null;
  await fs.mkdir(path.dirname(resolvedStaging), { recursive: true });
  try {
    await copyInventory(base.root, temporaryStaging, base);
    if (versionedPackages.length) {
      // Versioned DEV packages describe a branch result relative to the
      // common base. Validate each branch on its own copy first; the final
      // staging tree below may contain other, non-conflicting branches and
      // therefore cannot equal every package's branch-local tree hash.
      branchValidationRoot = path.join(
        path.dirname(resolvedStaging),
        `.${path.basename(resolvedStaging)}.${randomUUID()}.branches.partial`,
      );
      await fs.mkdir(branchValidationRoot, { recursive: false });
      const branchRoots = new Map();
      for (const entry of applicationOrder) {
        if (entry.descriptor.manifest.schema !== DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA) continue;
        const branch = entry.descriptor.manifest.development.branch;
        let branchRoot = branchRoots.get(branch);
        if (!branchRoot) {
          branchRoot = path.join(branchValidationRoot, branch);
          await copyInventory(base.root, branchRoot, base);
          branchRoots.set(branch, branchRoot);
        }
        await applyPackage(branchRoot, entry.descriptor);
      }
      await fs.rm(branchValidationRoot, { recursive: true, force: true });
      branchValidationRoot = null;
    }
    let current = base;
    for (const entry of applicationOrder) {
      current = await applyPackage(temporaryStaging, entry.descriptor, {
        validateResultTree: entry.descriptor.manifest.schema !== DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA,
      });
    }
    if (chain.finalTreeSha256 !== null && current.treeSha256 !== chain.finalTreeSha256) {
      fail("DEVELOPMENT_ASSEMBLY_FINAL_TREE_MISMATCH", `${current.treeSha256}:${chain.finalTreeSha256}`);
    }
    if (expectedFinalRoot) {
      const expected = await collectDevelopmentTree(expectedFinalRoot);
      if (
        expected.treeSha256 !== current.treeSha256
        || stableStringify(expected.files) !== stableStringify(current.files)
      ) fail("DEVELOPMENT_ASSEMBLY_REVIEWED_TREE_MISMATCH");
    }
    await fs.rename(temporaryStaging, resolvedStaging);
    return Object.freeze({
      stagingRoot: resolvedStaging,
      baseTreeSha256: base.treeSha256,
      finalTreeSha256: current.treeSha256,
      fileCount: current.files.length,
      totalBytes: current.files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      developmentMerge,
      appliedPackages: Object.freeze(applicationOrder.map((entry) => Object.freeze({
        candidateId: entry.candidateId,
        packageSha256: entry.packageSha256,
        status: entry.status,
        includedAs: entry.includedAs,
        dependencyOf: entry.dependencyOf,
      }))),
    });
  } catch (error) {
    await fs.rm(branchValidationRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(temporaryStaging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function assembleApprovedDevelopmentRelease(options) {
  return assembleDevelopmentTree(options, { requireReviewedTree: true });
}

export async function assembleDevelopmentTestTree(options) {
  return assembleDevelopmentTree(
    { ...options, expectedFinalRoot: null },
    { requireReviewedTree: false },
  );
}
