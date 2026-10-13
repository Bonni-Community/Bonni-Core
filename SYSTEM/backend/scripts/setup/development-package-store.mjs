import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assembleDevelopmentTestTree,
  collectDevelopmentTree,
  readDevelopmentPackageDescriptor,
} from "../development/release-assembly.mjs";

export const DEVELOPMENT_REVIEW_SCHEMA = "bonni.development-review/v1";
export const DEVELOPMENT_CHAIN_SCHEMA = "bonni.development-chain/v1";
export const DEVELOPMENT_CLEANUP_PLAN_SCHEMA = "bonni.development-cleanup-plan/v1";
export const DEVELOPMENT_TRASH_SCHEMA = "bonni.development-trash/v1";
export const DEVELOPMENT_DELETION_SCHEMA = "bonni.development-package-deletion/v1";
export const DEVELOPMENT_TEST_READY_SCHEMA = "bonni.development-test-ready/v1";
export const DEVELOPMENT_REVIEW_TRANSACTION_SCHEMA = "bonni.development-review-transaction/v1";

export const DEVELOPMENT_REVIEW_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "failed",
]);

const FINAL_REVIEW_STATUSES = new Set(["approved", "rejected", "failed"]);
const STATUS_DIRECTORY_NAMES = Object.freeze({
  pending: "PENDING",
  approved: "APPROVED",
  rejected: "REJECTED",
  failed: "FAILED",
});
const STATUS_BY_DIRECTORY_NAME = new Map(
  Object.entries(STATUS_DIRECTORY_NAMES).map(([status, directory]) => [directory, status]),
);
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STORED_PACKAGE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._+-]{0,127})--([a-f0-9]{64})\.zip$/u;
const RECEIPT_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._+-]{0,127})--([a-f0-9]{64})--([0-9]{4})-(pending|approved|rejected|failed)\.json$/u;
const DELETION_FILE_PATTERN = /^DELETED--([A-Za-z0-9][A-Za-z0-9._+-]{0,127})--([a-f0-9]{64})\.json$/u;
const TEST_READY_FILE_PATTERN = /^TEST-READY--([A-Za-z0-9][A-Za-z0-9._+-]{0,127})--([a-f0-9]{64})\.json$/u;
const REVIEW_TRANSACTION_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._+-]{0,127})--([a-f0-9]{64})--([a-f0-9]{64})\.json$/u;
const TRASH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u;
const MAXIMUM_RECEIPT_BYTES = 1024 * 1024;
const MAXIMUM_TRANSACTION_BYTES = 16 * 1024 * 1024;
const MAXIMUM_NOTE_BYTES = 16 * 1024;
const MAXIMUM_REVIEWER_BYTES = 512;
const MINIMUM_SIGNING_KEY_BYTES = 32;
const DEFAULT_TRASH_RETENTION_MS = 14 * 24 * 60 * 60_000;
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EACCES",
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);

export class DevelopmentPackageStoreError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "DevelopmentPackageStoreError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new DevelopmentPackageStoreError(code, detail, options);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function asSigningKey(value) {
  const key = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value ?? ""), "utf8");
  if (key.length < MINIMUM_SIGNING_KEY_BYTES) {
    fail("DEVELOPMENT_RECEIPT_SIGNING_KEY_REQUIRED");
  }
  return key;
}

function signedEnvelope(core, key, macField, hashField) {
  const mac = createHmac("sha256", key).update(stableStringify(core)).digest("hex");
  const withMac = { ...core, [macField]: mac };
  return { ...withMac, [hashField]: sha256(stableStringify(withMac)) };
}

function verifySignedEnvelope(value, key, macField, hashField, invalidCode) {
  if (!isPlainObject(value)) fail(invalidCode);
  const actualHash = value[hashField];
  const actualMac = value[macField];
  if (!isHash(actualHash) || !isHash(actualMac)) fail(invalidCode);
  const withMac = { ...value };
  delete withMac[hashField];
  if (sha256(stableStringify(withMac)) !== actualHash) fail(invalidCode);
  const core = { ...withMac };
  delete core[macField];
  const expectedMac = createHmac("sha256", key).update(stableStringify(core)).digest("hex");
  if (expectedMac !== actualMac) fail(invalidCode);
  return core;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, code, detail) {
  if (!isPlainObject(value)) fail(code, detail);
  const actual = Object.keys(value).sort(bytewiseCompare);
  const wanted = [...expected].sort(bytewiseCompare);
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail(code, detail);
  }
}

function isHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function assertHash(value, code, detail = "") {
  if (!isHash(value)) fail(code, detail);
  return value;
}

function assertNullableHash(value, code, detail = "") {
  if (value !== null && !isHash(value)) fail(code, detail);
  return value;
}

function assertCandidateId(value) {
  if (typeof value !== "string" || !CANDIDATE_ID_PATTERN.test(value) || value !== value.normalize("NFC")) {
    fail("DEVELOPMENT_CANDIDATE_ID_INVALID", String(value));
  }
  return value;
}

function assertVersion(value, label) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value) || value !== value.normalize("NFC")) {
    fail("DEVELOPMENT_VERSION_INVALID", label);
  }
  return value;
}

function assertStatus(value, { finalOnly = false } = {}) {
  if (!DEVELOPMENT_REVIEW_STATUSES.includes(value) || (finalOnly && !FINAL_REVIEW_STATUSES.has(value))) {
    fail("DEVELOPMENT_REVIEW_STATUS_INVALID", String(value));
  }
  return value;
}

function assertCanonicalTimestamp(value, code) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail(code);
  return value;
}

function timestamp(now = () => new Date()) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("DEVELOPMENT_TIME_INVALID");
  return date.toISOString();
}

function assertHumanText(value, code, maxBytes, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(code);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function normalizeRequires(value) {
  if (!Array.isArray(value) || value.length > 1_000) fail("DEVELOPMENT_REQUIRES_INVALID");
  const normalized = value.map((entry, index) => {
    assertExactKeys(
      entry,
      new Set(["candidateId", "packageSha256"]),
      "DEVELOPMENT_REQUIRES_INVALID",
      String(index),
    );
    return {
      candidateId: assertCandidateId(entry.candidateId),
      packageSha256: assertHash(entry.packageSha256, "DEVELOPMENT_REQUIRES_INVALID", String(index)),
    };
  }).sort((left, right) => {
    const candidateOrder = bytewiseCompare(left.candidateId, right.candidateId);
    return candidateOrder || bytewiseCompare(left.packageSha256, right.packageSha256);
  });
  const identities = new Set();
  for (const dependency of normalized) {
    const identity = `${dependency.candidateId}\0${dependency.packageSha256}`;
    if (identities.has(identity)) fail("DEVELOPMENT_REQUIRES_DUPLICATE", dependency.candidateId);
    identities.add(identity);
  }
  return normalized;
}

function normalizeCandidateSet(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("DEVELOPMENT_CANDIDATE_SET_INVALID", label);
  return [...new Set(value.map(assertCandidateId))].sort(bytewiseCompare);
}

function sameRequires(left, right) {
  return stableStringify(normalizeRequires(left)) === stableStringify(normalizeRequires(right));
}

function portableRelative(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("DEVELOPMENT_PATH_ESCAPE", target);
  }
  return relative.split(path.sep).join("/");
}

function containedPath(root, relativePath) {
  if (
    typeof relativePath !== "string"
    || !relativePath
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || relativePath.includes("//")
  ) fail("DEVELOPMENT_RELATIVE_PATH_INVALID");
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("DEVELOPMENT_RELATIVE_PATH_INVALID");
  }
  const target = path.resolve(root, ...segments);
  portableRelative(root, target);
  return target;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const state = await lstatOrNull(cursor);
    if (!state) return;
    if (state.isSymbolicLink()) fail("DEVELOPMENT_SYMLINK_FORBIDDEN", cursor);
  }
}

async function assertPlainDirectory(target, code = "DEVELOPMENT_DIRECTORY_MISSING") {
  await assertNoSymlinkComponents(target);
  const state = await lstatOrNull(target);
  if (!state) fail(code, target);
  if (!state.isDirectory() || state.isSymbolicLink()) fail("DEVELOPMENT_DIRECTORY_UNSAFE", target);
  return state;
}

async function ensurePlainDirectory(parent, name) {
  await assertPlainDirectory(parent);
  const target = path.join(parent, name);
  const state = await lstatOrNull(target);
  if (!state) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await assertPlainDirectory(target);
  return target;
}

