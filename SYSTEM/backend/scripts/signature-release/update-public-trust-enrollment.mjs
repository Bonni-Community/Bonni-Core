import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { parseUpdatePublicTrust } from "../setup/update-package-trust.mjs";

export const UPDATE_PUBLIC_TRUST_ENROLLMENT_TARGET = path.join(
  "RUN_INSTALL",
  "trust",
  "UPDATE-PUBLIC-TRUST.json",
);

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TRUST_BYTES = 4 * 1024 * 1024;
const PRIVATE_KEY_MARKER = /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u;
const FORBIDDEN_PRODUCT_SOURCE_ROOTS = new Set([
  "BACKUP",
  "CONTAINER",
  "DEVELOPMENT",
  "GITHUB",
  "LINUX",
  "RUN_INSTALL",
  "RUN_SYSTEM",
  "SYSTEM",
  "UPDATE",
  "WINDOWS",
]);

export class UpdatePublicTrustEnrollmentError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "UpdatePublicTrustEnrollmentError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new UpdatePublicTrustEnrollmentError(code, detail, options);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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

async function lstatOrNull(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

function pathIsWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertNotGroupOrWorldWritable(state, code, detail) {
  if (process.platform !== "win32" && (Number(state.mode) & 0o022) !== 0) {
    fail(code, detail);
  }
}

async function assertRealDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code, target);
  assertNotGroupOrWorldWritable(state, code, target);
  return state;
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function ensureTrustDirectory(productRoot) {
  await assertRealDirectory(productRoot, "UPDATE_TRUST_ENROLL_PRODUCT_ROOT_UNSAFE");
  const realProductRoot = await fs.realpath(productRoot);
  const runInstall = path.join(productRoot, "RUN_INSTALL");
  await assertRealDirectory(runInstall, "UPDATE_TRUST_ENROLL_RUN_INSTALL_UNSAFE");
  if (!sameResolvedPath(await fs.realpath(runInstall), path.join(realProductRoot, "RUN_INSTALL"))) {
    fail("UPDATE_TRUST_ENROLL_RUN_INSTALL_UNSAFE", runInstall);
  }
  const trustDirectory = path.join(runInstall, "trust");
  const existing = await lstatOrNull(trustDirectory);
  if (!existing) await fs.mkdir(trustDirectory, { mode: 0o700 });
  await assertRealDirectory(trustDirectory, "UPDATE_TRUST_ENROLL_DIRECTORY_UNSAFE");
  if (!sameResolvedPath(await fs.realpath(trustDirectory), path.join(realProductRoot, "RUN_INSTALL", "trust"))) {
    fail("UPDATE_TRUST_ENROLL_DIRECTORY_UNSAFE", trustDirectory);
  }
  return trustDirectory;
}

function assertEnrollmentSourceLocation(sourceFile, productRoot) {
  if (!pathIsWithin(productRoot, sourceFile)) return;
  const relative = path.relative(productRoot, sourceFile);
  const firstSegment = relative.split(path.sep).filter(Boolean)[0];
  if (!firstSegment || FORBIDDEN_PRODUCT_SOURCE_ROOTS.has(firstSegment.toUpperCase())) {
    fail("UPDATE_TRUST_ENROLL_SOURCE_FORBIDDEN", sourceFile);
  }
  if (firstSegment.toUpperCase() !== "SIGNATUR") {
    fail("UPDATE_TRUST_ENROLL_SOURCE_FORBIDDEN", sourceFile);
  }
}

async function assertCanonicalSourcePath(sourceFile, productRoot) {
  const parent = path.dirname(sourceFile);
  const parentState = await lstatOrNull(parent);
  if (!parentState || !parentState.isDirectory() || parentState.isSymbolicLink()) {
    fail("UPDATE_TRUST_ENROLL_SOURCE_UNSAFE", sourceFile);
  }
  const realParent = await fs.realpath(parent).catch(() => null);
  const realSource = await fs.realpath(sourceFile).catch(() => null);
  if (
    !realParent
    || !realSource
    || !sameResolvedPath(realParent, parent)
    || !sameResolvedPath(realSource, sourceFile)
  ) fail("UPDATE_TRUST_ENROLL_SOURCE_UNSAFE", sourceFile);
  assertEnrollmentSourceLocation(realSource, await fs.realpath(productRoot));
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readSecureFile(file, code) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    fail(code, file, { cause });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size <= 0n
      || before.size > BigInt(MAX_TRUST_BYTES)
    ) fail(code, file);
    assertNotGroupOrWorldWritable(before, code, file);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(bytes.length) !== before.size) fail(code, file);
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseEnrollmentTrust(bytes, code) {
  if (PRIVATE_KEY_MARKER.test(bytes.toString("utf8"))) fail("UPDATE_TRUST_ENROLL_PRIVATE_KEY_FORBIDDEN");
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    fail(code, "invalid JSON", { cause });
  }
  return parseUpdatePublicTrust(raw);
}

