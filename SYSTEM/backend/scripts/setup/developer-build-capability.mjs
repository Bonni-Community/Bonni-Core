import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {readDeveloperMasterTrust} from './developer-master-trust.mjs';

export const DEVELOPER_BUILD_CAPABILITY_SCHEMA = "bonni.developer-build-capability/v1";
export const DEVELOPER_BUILD_CAPABILITY_RECEIPT_SCHEMA = "bonni.developer-build-capability-receipt/v1";
export const DEVELOPER_BUILD_CAPABILITY_RECORD_SCHEMA = "bonni.developer-build-capability-record/v1";
export const DEVELOPER_BUILD_CAPABILITY_RELATIVE_DIRECTORY = path.join(
  "SIGNATUR",
  "DEVELOPER",
  "CAPABILITIES",
);
export const DEVELOPER_BUILD_CAPABILITY_QUARANTINE_RELATIVE_DIRECTORY = path.join(
  "SIGNATUR",
  "DEVELOPER",
  "QUARANTINE",
);

export const DEVELOPER_BUILD_CAPABILITY_SCOPES = Object.freeze([
  "bonni-container:create",
  "bonni-core:create",
  "bonni-linux:create",
  "bonni-windows:create",
  "hocket-app:create",
  "kassen-app:create",
  "kontor-app:create",
  "stueberl-app:create",
]);
export const DEVELOPER_BUILD_CAPABILITY_SCOPE_PATTERN = /^(?:bonni-(?:container|core|linux|windows):create|(?:hocket|kassen|kontor|stueberl)-app:create|bonni-app:[a-z0-9][a-z0-9._-]{1,63}:create)$/u;

// Only the public half of the Bonni Community capability authority is shipped.
// Capability files never supply or replace this key. An explicitly initialized
// installation may additionally pin its own public issuer in SYSTEM. Private
// issuer material stays encrypted outside SYSTEM and is never shipped.
export const TRUSTED_DEVELOPER_CAPABILITY_KEYS = Object.freeze([Object.freeze({
  keyId: "bonni-community-capability-2026-01",
  algorithm: "Ed25519",
  publicKeyPem: [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEAV0Jrlx60HWA7kYs7Tcg+BGkHL90zdtiN5AveQaefS1o=",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n"),
  fingerprintSha256: "3af8beaebf4a7ea38f1329340cb02f320d4b349903ca6e73c84a4efaae398ea9",
})]);

export async function resolveDeveloperCapabilityTrustedKeys(productRoot) {
  let trust;
  try { trust=await readDeveloperMasterTrust(productRoot); }
  catch { throw new DeveloperBuildCapabilityError('DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID'); }
  return trust ? Object.freeze([...TRUSTED_DEVELOPER_CAPABILITY_KEYS,trust.issuer]) : TRUSTED_DEVELOPER_CAPABILITY_KEYS;
}

const CAPABILITY_ISSUER = "bonni-community-developer-authority";
const CAPABILITY_FILE_SUFFIX = ".capability.json";
const RECEIPT_FILE_SUFFIX = ".receipt.json";
const RECORD_FILE_SUFFIX = ".grant.json";
const STAGING_DIRECTORY_NAME = "STAGING";
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SIGNATURE_DOMAIN = Buffer.from("BONNI-DEVELOPER-BUILD-CAPABILITY\0v1\0", "ascii");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEGACY_STORE_FILE = /^([0-9a-f-]{36})\.(capability|receipt)\.json$/u;
const RECORD_STORE_FILE = /^([0-9a-f-]{36})\.grant\.json$/u;
const LEGACY_TEMP_FILE = /^\.([0-9a-f-]{36})\.(capability|receipt)\.json\.([0-9a-f-]{36})\.tmp$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{86}$/u;
const PLATFORM_COMPONENTS = new Set(["SYSTEM", "WINDOWS", "LINUX", "CONTAINER"]);
const APPLICATION_COMPONENT = /^[A-Z][A-Z0-9._-]{1,63}$/u;
const LEGACY_APPLICATION_BUILD_SCOPES = Object.freeze({
  STUEBERLAPP: "stueberl-app:create",
  KONTORAPP: "kontor-app:create",
  HOCKETAPP: "hocket-app:create",
  KASSENAPP: "kassen-app:create",
});
const PLATFORM_BUILD_SCOPES = Object.freeze({
  SYSTEM: "bonni-core:create",
  WINDOWS: "bonni-windows:create",
  LINUX: "bonni-linux:create",
  CONTAINER: "bonni-container:create",
});
const FORBIDDEN_SOURCE_ROOTS = new Set([
  "DEVELOPMENT",
  "RUN_DEV",
  "GITHUB",
  "RUN_INSTALL",
  "UPDATE",
]);

export class DeveloperBuildCapabilityError extends Error {
  constructor(code, options = undefined) {
    super(code, options);
    this.name = "DeveloperBuildCapabilityError";
    this.code = code;
  }
}

function fail(code, options = undefined) {
  throw new DeveloperBuildCapabilityError(code, options);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function canonicalTimestamp(value, code) {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return milliseconds;
}

function normalizedVaultId(value, code = "DEVELOPER_BUILD_CAPABILITY_VAULT_ID_INVALID") {
  if (typeof value !== "string" || !UUID_V4.test(value.toLowerCase())) fail(code);
  return value.toLowerCase();
}

function normalizedDeveloperProfileSha256(
  value,
  code = "DEVELOPER_BUILD_CAPABILITY_DEVELOPER_PROFILE_SHA256_INVALID",
) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) fail(code);
  return value;
}

