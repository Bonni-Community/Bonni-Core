import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readAndVerifyUpdatePackageManifest } from "./update-package-manifest.mjs";
import { loadProductionUpdateVerificationPolicy } from "./update-package-trust.mjs";

export const READY_UPDATE_TRANSACTION_SCHEMA = "bonni.update-ready/v1";

const PREPARED_RECEIPT_SCHEMA = "bonni.update-prepared/v1";
const INTAKE_DIRECTORY = "update-package-intake";
const READY_DIRECTORY = "update-package-ready";
const TRANSACTIONS_DIRECTORY = "transactions";
const SUPPORTED_COMPONENTS = Object.freeze(["SYSTEM", "WINDOWS"]);
const SUPPORTED_COMPONENT_SET = new Set(SUPPORTED_COMPONENTS);
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MAXIMUM_CONTROL_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const WINDOWS_DIRECTORY_OPEN_UNSUPPORTED_CODES = new Set(["EACCES", "EISDIR", "EPERM"]);
const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EPERM"]);

export class PreparedUpdateConsumerError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "PreparedUpdateConsumerError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new PreparedUpdateConsumerError(code, detail, options);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => bytewiseCompare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function relativePortable(root, target, { allowSelf = false } = {}) {
  const relative = path.relative(root, target);
  if (!relative && allowSelf) return ".";
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail("READY_UPDATE_PATH_ESCAPE", target);
  return relative.split(path.sep).join("/");
}

function normalizePortableRelative(value, code) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    fail(code, String(value));
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(code, value);
  }
  return segments.join("/");
}

function resolveContained(root, relativeValue, code) {
  const relativePath = normalizePortableRelative(relativeValue, code);
  const target = path.resolve(root, ...relativePath.split("/"));
  relativePortable(root, target);
  return target;
}

async function lstatOrNull(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertPlainDirectory(target, missingCode) {
  const state = await lstatOrNull(target);
  if (!state) fail(missingCode, target);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("READY_UPDATE_DIRECTORY_UNSAFE", target);
  }
  return state;
}

async function ensurePlainChildDirectory(parent, name) {
  await assertPlainDirectory(parent, "READY_UPDATE_PARENT_MISSING");
  const target = path.join(parent, name);
  const existing = await lstatOrNull(target);
  if (!existing) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await assertPlainDirectory(target, "READY_UPDATE_DIRECTORY_MISSING");
  return target;
}

async function assertPlainPathChain(root, target, finalKind) {
  const relative = relativePortable(root, target, { allowSelf: true });
  if (relative === ".") return assertPlainDirectory(root, "READY_UPDATE_PATH_MISSING");
  let current = root;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const state = await lstatOrNull(current);
    if (!state) fail("READY_UPDATE_PATH_MISSING", current);
    if (state.isSymbolicLink()) fail("READY_UPDATE_PATH_SYMLINK_REJECTED", current);
    const isFinal = index === segments.length - 1;
    if (!isFinal && !state.isDirectory()) fail("READY_UPDATE_PATH_TYPE_INVALID", current);
    if (isFinal && finalKind === "directory" && !state.isDirectory()) {
      fail("READY_UPDATE_PATH_TYPE_INVALID", current);
    }
    if (isFinal && finalKind === "file" && !state.isFile()) {
      fail("READY_UPDATE_PATH_TYPE_INVALID", current);
    }
  }
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function openStableRegularFile(target, { maximumBytes, code, allowEmpty = false }) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    fail(code, target, { cause: error });
  }
  try {
    const state = await handle.stat({ bigint: true });
    if (
      !state.isFile()
      || state.nlink !== 1n
      || (!allowEmpty && state.size <= 0n)
      || (maximumBytes !== undefined && state.size > BigInt(maximumBytes))
    ) fail(code, target);
    return { handle, state };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function hashStableRegularFile(target, options) {
  const { handle, state: before } = await openStableRegularFile(target, options);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(sizeBytes) !== before.size) {
      fail("READY_UPDATE_FILE_CHANGED_DURING_READ", target);
    }
    return { sha256: hash.digest("hex"), sizeBytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readStableControlFile(target, code) {
  const { handle, state: before } = await openStableRegularFile(target, {
    maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    code,
  });
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(bytes.length) !== before.size) {
      fail("READY_UPDATE_FILE_CHANGED_DURING_READ", target);
    }
    return { bytes, sha256: sha256(bytes) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
  } catch (error) {
    if (process.platform === "win32" && WINDOWS_DIRECTORY_OPEN_UNSUPPORTED_CODES.has(error?.code)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!(process.platform === "win32" && WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error?.code))) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function syncTreeDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    const state = await fs.lstat(target);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      fail("READY_UPDATE_STAGED_TREE_UNSAFE", target);
    }
    await syncTreeDirectories(target);
  }
  await syncDirectory(root);
}