function semanticTrustView(parsed) {
  return {
    schema: parsed.schema,
    storeId: parsed.storeId,
    createdAt: parsed.createdAt,
    keys: [...parsed.keys]
      .map(({ keyId, scope, algorithm, fingerprintSha256 }) => ({
        keyId,
        scope,
        algorithm,
        fingerprintSha256,
      }))
      .sort((left, right) => bytewiseCompare(left.keyId, right.keyId)),
  };
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"]).has(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishTrustFile(targetFile, sourceBytes, sourceTrust) {
  const targetDirectory = path.dirname(targetFile);
  const temporary = path.join(targetDirectory, `.UPDATE-PUBLIC-TRUST.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(sourceBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, targetFile);
      await syncDirectory(targetDirectory);
      return true;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const existingBytes = await readSecureFile(targetFile, "UPDATE_TRUST_ENROLL_EXISTING_UNSAFE");
      const existingTrust = parseEnrollmentTrust(existingBytes, "UPDATE_TRUST_ENROLL_EXISTING_INVALID");
      if (
        Buffer.compare(existingBytes, sourceBytes) !== 0
        && stableStringify(semanticTrustView(existingTrust)) !== stableStringify(semanticTrustView(sourceTrust))
      ) fail("UPDATE_TRUST_ENROLL_CONFLICT", targetFile);
      return false;
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function enrollUpdatePublicTrust({
  productRoot,
  sourceFile,
  expectedSha256,
} = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("UPDATE_TRUST_ENROLL_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  if (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile)) {
    fail("UPDATE_TRUST_ENROLL_SOURCE_ABSOLUTE_REQUIRED");
  }
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    fail("UPDATE_TRUST_ENROLL_EXPECTED_SHA256_INVALID");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  const resolvedSourceFile = path.resolve(sourceFile);
  await assertRealDirectory(resolvedProductRoot, "UPDATE_TRUST_ENROLL_PRODUCT_ROOT_UNSAFE");
  assertEnrollmentSourceLocation(resolvedSourceFile, resolvedProductRoot);
  await assertCanonicalSourcePath(resolvedSourceFile, resolvedProductRoot);
  const sourceBytes = await readSecureFile(resolvedSourceFile, "UPDATE_TRUST_ENROLL_SOURCE_UNSAFE");
  const observedSha256 = sha256(sourceBytes);
  if (observedSha256 !== expectedSha256) {
    fail("UPDATE_TRUST_ENROLL_SOURCE_HASH_MISMATCH");
  }
  const sourceTrust = parseEnrollmentTrust(sourceBytes, "UPDATE_TRUST_ENROLL_SOURCE_INVALID");
  const trustDirectory = await ensureTrustDirectory(resolvedProductRoot);
  const targetFile = path.join(trustDirectory, "UPDATE-PUBLIC-TRUST.json");
  const existing = await lstatOrNull(targetFile);
  let initialized;
  if (existing) {
    const existingBytes = await readSecureFile(targetFile, "UPDATE_TRUST_ENROLL_EXISTING_UNSAFE");
    const existingTrust = parseEnrollmentTrust(existingBytes, "UPDATE_TRUST_ENROLL_EXISTING_INVALID");
    if (
      Buffer.compare(existingBytes, sourceBytes) !== 0
      && stableStringify(semanticTrustView(existingTrust)) !== stableStringify(semanticTrustView(sourceTrust))
    ) fail("UPDATE_TRUST_ENROLL_CONFLICT", targetFile);
    initialized = false;
  } else {
    initialized = await publishTrustFile(targetFile, sourceBytes, sourceTrust);
  }
  return Object.freeze({
    targetFile,
    initialized,
    storeId: sourceTrust.storeId,
    sourceSha256: observedSha256,
    keyCount: sourceTrust.keys.length,
  });
}