async function assertRegularFile(target, code, { expectedSize = undefined } = {}) {
  await assertNoSymlinkComponents(target);
  const state = await lstatOrNull(target);
  if (!state) fail(code, target);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) fail("DEVELOPMENT_FILE_UNSAFE", target);
  if (expectedSize !== undefined && state.size !== expectedSize) fail("DEVELOPMENT_PACKAGE_SIZE_MISMATCH", target);
  return state;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!(process.platform === "win32" && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeExclusiveSynced(target, contents, mode = 0o600) {
  await assertPlainDirectory(path.dirname(target));
  let handle;
  let created = false;
  try {
    handle = await fs.open(target, "wx", mode);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}

async function writeJsonExclusive(target, value) {
  await writeExclusiveSynced(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonAtomic(target, value) {
  const directory = path.dirname(target);
  await assertPlainDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  await writeJsonExclusive(temporary, value);
  try {
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readSmallJson(target, code) {
  return readBoundedJson(target, code, MAXIMUM_RECEIPT_BYTES);
}

async function readBoundedJson(target, code, maximumBytes) {
  const state = await assertRegularFile(target, code);
  if (state.size <= 0 || state.size > maximumBytes) fail(code, target);
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error instanceof DevelopmentPackageStoreError) throw error;
    fail(code, target, { cause: error });
  }
}

function storedPackageName(candidateId, packageSha256) {
  return `${assertCandidateId(candidateId)}--${assertHash(packageSha256, "DEVELOPMENT_PACKAGE_HASH_INVALID")}.zip`;
}

function receiptFileName(candidateId, packageSha256, sequence, status) {
  return `${candidateId}--${packageSha256}--${String(sequence).padStart(4, "0")}-${status}.json`;
}

export function resolveDevelopmentStorePaths(productRoot) {
  if (typeof productRoot !== "string" || !productRoot.trim()) fail("DEVELOPMENT_PRODUCT_ROOT_REQUIRED");
  const root = path.resolve(productRoot, "DEVELOPMENT");
  const packages = path.join(root, "PACKAGES");
  return Object.freeze({
    productRoot: path.resolve(productRoot),
    root,
    current: path.join(root, "CURRENT"),
    previous: path.join(root, "PREVIOUS"),
    bases: path.join(root, "BASES"),
    tests: path.join(root, "TESTS"),
    packages,
    packageDirectories: Object.freeze(Object.fromEntries(
      Object.entries(STATUS_DIRECTORY_NAMES).map(([status, directory]) => [status, path.join(packages, directory)]),
    )),
    receipts: path.join(root, "RECEIPTS"),
    transactions: path.join(root, "TRANSACTIONS"),
    trash: path.join(root, "TRASH"),
    approvedChain: path.join(root, "APPROVED-CHAIN.json"),
    cleanupPlan: path.join(root, "CLEANUP-PLAN.json"),
    localKey: path.resolve(productRoot, "SIGNATUR", "LOCAL", "development-review.key"),
  });
}

export async function initializeDevelopmentStore({ productRoot }) {
  const paths = resolveDevelopmentStorePaths(productRoot);
  await assertPlainDirectory(paths.productRoot, "DEVELOPMENT_PRODUCT_ROOT_MISSING");
  await ensurePlainDirectory(paths.productRoot, "DEVELOPMENT");
  await ensurePlainDirectory(paths.root, "BASES");
  await ensurePlainDirectory(paths.root, "TESTS");
  await ensurePlainDirectory(paths.root, "PACKAGES");
  for (const directory of Object.values(STATUS_DIRECTORY_NAMES)) {
    await ensurePlainDirectory(paths.packages, directory);
  }
  await ensurePlainDirectory(paths.root, "RECEIPTS");
  await ensurePlainDirectory(paths.root, "TRANSACTIONS");
  const recoveryPending = (await fs.readdir(paths.transactions)).some((name) => !name.startsWith("."));
  if (!recoveryPending) {
    await ensurePlainDirectory(paths.root, "CURRENT");
    await ensurePlainDirectory(paths.root, "PREVIOUS");
  }
  await ensurePlainDirectory(paths.root, "TRASH");
  return paths;
}

export async function initializeDevelopmentLocalKey({ productRoot, keyFile = undefined }) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const target = path.resolve(keyFile || paths.localKey);
  let parent;
  if (keyFile === undefined) {
    const signatureRoot = await ensurePlainDirectory(paths.productRoot, "SIGNATUR");
    parent = await ensurePlainDirectory(signatureRoot, "LOCAL");
  } else {
    parent = path.dirname(target);
    await assertNoSymlinkComponents(parent);
    await assertPlainDirectory(parent, "DEVELOPMENT_LOCAL_KEY_PARENT_MISSING");
  }
  const existing = await lstatOrNull(target);
  if (existing) {
    await assertRegularFile(target, "DEVELOPMENT_LOCAL_KEY_INVALID", { expectedSize: 32 });
    return { keyFile: target, created: false };
  }
  await writeExclusiveSynced(target, randomBytes(32));
  return { keyFile: target, created: true };
}

export async function loadDevelopmentLocalKey({ productRoot, keyFile = undefined }) {
  const paths = resolveDevelopmentStorePaths(productRoot);
  const target = path.resolve(keyFile || paths.localKey);
  await assertRegularFile(target, "DEVELOPMENT_LOCAL_KEY_MISSING", { expectedSize: 32 });
  return fs.readFile(target);
}

async function resolveKey(options) {
  const key = options.receiptSigningKey !== undefined
    ? asSigningKey(options.receiptSigningKey)
    : asSigningKey(await loadDevelopmentLocalKey(options));
  const paths = resolveDevelopmentStorePaths(options.productRoot);
  await recoverDevelopmentReviewTransactions(paths, key);
  return key;
}

function receiptCore({
  candidateId,
  packageSha256,
  packageSizeBytes,
  storedName,
  status,
  sequence,
  previousReceiptSha256,
  manifestSha256,
  resultingTreeSha256,
  requires,
  reviewedAt,
  reviewedBy,
  note,
}) {
  return {
    schema: DEVELOPMENT_REVIEW_SCHEMA,
    candidateId: assertCandidateId(candidateId),
    packageSha256: assertHash(packageSha256, "DEVELOPMENT_PACKAGE_HASH_INVALID"),
    packageSizeBytes,
    storedName,
    status: assertStatus(status),
    sequence,
    previousReceiptSha256,
    manifestSha256,
    resultingTreeSha256,
    requires: normalizeRequires(requires),
    reviewedAt,
    reviewedBy,
    note,
  };
}

function createReceipt(input, key) {
  if (!Number.isSafeInteger(input.packageSizeBytes) || input.packageSizeBytes <= 0) {
    fail("DEVELOPMENT_PACKAGE_SIZE_INVALID");
  }
  if (input.storedName !== storedPackageName(input.candidateId, input.packageSha256)) {
    fail("DEVELOPMENT_STORED_NAME_INVALID");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > 9_999) {
    fail("DEVELOPMENT_RECEIPT_SEQUENCE_INVALID");
  }
  if (input.sequence === 1 && input.previousReceiptSha256 !== null) {
    fail("DEVELOPMENT_PREVIOUS_RECEIPT_INVALID");
  }
  if (input.sequence > 1 && !isHash(input.previousReceiptSha256)) {
    fail("DEVELOPMENT_PREVIOUS_RECEIPT_INVALID");
  }
  assertNullableHash(input.manifestSha256, "DEVELOPMENT_MANIFEST_HASH_INVALID");
  assertNullableHash(input.resultingTreeSha256, "DEVELOPMENT_RESULT_TREE_HASH_INVALID");
  assertCanonicalTimestamp(input.reviewedAt, "DEVELOPMENT_REVIEW_TIME_INVALID");
  assertHumanText(input.reviewedBy, "DEVELOPMENT_REVIEWER_INVALID", MAXIMUM_REVIEWER_BYTES);
  assertHumanText(input.note, "DEVELOPMENT_REVIEW_NOTE_INVALID", MAXIMUM_NOTE_BYTES, { allowEmpty: true });
  if (input.status === "approved" && (!input.manifestSha256 || !input.resultingTreeSha256)) {
    fail("DEVELOPMENT_APPROVED_DESCRIPTOR_REQUIRED");
  }
  return signedEnvelope(receiptCore(input), key, "receiptMac", "receiptSha256");
}

function parseReceipt(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "candidateId", "packageSha256", "packageSizeBytes", "storedName", "status",
      "sequence", "previousReceiptSha256", "manifestSha256", "resultingTreeSha256", "requires",
      "reviewedAt", "reviewedBy", "note", "receiptMac", "receiptSha256",
    ]),
    "DEVELOPMENT_RECEIPT_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "receiptMac",
    "receiptSha256",
    "DEVELOPMENT_RECEIPT_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_REVIEW_SCHEMA) fail("DEVELOPMENT_RECEIPT_SCHEMA_UNSUPPORTED");
  const recreated = createReceipt(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_RECEIPT_INVALID");
  return recreated;
}

async function readReceiptFiles(paths, key) {
  await assertPlainDirectory(paths.receipts);
  const names = (await fs.readdir(paths.receipts)).sort(bytewiseCompare);
  const receipts = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (DELETION_FILE_PATTERN.test(name) || TEST_READY_FILE_PATTERN.test(name)) continue;
    const match = RECEIPT_FILE_PATTERN.exec(name);
    if (!match) fail("DEVELOPMENT_RECEIPT_FILE_UNRECOGNIZED", name);
    const receipt = parseReceipt(
      await readSmallJson(path.join(paths.receipts, name), "DEVELOPMENT_RECEIPT_INVALID"),
      key,
    );
    if (
      receipt.candidateId !== match[1]
      || receipt.packageSha256 !== match[2]
      || receipt.sequence !== Number(match[3])
      || receipt.status !== match[4]
    ) fail("DEVELOPMENT_RECEIPT_FILENAME_MISMATCH", name);
    receipts.push({ ...receipt, receiptFile: path.join(paths.receipts, name) });
  }
  return receipts;
}

function groupAndValidateReceipts(receipts) {
  const groups = new Map();
  const candidateHashes = new Map();
  for (const receipt of receipts) {
    const previousHash = candidateHashes.get(receipt.candidateId);
    if (previousHash && previousHash !== receipt.packageSha256) {
      fail("DEVELOPMENT_CANDIDATE_ID_COLLISION", receipt.candidateId);
    }
    candidateHashes.set(receipt.candidateId, receipt.packageSha256);
    const identity = `${receipt.candidateId}\0${receipt.packageSha256}`;
    const group = groups.get(identity) || [];
    group.push(receipt);
    groups.set(identity, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sequence - right.sequence);
    if (group.length > 2) fail("DEVELOPMENT_RECEIPT_TRANSITION_INVALID", group[0].candidateId);
    for (let index = 0; index < group.length; index += 1) {
      const receipt = group[index];
      if (receipt.sequence !== index + 1) fail("DEVELOPMENT_RECEIPT_SEQUENCE_GAP", receipt.candidateId);
      if (index === 0) {
        if (receipt.status !== "pending" || receipt.previousReceiptSha256 !== null) {
          fail("DEVELOPMENT_RECEIPT_TRANSITION_INVALID", receipt.candidateId);
        }
      } else if (
        !FINAL_REVIEW_STATUSES.has(receipt.status)
        || receipt.previousReceiptSha256 !== group[index - 1].receiptSha256
      ) {
        fail("DEVELOPMENT_RECEIPT_TRANSITION_INVALID", receipt.candidateId);
      }
      if (
        receipt.packageSizeBytes !== group[0].packageSizeBytes
        || receipt.storedName !== group[0].storedName
      ) fail("DEVELOPMENT_RECEIPT_PACKAGE_BINDING_MISMATCH", receipt.candidateId);
    }
  }
  return groups;
}

async function verifiedReceiptGroups(paths, key) {
  return groupAndValidateReceipts(await readReceiptFiles(paths, key));
}

async function packageLocations(paths, storedName) {
  const storedMatch = STORED_PACKAGE_PATTERN.exec(storedName);
  if (!storedMatch) fail("DEVELOPMENT_STORED_NAME_INVALID");
  const locations = [];
  for (const [status, directory] of Object.entries(paths.packageDirectories)) {
    const target = path.join(directory, storedName);
    if (await lstatOrNull(target)) locations.push({ kind: "package", status, path: target });
  }
  const trashEntries = await fs.readdir(paths.trash, { withFileTypes: true });
  for (const entry of trashEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const target = path.join(paths.trash, entry.name, storedName);
    if (await lstatOrNull(target)) locations.push({ kind: "trash", trashId: entry.name, path: target });
  }
  const deletionFile = path.join(paths.receipts, `DELETED--${storedMatch[1]}--${storedMatch[2]}.json`);
  if (await lstatOrNull(deletionFile)) locations.push({ kind: "deleted", path: deletionFile });
  return locations;
}

async function verifyPackageAtLocation(location, receipt) {
  await assertRegularFile(location.path, "DEVELOPMENT_PACKAGE_MISSING", {
    expectedSize: receipt.packageSizeBytes,
  });
  if (await sha256File(location.path) !== receipt.packageSha256) {
    fail("DEVELOPMENT_PACKAGE_HASH_MISMATCH", receipt.candidateId);
  }
}

export async function readVerifiedDevelopmentReceipt({
  productRoot,
  candidateId,
  packageSha256 = undefined,
  receiptSigningKey = undefined,
  keyFile = undefined,
  verifyPackage = true,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const groups = await verifiedReceiptGroups(paths, key);
  const matching = [...groups.values()].filter((group) => (
    group[0].candidateId === assertCandidateId(candidateId)
    && (packageSha256 === undefined || group[0].packageSha256 === packageSha256)
  ));
  if (!matching.length) fail("DEVELOPMENT_RECEIPT_NOT_FOUND", candidateId);
  if (matching.length !== 1) fail("DEVELOPMENT_RECEIPT_AMBIGUOUS", candidateId);
  const receipts = matching[0];
  const latest = receipts.at(-1);
  const locations = await packageLocations(paths, latest.storedName);
  if (locations.length !== 1) fail("DEVELOPMENT_PACKAGE_LOCATION_INVALID", latest.candidateId);
  if (verifyPackage) {
    if (locations[0].kind === "deleted") {
      const deletion = parseDeletionRecord(
        await readSmallJson(locations[0].path, "DEVELOPMENT_DELETION_INVALID"),
        key,
      );
      if (
        deletion.candidateId !== latest.candidateId
        || deletion.packageSha256 !== latest.packageSha256
        || deletion.sourceReceiptSha256 !== latest.receiptSha256
      ) fail("DEVELOPMENT_DELETION_RECEIPT_MISMATCH", latest.candidateId);
    } else {
      await verifyPackageAtLocation(locations[0], latest);
    }
  }
  return {
    receipt: latest,
    history: receipts,
    location: locations[0],
  };
}

async function copyPackageAtomically(source, target, expectedHash, expectedSize) {
  await assertRegularFile(source, "DEVELOPMENT_SOURCE_PACKAGE_MISSING", { expectedSize });
  const targetDirectory = path.dirname(target);
  await assertPlainDirectory(targetDirectory);
  if (await lstatOrNull(target)) fail("DEVELOPMENT_PACKAGE_ALREADY_EXISTS", target);
  const temporary = path.join(
    targetDirectory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await assertRegularFile(temporary, "DEVELOPMENT_PACKAGE_COPY_FAILED", { expectedSize });
    if (await sha256File(temporary) !== expectedHash) fail("DEVELOPMENT_SOURCE_PACKAGE_CHANGED");
    const handle = await fs.open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, target);
    await syncDirectory(targetDirectory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function registerDevelopmentPackage({
  productRoot,
  zipPath,
  candidateId,
  manifestSha256 = undefined,
  resultingTreeSha256 = undefined,
  requires = undefined,
  reviewedBy = "technical-admin",
  note = "",
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const normalizedId = assertCandidateId(candidateId);
  if (path.extname(zipPath).toLowerCase() !== ".zip") fail("DEVELOPMENT_PACKAGE_EXTENSION_INVALID");
  const sourceState = await assertRegularFile(path.resolve(zipPath), "DEVELOPMENT_SOURCE_PACKAGE_MISSING");
  if (sourceState.size <= 0) fail("DEVELOPMENT_PACKAGE_SIZE_INVALID");
  const descriptor = await readDevelopmentPackageDescriptor(path.resolve(zipPath));
  let packageSha256;
  let verifiedDescriptor;
  try {
    packageSha256 = descriptor.packageSha256;
    verifiedDescriptor = {
      manifestSha256: descriptor.manifestSha256,
      resultingTreeSha256: descriptor.manifest.resultingTreeSha256,
      requires: descriptor.manifest.requires,
    };
    if (descriptor.candidateId !== normalizedId) {
      fail("DEVELOPMENT_PACKAGE_CANDIDATE_ID_MISMATCH", `${normalizedId}:${descriptor.candidateId}`);
    }
    if (manifestSha256 !== undefined && manifestSha256 !== verifiedDescriptor.manifestSha256) {
      fail("DEVELOPMENT_MANIFEST_HASH_MISMATCH", normalizedId);
    }
    if (resultingTreeSha256 !== undefined && resultingTreeSha256 !== verifiedDescriptor.resultingTreeSha256) {
      fail("DEVELOPMENT_RESULT_TREE_HASH_MISMATCH", normalizedId);
    }
    if (requires !== undefined && !sameRequires(requires, verifiedDescriptor.requires)) {
      fail("DEVELOPMENT_REQUIRES_MISMATCH", normalizedId);
    }
  } finally {
    await descriptor.dispose();
  }
  if (await sha256File(path.resolve(zipPath)) !== packageSha256) {
    fail("DEVELOPMENT_SOURCE_PACKAGE_CHANGED");
  }
  const storedName = storedPackageName(normalizedId, packageSha256);
  const groups = await verifiedReceiptGroups(paths, key);
  const sameCandidate = [...groups.values()].filter((group) => group[0].candidateId === normalizedId);
  if (sameCandidate.some((group) => group[0].packageSha256 !== packageSha256)) {
    fail("DEVELOPMENT_CANDIDATE_ID_COLLISION", normalizedId);
  }
  if (sameCandidate.length) {
    return readVerifiedDevelopmentReceipt({
      productRoot,
      candidateId: normalizedId,
      packageSha256,
      receiptSigningKey: key,
    });
  }
  const target = path.join(paths.packageDirectories.pending, storedName);
  await copyPackageAtomically(path.resolve(zipPath), target, packageSha256, sourceState.size);
  const receipt = createReceipt({
    candidateId: normalizedId,
    packageSha256,
    packageSizeBytes: sourceState.size,
    storedName,
    status: "pending",
    sequence: 1,
    previousReceiptSha256: null,
    manifestSha256: verifiedDescriptor.manifestSha256,
    resultingTreeSha256: verifiedDescriptor.resultingTreeSha256,
    requires: verifiedDescriptor.requires,
    reviewedAt: timestamp(now),
    reviewedBy: assertHumanText(reviewedBy, "DEVELOPMENT_REVIEWER_INVALID", MAXIMUM_REVIEWER_BYTES),
    note: assertHumanText(note, "DEVELOPMENT_REVIEW_NOTE_INVALID", MAXIMUM_NOTE_BYTES, { allowEmpty: true }),
  }, key);
  const receiptFile = path.join(
    paths.receipts,
    receiptFileName(normalizedId, packageSha256, receipt.sequence, receipt.status),
  );
  try {
    await writeJsonExclusive(receiptFile, receipt);
  } catch (error) {
    await fs.unlink(target).catch(() => undefined);
    throw error;
  }
  return {
    receipt,
    history: [receipt],
    location: { kind: "package", status: "pending", path: target },
  };
}

function createTestReadyReceipt(input, key) {
  const core = {
    schema: DEVELOPMENT_TEST_READY_SCHEMA,
    candidateId: assertCandidateId(input.candidateId),
    packageSha256: assertHash(input.packageSha256, "DEVELOPMENT_TEST_READY_INVALID"),
    sourceReceiptSha256: assertHash(input.sourceReceiptSha256, "DEVELOPMENT_TEST_READY_INVALID"),
    manifestSha256: assertHash(input.manifestSha256, "DEVELOPMENT_TEST_READY_INVALID"),
    targetVersion: assertVersion(input.targetVersion, "targetVersion"),
    baseVersion: assertVersion(input.baseVersion, "baseVersion"),
    sourceChainSha256: assertNullableHash(input.sourceChainSha256, "DEVELOPMENT_TEST_READY_INVALID"),
    baseTreeSha256: assertHash(input.baseTreeSha256, "DEVELOPMENT_TEST_READY_INVALID"),
    finalTreeSha256: assertHash(input.finalTreeSha256, "DEVELOPMENT_TEST_READY_INVALID"),
    fileCount: input.fileCount,
    totalBytes: input.totalBytes,
    appliedPackages: input.appliedPackages,
    stagedAt: assertCanonicalTimestamp(input.stagedAt, "DEVELOPMENT_TEST_READY_TIME_INVALID"),
    testRelativePath: input.testRelativePath,
  };
  if (
    !Number.isSafeInteger(core.fileCount)
    || core.fileCount < 1
    || !Number.isSafeInteger(core.totalBytes)
    || core.totalBytes < 0
    || !Array.isArray(core.appliedPackages)
    || !core.appliedPackages.length
  ) fail("DEVELOPMENT_TEST_READY_INVALID");
  core.appliedPackages = core.appliedPackages.map((entry, index) => {
    assertExactKeys(
      entry,
      new Set(["candidateId", "packageSha256", "status", "includedAs", "dependencyOf"]),
      "DEVELOPMENT_TEST_READY_INVALID",
      `appliedPackages[${index}]`,
    );
    if (
      !["approved", "rejected", "failed"].includes(entry.status)
      || !["approved", "explicit-dependency"].includes(entry.includedAs)
      || (entry.dependencyOf !== null && typeof entry.dependencyOf !== "string")
    ) fail("DEVELOPMENT_TEST_READY_INVALID", `appliedPackages[${index}]`);
    return {
      candidateId: assertCandidateId(entry.candidateId),
      packageSha256: assertHash(entry.packageSha256, "DEVELOPMENT_TEST_READY_INVALID"),
      status: entry.status,
      includedAs: entry.includedAs,
      dependencyOf: entry.dependencyOf,
    };
  });
  const expectedRelative = `DEVELOPMENT/TESTS/${core.candidateId}--${core.packageSha256}/SYSTEM`;
  if (core.testRelativePath !== expectedRelative) fail("DEVELOPMENT_TEST_READY_PATH_INVALID");
  return signedEnvelope(core, key, "testReadyMac", "testReadySha256");
}

function parseTestReadyReceipt(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "candidateId", "packageSha256", "sourceReceiptSha256", "manifestSha256",
      "targetVersion", "baseVersion", "sourceChainSha256", "baseTreeSha256", "finalTreeSha256",
      "fileCount", "totalBytes", "appliedPackages", "stagedAt", "testRelativePath",
      "testReadyMac", "testReadySha256",
    ]),
    "DEVELOPMENT_TEST_READY_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "testReadyMac",
    "testReadySha256",
    "DEVELOPMENT_TEST_READY_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_TEST_READY_SCHEMA) fail("DEVELOPMENT_TEST_READY_SCHEMA_UNSUPPORTED");
  const recreated = createTestReadyReceipt(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_TEST_READY_INVALID");
  return recreated;
}

async function verifyTestReadyTree(paths, receipt) {
  let testSystem = containedPath(paths.productRoot, receipt.testRelativePath);
  if (!(await lstatOrNull(testSystem))) {
    const currentTree = await collectDevelopmentTree(paths.current);
    if (currentTree.treeSha256 !== receipt.finalTreeSha256) {
      fail("DEVELOPMENT_TEST_TREE_MISSING", receipt.candidateId);
    }
    testSystem = paths.current;
  }
  const tree = await collectDevelopmentTree(testSystem);
  if (
    tree.treeSha256 !== receipt.finalTreeSha256
    || tree.files.length !== receipt.fileCount
    || tree.files.reduce((sum, entry) => sum + entry.sizeBytes, 0) !== receipt.totalBytes
  ) fail("DEVELOPMENT_TEST_TREE_MISMATCH", receipt.candidateId);
  return { receipt, testSystem, tree };
}

export async function readDevelopmentTestReady({
  productRoot,
  candidateId,
  packageSha256,
  receiptSigningKey = undefined,
  keyFile = undefined,
  verifyTree = true,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const normalizedId = assertCandidateId(candidateId);
  const normalizedHash = assertHash(packageSha256, "DEVELOPMENT_PACKAGE_HASH_INVALID");
  const testRoot = path.join(paths.tests, `${normalizedId}--${normalizedHash}`);
  const activeFile = path.join(testRoot, "TEST-READY.json");
  const archivedFile = path.join(paths.receipts, `TEST-READY--${normalizedId}--${normalizedHash}.json`);
  const source = await lstatOrNull(activeFile) ? activeFile : archivedFile;
  const receipt = parseTestReadyReceipt(
    await readSmallJson(source, "DEVELOPMENT_TEST_READY_MISSING"),
    key,
  );
  if (receipt.candidateId !== normalizedId || receipt.packageSha256 !== normalizedHash) {
    fail("DEVELOPMENT_TEST_READY_BINDING_MISMATCH", normalizedId);
  }
  if (!verifyTree) return { receipt, testSystem: containedPath(paths.productRoot, receipt.testRelativePath) };
  return verifyTestReadyTree(paths, receipt);
}

async function inspectStoredTestArtifact(paths, key, receiptHistory) {
  const pending = receiptHistory[0];
  const latest = receiptHistory.at(-1);
  const testRoot = path.join(paths.tests, `${latest.candidateId}--${latest.packageSha256}`);
  const state = await lstatOrNull(testRoot);
  if (!state) return null;
  await assertPlainDirectory(testRoot, "DEVELOPMENT_TEST_ARTIFACT_INVALID");
  const readyFile = path.join(testRoot, "TEST-READY.json");
  const ready = parseTestReadyReceipt(
    await readSmallJson(readyFile, "DEVELOPMENT_TEST_ARTIFACT_INVALID"),
    key,
  );
  if (
    ready.candidateId !== latest.candidateId
    || ready.packageSha256 !== latest.packageSha256
    || ready.sourceReceiptSha256 !== pending.receiptSha256
    || ready.manifestSha256 !== latest.manifestSha256
    || ready.finalTreeSha256 !== latest.resultingTreeSha256
  ) fail("DEVELOPMENT_TEST_ARTIFACT_BINDING_MISMATCH", latest.candidateId);
  const verified = await verifyTestReadyTree(paths, ready);
  const readySize = (await assertRegularFile(readyFile, "DEVELOPMENT_TEST_ARTIFACT_INVALID")).size;
  return {
    testRoot,
    ready,
    tree: verified.tree,
    sizeBytes: readySize + verified.tree.files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

async function loadTestPackageDescriptors({ paths, key, roots, pendingCandidateId }) {
  const descriptors = new Map();
  const loading = new Set();
  const load = async (candidateId, packageSha256, dependencyOf = null) => {
    const existing = descriptors.get(candidateId);
    if (existing) {
      if (existing.packageSha256 !== packageSha256) {
        fail("DEVELOPMENT_TEST_DEPENDENCY_HASH_CONFLICT", candidateId);
      }
      return;
    }
    if (loading.has(candidateId)) fail("DEVELOPMENT_CHAIN_DEPENDENCY_CYCLE", candidateId);
    loading.add(candidateId);
    const verified = await readVerifiedDevelopmentReceipt({
      productRoot: paths.productRoot,
      candidateId,
      packageSha256,
      receiptSigningKey: key,
    });
    const isPendingRoot = candidateId === pendingCandidateId && dependencyOf === null;
    if (
      verified.location.kind !== "package"
      || (isPendingRoot
        ? verified.receipt.status !== "pending"
        : !FINAL_REVIEW_STATUSES.has(verified.receipt.status))
    ) fail("DEVELOPMENT_TEST_PACKAGE_STATUS_INVALID", candidateId);
    const packageDescriptor = await readDevelopmentPackageDescriptor(verified.location.path);
    if (
      packageDescriptor.candidateId !== candidateId
      || packageDescriptor.packageSha256 !== verified.receipt.packageSha256
      || packageDescriptor.manifestSha256 !== verified.receipt.manifestSha256
      || packageDescriptor.manifest.resultingTreeSha256 !== verified.receipt.resultingTreeSha256
      || !sameRequires(packageDescriptor.manifest.requires, verified.receipt.requires)
    ) {
      await packageDescriptor.dispose();
      fail("DEVELOPMENT_PACKAGE_DESCRIPTOR_MISMATCH", candidateId);
    }
    const descriptor = Object.freeze({
      ...packageDescriptor,
      status: isPendingRoot ? "approved" : verified.receipt.status,
      receiptSha256: verified.receipt.receiptSha256,
      actualReviewStatus: verified.receipt.status,
    });
    descriptors.set(candidateId, descriptor);
    for (const dependency of descriptor.manifest.requires) {
      await load(dependency.candidateId, dependency.packageSha256, candidateId);
    }
    loading.delete(candidateId);
  };
  try {
    for (const root of roots) await load(root.candidateId, root.packageSha256);
    return descriptors;
  } catch (error) {
    await Promise.all([...descriptors.values()].map((entry) => entry.dispose().catch(() => undefined)));
    throw error;
  }
}

export async function stageDevelopmentPackageForTest({
  productRoot,
  candidateId,
  packageSha256 = undefined,
  baseRoot = undefined,
  baseVersion = undefined,
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const state = await readVerifiedDevelopmentReceipt({
    productRoot,
    candidateId,
    packageSha256,
    receiptSigningKey: key,
  });
  if (
    state.receipt.status !== "pending"
    || state.location.kind !== "package"
    || state.location.status !== "pending"
  ) fail("DEVELOPMENT_TEST_REQUIRES_PENDING_PACKAGE", state.receipt.candidateId);

  const testRoot = path.join(paths.tests, `${state.receipt.candidateId}--${state.receipt.packageSha256}`);
  const testSystem = path.join(testRoot, "SYSTEM");
  const readyFile = path.join(testRoot, "TEST-READY.json");
  if (await lstatOrNull(readyFile)) {
    const existing = await readDevelopmentTestReady({
      productRoot,
      candidateId: state.receipt.candidateId,
      packageSha256: state.receipt.packageSha256,
      receiptSigningKey: key,
    });
    return {
      candidateId: state.receipt.candidateId,
      packageSha256: state.receipt.packageSha256,
      finalTreeSha256: existing.receipt.finalTreeSha256,
      testReadySha256: existing.receipt.testReadySha256,
      testRelativePath: existing.receipt.testRelativePath,
      idempotent: true,
    };
  }
  if (await lstatOrNull(testRoot)) {
    const entries = await fs.readdir(testRoot);
    if (entries.length !== 1 || entries[0] !== "SYSTEM") {
      fail("DEVELOPMENT_TEST_STAGING_INCOMPLETE", state.receipt.candidateId);
    }
  }

  let sourceChain = await readChainFile(paths, key, { required: false });
  if (sourceChain) {
    const groups = await verifiedReceiptGroups(paths, key);
    await validateChainAgainstReceipts(paths, key, sourceChain, groups);
    const currentTree = await collectDevelopmentTree(paths.current);
    if (currentTree.treeSha256 !== sourceChain.finalTreeSha256) {
      fail("DEVELOPMENT_CURRENT_TREE_MISMATCH");
    }
  }
  const selectedBaseVersion = sourceChain?.baseVersion
    || (baseVersion ? assertVersion(baseVersion, "baseVersion") : null);
  if (!selectedBaseVersion) fail("DEVELOPMENT_TEST_BASE_VERSION_REQUIRED");
  if (sourceChain && baseVersion && sourceChain.baseVersion !== baseVersion) {
    fail("DEVELOPMENT_CHAIN_BASE_CONFLICT");
  }
  const resolvedBaseRoot = baseRoot === undefined
    ? path.join(paths.bases, selectedBaseVersion, "SYSTEM")
    : path.resolve(baseRoot);
  await assertPlainDirectory(
    resolvedBaseRoot,
    baseRoot === undefined
      ? "DEVELOPMENT_VERSIONED_BASE_MISSING"
      : "DEVELOPMENT_EXPLICIT_BASE_MISSING",
  );
  const baseTree = await collectDevelopmentTree(resolvedBaseRoot);
  const topDescriptor = await readDevelopmentPackageDescriptor(state.location.path);
  let descriptors;
  try {
    if (
      topDescriptor.candidateId !== state.receipt.candidateId
      || topDescriptor.packageSha256 !== state.receipt.packageSha256
    ) fail("DEVELOPMENT_PACKAGE_DESCRIPTOR_MISMATCH", state.receipt.candidateId);
    if (sourceChain && sourceChain.targetVersion !== topDescriptor.manifest.targetVersion) {
      fail("DEVELOPMENT_PACKAGE_TARGET_VERSION_MISMATCH", state.receipt.candidateId);
    }
    if (sourceChain && sourceChain.baseTreeSha256 !== baseTree.treeSha256) {
      fail("DEVELOPMENT_CHAIN_BASE_TREE_MISMATCH");
    }
    const provisionalBaseVersion = selectedBaseVersion;
    const provisionalEntries = [...(sourceChain?.entries || []), {
      candidateId: state.receipt.candidateId,
      packageSha256: state.receipt.packageSha256,
      receiptSha256: state.receipt.receiptSha256,
      manifestSha256: state.receipt.manifestSha256,
      requires: state.receipt.requires,
      resultingTreeSha256: state.receipt.resultingTreeSha256,
    }];
    const provisionalChain = {
      schema: DEVELOPMENT_CHAIN_SCHEMA,
      targetVersion: sourceChain?.targetVersion || topDescriptor.manifest.targetVersion,
      baseVersion: provisionalBaseVersion,
      baseTreeSha256: sourceChain?.baseTreeSha256 || baseTree.treeSha256,
      entries: provisionalEntries,
      finalTreeSha256: state.receipt.resultingTreeSha256,
      updatedAt: timestamp(now),
      chainMac: "0".repeat(64),
      chainSha256: "0".repeat(64),
    };
    descriptors = await loadTestPackageDescriptors({
      paths,
      key,
      roots: provisionalEntries,
      pendingCandidateId: state.receipt.candidateId,
    });
    let assembled;
    if (await lstatOrNull(testSystem)) {
      const existingTree = await collectDevelopmentTree(testSystem);
      if (existingTree.treeSha256 !== state.receipt.resultingTreeSha256) {
        fail("DEVELOPMENT_TEST_STAGING_INCOMPLETE", state.receipt.candidateId);
      }
      assembled = {
        finalTreeSha256: existingTree.treeSha256,
        fileCount: existingTree.files.length,
        totalBytes: existingTree.files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
        appliedPackages: provisionalEntries.map((entry) => ({
          candidateId: entry.candidateId,
          packageSha256: entry.packageSha256,
          status: entry.candidateId === state.receipt.candidateId
            ? "approved"
            : descriptors.get(entry.candidateId).actualReviewStatus,
          includedAs: "approved",
          dependencyOf: null,
        })),
      };
    } else {
      assembled = await assembleDevelopmentTestTree({
        baseRoot: resolvedBaseRoot,
        stagingRoot: testSystem,
        chain: provisionalChain,
        packageDescriptors: descriptors,
      });
    }
    const appliedPackages = assembled.appliedPackages.map((entry) => (
      entry.candidateId === state.receipt.candidateId
        ? { ...entry, status: "approved" }
        : entry
    ));
    const ready = createTestReadyReceipt({
      candidateId: state.receipt.candidateId,
      packageSha256: state.receipt.packageSha256,
      sourceReceiptSha256: state.receipt.receiptSha256,
      manifestSha256: state.receipt.manifestSha256,
      targetVersion: provisionalChain.targetVersion,
      baseVersion: provisionalChain.baseVersion,
      sourceChainSha256: sourceChain?.chainSha256 || null,
      baseTreeSha256: provisionalChain.baseTreeSha256,
      finalTreeSha256: assembled.finalTreeSha256,
      fileCount: assembled.fileCount,
      totalBytes: assembled.totalBytes,
      appliedPackages,
      stagedAt: timestamp(now),
      testRelativePath: portableRelative(paths.productRoot, testSystem),
    }, key);
    await writeJsonExclusive(readyFile, ready);
    return {
      candidateId: ready.candidateId,
      packageSha256: ready.packageSha256,
      finalTreeSha256: ready.finalTreeSha256,
      testReadySha256: ready.testReadySha256,
      testRelativePath: ready.testRelativePath,
      idempotent: false,
    };
  } finally {
    await topDescriptor.dispose();
    if (descriptors) {
      await Promise.all([...descriptors.values()].map((entry) => entry.dispose().catch(() => undefined)));
    }
  }
}

function chainCore({ targetVersion, baseVersion, baseTreeSha256, entries, finalTreeSha256, updatedAt }) {
  return {
    schema: DEVELOPMENT_CHAIN_SCHEMA,
    targetVersion: assertVersion(targetVersion, "targetVersion"),
    baseVersion: assertVersion(baseVersion, "baseVersion"),
    baseTreeSha256: assertHash(baseTreeSha256, "DEVELOPMENT_BASE_TREE_HASH_INVALID"),
    entries,
    finalTreeSha256: assertHash(finalTreeSha256, "DEVELOPMENT_FINAL_TREE_HASH_INVALID"),
    updatedAt: assertCanonicalTimestamp(updatedAt, "DEVELOPMENT_CHAIN_TIME_INVALID"),
  };
}

function normalizeChainEntries(value) {
  if (!Array.isArray(value) || value.length > 10_000) fail("DEVELOPMENT_CHAIN_ENTRIES_INVALID");
  const entries = value.map((entry, index) => {
    assertExactKeys(
      entry,
      new Set([
        "candidateId", "packageSha256", "receiptSha256", "manifestSha256", "requires",
        "resultingTreeSha256",
      ]),
      "DEVELOPMENT_CHAIN_ENTRY_INVALID",
      String(index),
    );
    return {
      candidateId: assertCandidateId(entry.candidateId),
      packageSha256: assertHash(entry.packageSha256, "DEVELOPMENT_CHAIN_ENTRY_INVALID", String(index)),
      receiptSha256: assertHash(entry.receiptSha256, "DEVELOPMENT_CHAIN_ENTRY_INVALID", String(index)),
      manifestSha256: assertHash(entry.manifestSha256, "DEVELOPMENT_CHAIN_ENTRY_INVALID", String(index)),
      requires: normalizeRequires(entry.requires),
      resultingTreeSha256: assertHash(
        entry.resultingTreeSha256,
        "DEVELOPMENT_CHAIN_ENTRY_INVALID",
        String(index),
      ),
    };
  });
  const identities = new Set();
  for (const entry of entries) {
    const identity = `${entry.candidateId}\0${entry.packageSha256}`;
    if (identities.has(identity)) {
      fail("DEVELOPMENT_CHAIN_ENTRY_DUPLICATE", entry.candidateId);
    }
    identities.add(identity);
  }
  return entries;
}

function createChain(input, key) {
  const entries = normalizeChainEntries(input.entries);
  const core = chainCore({ ...input, entries });
  const expectedFinal = entries.length ? entries.at(-1).resultingTreeSha256 : core.baseTreeSha256;
  if (core.finalTreeSha256 !== expectedFinal) fail("DEVELOPMENT_CHAIN_FINAL_TREE_MISMATCH");
  return signedEnvelope(core, key, "chainMac", "chainSha256");
}

function parseChain(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "targetVersion", "baseVersion", "baseTreeSha256", "entries", "finalTreeSha256",
      "updatedAt", "chainMac", "chainSha256",
    ]),
    "DEVELOPMENT_CHAIN_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "chainMac",
    "chainSha256",
    "DEVELOPMENT_CHAIN_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_CHAIN_SCHEMA) fail("DEVELOPMENT_CHAIN_SCHEMA_UNSUPPORTED");
  const recreated = createChain(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_CHAIN_INVALID");
  return recreated;
}

const REVIEW_TRANSACTION_PHASES = new Set([
  "prepared",
  "package-moved",
  "receipt-written",
  "chain-written",
  "tree-promoted",
]);

function createReviewTransaction(input, key) {
  const finalReceipt = parseReceipt(input.finalReceipt, key);
  const chainAfter = input.chainAfter === null ? null : parseChain(input.chainAfter, key);
  const testReady = input.testReady === null ? null : parseTestReadyReceipt(input.testReady, key);
  const core = {
    schema: DEVELOPMENT_REVIEW_TRANSACTION_SCHEMA,
    transactionId: assertHash(input.transactionId, "DEVELOPMENT_TRANSACTION_INVALID"),
    candidateId: assertCandidateId(input.candidateId),
    packageSha256: assertHash(input.packageSha256, "DEVELOPMENT_TRANSACTION_INVALID"),
    finalStatus: assertStatus(input.finalStatus, { finalOnly: true }),
    finalReceipt,
    chainBeforeSha256: assertNullableHash(
      input.chainBeforeSha256,
      "DEVELOPMENT_TRANSACTION_INVALID",
    ),
    chainAfter,
    testReady,
    currentBeforeTreeSha256: assertHash(
      input.currentBeforeTreeSha256,
      "DEVELOPMENT_TRANSACTION_INVALID",
    ),
    previousBeforeTreeSha256: assertHash(
      input.previousBeforeTreeSha256,
      "DEVELOPMENT_TRANSACTION_INVALID",
    ),
    createdAt: assertCanonicalTimestamp(input.createdAt, "DEVELOPMENT_TRANSACTION_INVALID"),
    phase: input.phase,
  };
  if (!REVIEW_TRANSACTION_PHASES.has(core.phase)) fail("DEVELOPMENT_TRANSACTION_INVALID");
  if (
    core.transactionId !== finalReceipt.receiptSha256
    || core.candidateId !== finalReceipt.candidateId
    || core.packageSha256 !== finalReceipt.packageSha256
    || core.finalStatus !== finalReceipt.status
  ) fail("DEVELOPMENT_TRANSACTION_BINDING_MISMATCH", core.candidateId);
  if (core.finalStatus === "approved") {
    if (!chainAfter || !testReady) fail("DEVELOPMENT_TRANSACTION_APPROVAL_STATE_MISSING");
    const entry = chainAfter.entries.find((candidate) => candidate.candidateId === core.candidateId);
    if (
      !entry
      || entry.packageSha256 !== core.packageSha256
      || entry.receiptSha256 !== finalReceipt.receiptSha256
      || testReady.candidateId !== core.candidateId
      || testReady.packageSha256 !== core.packageSha256
      || testReady.finalTreeSha256 !== chainAfter.finalTreeSha256
    ) fail("DEVELOPMENT_TRANSACTION_APPROVAL_BINDING_MISMATCH", core.candidateId);
  } else if (chainAfter !== null || testReady !== null) {
    fail("DEVELOPMENT_TRANSACTION_NON_APPROVAL_STATE_INVALID", core.candidateId);
  }
  return signedEnvelope(core, key, "transactionMac", "transactionSha256");
}

function parseReviewTransaction(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "transactionId", "candidateId", "packageSha256", "finalStatus",
      "finalReceipt", "chainBeforeSha256", "chainAfter", "testReady",
      "currentBeforeTreeSha256", "previousBeforeTreeSha256", "createdAt", "phase",
      "transactionMac", "transactionSha256",
    ]),
    "DEVELOPMENT_TRANSACTION_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "transactionMac",
    "transactionSha256",
    "DEVELOPMENT_TRANSACTION_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_REVIEW_TRANSACTION_SCHEMA) {
    fail("DEVELOPMENT_TRANSACTION_SCHEMA_UNSUPPORTED");
  }
  const recreated = createReviewTransaction(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_TRANSACTION_INVALID");
  return recreated;
}

function reviewTransactionFile(paths, transaction) {
  return path.join(
    paths.transactions,
    `${transaction.candidateId}--${transaction.packageSha256}--${transaction.transactionId}.json`,
  );
}

function maybeCrashReviewTransaction(point) {
  if (
    process.env.NODE_ENV === "test"
    && process.env.BONNI_DEVELOPMENT_TEST_CRASH_AFTER === point
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

async function updateReviewTransactionPhase(paths, transaction, key, phase) {
  const updated = createReviewTransaction({ ...transaction, phase }, key);
  await writeJsonAtomic(reviewTransactionFile(paths, transaction), updated);
  return updated;
}

async function ensureTransactionPackageMoved(paths, transaction) {
  const receipt = transaction.finalReceipt;
  const source = path.join(paths.packageDirectories.pending, receipt.storedName);
  const target = path.join(paths.packageDirectories[receipt.status], receipt.storedName);
  const sourceState = await lstatOrNull(source);
  const targetState = await lstatOrNull(target);
  if (sourceState && targetState) fail("DEVELOPMENT_TRANSACTION_PACKAGE_DUPLICATED", receipt.candidateId);
  if (!sourceState && !targetState) fail("DEVELOPMENT_TRANSACTION_PACKAGE_MISSING", receipt.candidateId);
  if (sourceState) await movePackage(source, target);
  await verifyPackageAtLocation({ path: target }, receipt);
  return target;
}

async function ensureTransactionReceiptWritten(paths, transaction, key) {
  const receipt = transaction.finalReceipt;
  const target = path.join(
    paths.receipts,
    receiptFileName(receipt.candidateId, receipt.packageSha256, receipt.sequence, receipt.status),
  );
  if (!(await lstatOrNull(target))) {
    await writeJsonExclusive(target, receipt);
    return;
  }
  const existing = parseReceipt(await readSmallJson(target, "DEVELOPMENT_RECEIPT_INVALID"), key);
  if (existing.receiptSha256 !== receipt.receiptSha256) {
    fail("DEVELOPMENT_TRANSACTION_RECEIPT_CONFLICT", receipt.candidateId);
  }
}

async function ensureTransactionChainWritten(paths, transaction, key) {
  if (!transaction.chainAfter) return;
  const state = await lstatOrNull(paths.approvedChain);
  if (!state) {
    if (transaction.chainBeforeSha256 !== null) fail("DEVELOPMENT_TRANSACTION_CHAIN_MISSING");
    await writeJsonAtomic(paths.approvedChain, transaction.chainAfter);
    return;
  }
  const existing = parseChain(
    await readSmallJson(paths.approvedChain, "DEVELOPMENT_CHAIN_INVALID"),
    key,
  );
  if (existing.chainSha256 === transaction.chainAfter.chainSha256) return;
  if (existing.chainSha256 !== transaction.chainBeforeSha256) {
    fail("DEVELOPMENT_TRANSACTION_CHAIN_CONFLICT", transaction.candidateId);
  }
  await writeJsonAtomic(paths.approvedChain, transaction.chainAfter);
}

async function readChainFile(paths, key, { required = true } = {}) {
  const state = await lstatOrNull(paths.approvedChain);
  if (!state) {
    if (required) fail("DEVELOPMENT_CHAIN_MISSING");
    return null;
  }
  return parseChain(await readSmallJson(paths.approvedChain, "DEVELOPMENT_CHAIN_INVALID"), key);
}

function latestReceiptsByCandidate(groups) {
  return new Map([...groups.values()].map((receipts) => {
    const latest = receipts.at(-1);
    return [latest.candidateId, latest];
  }));
}

async function validateRequirementClosure({
  paths,
  groups,
  chain,
  roots,
  verifyPackages = true,
}) {
  const latestByCandidate = latestReceiptsByCandidate(groups);
  const chainPosition = new Map(chain.entries.map((entry, index) => [entry.candidateId, {
    index,
    packageSha256: entry.packageSha256,
  }]));
  const protectedIdentities = new Set();
  const verifiedPackages = new Set();

  const visit = async (dependency, ownerCandidateId, ownerIndex, visiting) => {
    const identity = `${dependency.candidateId}\0${dependency.packageSha256}`;
    if (visiting.has(identity)) {
      fail("DEVELOPMENT_CHAIN_DEPENDENCY_CYCLE", `${ownerCandidateId}:${dependency.candidateId}`);
    }
    const receipt = latestByCandidate.get(dependency.candidateId);
    if (!receipt || receipt.packageSha256 !== dependency.packageSha256) {
      fail("DEVELOPMENT_CHAIN_DEPENDENCY_MISSING", `${ownerCandidateId}:${dependency.candidateId}`);
    }
    if (!FINAL_REVIEW_STATUSES.has(receipt.status)) {
      fail("DEVELOPMENT_CHAIN_DEPENDENCY_NOT_FINAL", `${ownerCandidateId}:${dependency.candidateId}`);
    }
    const approvedPosition = chainPosition.get(dependency.candidateId);
    if (receipt.status === "approved") {
      if (
        !approvedPosition
        || approvedPosition.packageSha256 !== dependency.packageSha256
        || approvedPosition.index >= ownerIndex
      ) {
        fail("DEVELOPMENT_CHAIN_DEPENDENCY_ORDER_INVALID", `${ownerCandidateId}:${dependency.candidateId}`);
      }
    } else if (approvedPosition) {
      fail("DEVELOPMENT_CHAIN_DEPENDENCY_STATUS_MISMATCH", dependency.candidateId);
    }
    const locations = await packageLocations(paths, receipt.storedName);
    if (
      locations.length !== 1
      || locations[0].kind !== "package"
      || locations[0].status !== receipt.status
    ) fail("DEVELOPMENT_CHAIN_DEPENDENCY_PACKAGE_INVALID", dependency.candidateId);
    if (verifyPackages && !verifiedPackages.has(identity)) {
      await verifyPackageAtLocation(locations[0], receipt);
      verifiedPackages.add(identity);
    }
    protectedIdentities.add(identity);
    if (receipt.requires.length) {
      const nextVisiting = new Set(visiting);
      nextVisiting.add(identity);
      for (const nested of receipt.requires) {
        await visit(nested, dependency.candidateId, approvedPosition?.index ?? ownerIndex, nextVisiting);
      }
    }
  };

  for (const root of roots) {
    for (const dependency of root.requires) {
      await visit(dependency, root.ownerCandidateId, root.ownerIndex, new Set([
        `${root.ownerCandidateId}\0${root.ownerPackageSha256 || ""}`,
      ]));
    }
  }
  return protectedIdentities;
}

export async function initializeApprovedDevelopmentChain({
  productRoot,
  targetVersion,
  baseVersion,
  baseTreeSha256,
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const existing = await readChainFile(paths, key, { required: false });
  if (existing) {
    if (
      existing.targetVersion !== targetVersion
      || existing.baseVersion !== baseVersion
      || existing.baseTreeSha256 !== baseTreeSha256
    ) fail("DEVELOPMENT_CHAIN_BASE_CONFLICT");
    return existing;
  }
  const chain = createChain({
    targetVersion,
    baseVersion,
    baseTreeSha256,
    entries: [],
    finalTreeSha256: baseTreeSha256,
    updatedAt: timestamp(now),
  }, key);
  try {
    await writeJsonExclusive(paths.approvedChain, chain);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = await readChainFile(paths, key);
    if (
      raced.targetVersion !== targetVersion
      || raced.baseVersion !== baseVersion
      || raced.baseTreeSha256 !== baseTreeSha256
    ) fail("DEVELOPMENT_CHAIN_BASE_CONFLICT");
    return raced;
  }
  return chain;
}

async function validateChainAgainstReceipts(paths, key, chain, groups, { verifyPackages = true } = {}) {
  const approved = new Map();
  for (const receipts of groups.values()) {
    const latest = receipts.at(-1);
    if (latest.status === "approved") approved.set(latest.candidateId, latest);
  }
  if (chain.entries.length !== approved.size) fail("DEVELOPMENT_CHAIN_APPROVED_SET_MISMATCH");
  for (const entry of chain.entries) {
    const receipt = approved.get(entry.candidateId);
    if (
      !receipt
      || receipt.packageSha256 !== entry.packageSha256
      || receipt.receiptSha256 !== entry.receiptSha256
      || receipt.manifestSha256 !== entry.manifestSha256
      || receipt.resultingTreeSha256 !== entry.resultingTreeSha256
      || !sameRequires(receipt.requires, entry.requires)
    ) fail("DEVELOPMENT_CHAIN_RECEIPT_MISMATCH", entry.candidateId);
    const locations = await packageLocations(paths, receipt.storedName);
    if (
      locations.length !== 1
      || locations[0].kind !== "package"
      || locations[0].status !== "approved"
    ) fail("DEVELOPMENT_APPROVED_PACKAGE_LOCATION_INVALID", entry.candidateId);
    if (verifyPackages) await verifyPackageAtLocation(locations[0], receipt);
  }
  const dependencyIdentities = await validateRequirementClosure({
    paths,
    groups,
    chain,
    roots: chain.entries.map((entry, index) => ({
      ownerCandidateId: entry.candidateId,
      ownerPackageSha256: entry.packageSha256,
      ownerIndex: index,
      requires: entry.requires,
    })),
    verifyPackages,
  });
  return { chain, dependencyIdentities };
}

export async function readApprovedDevelopmentChain({
  productRoot,
  receiptSigningKey = undefined,
  keyFile = undefined,
  verifyPackages = true,
  required = true,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const chain = await readChainFile(paths, key, { required });
  if (!chain) return null;
  const groups = await verifiedReceiptGroups(paths, key);
  const verified = await validateChainAgainstReceipts(paths, key, chain, groups, { verifyPackages });
  return verified.chain;
}

async function movePackage(source, target) {
  await assertRegularFile(source, "DEVELOPMENT_PACKAGE_MISSING");
  await assertPlainDirectory(path.dirname(source));
  await assertPlainDirectory(path.dirname(target));
  if (await lstatOrNull(target)) fail("DEVELOPMENT_PACKAGE_ALREADY_EXISTS", target);
  await fs.rename(source, target);
  await syncDirectory(path.dirname(source));
  await syncDirectory(path.dirname(target));
}

async function reconcileApprovedChain({ paths, key, receipt, targetVersion, baseVersion, baseTreeSha256, now }) {
  let chain = await readChainFile(paths, key, { required: false });
  if (!chain) {
    if (!targetVersion || !baseVersion || !baseTreeSha256) fail("DEVELOPMENT_CHAIN_BASE_REQUIRED");
    chain = await initializeApprovedDevelopmentChain({
      productRoot: paths.productRoot,
      targetVersion,
      baseVersion,
      baseTreeSha256,
      receiptSigningKey: key,
      now,
    });
  }
  if (
    (targetVersion && targetVersion !== chain.targetVersion)
    || (baseVersion && baseVersion !== chain.baseVersion)
    || (baseTreeSha256 && baseTreeSha256 !== chain.baseTreeSha256)
  ) fail("DEVELOPMENT_CHAIN_BASE_CONFLICT");
  const existing = chain.entries.find((entry) => entry.candidateId === receipt.candidateId);
  if (existing) {
    if (
      existing.packageSha256 !== receipt.packageSha256
      || existing.receiptSha256 !== receipt.receiptSha256
    ) fail("DEVELOPMENT_CHAIN_ENTRY_CONFLICT", receipt.candidateId);
    return chain;
  }
  const groups = await verifiedReceiptGroups(paths, key);
  await validateRequirementClosure({
    paths,
    groups,
    chain,
    roots: [{
      ownerCandidateId: receipt.candidateId,
      ownerPackageSha256: receipt.packageSha256,
      ownerIndex: chain.entries.length,
      requires: receipt.requires,
    }],
  });
  const entry = {
    candidateId: receipt.candidateId,
    packageSha256: receipt.packageSha256,
    receiptSha256: receipt.receiptSha256,
    manifestSha256: receipt.manifestSha256,
    requires: receipt.requires,
    resultingTreeSha256: receipt.resultingTreeSha256,
  };
  const updated = createChain({
    targetVersion: chain.targetVersion,
    baseVersion: chain.baseVersion,
    baseTreeSha256: chain.baseTreeSha256,
    entries: [...chain.entries, entry],
    finalTreeSha256: receipt.resultingTreeSha256,
    updatedAt: timestamp(now),
  }, key);
  await writeJsonAtomic(paths.approvedChain, updated);
  return updated;
}

async function verifyReceiptPackageDescriptor(packagePath, receipt, expectedTargetVersion) {
  const descriptor = await readDevelopmentPackageDescriptor(packagePath);
  try {
    if (
      descriptor.candidateId !== receipt.candidateId
      || descriptor.packageSha256 !== receipt.packageSha256
      || descriptor.manifestSha256 !== receipt.manifestSha256
      || descriptor.manifest.resultingTreeSha256 !== receipt.resultingTreeSha256
      || !sameRequires(descriptor.manifest.requires, receipt.requires)
    ) fail("DEVELOPMENT_PACKAGE_DESCRIPTOR_MISMATCH", receipt.candidateId);
    if (descriptor.manifest.targetVersion !== expectedTargetVersion) {
      fail(
        "DEVELOPMENT_PACKAGE_TARGET_VERSION_MISMATCH",
        `${receipt.candidateId}:${descriptor.manifest.targetVersion}:${expectedTargetVersion}`,
      );
    }
  } finally {
    await descriptor.dispose();
  }
}

async function assertTestReadyForApproval({
  paths,
  key,
  reviewState,
  chain,
  verifyTree = true,
  afterApproval = false,
}) {
  const pendingReceipt = reviewState.history[0];
  const ready = await readDevelopmentTestReady({
    productRoot: paths.productRoot,
    candidateId: pendingReceipt.candidateId,
    packageSha256: pendingReceipt.packageSha256,
    receiptSigningKey: key,
    verifyTree,
  });
  const approvedEntry = afterApproval
    ? chain.entries.find((entry) => entry.candidateId === reviewState.receipt.candidateId)
    : null;
  const sourceChainMatches = afterApproval
    ? Boolean(
      approvedEntry
      && approvedEntry.packageSha256 === reviewState.receipt.packageSha256
      && approvedEntry.receiptSha256 === reviewState.receipt.receiptSha256
    )
    : (ready.receipt.sourceChainSha256 !== null
      ? ready.receipt.sourceChainSha256 === chain.chainSha256
      : chain.entries.length === 0);
  if (
    ready.receipt.sourceReceiptSha256 !== pendingReceipt.receiptSha256
    || ready.receipt.manifestSha256 !== pendingReceipt.manifestSha256
    || ready.receipt.finalTreeSha256 !== pendingReceipt.resultingTreeSha256
    || ready.receipt.targetVersion !== chain.targetVersion
    || ready.receipt.baseVersion !== chain.baseVersion
    || ready.receipt.baseTreeSha256 !== chain.baseTreeSha256
    || !sourceChainMatches
  ) fail("DEVELOPMENT_TEST_READY_APPROVAL_MISMATCH", pendingReceipt.candidateId);
  return ready;
}

async function archiveTestReadyReceipt(paths, key, receipt) {
  const target = path.join(
    paths.receipts,
    `TEST-READY--${receipt.candidateId}--${receipt.packageSha256}.json`,
  );
  const existing = await lstatOrNull(target);
  if (existing) {
    const archived = parseTestReadyReceipt(
      await readSmallJson(target, "DEVELOPMENT_TEST_READY_INVALID"),
      key,
    );
    if (archived.testReadySha256 !== receipt.testReadySha256) {
      fail("DEVELOPMENT_TEST_READY_ARCHIVE_CONFLICT", receipt.candidateId);
    }
    return target;
  }
  await writeJsonExclusive(target, receipt);
  return target;
}

async function collectTreeOrNull(target) {
  const state = await lstatOrNull(target);
  if (!state) return null;
  await assertPlainDirectory(target, "DEVELOPMENT_PROMOTION_DIRECTORY_INVALID");
  return collectDevelopmentTree(target);
}

async function promoteDevelopmentTestToCurrent(paths, key, ready, transaction) {
  await archiveTestReadyReceipt(paths, key, ready.receipt);
  const testSystem = containedPath(paths.productRoot, ready.receipt.testRelativePath);
  const retiredPrevious = path.join(paths.root, `.PREVIOUS.${transaction.transactionId}.retired`);
  let currentTree = await collectTreeOrNull(paths.current);
  let testTree = await collectTreeOrNull(testSystem);
  let retiredTree = await collectTreeOrNull(retiredPrevious);
  let previousTree = await collectTreeOrNull(paths.previous);
  const alreadyPromoted = currentTree?.treeSha256 === ready.receipt.finalTreeSha256;

  if (!alreadyPromoted) {
    if (testTree?.treeSha256 !== ready.receipt.finalTreeSha256) {
      fail("DEVELOPMENT_TEST_TREE_MISMATCH", ready.receipt.candidateId);
    }
    if (!retiredTree) {
      if (
        previousTree?.treeSha256 !== transaction.previousBeforeTreeSha256
        || currentTree?.treeSha256 !== transaction.currentBeforeTreeSha256
      ) fail("DEVELOPMENT_PROMOTION_STATE_INVALID", ready.receipt.candidateId);
      await fs.rename(paths.previous, retiredPrevious);
      await syncDirectory(paths.root);
      maybeCrashReviewTransaction("previous-retired");
      retiredTree = previousTree;
      previousTree = null;
    } else if (retiredTree.treeSha256 !== transaction.previousBeforeTreeSha256) {
      fail("DEVELOPMENT_PROMOTION_RETIRED_TREE_MISMATCH", ready.receipt.candidateId);
    }

    currentTree = await collectTreeOrNull(paths.current);
    previousTree = await collectTreeOrNull(paths.previous);
    if (currentTree) {
      if (
        currentTree.treeSha256 !== transaction.currentBeforeTreeSha256
        || previousTree !== null
      ) fail("DEVELOPMENT_PROMOTION_STATE_INVALID", ready.receipt.candidateId);
      await fs.rename(paths.current, paths.previous);
      await syncDirectory(paths.root);
      maybeCrashReviewTransaction("current-moved");
    } else if (previousTree?.treeSha256 !== transaction.currentBeforeTreeSha256) {
      fail("DEVELOPMENT_PROMOTION_STATE_INVALID", ready.receipt.candidateId);
    }

    currentTree = await collectTreeOrNull(paths.current);
    testTree = await collectTreeOrNull(testSystem);
    if (currentTree) fail("DEVELOPMENT_PROMOTION_STATE_INVALID", ready.receipt.candidateId);
    if (testTree?.treeSha256 !== ready.receipt.finalTreeSha256) {
      fail("DEVELOPMENT_TEST_TREE_MISMATCH", ready.receipt.candidateId);
    }
    await fs.rename(testSystem, paths.current);
    await syncDirectory(paths.root);
    await syncDirectory(path.dirname(testSystem));
    maybeCrashReviewTransaction("test-moved");
    currentTree = await collectDevelopmentTree(paths.current);
  }

  if (currentTree.treeSha256 !== ready.receipt.finalTreeSha256) {
    fail("DEVELOPMENT_PROMOTION_CURRENT_TREE_MISMATCH", ready.receipt.candidateId);
  }
  if (await lstatOrNull(retiredPrevious)) {
    await fs.rm(retiredPrevious, { recursive: true, force: true });
    await syncDirectory(paths.root);
  }
  const testRoot = path.dirname(testSystem);
  await fs.unlink(path.join(testRoot, "TEST-READY.json")).catch(() => undefined);
  await fs.rmdir(testRoot).catch((error) => {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  });
  return { finalTreeSha256: ready.receipt.finalTreeSha256, idempotent: alreadyPromoted };
}

async function completeDevelopmentReviewTransaction(paths, key, initialTransaction) {
  let transaction = initialTransaction;
  const transactionFile = reviewTransactionFile(paths, transaction);
  const target = await ensureTransactionPackageMoved(paths, transaction);
  transaction = await updateReviewTransactionPhase(paths, transaction, key, "package-moved");
  maybeCrashReviewTransaction("package-moved");

  await ensureTransactionReceiptWritten(paths, transaction, key);
  transaction = await updateReviewTransactionPhase(paths, transaction, key, "receipt-written");
  maybeCrashReviewTransaction("receipt-written");

  let chain = null;
  let promotion = null;
  if (transaction.finalStatus === "approved") {
    await ensureTransactionChainWritten(paths, transaction, key);
    chain = transaction.chainAfter;
    transaction = await updateReviewTransactionPhase(paths, transaction, key, "chain-written");
    maybeCrashReviewTransaction("chain-written");
    const ready = await verifyTestReadyTree(paths, transaction.testReady);
    promotion = await promoteDevelopmentTestToCurrent(paths, key, ready, transaction);
    transaction = await updateReviewTransactionPhase(paths, transaction, key, "tree-promoted");
    maybeCrashReviewTransaction("tree-promoted");
  }

  await fs.unlink(transactionFile);
  await syncDirectory(paths.transactions);
  return {
    receipt: transaction.finalReceipt,
    location: { kind: "package", status: transaction.finalStatus, path: target },
    chain,
    promotion,
  };
}

async function recoverDevelopmentReviewTransactions(paths, key) {
  await assertPlainDirectory(paths.transactions);
  const names = (await fs.readdir(paths.transactions)).sort(bytewiseCompare);
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const match = REVIEW_TRANSACTION_FILE_PATTERN.exec(name);
    if (!match) fail("DEVELOPMENT_TRANSACTION_FILE_UNRECOGNIZED", name);
    const transaction = parseReviewTransaction(
      await readBoundedJson(
        path.join(paths.transactions, name),
        "DEVELOPMENT_TRANSACTION_INVALID",
        MAXIMUM_TRANSACTION_BYTES,
      ),
      key,
    );
    if (
      transaction.candidateId !== match[1]
      || transaction.packageSha256 !== match[2]
      || transaction.transactionId !== match[3]
    ) fail("DEVELOPMENT_TRANSACTION_FILENAME_MISMATCH", name);
    await completeDevelopmentReviewTransaction(paths, key, transaction);
  }
}

export async function recordDevelopmentReview({
  productRoot,
  candidateId,
  packageSha256 = undefined,
  status,
  manifestSha256 = undefined,
  resultingTreeSha256 = undefined,
  requires = undefined,
  reviewedBy,
  note = "",
  targetVersion = undefined,
  baseVersion = undefined,
  baseTreeSha256 = undefined,
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
}) {
  const finalStatus = assertStatus(status, { finalOnly: true });
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const current = await readVerifiedDevelopmentReceipt({
    productRoot,
    candidateId,
    packageSha256,
    receiptSigningKey: key,
  });
  const latest = current.receipt;
  if (latest.status !== "pending") {
    if (latest.status !== finalStatus) fail("DEVELOPMENT_REVIEW_ALREADY_FINAL", latest.candidateId);
    let chain = null;
    let promotion = null;
    if (finalStatus === "approved") {
      chain = await reconcileApprovedChain({
        paths,
        key,
        receipt: latest,
        targetVersion,
        baseVersion,
        baseTreeSha256,
        now,
      });
      const ready = await assertTestReadyForApproval({
        paths,
        key,
        reviewState: current,
        chain,
        afterApproval: true,
      });
      const currentTree = await collectDevelopmentTree(paths.current);
      if (currentTree.treeSha256 !== ready.receipt.finalTreeSha256) {
        fail("DEVELOPMENT_PROMOTION_CURRENT_TREE_MISMATCH", latest.candidateId);
      }
      promotion = { finalTreeSha256: currentTree.treeSha256, idempotent: true };
    }
    return { ...current, chain, promotion, idempotent: true };
  }
  const descriptor = {
    manifestSha256: manifestSha256 === undefined ? latest.manifestSha256 : manifestSha256,
    resultingTreeSha256: resultingTreeSha256 === undefined
      ? latest.resultingTreeSha256
      : resultingTreeSha256,
    requires: requires === undefined ? latest.requires : requires,
  };
  assertNullableHash(descriptor.manifestSha256, "DEVELOPMENT_MANIFEST_HASH_INVALID");
  assertNullableHash(descriptor.resultingTreeSha256, "DEVELOPMENT_RESULT_TREE_HASH_INVALID");
  descriptor.requires = normalizeRequires(descriptor.requires);

  let chainBefore = null;
  let approvedTestReady = null;
  if (finalStatus === "approved") {
    if (!descriptor.manifestSha256 || !descriptor.resultingTreeSha256) {
      fail("DEVELOPMENT_APPROVED_DESCRIPTOR_REQUIRED");
    }
    chainBefore = await readChainFile(paths, key, { required: false });
    if (!chainBefore) {
      if (!targetVersion || !baseVersion || !baseTreeSha256) fail("DEVELOPMENT_CHAIN_BASE_REQUIRED");
      chainBefore = createChain({
        targetVersion,
        baseVersion,
        baseTreeSha256,
        entries: [],
        finalTreeSha256: baseTreeSha256,
        updatedAt: timestamp(now),
      }, key);
    }
    await verifyReceiptPackageDescriptor(current.location.path, {
      ...latest,
      ...descriptor,
    }, chainBefore.targetVersion);
    const groupsBefore = await verifiedReceiptGroups(paths, key);
    await validateChainAgainstReceipts(paths, key, chainBefore, groupsBefore);
    await validateRequirementClosure({
      paths,
      groups: groupsBefore,
      chain: chainBefore,
      roots: [{
        ownerCandidateId: latest.candidateId,
        ownerPackageSha256: latest.packageSha256,
        ownerIndex: chainBefore.entries.length,
        requires: descriptor.requires,
      }],
    });
    approvedTestReady = await assertTestReadyForApproval({
      paths,
      key,
      reviewState: current,
      chain: chainBefore,
    });
  }

  const receipt = createReceipt({
    candidateId: latest.candidateId,
    packageSha256: latest.packageSha256,
    packageSizeBytes: latest.packageSizeBytes,
    storedName: latest.storedName,
    status: finalStatus,
    sequence: latest.sequence + 1,
    previousReceiptSha256: latest.receiptSha256,
    ...descriptor,
    reviewedAt: timestamp(now),
    reviewedBy: assertHumanText(reviewedBy, "DEVELOPMENT_REVIEWER_INVALID", MAXIMUM_REVIEWER_BYTES),
    note: assertHumanText(note, "DEVELOPMENT_REVIEW_NOTE_INVALID", MAXIMUM_NOTE_BYTES, { allowEmpty: true }),
  }, key);
  let chainAfter = null;
  if (finalStatus === "approved") {
    const entry = {
      candidateId: receipt.candidateId,
      packageSha256: receipt.packageSha256,
      receiptSha256: receipt.receiptSha256,
      manifestSha256: receipt.manifestSha256,
      requires: receipt.requires,
      resultingTreeSha256: receipt.resultingTreeSha256,
    };
    chainAfter = createChain({
      targetVersion: chainBefore.targetVersion,
      baseVersion: chainBefore.baseVersion,
      baseTreeSha256: chainBefore.baseTreeSha256,
      entries: [...chainBefore.entries, entry],
      finalTreeSha256: receipt.resultingTreeSha256,
      updatedAt: timestamp(now),
    }, key);
  }
  const currentBefore = await collectDevelopmentTree(paths.current);
  const previousBefore = await collectDevelopmentTree(paths.previous);
  const transaction = createReviewTransaction({
    transactionId: receipt.receiptSha256,
    candidateId: receipt.candidateId,
    packageSha256: receipt.packageSha256,
    finalStatus,
    finalReceipt: receipt,
    chainBeforeSha256: finalStatus === "approved" && await lstatOrNull(paths.approvedChain)
      ? chainBefore.chainSha256
      : null,
    chainAfter,
    testReady: approvedTestReady?.receipt || null,
    currentBeforeTreeSha256: currentBefore.treeSha256,
    previousBeforeTreeSha256: previousBefore.treeSha256,
    createdAt: timestamp(now),
    phase: "prepared",
  }, key);
  const transactionFile = reviewTransactionFile(paths, transaction);
  await writeJsonExclusive(transactionFile, transaction);
  maybeCrashReviewTransaction("journal-written");
  const completed = await completeDevelopmentReviewTransaction(paths, key, transaction);
  return {
    receipt: completed.receipt,
    history: [...current.history, receipt],
    location: completed.location,
    chain: completed.chain,
    promotion: completed.promotion,
    idempotent: false,
  };
}

export async function listDevelopmentPackages({
  productRoot,
  receiptSigningKey = undefined,
  keyFile = undefined,
  verifyPackages = false,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const groups = await verifiedReceiptGroups(paths, key);
  const candidates = [];
  for (const receipts of groups.values()) {
    const latest = receipts.at(-1);
    const locations = await packageLocations(paths, latest.storedName);
    if (locations.length !== 1) fail("DEVELOPMENT_PACKAGE_LOCATION_INVALID", latest.candidateId);
    if (verifyPackages) {
      if (locations[0].kind === "deleted") {
        const deletion = parseDeletionRecord(
          await readSmallJson(locations[0].path, "DEVELOPMENT_DELETION_INVALID"),
          key,
        );
        if (
          deletion.candidateId !== latest.candidateId
          || deletion.packageSha256 !== latest.packageSha256
          || deletion.sourceReceiptSha256 !== latest.receiptSha256
        ) fail("DEVELOPMENT_DELETION_RECEIPT_MISMATCH", latest.candidateId);
      } else {
        await verifyPackageAtLocation(locations[0], latest);
      }
    }
    candidates.push({
      candidateId: latest.candidateId,
      packageSha256: latest.packageSha256,
      status: latest.status,
      packageSizeBytes: latest.packageSizeBytes,
      reviewedAt: latest.reviewedAt,
      reviewedBy: latest.reviewedBy,
      note: latest.note,
      manifestSha256: latest.manifestSha256,
      resultingTreeSha256: latest.resultingTreeSha256,
      requires: latest.requires,
      receiptSha256: latest.receiptSha256,
      location: locations[0].kind === "trash"
        ? "trash"
        : (locations[0].kind === "deleted" ? "deleted" : locations[0].status),
      trashId: locations[0].trashId || null,
    });
  }
  candidates.sort((left, right) => bytewiseCompare(left.candidateId, right.candidateId));
  return candidates;
}

function createCleanupPlanEnvelope(core, key) {
  return signedEnvelope(core, key, "planMac", "planSha256");
}

function parseCleanupPlan(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "createdAt", "activeCandidateIds", "openCandidateIds", "preparedReleaseCandidateIds",
      "discardPendingCandidateIds", "candidates", "protected", "reclaimableBytes", "planMac", "planSha256",
    ]),
    "DEVELOPMENT_CLEANUP_PLAN_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "planMac",
    "planSha256",
    "DEVELOPMENT_CLEANUP_PLAN_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_CLEANUP_PLAN_SCHEMA) fail("DEVELOPMENT_CLEANUP_PLAN_SCHEMA_UNSUPPORTED");
  assertCanonicalTimestamp(core.createdAt, "DEVELOPMENT_CLEANUP_PLAN_TIME_INVALID");
  for (const [label, values] of Object.entries({
    activeCandidateIds: core.activeCandidateIds,
    openCandidateIds: core.openCandidateIds,
    preparedReleaseCandidateIds: core.preparedReleaseCandidateIds,
    discardPendingCandidateIds: core.discardPendingCandidateIds,
  })) {
    if (stableStringify(values) !== stableStringify(normalizeCandidateSet(values, label))) {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID", label);
    }
  }
  if (!Array.isArray(core.candidates) || !Array.isArray(core.protected)) {
    fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
  }
  let bytes = 0;
  for (const entry of core.candidates) {
    assertExactKeys(
      entry,
      new Set([
        "candidateId", "packageSha256", "receiptSha256", "status", "storedName", "packageSizeBytes",
        "testTreeSha256", "testSizeBytes", "reason",
      ]),
      "DEVELOPMENT_CLEANUP_PLAN_INVALID",
      "candidate",
    );
    assertCandidateId(entry.candidateId);
    assertHash(entry.packageSha256, "DEVELOPMENT_CLEANUP_PLAN_INVALID");
    assertHash(entry.receiptSha256, "DEVELOPMENT_CLEANUP_PLAN_INVALID");
    assertStatus(entry.status);
    if (entry.storedName !== storedPackageName(entry.candidateId, entry.packageSha256)) {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
    }
    if (!Number.isSafeInteger(entry.packageSizeBytes) || entry.packageSizeBytes <= 0) {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
    }
    assertNullableHash(entry.testTreeSha256, "DEVELOPMENT_CLEANUP_PLAN_INVALID");
    if (!Number.isSafeInteger(entry.testSizeBytes) || entry.testSizeBytes < 0) {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
    }
    if ((entry.testTreeSha256 === null) !== (entry.testSizeBytes === 0)) {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
    }
    if (entry.reason !== "terminal-unreferenced" && entry.reason !== "discarded-pending") {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
    }
    bytes += entry.packageSizeBytes + entry.testSizeBytes;
  }
  for (const entry of core.protected) {
    assertExactKeys(
      entry,
      new Set(["candidateId", "packageSha256", "status", "reasons"]),
      "DEVELOPMENT_CLEANUP_PLAN_INVALID",
      "protected",
    );
    assertCandidateId(entry.candidateId);
    assertHash(entry.packageSha256, "DEVELOPMENT_CLEANUP_PLAN_INVALID");
    assertStatus(entry.status);
    if (!Array.isArray(entry.reasons) || !entry.reasons.length || entry.reasons.some((reason) => typeof reason !== "string")) {
      fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
    }
  }
  if (!Number.isSafeInteger(core.reclaimableBytes) || core.reclaimableBytes !== bytes) {
    fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
  }
  const recreated = createCleanupPlanEnvelope(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_CLEANUP_PLAN_INVALID");
  return recreated;
}

export async function createDevelopmentCleanupPlan({
  productRoot,
  activeCandidateIds = [],
  openCandidateIds = [],
  preparedReleaseCandidateIds = [],
  discardPendingCandidateIds = [],
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
  persist = false,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const normalized = {
    activeCandidateIds: normalizeCandidateSet(activeCandidateIds, "active"),
    openCandidateIds: normalizeCandidateSet(openCandidateIds, "open"),
    preparedReleaseCandidateIds: normalizeCandidateSet(preparedReleaseCandidateIds, "prepared-release"),
    discardPendingCandidateIds: normalizeCandidateSet(discardPendingCandidateIds, "discard-pending"),
  };
  const active = new Set(normalized.activeCandidateIds);
  const open = new Set(normalized.openCandidateIds);
  const prepared = new Set(normalized.preparedReleaseCandidateIds);
  const discardPending = new Set(normalized.discardPendingCandidateIds);
  const groups = await verifiedReceiptGroups(paths, key);
  const chain = await readChainFile(paths, key, { required: false });
  const verifiedChain = chain
    ? await validateChainAgainstReceipts(paths, key, chain, groups)
    : { chain: null, dependencyIdentities: new Set() };
  const chainCandidates = new Set((chain?.entries || []).map((entry) => entry.candidateId));
  const candidates = [];
  const protectedEntries = [];
  for (const receipts of groups.values()) {
    const latest = receipts.at(-1);
    const locations = await packageLocations(paths, latest.storedName);
    if (locations.length !== 1) fail("DEVELOPMENT_PACKAGE_LOCATION_INVALID", latest.candidateId);
    const location = locations[0];
    if (location.kind === "trash" || location.kind === "deleted") continue;
    await verifyPackageAtLocation(location, latest);
    const reasons = [];
    if (latest.status === "approved") reasons.push("approved");
    if (chainCandidates.has(latest.candidateId)) reasons.push("approved-chain");
    if (verifiedChain.dependencyIdentities.has(`${latest.candidateId}\0${latest.packageSha256}`)) {
      reasons.push("dependency");
    }
    if (active.has(latest.candidateId)) reasons.push("active");
    if (open.has(latest.candidateId)) reasons.push("open-test");
    if (prepared.has(latest.candidateId)) reasons.push("prepared-release");
    if (latest.status === "pending" && !discardPending.has(latest.candidateId)) reasons.push("pending");
    if (reasons.length) {
      protectedEntries.push({
        candidateId: latest.candidateId,
        packageSha256: latest.packageSha256,
        status: latest.status,
        reasons: [...new Set(reasons)].sort(bytewiseCompare),
      });
      continue;
    }
    const terminal = new Set(["rejected", "failed"]).has(latest.status);
    if (!terminal && !(latest.status === "pending" && discardPending.has(latest.candidateId))) {
      protectedEntries.push({
        candidateId: latest.candidateId,
        packageSha256: latest.packageSha256,
        status: latest.status,
        reasons: ["unsupported-cleanup-state"],
      });
      continue;
    }
    const testArtifact = await inspectStoredTestArtifact(paths, key, receipts);
    candidates.push({
      candidateId: latest.candidateId,
      packageSha256: latest.packageSha256,
      receiptSha256: latest.receiptSha256,
      status: latest.status,
      storedName: latest.storedName,
      packageSizeBytes: latest.packageSizeBytes,
      testTreeSha256: testArtifact?.tree.treeSha256 || null,
      testSizeBytes: testArtifact?.sizeBytes || 0,
      reason: terminal ? "terminal-unreferenced" : "discarded-pending",
    });
  }
  candidates.sort((left, right) => bytewiseCompare(left.candidateId, right.candidateId));
  protectedEntries.sort((left, right) => bytewiseCompare(left.candidateId, right.candidateId));
  const plan = createCleanupPlanEnvelope({
    schema: DEVELOPMENT_CLEANUP_PLAN_SCHEMA,
    createdAt: timestamp(now),
    ...normalized,
    candidates,
    protected: protectedEntries,
    reclaimableBytes: candidates.reduce(
      (sum, entry) => sum + entry.packageSizeBytes + entry.testSizeBytes,
      0,
    ),
  }, key);
  if (persist) await writeJsonAtomic(paths.cleanupPlan, plan);
  return plan;
}

function createTrashRecord(input, key) {
  const core = {
    schema: DEVELOPMENT_TRASH_SCHEMA,
    trashId: input.trashId,
    candidateId: assertCandidateId(input.candidateId),
    packageSha256: assertHash(input.packageSha256, "DEVELOPMENT_TRASH_INVALID"),
    packageSizeBytes: input.packageSizeBytes,
    storedName: input.storedName,
    sourceStatus: assertStatus(input.sourceStatus),
    sourceReceiptSha256: assertHash(input.sourceReceiptSha256, "DEVELOPMENT_TRASH_INVALID"),
    testReadySha256: assertNullableHash(input.testReadySha256, "DEVELOPMENT_TRASH_INVALID"),
    testTreeSha256: assertNullableHash(input.testTreeSha256, "DEVELOPMENT_TRASH_INVALID"),
    testSizeBytes: input.testSizeBytes,
    trashedAt: assertCanonicalTimestamp(input.trashedAt, "DEVELOPMENT_TRASH_TIME_INVALID"),
  };
  if (!TRASH_ID_PATTERN.test(core.trashId)) fail("DEVELOPMENT_TRASH_ID_INVALID");
  if (!Number.isSafeInteger(core.packageSizeBytes) || core.packageSizeBytes <= 0) {
    fail("DEVELOPMENT_TRASH_INVALID");
  }
  if (!Number.isSafeInteger(core.testSizeBytes) || core.testSizeBytes < 0) {
    fail("DEVELOPMENT_TRASH_INVALID");
  }
  const testFields = [core.testReadySha256, core.testTreeSha256];
  if (testFields.some((value) => value === null) !== testFields.every((value) => value === null)) {
    fail("DEVELOPMENT_TRASH_INVALID");
  }
  if ((core.testTreeSha256 === null) !== (core.testSizeBytes === 0)) {
    fail("DEVELOPMENT_TRASH_INVALID");
  }
  if (core.storedName !== storedPackageName(core.candidateId, core.packageSha256)) {
    fail("DEVELOPMENT_TRASH_INVALID");
  }
  return signedEnvelope(core, key, "trashMac", "trashSha256");
}

function parseTrashRecord(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "trashId", "candidateId", "packageSha256", "packageSizeBytes", "storedName",
      "sourceStatus", "sourceReceiptSha256", "testReadySha256", "testTreeSha256", "testSizeBytes",
      "trashedAt", "trashMac", "trashSha256",
    ]),
    "DEVELOPMENT_TRASH_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "trashMac",
    "trashSha256",
    "DEVELOPMENT_TRASH_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_TRASH_SCHEMA) fail("DEVELOPMENT_TRASH_SCHEMA_UNSUPPORTED");
  const recreated = createTrashRecord(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_TRASH_INVALID");
  return recreated;
}

function createDeletionRecord(input, key) {
  const core = {
    schema: DEVELOPMENT_DELETION_SCHEMA,
    candidateId: assertCandidateId(input.candidateId),
    packageSha256: assertHash(input.packageSha256, "DEVELOPMENT_DELETION_INVALID"),
    packageSizeBytes: input.packageSizeBytes,
    sourceReceiptSha256: assertHash(input.sourceReceiptSha256, "DEVELOPMENT_DELETION_INVALID"),
    trashReceiptSha256: assertHash(input.trashReceiptSha256, "DEVELOPMENT_DELETION_INVALID"),
    deletedAt: assertCanonicalTimestamp(input.deletedAt, "DEVELOPMENT_DELETION_TIME_INVALID"),
  };
  if (!Number.isSafeInteger(core.packageSizeBytes) || core.packageSizeBytes <= 0) {
    fail("DEVELOPMENT_DELETION_INVALID");
  }
  return signedEnvelope(core, key, "deletionMac", "deletionSha256");
}

function parseDeletionRecord(raw, key) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "candidateId", "packageSha256", "packageSizeBytes", "sourceReceiptSha256",
      "trashReceiptSha256", "deletedAt", "deletionMac", "deletionSha256",
    ]),
    "DEVELOPMENT_DELETION_INVALID",
    "fields",
  );
  const core = verifySignedEnvelope(
    raw,
    key,
    "deletionMac",
    "deletionSha256",
    "DEVELOPMENT_DELETION_AUTHENTICATION_FAILED",
  );
  if (core.schema !== DEVELOPMENT_DELETION_SCHEMA) fail("DEVELOPMENT_DELETION_SCHEMA_UNSUPPORTED");
  const recreated = createDeletionRecord(core, key);
  if (stableStringify(recreated) !== stableStringify(raw)) fail("DEVELOPMENT_DELETION_INVALID");
  return recreated;
}

async function readTrashRecord(paths, key, trashId, { verifyPackage = true } = {}) {
  if (typeof trashId !== "string" || !TRASH_ID_PATTERN.test(trashId)) fail("DEVELOPMENT_TRASH_ID_INVALID");
  const trashRoot = containedPath(paths.trash, trashId);
  await assertPlainDirectory(trashRoot, "DEVELOPMENT_TRASH_NOT_FOUND");
  const record = parseTrashRecord(
    await readSmallJson(path.join(trashRoot, "TRASH-RECEIPT.json"), "DEVELOPMENT_TRASH_INVALID"),
    key,
  );
  if (record.trashId !== trashId) fail("DEVELOPMENT_TRASH_ID_MISMATCH");
  const packagePath = path.join(trashRoot, record.storedName);
  if (verifyPackage) {
    await verifyPackageAtLocation({ path: packagePath }, {
      ...record,
      packageSizeBytes: record.packageSizeBytes,
    });
  }
  let testArtifact = null;
  if (record.testTreeSha256 !== null) {
    const testRoot = path.join(trashRoot, "TEST");
    await assertPlainDirectory(testRoot, "DEVELOPMENT_TRASH_TEST_INVALID");
    const readyFile = path.join(testRoot, "TEST-READY.json");
    const ready = parseTestReadyReceipt(
      await readSmallJson(readyFile, "DEVELOPMENT_TRASH_TEST_INVALID"),
      key,
    );
    const testSystem = path.join(testRoot, "SYSTEM");
    const tree = await collectDevelopmentTree(testSystem);
    const readySize = (await assertRegularFile(readyFile, "DEVELOPMENT_TRASH_TEST_INVALID")).size;
    const sizeBytes = readySize + tree.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (
      ready.testReadySha256 !== record.testReadySha256
      || tree.treeSha256 !== record.testTreeSha256
      || sizeBytes !== record.testSizeBytes
    ) fail("DEVELOPMENT_TRASH_TEST_INVALID", trashId);
    const testNames = (await fs.readdir(testRoot)).sort(bytewiseCompare);
    if (stableStringify(testNames) !== stableStringify(["SYSTEM", "TEST-READY.json"])) {
      fail("DEVELOPMENT_TRASH_TEST_INVALID", trashId);
    }
    testArtifact = { testRoot, testSystem, readyFile, ready, tree, sizeBytes };
  }
  const names = (await fs.readdir(trashRoot)).sort(bytewiseCompare);
  const expectedNames = ["TRASH-RECEIPT.json", record.storedName];
  if (record.testTreeSha256 !== null) expectedNames.push("TEST");
  if (stableStringify(names) !== stableStringify(expectedNames.sort(bytewiseCompare))) {
    fail("DEVELOPMENT_TRASH_CONTENT_INVALID", trashId);
  }
  return { record, trashRoot, packagePath, testArtifact };
}

export async function listDevelopmentTrash({
  productRoot,
  receiptSigningKey = undefined,
  keyFile = undefined,
  verifyPackages = true,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const entries = (await fs.readdir(paths.trash, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => bytewiseCompare(left.name, right.name));
  const trash = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail("DEVELOPMENT_TRASH_CONTENT_INVALID", entry.name);
    }
    const item = await readTrashRecord(paths, key, entry.name, { verifyPackage: verifyPackages });
    trash.push({
      trashId: item.record.trashId,
      candidateId: item.record.candidateId,
      packageSha256: item.record.packageSha256,
      sourceStatus: item.record.sourceStatus,
      packageSizeBytes: item.record.packageSizeBytes,
      testTreeSha256: item.record.testTreeSha256,
      testSizeBytes: item.record.testSizeBytes,
      trashedAt: item.record.trashedAt,
      trashSha256: item.record.trashSha256,
    });
  }
  return trash;
}

async function trashCleanupCandidate({ paths, key, entry, now, planSha256 }) {
  const trashId = `${entry.candidateId}--${entry.packageSha256.slice(0, 16)}--${planSha256.slice(0, 16)}`;
  const latest = await readVerifiedDevelopmentReceipt({
    productRoot: paths.productRoot,
    candidateId: entry.candidateId,
    packageSha256: entry.packageSha256,
    receiptSigningKey: key,
  });
  if (
    latest.receipt.receiptSha256 !== entry.receiptSha256
    || latest.receipt.status !== entry.status
    || latest.location.kind !== "package"
    || latest.location.status !== entry.status
  ) fail("DEVELOPMENT_CLEANUP_STATE_CHANGED", entry.candidateId);
  const testArtifact = await inspectStoredTestArtifact(paths, key, latest.history);
  if (
    (testArtifact?.tree.treeSha256 || null) !== entry.testTreeSha256
    || (testArtifact?.sizeBytes || 0) !== entry.testSizeBytes
  ) fail("DEVELOPMENT_CLEANUP_TEST_STATE_CHANGED", entry.candidateId);
  const trashRoot = path.join(paths.trash, trashId);
  const existing = await lstatOrNull(trashRoot);
  if (!existing) await fs.mkdir(trashRoot, { mode: 0o700 });
  await assertPlainDirectory(trashRoot);
  const recordFile = path.join(trashRoot, "TRASH-RECEIPT.json");
  let record;
  if (await lstatOrNull(recordFile)) {
    record = parseTrashRecord(await readSmallJson(recordFile, "DEVELOPMENT_TRASH_INVALID"), key);
    if (
      record.trashId !== trashId
      || record.candidateId !== entry.candidateId
      || record.packageSha256 !== entry.packageSha256
      || record.sourceReceiptSha256 !== entry.receiptSha256
      || record.testTreeSha256 !== entry.testTreeSha256
      || record.testSizeBytes !== entry.testSizeBytes
    ) fail("DEVELOPMENT_TRASH_CONFLICT", entry.candidateId);
  } else {
    record = createTrashRecord({
      trashId,
      candidateId: entry.candidateId,
      packageSha256: entry.packageSha256,
      packageSizeBytes: entry.packageSizeBytes,
      storedName: entry.storedName,
      sourceStatus: entry.status,
      sourceReceiptSha256: entry.receiptSha256,
      testReadySha256: testArtifact?.ready.testReadySha256 || null,
      testTreeSha256: testArtifact?.tree.treeSha256 || null,
      testSizeBytes: testArtifact?.sizeBytes || 0,
      trashedAt: timestamp(now),
    }, key);
    await writeJsonExclusive(recordFile, record);
  }
  const target = path.join(trashRoot, entry.storedName);
  if (!(await lstatOrNull(target))) await movePackage(latest.location.path, target);
  if (testArtifact) {
    const testTarget = path.join(trashRoot, "TEST");
    if (!(await lstatOrNull(testTarget))) {
      await fs.rename(testArtifact.testRoot, testTarget);
      await syncDirectory(paths.tests);
      await syncDirectory(trashRoot);
    }
  }
  await readTrashRecord(paths, key, trashId);
  return { trashId, candidateId: entry.candidateId, packageSha256: entry.packageSha256 };
}

export async function executeDevelopmentCleanup({
  productRoot,
  plan = undefined,
  expectedPlanSha256 = undefined,
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const rawPlan = plan || await readSmallJson(paths.cleanupPlan, "DEVELOPMENT_CLEANUP_PLAN_MISSING");
  const verifiedPlan = parseCleanupPlan(rawPlan, key);
  if (expectedPlanSha256 !== undefined && verifiedPlan.planSha256 !== expectedPlanSha256) {
    fail("DEVELOPMENT_CLEANUP_PLAN_CHANGED");
  }
  const groups = await verifiedReceiptGroups(paths, key);
  const chain = await readChainFile(paths, key, { required: false });
  const verifiedChain = chain
    ? await validateChainAgainstReceipts(paths, key, chain, groups)
    : { chain: null, dependencyIdentities: new Set() };
  const protectedIds = new Set([
    ...verifiedPlan.activeCandidateIds,
    ...verifiedPlan.openCandidateIds,
    ...verifiedPlan.preparedReleaseCandidateIds,
    ...(chain?.entries || []).map((entry) => entry.candidateId),
    ...[...verifiedChain.dependencyIdentities].map((identity) => identity.split("\0", 1)[0]),
  ]);
  for (const entry of verifiedPlan.candidates) {
    if (protectedIds.has(entry.candidateId) || entry.status === "approved") {
      fail("DEVELOPMENT_CLEANUP_PROTECTED", entry.candidateId);
    }
  }
  const moved = [];
  for (const entry of verifiedPlan.candidates) {
    moved.push(await trashCleanupCandidate({
      paths,
      key,
      entry,
      now,
      planSha256: verifiedPlan.planSha256,
    }));
  }
  if (plan === undefined) await fs.unlink(paths.cleanupPlan).catch(() => undefined);
  return {
    planSha256: verifiedPlan.planSha256,
    moved,
    reclaimedBytes: verifiedPlan.reclaimableBytes,
  };
}

export async function restoreDevelopmentPackage({
  productRoot,
  trashId,
  receiptSigningKey = undefined,
  keyFile = undefined,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  const item = await readTrashRecord(paths, key, trashId);
  const receiptState = await readVerifiedDevelopmentReceipt({
    productRoot,
    candidateId: item.record.candidateId,
    packageSha256: item.record.packageSha256,
    receiptSigningKey: key,
  });
  if (
    receiptState.receipt.status !== item.record.sourceStatus
    || receiptState.receipt.receiptSha256 !== item.record.sourceReceiptSha256
    || receiptState.location.kind !== "trash"
    || receiptState.location.trashId !== trashId
  ) fail("DEVELOPMENT_TRASH_RECEIPT_MISMATCH");
  if (receiptState.receipt.status === "approved") fail("DEVELOPMENT_RESTORE_APPROVED_INVALID");
  const chain = await readChainFile(paths, key, { required: false });
  if (chain?.entries.some((entry) => entry.candidateId === item.record.candidateId)) {
    fail("DEVELOPMENT_RESTORE_CHAIN_CONFLICT", item.record.candidateId);
  }
  const target = path.join(paths.packageDirectories[item.record.sourceStatus], item.record.storedName);
  const testTarget = item.testArtifact
    ? path.join(paths.tests, `${item.record.candidateId}--${item.record.packageSha256}`)
    : null;
  if (testTarget && await lstatOrNull(testTarget)) {
    fail("DEVELOPMENT_RESTORE_TEST_TARGET_EXISTS", item.record.candidateId);
  }
  await movePackage(item.packagePath, target);
  try {
    if (item.testArtifact) {
      await fs.rename(item.testArtifact.testRoot, testTarget);
      await syncDirectory(paths.tests);
    }
  } catch (error) {
    await movePackage(target, item.packagePath).catch(() => undefined);
    throw error;
  }
  await fs.unlink(path.join(item.trashRoot, "TRASH-RECEIPT.json"));
  await fs.rmdir(item.trashRoot);
  await syncDirectory(paths.trash);
  return {
    candidateId: item.record.candidateId,
    packageSha256: item.record.packageSha256,
    status: item.record.sourceStatus,
    restoredPath: target,
    testRestored: Boolean(item.testArtifact),
  };
}

export async function emptyDevelopmentTrash({
  productRoot,
  retentionMs = DEFAULT_TRASH_RETENTION_MS,
  force = false,
  receiptSigningKey = undefined,
  keyFile = undefined,
  now = undefined,
}) {
  const paths = await initializeDevelopmentStore({ productRoot });
  const key = await resolveKey({ productRoot, receiptSigningKey, keyFile });
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) fail("DEVELOPMENT_TRASH_RETENTION_INVALID");
  const currentTime = Date.parse(timestamp(now));
  const removed = [];
  const retained = [];
  const entries = (await fs.readdir(paths.trash, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => bytewiseCompare(left.name, right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("DEVELOPMENT_TRASH_CONTENT_INVALID", entry.name);
    const item = await readTrashRecord(paths, key, entry.name);
    const age = currentTime - Date.parse(item.record.trashedAt);
    if (!force && age < retentionMs) {
      retained.push({ trashId: entry.name, candidateId: item.record.candidateId });
      continue;
    }
    const deletionFile = path.join(
      paths.receipts,
      `DELETED--${item.record.candidateId}--${item.record.packageSha256}.json`,
    );
    const deletionRecord = createDeletionRecord({
      candidateId: item.record.candidateId,
      packageSha256: item.record.packageSha256,
      packageSizeBytes: item.record.packageSizeBytes,
      sourceReceiptSha256: item.record.sourceReceiptSha256,
      trashReceiptSha256: item.record.trashSha256,
      deletedAt: timestamp(now),
    }, key);
    const existingDeletion = await lstatOrNull(deletionFile);
    if (existingDeletion) {
      const verifiedDeletion = parseDeletionRecord(
        await readSmallJson(deletionFile, "DEVELOPMENT_DELETION_INVALID"),
        key,
      );
      if (
        verifiedDeletion.candidateId !== deletionRecord.candidateId
        || verifiedDeletion.packageSha256 !== deletionRecord.packageSha256
        || verifiedDeletion.sourceReceiptSha256 !== deletionRecord.sourceReceiptSha256
        || verifiedDeletion.trashReceiptSha256 !== deletionRecord.trashReceiptSha256
      ) fail("DEVELOPMENT_DELETION_CONFLICT", item.record.candidateId);
    } else {
      await writeJsonExclusive(deletionFile, deletionRecord);
    }
    if (item.testArtifact) {
      await archiveTestReadyReceipt(paths, key, item.testArtifact.ready);
      await fs.rm(item.testArtifact.testRoot, { recursive: true, force: true });
    }
    await fs.unlink(item.packagePath);
    await fs.unlink(path.join(item.trashRoot, "TRASH-RECEIPT.json"));
    await fs.rmdir(item.trashRoot);
    removed.push({
      trashId: entry.name,
      candidateId: item.record.candidateId,
      packageSha256: item.record.packageSha256,
      removedBytes: item.record.packageSizeBytes + item.record.testSizeBytes,
    });
  }
  await syncDirectory(paths.trash);
  return {
    removed,
    retained,
    removedBytes: removed.reduce((sum, entry) => sum + entry.removedBytes, 0),
  };
}