function sameSha256(left, right) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  try {
    return crypto.timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function parsePublicKey(entry) {
  exactKeys(
    entry,
    ["keyId", "algorithm", "publicKeyPem", "fingerprintSha256"],
    "DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID",
  );
  if (!KEY_ID.test(entry.keyId || "") || entry.algorithm !== "Ed25519") {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID");
  }
  let key;
  try {
    key = crypto.createPublicKey(entry.publicKeyPem);
  } catch (cause) {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID", { cause });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID");
  }
  const der = key.export({ type: "spki", format: "der" });
  const fingerprintSha256 = sha256(der);
  if (!SHA256_HEX.test(entry.fingerprintSha256 || "") || entry.fingerprintSha256 !== fingerprintSha256) {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID");
  }
  return Object.freeze({
    keyId: entry.keyId,
    algorithm: "Ed25519",
    publicKey: key,
    fingerprintSha256,
  });
}

function normalizeTrustedKeys(trustedKeys) {
  if (!Array.isArray(trustedKeys) || trustedKeys.length < 1 || trustedKeys.length > 8) {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID");
  }
  const parsed = trustedKeys.map(parsePublicKey);
  if (new Set(parsed.map((entry) => entry.keyId)).size !== parsed.length) {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID");
  }
  if (new Set(parsed.map((entry) => entry.fingerprintSha256)).size !== parsed.length) {
    fail("DEVELOPER_BUILD_CAPABILITY_TRUST_CONFIGURATION_INVALID");
  }
  return new Map(parsed.map((entry) => [entry.keyId, entry]));
}

function normalizeScopes(scopes, code = "DEVELOPER_BUILD_CAPABILITY_SCOPE_INVALID") {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 132) fail(code);
  if (scopes.some((scope) => typeof scope !== "string" || !DEVELOPER_BUILD_CAPABILITY_SCOPE_PATTERN.test(scope))) fail(code);
  const normalized = [...scopes].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (new Set(normalized).size !== normalized.length || JSON.stringify(scopes) !== JSON.stringify(normalized)) {
    fail(code);
  }
  return Object.freeze(normalized);
}

function canonicalPayload(capability) {
  return Object.freeze({
    schema: capability.schema,
    authorizationId: capability.authorizationId,
    issuer: capability.issuer,
    subjectVaultId: capability.subjectVaultId,
    subjectDeveloperProfileSha256: capability.subjectDeveloperProfileSha256,
    sequence: capability.sequence,
    issuedAt: capability.issuedAt,
    notBefore: capability.notBefore,
    expiresAt: capability.expiresAt,
    scopes: [...capability.scopes],
  });
}

export function canonicalDeveloperBuildCapabilityPayload(capability) {
  return Buffer.concat([
    SIGNATURE_DOMAIN,
    Buffer.from(JSON.stringify(canonicalPayload(capability)), "utf8"),
  ]);
}

function parseSignature(value, trustedKeyMap) {
  exactKeys(
    value,
    ["algorithm", "keyId", "value"],
    "DEVELOPER_BUILD_CAPABILITY_SIGNATURE_INVALID",
  );
  if (value.algorithm !== "Ed25519" || !KEY_ID.test(value.keyId || "")) {
    fail("DEVELOPER_BUILD_CAPABILITY_SIGNATURE_INVALID");
  }
  const trusted = trustedKeyMap.get(value.keyId);
  if (!trusted) fail("DEVELOPER_BUILD_CAPABILITY_SIGNER_UNTRUSTED");
  if (typeof value.value !== "string" || !SIGNATURE_BASE64URL.test(value.value)) {
    fail("DEVELOPER_BUILD_CAPABILITY_SIGNATURE_INVALID");
  }
  const signature = Buffer.from(value.value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value.value) {
    fail("DEVELOPER_BUILD_CAPABILITY_SIGNATURE_INVALID");
  }
  return { trusted, signature };
}

function nowMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) fail("DEVELOPER_BUILD_CAPABILITY_CLOCK_INVALID");
  return milliseconds;
}