async function writeFileSyncedExclusive(target, contents) {
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function manifestView(manifest) {
  if (!isPlainObject(manifest) || typeof manifest.schema !== "string") {
    fail("READY_UPDATE_MANIFEST_INVALID");
  }
  const signed = new Set(["bonni.update/v2", "bonni.update/v3"]).has(manifest.schema)
    ? manifest.signed
    : manifest;
  if (
    !isPlainObject(signed)
    || typeof signed.updateId !== "string"
    || !UPDATE_ID.test(signed.updateId)
    || typeof signed.createdAt !== "string"
    || !Array.isArray(signed.payloads)
  ) fail("READY_UPDATE_MANIFEST_INVALID");
  return {
    schema: manifest.schema,
    updateId: signed.updateId,
    createdAt: signed.createdAt,
    ...(typeof signed.channel === "string" ? { channel: signed.channel } : {}),
    ...(Number.isSafeInteger(signed.releaseSequence) ? { releaseSequence: signed.releaseSequence } : {}),
    payloads: signed.payloads,
  };
}

function payloadSummary(payload) {
  return {
    component: payload.component,
    ...(payload.platform === undefined ? {} : { platform: payload.platform }),
    version: payload.version,
    fileCount: payload.fileCount,
    totalBytes: payload.totalBytes,
    treeSha256: payload.treeSha256,
  };
}

function canonicalPayloadSummaries(payloads) {
  return payloads.map(payloadSummary).sort((left, right) => bytewiseCompare(left.component, right.component));
}

function parseJson(bytes, code, detail) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(code, detail, { cause: error });
  }
}

function validatePreparedReceipt(receipt, receiptFile, runInstallRoot) {
  if (
    !isPlainObject(receipt)
    || receipt.schema !== PREPARED_RECEIPT_SCHEMA
    || receipt.state !== "prepared"
    || receipt.originalPreserved !== true
    || typeof receipt.sourceName !== "string"
    || !receipt.sourceName
    || !Number.isSafeInteger(receipt.zipSizeBytes)
    || receipt.zipSizeBytes <= 0
    || receipt.zipSizeBytes > MAXIMUM_ARCHIVE_BYTES
    || typeof receipt.zipSha256 !== "string"
    || !SHA256_HEX.test(receipt.zipSha256)
    || !isPlainObject(receipt.manifest)
    || typeof receipt.manifest.manifestSha256 !== "string"
    || !SHA256_HEX.test(receipt.manifest.manifestSha256)
    || !Array.isArray(receipt.manifest.payloads)
  ) fail("READY_UPDATE_PREPARED_RECEIPT_INVALID", receiptFile);

  const expectedReceiptPath = `${INTAKE_DIRECTORY}/receipts/${receipt.zipSha256}/PREPARED-RECEIPT.json`;
  if (relativePortable(runInstallRoot, receiptFile) !== expectedReceiptPath) {
    fail("READY_UPDATE_PREPARED_RECEIPT_PATH_INVALID", receiptFile);
  }
  const expectedClaimPath = `${INTAKE_DIRECTORY}/claims/${receipt.zipSha256}/package.zip`;
  const expectedStagingPath = `${INTAKE_DIRECTORY}/staging/${receipt.zipSha256}`;
  if (receipt.claimRelativePath !== expectedClaimPath || receipt.stagingRelativePath !== expectedStagingPath) {
    fail("READY_UPDATE_PREPARED_RECEIPT_INVALID", receiptFile);
  }
  if (
    typeof receipt.packageRootRelativePath !== "string"
    || (
      receipt.packageRootRelativePath !== expectedStagingPath
      && !receipt.packageRootRelativePath.startsWith(`${expectedStagingPath}/`)
    )
  ) fail("READY_UPDATE_PREPARED_RECEIPT_INVALID", receiptFile);
  return receipt;
}

