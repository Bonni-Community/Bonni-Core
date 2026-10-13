import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_UPDATE_ZIP_LIMITS,
  extractUpdateZip,
} from "./safe-update-zip.mjs";
import { readAndVerifyUpdatePackageManifest } from "./update-package-manifest.mjs";
import { loadProductionUpdateVerificationPolicy } from "./update-package-trust.mjs";

export const UPDATE_PACKAGE_INTAKE_RECEIPT_SCHEMA = "bonni.update-prepared/v1";
export const UPDATE_PACKAGE_INTAKE_CLAIM_SCHEMA = "bonni.update-zip-claim/v1";

const INTAKE_DIRECTORY = "update-package-intake";
const MAXIMUM_CONTROL_FILE_BYTES = 1024 * 1024;
const MAXIMUM_EXTRACTED_DISCOVERY_ENTRIES = 100_000;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const WINDOWS_DIRECTORY_OPEN_UNSUPPORTED_CODES = new Set(["EACCES", "EISDIR", "EPERM"]);
const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EPERM"]);

export class UpdatePackageIntakeError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "UpdatePackageIntakeError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new UpdatePackageIntakeError(code, detail, options);
}

function canonicalSourceName(value) {
  return value.normalize("NFC").toLowerCase();
}

function relativePortable(root, target, { allowSelf = false } = {}) {
  const relative = path.relative(root, target);
  if (!relative && allowSelf) return ".";
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail("UPDATE_PACKAGE_INTAKE_PATH_ESCAPE", target);
  return relative.split(path.sep).join("/");
}

function resolveContained(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
    fail("UPDATE_PACKAGE_INTAKE_RECEIPT_INVALID", "relative path");
  }
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
    fail("UPDATE_PACKAGE_INTAKE_DIRECTORY_UNSAFE", target);
  }
  return state;
}

async function ensurePlainChildDirectory(parent, name) {
  const target = path.join(parent, name);
  const existing = await lstatOrNull(target);
  if (!existing) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await assertPlainDirectory(target, "UPDATE_PACKAGE_INTAKE_DIRECTORY_MISSING");
  return target;
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

async function writeFileSyncedExclusive(target, contents) {
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSmallJson(target, invalidCode) {
  const state = await lstatOrNull(target);
  if (!state) return null;
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || state.nlink !== 1
    || state.size <= 0
    || state.size > MAXIMUM_CONTROL_FILE_BYTES
  ) fail(invalidCode, target);
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error instanceof UpdatePackageIntakeError) throw error;
    fail(invalidCode, target, { cause: error });
  }
}

function assertSafeZipState(state, detail) {
  const linkCount = typeof state.nlink === "bigint" ? state.nlink : BigInt(state.nlink);
  const size = typeof state.size === "bigint" ? state.size : BigInt(state.size);
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || linkCount !== 1n
    || size <= 0n
    || size > BigInt(DEFAULT_UPDATE_ZIP_LIMITS.maxArchiveBytes)
  ) fail("UPDATE_PACKAGE_INTAKE_ZIP_UNSAFE", detail);
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function openRegularFileNoFollow(target) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    fail("UPDATE_PACKAGE_INTAKE_ZIP_OPEN_FAILED", target, { cause: error });
  }
  try {
    const state = await handle.stat({ bigint: true });
    assertSafeZipState(state, target);
    return { handle, state };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function hashRegularFile(target) {
  const { handle, state: before } = await openRegularFileNoFollow(target);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(offset) !== before.size) {
      fail("UPDATE_PACKAGE_INTAKE_SOURCE_CHANGED", target);
    }
    return { sha256: hash.digest("hex"), sizeBytes: Number(before.size) };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function copyAndHashRegularFile(source, target) {
  const { handle: sourceHandle, state: before } = await openRegularFileNoFollow(source);
  let targetHandle;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    targetHandle = await fs.open(target, "wx", 0o600);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) fail("UPDATE_PACKAGE_INTAKE_CLAIM_COPY_FAILED", source);
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await targetHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(offset) !== before.size) {
      fail("UPDATE_PACKAGE_INTAKE_SOURCE_CHANGED", source);
    }
    return { sha256: hash.digest("hex"), sizeBytes: Number(before.size) };
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
}