function parseAndVerifyDeveloperBuildCapabilityInternal(sourceBytes, {
  expectedVaultId = "",
  expectedDeveloperProfileSha256 = "",
  trustedKeys = TRUSTED_DEVELOPER_CAPABILITY_KEYS,
  now = () => new Date(),
  allowInactive = false,
} = {}) {
  const bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes || "");
  if (bytes.length < 2 || bytes.length > MAX_SOURCE_BYTES || bytes.includes(0)) {
    fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_SIZE_INVALID");
  }
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    fail("DEVELOPER_BUILD_CAPABILITY_JSON_INVALID", { cause });
  }
  exactKeys(
    raw,
    [
      "schema",
      "authorizationId",
      "issuer",
      "subjectVaultId",
      "subjectDeveloperProfileSha256",
      "sequence",
      "issuedAt",
      "notBefore",
      "expiresAt",
      "scopes",
      "signature",
    ],
    "DEVELOPER_BUILD_CAPABILITY_FORMAT_INVALID",
  );
  if (raw.schema !== DEVELOPER_BUILD_CAPABILITY_SCHEMA) {
    fail("DEVELOPER_BUILD_CAPABILITY_SCHEMA_UNSUPPORTED");
  }
  if (typeof raw.authorizationId !== "string" || !UUID_V4.test(raw.authorizationId.toLowerCase())) {
    fail("DEVELOPER_BUILD_CAPABILITY_ID_INVALID");
  }
  if (raw.issuer !== CAPABILITY_ISSUER) fail("DEVELOPER_BUILD_CAPABILITY_ISSUER_INVALID");
  const subjectVaultId = normalizedVaultId(raw.subjectVaultId);
  const subjectDeveloperProfileSha256 = normalizedDeveloperProfileSha256(
    raw.subjectDeveloperProfileSha256,
  );
  if (expectedVaultId && subjectVaultId !== normalizedVaultId(expectedVaultId)) {
    fail("DEVELOPER_BUILD_CAPABILITY_SUBJECT_MISMATCH");
  }
  if (
    expectedDeveloperProfileSha256
    && !sameSha256(
      subjectDeveloperProfileSha256,
      normalizedDeveloperProfileSha256(expectedDeveloperProfileSha256),
    )
  ) fail("DEVELOPER_BUILD_CAPABILITY_DEVELOPER_PROFILE_MISMATCH");
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
    fail("DEVELOPER_BUILD_CAPABILITY_SEQUENCE_INVALID");
  }
  const issuedAtMs = canonicalTimestamp(raw.issuedAt, "DEVELOPER_BUILD_CAPABILITY_TIME_INVALID");
  const notBeforeMs = canonicalTimestamp(raw.notBefore, "DEVELOPER_BUILD_CAPABILITY_TIME_INVALID");
  const expiresAtMs = canonicalTimestamp(raw.expiresAt, "DEVELOPER_BUILD_CAPABILITY_TIME_INVALID");
  if (
    notBeforeMs < issuedAtMs - CLOCK_SKEW_MS
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAX_VALIDITY_MS
  ) fail("DEVELOPER_BUILD_CAPABILITY_TIME_INVALID");
  const currentMs = nowMilliseconds(now);
  const validityState = expiresAtMs <= currentMs
    ? "expired"
    : (
        issuedAtMs > currentMs + CLOCK_SKEW_MS || notBeforeMs > currentMs + CLOCK_SKEW_MS
          ? "not-yet-valid"
          : "active"
      );
  const scopes = normalizeScopes(raw.scopes);
  const trustedKeyMap = normalizeTrustedKeys(trustedKeys);
  const parsedSignature = parseSignature(raw.signature, trustedKeyMap);
  const normalized = {
    schema: DEVELOPER_BUILD_CAPABILITY_SCHEMA,
    authorizationId: raw.authorizationId.toLowerCase(),
    issuer: CAPABILITY_ISSUER,
    subjectVaultId,
    subjectDeveloperProfileSha256,
    sequence: raw.sequence,
    issuedAt: raw.issuedAt,
    notBefore: raw.notBefore,
    expiresAt: raw.expiresAt,
    scopes,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: raw.signature.keyId,
      value: raw.signature.value,
    }),
  };
  const payload = canonicalDeveloperBuildCapabilityPayload(normalized);
  try {
    if (!crypto.verify(null, payload, parsedSignature.trusted.publicKey, parsedSignature.signature)) {
      fail("DEVELOPER_BUILD_CAPABILITY_SIGNATURE_INVALID");
    }
  } finally {
    payload.fill(0);
    parsedSignature.signature.fill(0);
  }
  if (!allowInactive && validityState === "not-yet-valid") {
    fail("DEVELOPER_BUILD_CAPABILITY_NOT_YET_VALID");
  }
  if (!allowInactive && validityState === "expired") {
    fail("DEVELOPER_BUILD_CAPABILITY_EXPIRED");
  }
  return Object.freeze({
    ...normalized,
    scopes: Object.freeze([...scopes]),
    signerFingerprintSha256: parsedSignature.trusted.fingerprintSha256,
    validityState,
  });
}

export function parseAndVerifyDeveloperBuildCapability(sourceBytes, options = {}) {
  const verified = parseAndVerifyDeveloperBuildCapabilityInternal(sourceBytes, {
    ...options,
    allowInactive: false,
  });
  const { validityState: _validityState, ...capability } = verified;
  return Object.freeze(capability);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function privateMode(state, code) {
  if (process.platform !== "win32" && (Number(state.mode) & 0o077) !== 0) fail(code);
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code);
  privateMode(state, code);
  if (!samePath(await fs.realpath(target), target)) fail(code);
}

async function ensureDeveloperStorageDirectory(productRoot, leafName) {
  await assertPlainDirectory(productRoot, "DEVELOPER_BUILD_CAPABILITY_PRODUCT_ROOT_UNSAFE");
  let cursor = productRoot;
  for (const segment of ["SIGNATUR", "DEVELOPER", leafName]) {
    cursor = path.join(cursor, segment);
    if (!await lstatOrNull(cursor)) await fs.mkdir(cursor, { mode: 0o700 });
    await assertPlainDirectory(cursor, "DEVELOPER_BUILD_CAPABILITY_DIRECTORY_UNSAFE");
  }
  return cursor;
}