function assertPreparedManifestSummary(receiptSummary, view, manifestSha256, detail) {
  const expected = {
    schema: view.schema,
    updateId: view.updateId,
    createdAt: view.createdAt,
    manifestSha256,
    payloads: canonicalPayloadSummaries(view.payloads),
  };
  const actual = {
    schema: receiptSummary.schema,
    updateId: receiptSummary.updateId,
    createdAt: receiptSummary.createdAt,
    manifestSha256: receiptSummary.manifestSha256,
    payloads: Array.isArray(receiptSummary.payloads)
      ? [...receiptSummary.payloads].sort((left, right) => bytewiseCompare(left.component, right.component))
      : receiptSummary.payloads,
  };
  if (stableStringify(actual) !== stableStringify(expected)) {
    fail("READY_UPDATE_PREPARED_MANIFEST_CHANGED", detail);
  }
}

async function discoverPreparedReceipt(runInstallRoot) {
  const receiptsRoot = path.join(runInstallRoot, INTAKE_DIRECTORY, "receipts");
  await assertPlainPathChain(runInstallRoot, receiptsRoot, "directory");
  const entries = await fs.readdir(receiptsRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.sort((left, right) => bytewiseCompare(left.name, right.name))) {
    if (entry.name.startsWith(".")) continue;
    if (!SHA256_HEX.test(entry.name)) fail("READY_UPDATE_RECEIPT_DIRECTORY_UNKNOWN", entry.name);
    const receiptRoot = path.join(receiptsRoot, entry.name);
    const state = await fs.lstat(receiptRoot);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      fail("READY_UPDATE_PREPARED_RECEIPT_PATH_INVALID", receiptRoot);
    }
    const receiptFile = path.join(receiptRoot, "PREPARED-RECEIPT.json");
    if (await lstatOrNull(receiptFile)) candidates.push(receiptFile);
  }
  if (!candidates.length) fail("READY_UPDATE_PREPARED_RECEIPT_MISSING", receiptsRoot);
  if (candidates.length !== 1) fail("READY_UPDATE_PREPARED_RECEIPT_AMBIGUOUS", String(candidates.length));
  return candidates[0];
}