async function scanDirectUpdateZip(updateRoot) {
  const entries = await fs.readdir(updateRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!/\.zip$/iu.test(entry.name)) continue;
    const absolutePath = path.join(updateRoot, entry.name);
    const state = await fs.lstat(absolutePath);
    assertSafeZipState(state, entry.name);
    candidates.push({ name: entry.name, path: absolutePath });
  }
  candidates.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  if (candidates.length > 1) {
    fail("UPDATE_PACKAGE_INTAKE_MULTIPLE_ZIPS", candidates.map(({ name }) => name).join(", "));
  }
  return candidates[0] ?? null;
}

async function assertSinglePackageEnvelope(extractionRoot, verified) {
  const expectedManifest = path.resolve(verified.manifestPath);
  const expectedPayload = path.resolve(verified.packageRoot, "PAYLOAD");
  const manifests = [];
  const payloads = [];
  let visitedEntries = 0;

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAXIMUM_EXTRACTED_DISCOVERY_ENTRIES) {
        fail("UPDATE_PACKAGE_INTAKE_DISCOVERY_LIMIT_EXCEEDED");
      }
      const absolutePath = path.join(directory, entry.name);
      const state = await fs.lstat(absolutePath);
      if (state.isSymbolicLink()) {
        fail("UPDATE_PACKAGE_INTAKE_EXTRACTED_LINK_UNSAFE", absolutePath);
      }
      const collisionName = entry.name.normalize("NFC").toLowerCase();
      if (collisionName === "update-manifest.json") {
        if (!state.isFile()) fail("UPDATE_PACKAGE_INTAKE_MANIFEST_AMBIGUOUS", absolutePath);
        manifests.push(path.resolve(absolutePath));
      }
      if (collisionName === "payload") {
        if (!state.isDirectory()) fail("UPDATE_PACKAGE_INTAKE_PAYLOAD_AMBIGUOUS", absolutePath);
        payloads.push(path.resolve(absolutePath));
      }
      if (state.isDirectory()) await visit(absolutePath);
    }
  }

  await visit(extractionRoot);
  if (manifests.length !== 1 || manifests[0] !== expectedManifest) {
    fail("UPDATE_PACKAGE_INTAKE_MANIFEST_AMBIGUOUS", String(manifests.length));
  }
  if (payloads.length !== 1 || payloads[0] !== expectedPayload) {
    fail("UPDATE_PACKAGE_INTAKE_PAYLOAD_AMBIGUOUS", String(payloads.length));
  }
}

async function notifyPhase(onPhase, phase, details = {}) {
  if (typeof onPhase === "function") await onPhase(phase, details);
}

async function publishDirectoryOnce(temporaryRoot, finalRoot) {
  // Every updater-owned publication is a fully synced, non-empty directory.
  // Therefore a competing updater that wins after the absence check leaves a
  // non-empty final: POSIX refuses to replace it and Windows rejects any
  // existing target. A final already visible before this check is never passed
  // to rename(), including an empty crash/sentinel directory. An unrelated
  // process with concurrent write authority inside private RUN_INSTALL is
  // outside the updater trust boundary and could mutate any prepared evidence.
  const temporaryEntries = await fs.readdir(temporaryRoot);
  if (temporaryEntries.length === 0) {
    fail("UPDATE_PACKAGE_INTAKE_PUBLISH_SOURCE_EMPTY", temporaryRoot);
  }
  if (await lstatOrNull(finalRoot)) return false;
  try {
    await fs.rename(temporaryRoot, finalRoot);
    await syncDirectory(path.dirname(finalRoot));
    return true;
  } catch (error) {
    if (!await lstatOrNull(finalRoot)) throw error;
    return false;
  }
}