async function ensureCapabilityDirectory(productRoot) {
  return ensureDeveloperStorageDirectory(productRoot, "CAPABILITIES");
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readSecureFile(file, code, {
  privateAccess = true,
  maximumBytes = MAX_SOURCE_BYTES,
  allowCommitHardlink = false,
} = {}) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    const maximumLinks = allowCommitHardlink ? 2n : 1n;
    if (
      !before.isFile()
      || before.nlink < 1n
      || before.nlink > maximumLinks
      || before.size < 2n
      || before.size > BigInt(maximumBytes)
    ) {
      fail(code);
    }
    if (privateAccess) privateMode(before, code);
    else if (process.platform !== "win32" && (Number(before.mode) & 0o022) !== 0) fail(code);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(bytes.length) !== before.size) fail(code);
    return bytes;
  } catch (cause) {
    if (cause instanceof DeveloperBuildCapabilityError) throw cause;
    fail(code, { cause });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSafeSource(sourceFile, productRoot) {
  const parent = path.dirname(sourceFile);
  const parentState = await lstatOrNull(parent);
  if (!parentState || !parentState.isDirectory() || parentState.isSymbolicLink()) {
    fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_UNSAFE");
  }
  const realParent = await fs.realpath(parent).catch(() => null);
  const realSource = await fs.realpath(sourceFile).catch(() => null);
  if (!realParent || !realSource || !samePath(realParent, parent) || !samePath(realSource, sourceFile)) {
    fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_UNSAFE");
  }
  const realRoot = await fs.realpath(productRoot);
  if (pathWithin(realRoot, realSource)) {
    const first = path.relative(realRoot, realSource).split(path.sep).filter(Boolean)[0]?.toUpperCase();
    if (!first || FORBIDDEN_SOURCE_ROOTS.has(first) || first !== "SIGNATUR") {
      fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_FORBIDDEN");
    }
  }
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

async function writeSyncedExclusive(target, bytes) {
  let handle;
  try {
    handle = await fs.open(target, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeStagedGrantRecord(productRoot, target, bytes, verifyStagedRecord) {
  const stagingDirectory = await ensureDeveloperStorageDirectory(productRoot, STAGING_DIRECTORY_NAME);
  const stagingFile = path.join(
    stagingDirectory,
    `${path.basename(target)}.${crypto.randomUUID()}.stage`,
  );
  let stagedBytes;
  try {
    await writeSyncedExclusive(stagingFile, bytes);
    stagedBytes = await readSecureFile(
      stagingFile,
      "DEVELOPER_BUILD_CAPABILITY_STAGING_FILE_UNSAFE",
      { maximumBytes: MAX_RECORD_BYTES },
    );
    await verifyStagedRecord(stagedBytes);
    await fs.link(stagingFile, target);
    await syncDirectory(path.dirname(target));
  } finally {
    stagedBytes?.fill(0);
    await fs.rm(stagingFile, { force: true }).catch(() => {});
    await syncDirectory(stagingDirectory).catch(() => {});
  }
}

function capabilityPaths(directory, authorizationId) {
  return Object.freeze({
    capabilityFile: path.join(directory, `${authorizationId}${CAPABILITY_FILE_SUFFIX}`),
    receiptFile: path.join(directory, `${authorizationId}${RECEIPT_FILE_SUFFIX}`),
    recordFile: path.join(directory, `${authorizationId}${RECORD_FILE_SUFFIX}`),
  });
}

function storedCapabilityBytes(capability) {
  const value = {
    ...canonicalPayload(capability),
    signature: {
      algorithm: capability.signature.algorithm,
      keyId: capability.signature.keyId,
      value: capability.signature.value,
    },
  };
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function receiptBytes(capability, capabilityBytes, importedAt) {
  return Buffer.from(`${JSON.stringify({
    schema: DEVELOPER_BUILD_CAPABILITY_RECEIPT_SCHEMA,
    authorizationId: capability.authorizationId,
    subjectVaultId: capability.subjectVaultId,
    subjectDeveloperProfileSha256: capability.subjectDeveloperProfileSha256,
    importedAt,
    capabilitySha256: sha256(capabilityBytes),
    signerKeyId: capability.signature.keyId,
    signerFingerprintSha256: capability.signerFingerprintSha256,
  }, null, 2)}\n`, "utf8");
}

function storedGrantRecordBytes(capabilityBytes, receiptSource) {
  let capability;
  let receipt;
  try {
    capability = JSON.parse(capabilityBytes.toString("utf8"));
    receipt = JSON.parse(receiptSource.toString("utf8"));
  } catch (cause) {
    fail("DEVELOPER_BUILD_CAPABILITY_RECORD_INVALID", { cause });
  }
  return Buffer.from(`${JSON.stringify({
    schema: DEVELOPER_BUILD_CAPABILITY_RECORD_SCHEMA,
    capability,
    receipt,
  }, null, 2)}\n`, "utf8");
}

function validateReceipt(receipt, capability, capabilityBytes) {
  exactKeys(
    receipt,
    [
      "schema",
      "authorizationId",
      "subjectVaultId",
      "subjectDeveloperProfileSha256",
      "importedAt",
      "capabilitySha256",
      "signerKeyId",
      "signerFingerprintSha256",
    ],
    "DEVELOPER_BUILD_CAPABILITY_RECEIPT_INVALID",
  );
  if (
    receipt.schema !== DEVELOPER_BUILD_CAPABILITY_RECEIPT_SCHEMA
    || receipt.authorizationId !== capability.authorizationId
    || receipt.subjectVaultId !== capability.subjectVaultId
    || receipt.subjectDeveloperProfileSha256 !== capability.subjectDeveloperProfileSha256
    || receipt.capabilitySha256 !== sha256(capabilityBytes)
    || receipt.signerKeyId !== capability.signature.keyId
    || receipt.signerFingerprintSha256 !== capability.signerFingerprintSha256
    || !SHA256_HEX.test(receipt.capabilitySha256 || "")
    || !SHA256_HEX.test(receipt.subjectDeveloperProfileSha256 || "")
    || !SHA256_HEX.test(receipt.signerFingerprintSha256 || "")
  ) fail("DEVELOPER_BUILD_CAPABILITY_RECEIPT_INVALID");
  canonicalTimestamp(receipt.importedAt, "DEVELOPER_BUILD_CAPABILITY_RECEIPT_INVALID");
}

function parseReceiptSource(receiptSource) {
  try {
    return JSON.parse(receiptSource.toString("utf8"));
  } catch (cause) {
    fail("DEVELOPER_BUILD_CAPABILITY_RECEIPT_INVALID", { cause });
  }
}

function capabilitySummary(capability, receipt, capabilitySha256) {
  return Object.freeze({
    authorizationId: capability.authorizationId,
    subjectDeveloperProfileSha256: capability.subjectDeveloperProfileSha256,
    sequence: capability.sequence,
    expiresAt: capability.expiresAt,
    validityState: capability.validityState,
    active: capability.validityState === "active",
    scopes: Object.freeze([...capability.scopes]),
    capabilitySha256,
    signerKeyId: capability.signature.keyId,
    signerFingerprintSha256: capability.signerFingerprintSha256,
    importedAt: receipt.importedAt,
  });
}

function verifyLegacyCapabilityPair(capabilityBytes, receiptSource, authorizationId, options = {}) {
  const capability = parseAndVerifyDeveloperBuildCapabilityInternal(capabilityBytes, {
    expectedVaultId: options.vaultId,
    expectedDeveloperProfileSha256: options.developerProfileSha256,
    trustedKeys: options.trustedKeys,
    now: options.now,
    allowInactive: true,
  });
  if (capability.authorizationId !== authorizationId) {
    fail("DEVELOPER_BUILD_CAPABILITY_STORE_ID_MISMATCH");
  }
  const receipt = parseReceiptSource(receiptSource);
  validateReceipt(receipt, capability, capabilityBytes);
  return capabilitySummary(capability, receipt, receipt.capabilitySha256);
}

function verifyStoredGrantRecord(sourceBytes, authorizationId, options = {}) {
  let raw;
  try {
    raw = JSON.parse(sourceBytes.toString("utf8"));
  } catch (cause) {
    fail("DEVELOPER_BUILD_CAPABILITY_RECORD_INVALID", { cause });
  }
  exactKeys(
    raw,
    ["schema", "capability", "receipt"],
    "DEVELOPER_BUILD_CAPABILITY_RECORD_INVALID",
  );
  if (raw.schema !== DEVELOPER_BUILD_CAPABILITY_RECORD_SCHEMA) {
    fail("DEVELOPER_BUILD_CAPABILITY_RECORD_INVALID");
  }
  const capabilitySource = Buffer.from(JSON.stringify(raw.capability), "utf8");
  let canonicalCapability;
  try {
    const capability = parseAndVerifyDeveloperBuildCapabilityInternal(capabilitySource, {
      expectedVaultId: options.vaultId,
      expectedDeveloperProfileSha256: options.developerProfileSha256,
      trustedKeys: options.trustedKeys,
      now: options.now,
      allowInactive: options.allowInactive === true,
    });
    if (capability.authorizationId !== authorizationId) {
      fail("DEVELOPER_BUILD_CAPABILITY_STORE_ID_MISMATCH");
    }
    canonicalCapability = storedCapabilityBytes(capability);
    validateReceipt(raw.receipt, capability, canonicalCapability);
    return capabilitySummary(capability, raw.receipt, sha256(canonicalCapability));
  } finally {
    capabilitySource.fill(0);
    canonicalCapability?.fill(0);
  }
}

async function quarantineRegularStoreFile(productRoot, directory, sourceFile, reason) {
  let sourceBytes;
  try {
    sourceBytes = await readSecureFile(
      sourceFile,
      "DEVELOPER_BUILD_CAPABILITY_STORE_RECOVERY_UNSAFE",
      { maximumBytes: MAX_RECORD_BYTES },
    );
  } catch (error) {
    if (error?.cause?.code === "ENOENT") return false;
    throw error;
  }
  const quarantineDirectory = await ensureDeveloperStorageDirectory(productRoot, "QUARANTINE");
  const quarantineFile = path.join(
    quarantineDirectory,
    `${path.basename(sourceFile)}.${reason}.${crypto.randomUUID()}.quarantined`,
  );
  try {
    await writeSyncedExclusive(quarantineFile, sourceBytes);
    await syncDirectory(quarantineDirectory);
    await fs.unlink(sourceFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await syncDirectory(directory);
    return true;
  } finally {
    sourceBytes.fill(0);
  }
}

async function settleLegacyStoreArtifacts(productRoot, directory) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const names = (await fs.readdir(directory)).sort();
    const legacy = new Map();
    const recordIds = new Set();
    const temporary = [];
    for (const name of names) {
      const recordMatch = name.match(RECORD_STORE_FILE);
      if (recordMatch) {
        if (!UUID_V4.test(recordMatch[1])) fail("DEVELOPER_BUILD_CAPABILITY_STORE_INVALID");
        recordIds.add(recordMatch[1]);
        continue;
      }
      const legacyMatch = name.match(LEGACY_STORE_FILE);
      if (legacyMatch) {
        if (!UUID_V4.test(legacyMatch[1])) fail("DEVELOPER_BUILD_CAPABILITY_STORE_INVALID");
        const kinds = legacy.get(legacyMatch[1]) || new Set();
        kinds.add(legacyMatch[2]);
        legacy.set(legacyMatch[1], kinds);
        continue;
      }
      const temporaryMatch = name.match(LEGACY_TEMP_FILE);
      if (temporaryMatch) {
        if (!UUID_V4.test(temporaryMatch[1]) || !UUID_V4.test(temporaryMatch[3])) {
          fail("DEVELOPER_BUILD_CAPABILITY_STORE_INVALID");
        }
        temporary.push({
          name,
          authorizationId: temporaryMatch[1],
          kind: temporaryMatch[2],
        });
        continue;
      }
      fail("DEVELOPER_BUILD_CAPABILITY_STORE_INVALID");
    }

    let changed = false;
    for (const entry of temporary) {
      const temporaryFile = path.join(directory, entry.name);
      const targetFile = path.join(directory, `${entry.authorizationId}.${entry.kind}.json`);
      const temporaryState = await lstatOrNull(temporaryFile);
      if (!temporaryState) continue;
      if (!temporaryState.isFile() || temporaryState.isSymbolicLink()) {
        fail("DEVELOPER_BUILD_CAPABILITY_STORE_RECOVERY_UNSAFE");
      }
      const targetState = await lstatOrNull(targetFile);
      if (
        targetState
        && targetState.isFile()
        && !targetState.isSymbolicLink()
        && targetState.dev === temporaryState.dev
        && targetState.ino === temporaryState.ino
      ) {
        await fs.unlink(temporaryFile).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await syncDirectory(directory);
      } else {
        await quarantineRegularStoreFile(productRoot, directory, temporaryFile, "legacy-temp");
      }
      changed = true;
    }
    if (changed) continue;

    for (const [authorizationId, kinds] of legacy) {
      const complete = kinds.size === 2 && kinds.has("capability") && kinds.has("receipt");
      if (!complete) {
        for (const kind of kinds) {
          await quarantineRegularStoreFile(
            productRoot,
            directory,
            path.join(directory, `${authorizationId}.${kind}.json`),
            "legacy-incomplete",
          );
        }
        changed = true;
        continue;
      }
      if (recordIds.has(authorizationId)) {
        fail("DEVELOPER_BUILD_CAPABILITY_STORE_ID_CONFLICT");
      }
    }
    if (changed) continue;

    return Object.freeze({
      legacyIds: Object.freeze([...legacy.keys()].sort()),
      recordIds: Object.freeze([...recordIds].sort()),
    });
  }
  fail("DEVELOPER_BUILD_CAPABILITY_STORE_RECOVERY_FAILED");
}

async function readInstalledCapabilities(productRoot, vaultId, options = {}) {
  await assertPlainDirectory(productRoot, "DEVELOPER_BUILD_CAPABILITY_PRODUCT_ROOT_UNSAFE");
  const directory = path.join(productRoot, DEVELOPER_BUILD_CAPABILITY_RELATIVE_DIRECTORY);
  const directoryState = await lstatOrNull(directory);
  if (!directoryState) return [];
  await assertPlainDirectory(directory, "DEVELOPER_BUILD_CAPABILITY_DIRECTORY_UNSAFE");
  const layout = await settleLegacyStoreArtifacts(productRoot, directory);
  const capabilities = [];
  for (const authorizationId of layout.recordIds) {
    const files = capabilityPaths(directory, authorizationId);
    const recordSource = await readSecureFile(
      files.recordFile,
      "DEVELOPER_BUILD_CAPABILITY_RECORD_UNSAFE",
      { maximumBytes: MAX_RECORD_BYTES, allowCommitHardlink: true },
    );
    try {
      capabilities.push(verifyStoredGrantRecord(recordSource, authorizationId, {
        vaultId,
        developerProfileSha256: options.developerProfileSha256,
        trustedKeys: options.trustedKeys,
        now: options.now,
        allowInactive: true,
      }));
    } finally {
      recordSource.fill(0);
    }
  }
  for (const authorizationId of layout.legacyIds) {
    const files = capabilityPaths(directory, authorizationId);
    const capabilityBytes = await readSecureFile(
      files.capabilityFile,
      "DEVELOPER_BUILD_CAPABILITY_FILE_UNSAFE",
    );
    const receiptSource = await readSecureFile(
      files.receiptFile,
      "DEVELOPER_BUILD_CAPABILITY_RECEIPT_UNSAFE",
    );
    try {
      capabilities.push(verifyLegacyCapabilityPair(
        capabilityBytes,
        receiptSource,
        authorizationId,
        {
          vaultId,
          developerProfileSha256: options.developerProfileSha256,
          trustedKeys: options.trustedKeys,
          now: options.now,
        },
      ));
    } finally {
      capabilityBytes.fill(0);
      receiptSource.fill(0);
    }
  }
  return capabilities.sort((left, right) => Buffer.compare(
    Buffer.from(left.authorizationId),
    Buffer.from(right.authorizationId),
  ));
}

export async function getDeveloperBuildCapabilityStatus({
  productRoot,
  vaultId,
  developerProfileSha256 = "",
  trustedKeys,
  now = () => new Date(),
} = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("DEVELOPER_BUILD_CAPABILITY_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const root = path.resolve(productRoot);
  if (trustedKeys === undefined) trustedKeys = await resolveDeveloperCapabilityTrustedKeys(root);
  const subjectVaultId = normalizedVaultId(vaultId);
  const subjectDeveloperProfileSha256 = developerProfileSha256
    ? normalizedDeveloperProfileSha256(developerProfileSha256)
    : "";
  const capabilities = await readInstalledCapabilities(root, subjectVaultId, {
    developerProfileSha256: subjectDeveloperProfileSha256,
    trustedKeys,
    now,
  });
  const activeCapabilities = capabilities.filter((entry) => entry.active);
  const scopes = [...new Set(activeCapabilities.flatMap((entry) => entry.scopes))]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return Object.freeze({
    authorized: scopes.length > 0,
    state: scopes.length > 0
      ? "signed-capabilities-active"
      : (capabilities.length > 0 ? "signed-capabilities-inactive" : "not-configured"),
    subjectVaultId,
    subjectDeveloperProfileSha256,
    activeScopes: Object.freeze(scopes),
    activeCapabilityCount: activeCapabilities.length,
    capabilityCount: capabilities.length,
    capabilities: Object.freeze(capabilities),
  });
}

export async function importDeveloperBuildCapability({
  productRoot,
  vaultId,
  developerProfileSha256,
  sourceFile,
  sourceBytes,
  expectedSha256 = "",
  trustedKeys,
  now = () => new Date(),
} = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("DEVELOPER_BUILD_CAPABILITY_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const root = path.resolve(productRoot);
  if (trustedKeys === undefined) trustedKeys = await resolveDeveloperCapabilityTrustedKeys(root);
  const subjectVaultId = normalizedVaultId(vaultId);
  const subjectDeveloperProfileSha256 = normalizedDeveloperProfileSha256(developerProfileSha256);
  await assertPlainDirectory(root, "DEVELOPER_BUILD_CAPABILITY_PRODUCT_ROOT_UNSAFE");
  let bytes;
  if (sourceFile) {
    if (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile)) {
      fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_ABSOLUTE_REQUIRED");
    }
    const resolvedSource = path.resolve(sourceFile);
    await assertSafeSource(resolvedSource, root);
    bytes = await readSecureFile(resolvedSource, "DEVELOPER_BUILD_CAPABILITY_SOURCE_UNSAFE", {
      privateAccess: false,
    });
  } else {
    bytes = Buffer.isBuffer(sourceBytes) ? Buffer.from(sourceBytes) : Buffer.from(sourceBytes || "");
  }
  try {
    if (bytes.length < 2 || bytes.length > MAX_SOURCE_BYTES) {
      fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_SIZE_INVALID");
    }
    const sourceSha256 = sha256(bytes);
    if (!SHA256_HEX.test(expectedSha256 || "") || expectedSha256 !== sourceSha256) {
      fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_HASH_MISMATCH");
    }
    const capability = parseAndVerifyDeveloperBuildCapability(bytes, {
      expectedVaultId: subjectVaultId,
      expectedDeveloperProfileSha256: subjectDeveloperProfileSha256,
      trustedKeys,
      now,
    });
    const importedAt = now().toISOString();
    canonicalTimestamp(importedAt, "DEVELOPER_BUILD_CAPABILITY_CLOCK_INVALID");
    const capabilityBytes = storedCapabilityBytes(capability);
    const receipt = receiptBytes(capability, capabilityBytes, importedAt);
    const record = storedGrantRecordBytes(capabilityBytes, receipt);
    try {
      const directory = await ensureCapabilityDirectory(root);
      const installed = await readInstalledCapabilities(root, subjectVaultId, {
        developerProfileSha256: subjectDeveloperProfileSha256,
        trustedKeys,
        now,
      });
      const files = capabilityPaths(directory, capability.authorizationId);
      const existing = installed.find((entry) => entry.authorizationId === capability.authorizationId);
      if (existing) {
        if (existing.capabilitySha256 !== sha256(capabilityBytes)) {
          fail("DEVELOPER_BUILD_CAPABILITY_ID_CONFLICT");
        }
        const status = await getDeveloperBuildCapabilityStatus({
          productRoot: root,
          vaultId: subjectVaultId,
          developerProfileSha256: subjectDeveloperProfileSha256,
          trustedKeys,
          now,
        });
        return Object.freeze({ imported: false, authorizationId: capability.authorizationId, ...status });
      }
      try {
        await writeStagedGrantRecord(root, files.recordFile, record, async (stagedRecord) => {
          verifyStoredGrantRecord(stagedRecord, capability.authorizationId, {
            vaultId: subjectVaultId,
            developerProfileSha256: subjectDeveloperProfileSha256,
            trustedKeys,
            now,
            allowInactive: false,
          });
        });
      } catch (cause) {
        if (cause?.code === "EEXIST") fail("DEVELOPER_BUILD_CAPABILITY_ID_CONFLICT", { cause });
        throw cause;
      }
      const status = await getDeveloperBuildCapabilityStatus({
        productRoot: root,
        vaultId: subjectVaultId,
        developerProfileSha256: subjectDeveloperProfileSha256,
        trustedKeys,
        now,
      });
      return Object.freeze({ imported: true, authorizationId: capability.authorizationId, ...status });
    } finally {
      capabilityBytes.fill(0);
      receipt.fill(0);
      record.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

export function requiredDeveloperBuildScopes(components) {
  if (!Array.isArray(components) || components.length < 1 || components.length > 132) {
    fail("DEVELOPER_BUILD_CAPABILITY_COMPONENT_INVALID");
  }
  const normalized = components.map((value) => {
    if (typeof value !== "string") fail("DEVELOPER_BUILD_CAPABILITY_COMPONENT_INVALID");
    return value.trim().toUpperCase();
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("DEVELOPER_BUILD_CAPABILITY_COMPONENT_INVALID");
  }
  if (normalized.some((component) => (
    !PLATFORM_COMPONENTS.has(component) && !APPLICATION_COMPONENT.test(component)
  ))) {
    fail("DEVELOPER_BUILD_CAPABILITY_COMPONENT_UNSUPPORTED");
  }
  if (
    normalized.some((component) => !PLATFORM_COMPONENTS.has(component))
    && !normalized.includes("SYSTEM")
  ) {
    fail("DEVELOPER_BUILD_CAPABILITY_COMPONENT_INVALID");
  }
  const required = new Set();
  // Application files live inside the complete SYSTEM payload. An app grant
  // therefore supplements the Core grant; it can never replace it.
  for (const component of normalized) {
    const scope = PLATFORM_BUILD_SCOPES[component]
      || LEGACY_APPLICATION_BUILD_SCOPES[component]
      || `bonni-app:${component.toLowerCase()}:create`;
    if (scope) required.add(scope);
  }
  return Object.freeze([...required].sort());
}

export async function assertDeveloperBuildAuthorized({
  productRoot,
  vaultId,
  components,
  developerProfileSha256 = "",
  trustedKeys,
  now = () => new Date(),
} = {}) {
  const requiredScopes = requiredDeveloperBuildScopes(components);
  const status = await getDeveloperBuildCapabilityStatus({ productRoot, vaultId, trustedKeys, now });
  let activeScopes = status.activeScopes;
  if (developerProfileSha256) {
    const subjectDeveloperProfileSha256 = normalizedDeveloperProfileSha256(developerProfileSha256);
    const matchingCapabilities = status.capabilities.filter((capability) => (
      capability.active
      && sameSha256(
        capability.subjectDeveloperProfileSha256,
        subjectDeveloperProfileSha256,
      )
    ));
    if (matchingCapabilities.length < 1) {
      fail("DEVELOPER_BUILD_CAPABILITY_DEVELOPER_PROFILE_MISMATCH");
    }
    activeScopes = Object.freeze([...new Set(matchingCapabilities.flatMap((entry) => entry.scopes))]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
  }
  const active = new Set(activeScopes);
  const missingScopes = requiredScopes.filter((scope) => !active.has(scope));
  if (missingScopes.length > 0) fail("DEVELOPER_BUILD_CAPABILITY_SCOPE_MISSING");
  return Object.freeze({
    authorized: true,
    subjectVaultId: status.subjectVaultId,
    subjectDeveloperProfileSha256: developerProfileSha256 || "",
    requiredScopes,
    activeScopes,
    capabilityCount: status.capabilityCount,
  });
}

function assertGitHubRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("DEVELOPER_BUILD_CAPABILITY_REQUEST_INVALID");
  }
  if (request.schema !== "bonni.github-release-request/v1" || !Array.isArray(request.components)) {
    fail("DEVELOPER_BUILD_CAPABILITY_REQUEST_INVALID");
  }
  return request;
}

export async function assertDeveloperGitHubRequestAuthorized({
  productRoot,
  vaultId,
  request,
  trustedKeys,
  now = () => new Date(),
} = {}) {
  assertGitHubRequest(request);
  return assertDeveloperBuildAuthorized({
    productRoot,
    vaultId,
    components: request.components,
    trustedKeys,
    now,
  });
}


export async function assertDeveloperGitHubRequestAuthorizedForProfile({
  productRoot,
  vaultId,
  developerProfileSha256,
  request,
  trustedKeys,
  now = () => new Date(),
} = {}) {
  assertGitHubRequest(request);
  normalizedDeveloperProfileSha256(developerProfileSha256);
  return assertDeveloperBuildAuthorized({
    productRoot,
    vaultId,
    components: request.components,
    developerProfileSha256,
    trustedKeys,
    now,
  });
}