async function loadPreparedContext({
  productRoot,
  preparedReceiptFile,
  verifyManifest,
  verificationPolicy,
}) {
  if (typeof productRoot !== "string" || !productRoot) fail("READY_UPDATE_PRODUCT_ROOT_REQUIRED");
  const resolvedProductRoot = path.resolve(productRoot);
  await assertPlainDirectory(resolvedProductRoot, "READY_UPDATE_PRODUCT_ROOT_MISSING");
  const runInstallRoot = path.join(resolvedProductRoot, "RUN_INSTALL");
  await assertPlainPathChain(resolvedProductRoot, runInstallRoot, "directory");

  const receiptFile = preparedReceiptFile
    ? path.resolve(preparedReceiptFile)
    : await discoverPreparedReceipt(runInstallRoot);
  relativePortable(runInstallRoot, receiptFile);
  await assertPlainPathChain(runInstallRoot, receiptFile, "file");
  const receiptSource = await readStableControlFile(receiptFile, "READY_UPDATE_PREPARED_RECEIPT_INVALID");
  const receipt = validatePreparedReceipt(
    parseJson(receiptSource.bytes, "READY_UPDATE_PREPARED_RECEIPT_INVALID", receiptFile),
    receiptFile,
    runInstallRoot,
  );

  const claimFile = resolveContained(
    runInstallRoot,
    receipt.claimRelativePath,
    "READY_UPDATE_PREPARED_RECEIPT_INVALID",
  );
  const stagingRoot = resolveContained(
    runInstallRoot,
    receipt.stagingRelativePath,
    "READY_UPDATE_PREPARED_RECEIPT_INVALID",
  );
  const packageRoot = resolveContained(
    runInstallRoot,
    receipt.packageRootRelativePath,
    "READY_UPDATE_PREPARED_RECEIPT_INVALID",
  );
  await assertPlainPathChain(runInstallRoot, claimFile, "file");
  await assertPlainPathChain(runInstallRoot, stagingRoot, "directory");
  await assertPlainPathChain(runInstallRoot, packageRoot, "directory");

  const claimed = await hashStableRegularFile(claimFile, {
    maximumBytes: MAXIMUM_ARCHIVE_BYTES,
    code: "READY_UPDATE_CLAIM_INVALID",
  });
  if (claimed.sha256 !== receipt.zipSha256 || claimed.sizeBytes !== receipt.zipSizeBytes) {
    fail("READY_UPDATE_CLAIM_CHANGED", claimFile);
  }

  const verified = await verifyManifest(packageRoot, verificationPolicy);
  if (
    !verified
    || path.resolve(verified.packageRoot || "") !== packageRoot
    || typeof verified.manifestPath !== "string"
  ) fail("READY_UPDATE_MANIFEST_VERIFIER_RESULT_INVALID", packageRoot);
  relativePortable(packageRoot, path.resolve(verified.manifestPath));
  await assertPlainPathChain(packageRoot, path.resolve(verified.manifestPath), "file");
  const manifestSource = await readStableControlFile(
    path.resolve(verified.manifestPath),
    "READY_UPDATE_MANIFEST_FILE_INVALID",
  );
  const view = manifestView(verified.manifest);
  assertPreparedManifestSummary(receipt.manifest, view, manifestSource.sha256, receiptFile);

  const unsupported = view.payloads
    .map((payload) => payload.component)
    .filter((component) => !SUPPORTED_COMPONENT_SET.has(component));
  if (unsupported.length) fail("READY_UPDATE_COMPONENT_UNSUPPORTED", unsupported.join(","));
  if (!view.payloads.length) fail("READY_UPDATE_COMPONENTS_EMPTY");

  return {
    productRoot: resolvedProductRoot,
    runInstallRoot,
    receipt,
    receiptFile,
    receiptSha256: receiptSource.sha256,
    claimFile,
    packageRoot,
    manifestPath: path.resolve(verified.manifestPath),
    manifestSha256: manifestSource.sha256,
    verified,
    view,
  };
}

function normalizePayloadFilePath(value, component) {
  return normalizePortableRelative(value, `READY_UPDATE_PAYLOAD_PATH_INVALID:${component}`);
}