function buildClaim({ candidate, identity, now, recovered = false }) {
  return {
    schema: UPDATE_PACKAGE_INTAKE_CLAIM_SCHEMA,
    state: "claimed",
    claimedAt: now().toISOString(),
    sourceName: candidate.name,
    sourceNameKey: canonicalSourceName(candidate.name),
    sizeBytes: identity.sizeBytes,
    sha256: identity.sha256,
    claimFile: "package.zip",
    originalPreserved: true,
    ...(recovered ? { recovered: true } : {}),
  };
}

function validateClaim(raw, expectedIdentity, claimFile) {
  if (
    !raw
    || raw.schema !== UPDATE_PACKAGE_INTAKE_CLAIM_SCHEMA
    || raw.state !== "claimed"
    || typeof raw.sourceName !== "string"
    || canonicalSourceName(raw.sourceName) !== raw.sourceNameKey
    || !Number.isSafeInteger(raw.sizeBytes)
    || raw.sizeBytes <= 0
    || typeof raw.sha256 !== "string"
    || !SHA256_HEX.test(raw.sha256)
    || raw.sha256 !== expectedIdentity.sha256
    || raw.sizeBytes !== expectedIdentity.sizeBytes
    || raw.claimFile !== "package.zip"
  ) fail("UPDATE_PACKAGE_INTAKE_CLAIM_INVALID", claimFile);
  return raw;
}