async function copyBoundFile(source, target, expected, component) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let sourceHandle;
  let targetHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expected.sizeBytes)) {
      fail("READY_UPDATE_PAYLOAD_SOURCE_UNSAFE", `${component}:${expected.path}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    targetHandle = await fs.open(target, "wx", 0o600);
    const hash = createHash("sha256");
    let offset = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await targetHandle.write(chunk, written, chunk.length - written, offset + written);
        if (!result.bytesWritten) fail("READY_UPDATE_PAYLOAD_COPY_FAILED", `${component}:${expected.path}`);
        written += result.bytesWritten;
      }
      offset += chunk.length;
    }
    await targetHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    const digest = hash.digest("hex");
    if (
      !sameOpenFile(before, after)
      || BigInt(offset) !== before.size
      || offset !== expected.sizeBytes
      || digest !== expected.sha256
    ) fail("READY_UPDATE_PAYLOAD_SOURCE_CHANGED", `${component}:${expected.path}`);
  } catch (error) {
    await targetHandle?.close().catch(() => undefined);
    targetHandle = null;
    await sourceHandle?.close().catch(() => undefined);
    sourceHandle = null;
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

async function listRegularTree(root, relativeDirectory = "") {
  const directory = relativeDirectory
    ? path.join(root, ...relativeDirectory.split("/"))
    : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => bytewiseCompare(left.name, right.name))) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    const state = await fs.lstat(target);
    if (state.isSymbolicLink()) fail("READY_UPDATE_STAGED_TREE_UNSAFE", relative);
    if (state.isDirectory()) files.push(...await listRegularTree(root, relative));
    else if (state.isFile()) files.push(relative);
    else fail("READY_UPDATE_STAGED_TREE_UNSAFE", relative);
  }
  return files.sort(bytewiseCompare);
}

async function verifyStagedComponent(componentRoot, payload) {
  await assertPlainDirectory(componentRoot, "READY_UPDATE_STAGED_COMPONENT_MISSING");
  const expectedFiles = payload.files.map((entry) => normalizePayloadFilePath(entry.path, payload.component));
  const actualFiles = await listRegularTree(componentRoot);
  if (stableStringify(actualFiles) !== stableStringify(expectedFiles)) {
    fail("READY_UPDATE_STAGED_FILE_SET_MISMATCH", payload.component);
  }
  let totalBytes = 0;
  for (let index = 0; index < payload.files.length; index += 1) {
    const expected = payload.files[index];
    const target = path.join(componentRoot, ...expectedFiles[index].split("/"));
    const actual = await hashStableRegularFile(target, {
      maximumBytes: expected.sizeBytes,
      code: "READY_UPDATE_STAGED_FILE_INVALID",
      allowEmpty: true,
    });
    if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
      fail("READY_UPDATE_STAGED_FILE_MISMATCH", `${payload.component}:${expected.path}`);
    }
    totalBytes += actual.sizeBytes;
  }
  if (payload.fileCount !== actualFiles.length || payload.totalBytes !== totalBytes) {
    fail("READY_UPDATE_STAGED_COMPONENT_MISMATCH", payload.component);
  }
}

function transactionIdentity(context) {
  const identity = {
    preparedReceiptSha256: context.receiptSha256,
    zipSha256: context.receipt.zipSha256,
    manifestSha256: context.manifestSha256,
    manifestSchema: context.view.schema,
    updateId: context.view.updateId,
    payloads: canonicalPayloadSummaries(context.view.payloads),
  };
  return sha256(stableStringify(identity));
}

function readyComponentEntry(payload) {
  return {
    ...payloadSummary(payload),
    sourcePath: `PAYLOAD/${payload.component}`,
    stagedPath: `COMPONENTS/${payload.component}`,
  };
}

function buildReadyReceipt(context, transactionId, readyAt) {
  return {
    schema: READY_UPDATE_TRANSACTION_SCHEMA,
    state: "ready",
    transactionId,
    readyAt,
    source: {
      preparedReceiptPath: relativePortable(context.runInstallRoot, context.receiptFile),
      preparedReceiptSha256: context.receiptSha256,
      claimPath: relativePortable(context.runInstallRoot, context.claimFile),
      zipSha256: context.receipt.zipSha256,
      zipSizeBytes: context.receipt.zipSizeBytes,
      packageRootPath: relativePortable(context.runInstallRoot, context.packageRoot),
      manifestPath: relativePortable(context.runInstallRoot, context.manifestPath),
      manifestSha256: context.manifestSha256,
      manifestSchema: context.view.schema,
      updateId: context.view.updateId,
      createdAt: context.view.createdAt,
      ...(context.view.channel === undefined ? {} : { channel: context.view.channel }),
      ...(context.view.releaseSequence === undefined ? {} : { releaseSequence: context.view.releaseSequence }),
      authenticated: context.verified.authenticated === true,
      legacyManualBootstrap: context.verified.legacyManualBootstrap === true,
      verifiedScopes: Array.isArray(context.verified.verifiedScopes)
        ? [...context.verified.verifiedScopes].sort(bytewiseCompare)
        : [],
    },
    components: context.view.payloads
      .map(readyComponentEntry)
      .sort((left, right) => bytewiseCompare(left.component, right.component)),
  };
}

async function publishDirectoryOnce(temporaryRoot, finalRoot) {
  try {
    await fs.rename(temporaryRoot, finalRoot);
    await syncDirectory(path.dirname(finalRoot));
    return true;
  } catch (error) {
    const finalState = await lstatOrNull(finalRoot);
    if (finalState && finalState.isDirectory() && !finalState.isSymbolicLink()) return false;
    throw error;
  }
}

async function notifyPhase(onPhase, phase, details = {}) {
  if (typeof onPhase === "function") await onPhase(phase, details);
}

function validateReadyAt(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("READY_UPDATE_RECEIPT_INVALID", "readyAt");
  }
  return value;
}

async function assertReadyEnvelope(transactionRoot, expectedComponents) {
  const entries = (await fs.readdir(transactionRoot, { withFileTypes: true }))
    .sort((left, right) => bytewiseCompare(left.name, right.name));
  if (
    entries.length !== 2
    || entries[0].name !== "COMPONENTS"
    || !entries[0].isDirectory()
    || entries[1].name !== "READY.json"
    || !entries[1].isFile()
  ) fail("READY_UPDATE_ENVELOPE_INVALID", transactionRoot);
  const componentsRoot = path.join(transactionRoot, "COMPONENTS");
  const componentEntries = (await fs.readdir(componentsRoot, { withFileTypes: true }))
    .sort((left, right) => bytewiseCompare(left.name, right.name));
  if (
    stableStringify(componentEntries.map((entry) => entry.name)) !== stableStringify(expectedComponents)
    || componentEntries.some((entry) => !entry.isDirectory())
  ) fail("READY_UPDATE_COMPONENT_ENVELOPE_INVALID", transactionRoot);
}

async function resolveVerificationPolicy(productRoot, verifyManifest, verificationPolicy) {
  if (verificationPolicy !== undefined) return verificationPolicy;
  if (verifyManifest !== readAndVerifyUpdatePackageManifest) return undefined;
  if (typeof productRoot !== "string" || !productRoot) fail("READY_UPDATE_PRODUCT_ROOT_REQUIRED");
  return loadProductionUpdateVerificationPolicy(path.resolve(productRoot));
}

export async function verifyReadyUpdateTransaction({
  productRoot,
  preparedReceiptFile,
  transactionRoot,
  verifyManifest = readAndVerifyUpdatePackageManifest,
  verificationPolicy,
} = {}) {
  const effectiveVerificationPolicy = await resolveVerificationPolicy(
    productRoot,
    verifyManifest,
    verificationPolicy,
  );
  const context = await loadPreparedContext({
    productRoot,
    preparedReceiptFile,
    verifyManifest,
    verificationPolicy: effectiveVerificationPolicy,
  });
  const transactionId = transactionIdentity(context);
  const expectedRoot = path.join(
    context.runInstallRoot,
    READY_DIRECTORY,
    TRANSACTIONS_DIRECTORY,
    transactionId,
  );
  const resolvedTransactionRoot = transactionRoot ? path.resolve(transactionRoot) : expectedRoot;
  if (resolvedTransactionRoot !== expectedRoot) {
    fail("READY_UPDATE_TRANSACTION_PATH_INVALID", resolvedTransactionRoot);
  }
  await assertPlainPathChain(context.runInstallRoot, resolvedTransactionRoot, "directory");
  const readyFile = path.join(resolvedTransactionRoot, "READY.json");
  await assertPlainPathChain(resolvedTransactionRoot, readyFile, "file");
  const readySource = await readStableControlFile(readyFile, "READY_UPDATE_RECEIPT_INVALID");
  const ready = parseJson(readySource.bytes, "READY_UPDATE_RECEIPT_INVALID", readyFile);
  if (!isPlainObject(ready) || ready.schema !== READY_UPDATE_TRANSACTION_SCHEMA || ready.state !== "ready") {
    fail("READY_UPDATE_RECEIPT_INVALID", readyFile);
  }
  const expected = buildReadyReceipt(context, transactionId, validateReadyAt(ready.readyAt));
  if (stableStringify(ready) !== stableStringify(expected)) {
    fail("READY_UPDATE_RECEIPT_MISMATCH", readyFile);
  }
  const componentNames = expected.components.map((entry) => entry.component);
  await assertReadyEnvelope(resolvedTransactionRoot, componentNames);
  for (const payload of context.view.payloads) {
    await verifyStagedComponent(
      path.join(resolvedTransactionRoot, "COMPONENTS", payload.component),
      payload,
    );
  }
  return {
    status: "ready",
    transactionId,
    transactionRoot: resolvedTransactionRoot,
    readyFile,
    readyReceiptSha256: readySource.sha256,
    receipt: ready,
    manifest: context.verified.manifest,
  };
}

/**
 * Turns one already prepared and verified update package into an immutable
 * RUN_INSTALL transaction. It never writes SYSTEM, WINDOWS, RUN_SYSTEM or any
 * other live product root. A later privileged installer/bootstrapper must
 * verify READY.json again before performing its own component-specific swap.
 */
export async function consumePreparedUpdatePackage({
  productRoot,
  preparedReceiptFile,
  verifyManifest = readAndVerifyUpdatePackageManifest,
  verificationPolicy,
  now = () => new Date(),
  onPhase,
  _testHooks = {},
} = {}) {
  const effectiveVerificationPolicy = await resolveVerificationPolicy(
    productRoot,
    verifyManifest,
    verificationPolicy,
  );
  const context = await loadPreparedContext({
    productRoot,
    preparedReceiptFile,
    verifyManifest,
    verificationPolicy: effectiveVerificationPolicy,
  });
  const transactionId = transactionIdentity(context);
  const readyRoot = await ensurePlainChildDirectory(context.runInstallRoot, READY_DIRECTORY);
  const transactionsRoot = await ensurePlainChildDirectory(readyRoot, TRANSACTIONS_DIRECTORY);
  const finalRoot = path.join(transactionsRoot, transactionId);
  if (await lstatOrNull(finalRoot)) {
    const verified = await verifyReadyUpdateTransaction({
      productRoot: context.productRoot,
      preparedReceiptFile: context.receiptFile,
      transactionRoot: finalRoot,
      verifyManifest,
      verificationPolicy: effectiveVerificationPolicy,
    });
    return { ...verified, status: "already-ready" };
  }

  const temporaryRoot = path.join(
    readyRoot,
    `.stage-${transactionId}-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  await fs.mkdir(path.join(temporaryRoot, "COMPONENTS"), { recursive: true, mode: 0o700 });
  try {
    await notifyPhase(onPhase, "copy-start", { transactionId });
    for (const payload of context.view.payloads) {
      const sourceRoot = path.join(context.packageRoot, "PAYLOAD", payload.component);
      await assertPlainPathChain(context.packageRoot, sourceRoot, "directory");
      const targetRoot = path.join(temporaryRoot, "COMPONENTS", payload.component);
      await fs.mkdir(targetRoot, { mode: 0o700 });
      for (const expected of payload.files) {
        const relativePath = normalizePayloadFilePath(expected.path, payload.component);
        const source = path.join(sourceRoot, ...relativePath.split("/"));
        relativePortable(sourceRoot, source);
        await assertPlainPathChain(sourceRoot, source, "file");
        await copyBoundFile(
          source,
          path.join(targetRoot, ...relativePath.split("/")),
          expected,
          payload.component,
        );
      }
      await verifyStagedComponent(targetRoot, payload);
      await _testHooks.afterComponentCopied?.({ payload, sourceRoot, targetRoot, transactionId });
      await notifyPhase(onPhase, "component-ready", { component: payload.component, transactionId });
    }

    const readyAtValue = now();
    if (!(readyAtValue instanceof Date) || !Number.isFinite(readyAtValue.getTime())) {
      fail("READY_UPDATE_TIME_INVALID");
    }
    const readyReceipt = buildReadyReceipt(context, transactionId, readyAtValue.toISOString());
    await writeFileSyncedExclusive(
      path.join(temporaryRoot, "READY.json"),
      `${JSON.stringify(readyReceipt, null, 2)}\n`,
    );
    await syncTreeDirectories(path.join(temporaryRoot, "COMPONENTS"));
    await syncDirectory(temporaryRoot);
    await _testHooks.beforePublish?.({ temporaryRoot, finalRoot, readyReceipt, transactionId });
    await notifyPhase(onPhase, "publish-start", { transactionId });
    const published = await publishDirectoryOnce(temporaryRoot, finalRoot);
    const verified = await verifyReadyUpdateTransaction({
      productRoot: context.productRoot,
      preparedReceiptFile: context.receiptFile,
      transactionRoot: finalRoot,
      verifyManifest,
      verificationPolicy: effectiveVerificationPolicy,
    });
    await notifyPhase(onPhase, published ? "published" : "reused", { transactionId });
    return { ...verified, status: published ? "ready" : "already-ready" };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseArguments(argv) {
  const options = {
    productRoot: "",
    preparedReceiptFile: "",
    manualBootstrap: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--product-root") {
      options.productRoot = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (argument === "--prepared-receipt") {
      options.preparedReceiptFile = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (argument === "--manual-bootstrap-v1") {
      options.manualBootstrap = true;
      continue;
    }
    fail("READY_UPDATE_ARGUMENT_UNKNOWN", argument);
  }
  if (!options.help && !options.productRoot) fail("READY_UPDATE_PRODUCT_ROOT_REQUIRED");
  return options;
}

function usage() {
  return [
    "Bonni PAYLOAD aus einem geprueften PREPARED-RECEIPT in RUN_INSTALL vorbereiten.",
    "",
    "Verwendung:",
    "  node consume-prepared-update-package.mjs --product-root <Bonni-Hauptordner> [Optionen]",
    "",
    "Optionen:",
    "  --prepared-receipt <Datei>  Exakten PREPARED-RECEIPT verwenden.",
    "                                Ohne Angabe muss genau ein Beleg vorhanden sein.",
    "  --manual-bootstrap-v1       Einmalige lokale v1-Vertrauensbruecke erlauben.",
    "  -h, --help                  Diese Hilfe anzeigen.",
    "",
    "Das Werkzeug schreibt ausschliesslich unter RUN_INSTALL/update-package-ready.",
    "Es tauscht weder SYSTEM noch WINDOWS oder andere laufende Dateien aus.",
  ].join("\n");
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const verificationPolicy = options.manualBootstrap
      ? {
        verificationMode: "manual-bootstrap",
        allowLegacyV1ManualBootstrap: true,
        packageSource: "local",
      }
      : await loadProductionUpdateVerificationPolicy(options.productRoot);
    const result = await consumePreparedUpdatePackage({
      productRoot: options.productRoot,
      ...(options.preparedReceiptFile ? { preparedReceiptFile: options.preparedReceiptFile } : {}),
      verificationPolicy,
    });
    console.log(`[bonni-update] PAYLOAD sicher in RUN_INSTALL vorbereitet: ${result.transactionId}`);
    console.log(`[bonni-update] READY-Beleg: ${result.readyFile}`);
  } catch (error) {
    const code = error?.code || "READY_UPDATE_FAILED";
    console.error(`[bonni-update] SICHER ABGEBROCHEN: ${code}`);
    if (error?.detail) console.error(`[bonni-update] ${error.detail}`);
    process.exitCode = 22;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