async function readOrAdoptClaim({
  candidate,
  claimRoot,
  identity,
  now,
  onPhase,
}) {
  await assertPlainDirectory(claimRoot, "UPDATE_PACKAGE_INTAKE_CLAIM_MISSING");
  const claimFile = path.join(claimRoot, "package.zip");
  const claimReceiptFile = path.join(claimRoot, "CLAIM.json");
  const claimedIdentity = await hashRegularFile(claimFile);
  if (
    claimedIdentity.sha256 !== identity.sha256
    || claimedIdentity.sizeBytes !== identity.sizeBytes
  ) fail("UPDATE_PACKAGE_INTAKE_CLAIM_CONTENT_MISMATCH", claimFile);

  let raw;
  try {
    raw = await readSmallJson(claimReceiptFile, "UPDATE_PACKAGE_INTAKE_CLAIM_INVALID");
  } catch (error) {
    if (error?.code !== "UPDATE_PACKAGE_INTAKE_CLAIM_INVALID") throw error;
    // CLAIM.json is descriptive evidence, never the authority for the claim.
    // Preserve a torn/corrupt crash artifact unchanged and recover from the
    // content-addressed, freshly hashed package.zip instead.
    raw = null;
  }
  if (!raw) {
    const recoveredClaim = buildClaim({ candidate, identity, now, recovered: true });
    if (!await lstatOrNull(claimReceiptFile)) {
      try {
        await writeFileSyncedExclusive(
          claimReceiptFile,
          `${JSON.stringify(recoveredClaim, null, 2)}\n`,
        );
        await syncDirectory(claimRoot);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await notifyPhase(onPhase, "claim-adopted", { claimRoot, claimFile });
    try {
      raw = await readSmallJson(claimReceiptFile, "UPDATE_PACKAGE_INTAKE_CLAIM_INVALID");
    } catch (error) {
      if (error?.code !== "UPDATE_PACKAGE_INTAKE_CLAIM_INVALID") throw error;
      raw = null;
    }
    if (!raw) raw = recoveredClaim;
  }
  return {
    claim: validateClaim(raw, identity, claimReceiptFile),
    claimFile,
    claimRoot,
  };
}

async function claimUpdateZip({ candidate, claimsRoot, now, onPhase }) {
  const temporaryClaimRoot = path.join(
    claimsRoot,
    `.claim-${process.pid}-${randomBytes(16).toString("hex")}`,
  );
  await fs.mkdir(temporaryClaimRoot, { mode: 0o700 });
  const temporaryClaimFile = path.join(temporaryClaimRoot, "package.zip");
  try {
    const identity = await copyAndHashRegularFile(candidate.path, temporaryClaimFile);
    const claim = buildClaim({ candidate, identity, now });
    await writeFileSyncedExclusive(
      path.join(temporaryClaimRoot, "CLAIM.json"),
      `${JSON.stringify(claim, null, 2)}\n`,
    );
    await syncDirectory(temporaryClaimRoot);

    const claimRoot = path.join(claimsRoot, identity.sha256);
    await notifyPhase(onPhase, "claim-ready", { claimRoot, temporaryClaimRoot });
    const published = await publishDirectoryOnce(temporaryClaimRoot, claimRoot);
    if (published) {
      await notifyPhase(onPhase, "claim-published", { claimRoot });
    } else {
      await notifyPhase(onPhase, "claim-collision", { claimRoot });
    }
    const adopted = await readOrAdoptClaim({
      candidate,
      claimRoot,
      identity,
      now,
      onPhase,
    });
    if (!published) {
      await fs.rm(temporaryClaimRoot, { recursive: true, force: true });
    }
    return { ...adopted, reused: !published };
  } finally {
    await fs.rm(temporaryClaimRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function manifestSummary(verified, manifestHash) {
  return {
    schema: verified.manifest.schema,
    updateId: verified.manifest.updateId,
    createdAt: verified.manifest.createdAt,
    manifestSha256: manifestHash,
    payloads: verified.manifest.payloads.map((payload) => ({
      component: payload.component,
      ...(payload.platform === undefined ? {} : { platform: payload.platform }),
      version: payload.version,
      fileCount: payload.fileCount,
      totalBytes: payload.totalBytes,
      treeSha256: payload.treeSha256,
    })),
  };
}

function validatePreparedReceipt(raw, expected) {
  const expectedClaimPath = `${INTAKE_DIRECTORY}/claims/${expected.zipSha256}/package.zip`;
  const expectedStagingPath = `${INTAKE_DIRECTORY}/staging/${expected.zipSha256}`;
  if (
    !raw
    || raw.schema !== UPDATE_PACKAGE_INTAKE_RECEIPT_SCHEMA
    || raw.state !== "prepared"
    || typeof raw.sourceName !== "string"
    || canonicalSourceName(raw.sourceName) !== raw.sourceNameKey
    || raw.zipSha256 !== expected.zipSha256
    || raw.zipSizeBytes !== expected.zipSizeBytes
    || raw.originalPreserved !== true
    || raw.claimRelativePath !== expectedClaimPath
    || raw.stagingRelativePath !== expectedStagingPath
    || typeof raw.packageRootRelativePath !== "string"
    || (
      raw.packageRootRelativePath !== expectedStagingPath
      && !raw.packageRootRelativePath.startsWith(`${expectedStagingPath}/`)
    )
    || !raw.manifest
    || typeof raw.manifest.updateId !== "string"
    || typeof raw.manifest.manifestSha256 !== "string"
    || !SHA256_HEX.test(raw.manifest.manifestSha256)
  ) fail("UPDATE_PACKAGE_INTAKE_RECEIPT_INVALID", expected.receiptFile);
  return raw;
}

async function verifyStagingRoot({ stagingRoot, verifyManifest }) {
  await assertPlainDirectory(stagingRoot, "UPDATE_PACKAGE_INTAKE_STAGING_MISSING");
  const verified = await verifyManifest(stagingRoot);
  await assertSinglePackageEnvelope(stagingRoot, verified);
  const packageRelativeInsideStaging = relativePortable(
    stagingRoot,
    verified.packageRoot,
    { allowSelf: true },
  );
  relativePortable(stagingRoot, verified.manifestPath);
  await assertPlainDirectory(
    path.join(verified.packageRoot, "PAYLOAD"),
    "UPDATE_PACKAGE_INTAKE_PAYLOAD_MISSING",
  );
  const manifestIdentity = await hashRegularFile(verified.manifestPath);
  return { verified, packageRelativeInsideStaging, manifestIdentity };
}

async function verifyPreparedReceipt({ receipt, runInstallRoot, verifyManifest }) {
  const claimedZip = resolveContained(runInstallRoot, receipt.claimRelativePath);
  const stagingRoot = resolveContained(runInstallRoot, receipt.stagingRelativePath);
  const expectedPackageRoot = resolveContained(runInstallRoot, receipt.packageRootRelativePath);
  const claimedIdentity = await hashRegularFile(claimedZip);
  if (
    claimedIdentity.sha256 !== receipt.zipSha256
    || claimedIdentity.sizeBytes !== receipt.zipSizeBytes
  ) fail("UPDATE_PACKAGE_INTAKE_CLAIM_CHANGED", claimedZip);
  const staging = await verifyStagingRoot({ stagingRoot, verifyManifest });
  const { verified } = staging;
  if (path.resolve(verified.packageRoot) !== path.resolve(expectedPackageRoot)) {
    fail("UPDATE_PACKAGE_INTAKE_PACKAGE_ROOT_CHANGED", expectedPackageRoot);
  }
  if (
    verified.manifest.updateId !== receipt.manifest.updateId
    || staging.manifestIdentity.sha256 !== receipt.manifest.manifestSha256
  ) fail("UPDATE_PACKAGE_INTAKE_PREPARED_PACKAGE_CHANGED", stagingRoot);
  return verified;
}

function buildPreparedReceipt({
  claimed,
  runInstallRoot,
  finalStagingRoot,
  staging,
  now,
}) {
  const finalPackageRoot = path.join(
    finalStagingRoot,
    ...staging.packageRelativeInsideStaging.split("/"),
  );
  return {
    schema: UPDATE_PACKAGE_INTAKE_RECEIPT_SCHEMA,
    state: "prepared",
    preparedAt: now().toISOString(),
    sourceName: claimed.claim.sourceName,
    sourceNameKey: claimed.claim.sourceNameKey,
    zipSizeBytes: claimed.claim.sizeBytes,
    zipSha256: claimed.claim.sha256,
    originalPreserved: true,
    claimRelativePath: relativePortable(runInstallRoot, claimed.claimFile),
    stagingRelativePath: relativePortable(runInstallRoot, finalStagingRoot),
    packageRootRelativePath: relativePortable(runInstallRoot, finalPackageRoot),
    manifest: manifestSummary(staging.verified, staging.manifestIdentity.sha256),
  };
}

async function readPreparedReceipt(receiptRoot) {
  const state = await lstatOrNull(receiptRoot);
  if (!state) return null;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("UPDATE_PACKAGE_INTAKE_RECEIPT_INVALID", receiptRoot);
  }
  const receiptFile = path.join(receiptRoot, "PREPARED-RECEIPT.json");
  const receipt = await readSmallJson(receiptFile, "UPDATE_PACKAGE_INTAKE_RECEIPT_INVALID");
  if (!receipt) fail("UPDATE_PACKAGE_INTAKE_RECEIPT_INVALID", receiptFile);
  return { receipt, receiptFile };
}

async function publishPreparedReceipt({ receiptsRoot, zipSha256, receipt, onPhase }) {
  const receiptRoot = path.join(receiptsRoot, zipSha256);
  const existing = await readPreparedReceipt(receiptRoot);
  if (existing) return { ...existing, receiptRoot, published: false };

  const temporaryReceiptRoot = path.join(
    receiptsRoot,
    `.receipt-${zipSha256}-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  await fs.mkdir(temporaryReceiptRoot, { mode: 0o700 });
  try {
    await writeFileSyncedExclusive(
      path.join(temporaryReceiptRoot, "PREPARED-RECEIPT.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await syncDirectory(temporaryReceiptRoot);
    const published = await publishDirectoryOnce(temporaryReceiptRoot, receiptRoot);
    if (!published) {
      await notifyPhase(onPhase, "receipt-collision", { receiptRoot });
    }
    const durable = await readPreparedReceipt(receiptRoot);
    if (!published) {
      await fs.rm(temporaryReceiptRoot, { recursive: true, force: true });
    }
    return { ...durable, receiptRoot, published };
  } finally {
    await fs.rm(temporaryReceiptRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareOrRecoverStaging({
  claimed,
  stagingRoot,
  extractZip,
  verifyManifest,
  onPhase,
}) {
  const finalStagingRoot = path.join(stagingRoot, claimed.claim.sha256);
  await notifyPhase(onPhase, "staging-enter", { finalStagingRoot });
  if (await lstatOrNull(finalStagingRoot)) {
    const staging = await verifyStagingRoot({ stagingRoot: finalStagingRoot, verifyManifest });
    await notifyPhase(onPhase, "staging-recovered", { finalStagingRoot });
    return { finalStagingRoot, staging, recovered: true };
  }

  const temporaryStagingRoot = path.join(
    stagingRoot,
    `.prepare-${claimed.claim.sha256}-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  try {
    await extractZip(claimed.claimFile, temporaryStagingRoot);
    await verifyStagingRoot({ stagingRoot: temporaryStagingRoot, verifyManifest });
    await notifyPhase(onPhase, "staging-verified", { temporaryStagingRoot });
    const published = await publishDirectoryOnce(temporaryStagingRoot, finalStagingRoot);
    if (published) {
      await notifyPhase(onPhase, "staging-published", { finalStagingRoot });
    } else {
      await notifyPhase(onPhase, "staging-collision", { finalStagingRoot });
    }
    const staging = await verifyStagingRoot({ stagingRoot: finalStagingRoot, verifyManifest });
    if (!published) {
      await fs.rm(temporaryStagingRoot, { recursive: true, force: true });
    }
    return { finalStagingRoot, staging, recovered: !published };
  } finally {
    await fs.rm(temporaryStagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Claims and validates one explicitly supplied update ZIP. This function only
 * prepares a package; it never installs files, swaps a runtime, or deletes the
 * original ZIP from UPDATE.
 */
export async function prepareUpdatePackage({
  productRoot,
  now = () => new Date(),
  extractZip = extractUpdateZip,
  verifyManifest = readAndVerifyUpdatePackageManifest,
  verificationPolicy,
  onPhase,
} = {}) {
  if (typeof productRoot !== "string" || !productRoot) {
    fail("UPDATE_PACKAGE_INTAKE_PRODUCT_ROOT_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  await assertPlainDirectory(resolvedProductRoot, "UPDATE_PACKAGE_INTAKE_PRODUCT_ROOT_MISSING");
  const updateRoot = path.join(resolvedProductRoot, "UPDATE");
  const runInstallRoot = path.join(resolvedProductRoot, "RUN_INSTALL");
  await assertPlainDirectory(updateRoot, "UPDATE_PACKAGE_INTAKE_UPDATE_ROOT_MISSING");
  await assertPlainDirectory(runInstallRoot, "UPDATE_PACKAGE_INTAKE_RUN_INSTALL_MISSING");

  const candidate = await scanDirectUpdateZip(updateRoot);
  if (!candidate) return { status: "no-update-zip", originalPreserved: true };

  const effectiveVerificationPolicy = verificationPolicy === undefined
    && verifyManifest === readAndVerifyUpdatePackageManifest
    ? await loadProductionUpdateVerificationPolicy(resolvedProductRoot)
    : verificationPolicy;
  const verifyPreparedManifest = effectiveVerificationPolicy === undefined
    ? verifyManifest
    : (searchRoot) => verifyManifest(searchRoot, effectiveVerificationPolicy);

  const intakeRoot = await ensurePlainChildDirectory(runInstallRoot, INTAKE_DIRECTORY);
  const claimsRoot = await ensurePlainChildDirectory(intakeRoot, "claims");
  const stagingRoot = await ensurePlainChildDirectory(intakeRoot, "staging");
  const receiptsRoot = await ensurePlainChildDirectory(intakeRoot, "receipts");
  const claimed = await claimUpdateZip({ candidate, claimsRoot, now, onPhase });
  const receiptRoot = path.join(receiptsRoot, claimed.claim.sha256);
  const existingReceipt = await readPreparedReceipt(receiptRoot);
  if (existingReceipt) {
    const receipt = validatePreparedReceipt(existingReceipt.receipt, {
      zipSha256: claimed.claim.sha256,
      zipSizeBytes: claimed.claim.sizeBytes,
      receiptFile: existingReceipt.receiptFile,
    });
    const verified = await verifyPreparedReceipt({ receipt, runInstallRoot, verifyManifest: verifyPreparedManifest });
    return {
      status: "already-prepared",
      originalPreserved: true,
      receiptFile: existingReceipt.receiptFile,
      stagingRoot: resolveContained(runInstallRoot, receipt.stagingRelativePath),
      packageRoot: verified.packageRoot,
      manifest: verified.manifest,
    };
  }

  const preparedStaging = await prepareOrRecoverStaging({
    claimed,
    stagingRoot,
    extractZip,
    verifyManifest: verifyPreparedManifest,
    onPhase,
  });
  const proposedReceipt = buildPreparedReceipt({
    claimed,
    runInstallRoot,
    finalStagingRoot: preparedStaging.finalStagingRoot,
    staging: preparedStaging.staging,
    now,
  });
  await notifyPhase(onPhase, "receipt-ready", { receiptRoot });
  const publishedReceipt = await publishPreparedReceipt({
    receiptsRoot,
    zipSha256: claimed.claim.sha256,
    receipt: proposedReceipt,
    onPhase,
  });
  const receipt = validatePreparedReceipt(publishedReceipt.receipt, {
    zipSha256: claimed.claim.sha256,
    zipSizeBytes: claimed.claim.sizeBytes,
    receiptFile: publishedReceipt.receiptFile,
  });
  const verified = await verifyPreparedReceipt({ receipt, runInstallRoot, verifyManifest: verifyPreparedManifest });
  if (publishedReceipt.published) {
    await notifyPhase(onPhase, "receipt-published", {
      receiptFile: publishedReceipt.receiptFile,
    });
  }
  return {
    status: publishedReceipt.published ? "prepared" : "already-prepared",
    originalPreserved: true,
    recovered: preparedStaging.recovered,
    receiptFile: publishedReceipt.receiptFile,
    stagingRoot: resolveContained(runInstallRoot, receipt.stagingRelativePath),
    packageRoot: verified.packageRoot,
    manifest: verified.manifest,
  };
}

function parseArguments(argv) {
  let productRoot = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--product-root") {
      productRoot = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    fail("UPDATE_PACKAGE_INTAKE_ARGUMENT_UNKNOWN", argument);
  }
  if (!productRoot) fail("UPDATE_PACKAGE_INTAKE_PRODUCT_ROOT_REQUIRED");
  return { productRoot };
}

async function runCli() {
  try {
    const argumentsValue = parseArguments(process.argv.slice(2));
    const verifyProductionManifest = async (searchRoot) => {
      const policy = await loadProductionUpdateVerificationPolicy(argumentsValue.productRoot);
      return readAndVerifyUpdatePackageManifest(searchRoot, policy);
    };
    const result = await prepareUpdatePackage({
      ...argumentsValue,
      verifyManifest: verifyProductionManifest,
    });
    const updateId = result.manifest?.schema === "bonni.update/v2"
      ? result.manifest.signed.updateId
      : result.manifest?.updateId;
    if (result.status === "no-update-zip") {
      console.log("[bonni-update] Keine direkte UPDATE-ZIP gefunden; nichts vorzubereiten.");
    } else if (result.status === "already-prepared") {
      console.log(`[bonni-update] Update bereits sicher vorbereitet: ${updateId}`);
    } else {
      console.log(`[bonni-update] Update sicher vorbereitet: ${updateId}`);
      console.log("[bonni-update] Das Original-ZIP bleibt unveraendert im UPDATE-Ordner.");
    }
  } catch (error) {
    const code = error?.code || "UPDATE_PACKAGE_INTAKE_FAILED";
    console.error(`[bonni-update] SICHER ABGEBROCHEN: ${code}`);
    if (error?.detail) console.error(`[bonni-update] ${error.detail}`);
    process.exitCode = 21;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
