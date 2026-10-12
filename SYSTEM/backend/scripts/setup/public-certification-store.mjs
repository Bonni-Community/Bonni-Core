import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const PUBLIC_CERTIFICATION_STORE_SCHEMA = "bonni.public-certification-store/v1";
export const PUBLIC_CERTIFICATION_RECEIPT_SCHEMA = "bonni.public-certification-receipt/v1";
export const PUBLIC_CERTIFICATION_INPUT_SCHEMA = "bonni.public-trust/v1";
export const PUBLIC_CERTIFICATION_RELATIVE_DIRECTORY = path.join("SIGNATUR", "TRUST");

const STORE_FILE_NAME = "PUBLIC-CERTIFICATION.json";
const RECEIPT_FILE_NAME = "PUBLIC-CERTIFICATION.receipt.json";
const MAX_SOURCE_BYTES = 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_PUBLIC_KEY_COUNT = 256;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TRUST_SCOPE = /^(?:offline-root|release-set|component:(?:SYSTEM|WINDOWS|LINUX|CONTAINER)|app:[a-z0-9][a-z0-9._-]{1,63})$/u;
const PRIVATE_KEY_MARKER = /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|PGP|RSA) )?PRIVATE KEY(?: BLOCK)?-----/iu;
const FORBIDDEN_PRODUCT_SOURCE_ROOTS = new Set([
  "BACKUP",
  "CONTAINER",
  "DEVELOPMENT",
  "RUN_DEV",
  "GITHUB",
  "LINUX",
  "RUN_INSTALL",
  "RUN_SYSTEM",
  "SYSTEM",
  "UPDATE",
  "WINDOWS",
]);

export class PublicCertificationError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "PublicCertificationError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new PublicCertificationError(code, detail, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, code) {
  if (!isPlainObject(value)) fail(code);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code);
  }
}

function canonicalTimestamp(value, code) {
  if (
    typeof value !== "string"
    || !CANONICAL_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) fail(code);
  return value;
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
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalPublicKey(publicKey, code = "PUBLIC_CERTIFICATION_PUBLIC_KEY_INVALID") {
  if (publicKey?.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") fail(code);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprintSha256 = sha256(publicKey.export({ type: "spki", format: "der" }));
  return { publicKeyPem, fingerprintSha256 };
}

function parseEd25519PublicKey(value, code = "PUBLIC_CERTIFICATION_PUBLIC_KEY_INVALID") {
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(value);
  } catch (cause) {
    fail(code, "", { cause });
  }
  return canonicalPublicKey(publicKey, code);
}

function splitExactPemBlocks(text, label) {
  const pattern = new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`, "gu");
  const blocks = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (text.slice(cursor, match.index).trim() !== "") fail("PUBLIC_CERTIFICATION_SOURCE_FORMAT_INVALID");
    blocks.push(match[0]);
    cursor = Number(match.index) + match[0].length;
  }
  if (text.slice(cursor).trim() !== "") fail("PUBLIC_CERTIFICATION_SOURCE_FORMAT_INVALID");
  return blocks;
}

function normalizeKeys(keys, code = "PUBLIC_CERTIFICATION_KEYS_INVALID") {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_PUBLIC_KEY_COUNT) fail(code);
  const keyIds = new Set();
  const fingerprints = new Set();
  const result = keys.map((entry) => {
    assertExactKeys(
      entry,
      new Set(["keyId", "purpose", "algorithm", "publicKeyPem", "fingerprintSha256", "sourceType"]),
      new Set(["keyId", "purpose", "algorithm", "publicKeyPem", "fingerprintSha256", "sourceType"]),
      code,
    );
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId) || keyIds.has(entry.keyId)) fail(code);
    if (typeof entry.purpose !== "string" || entry.purpose.length < 1 || entry.purpose.length > 128) fail(code);
    if (entry.algorithm !== "Ed25519") fail(code);
    if (!new Set(["public-key", "x509-certificate", "bonni-public-trust"]).has(entry.sourceType)) fail(code);
    const parsed = parseEd25519PublicKey(entry.publicKeyPem, code);
    if (
      !SHA256_HEX.test(entry.fingerprintSha256 || "")
      || entry.fingerprintSha256 !== parsed.fingerprintSha256
    ) fail(code);
    if (fingerprints.has(parsed.fingerprintSha256)) fail(code);
    keyIds.add(entry.keyId);
    fingerprints.add(parsed.fingerprintSha256);
    return {
      keyId: entry.keyId,
      purpose: entry.purpose,
      algorithm: "Ed25519",
      publicKeyPem: parsed.publicKeyPem,
      fingerprintSha256: parsed.fingerprintSha256,
      sourceType: entry.sourceType,
    };
  });
  return result.sort((left, right) => bytewiseCompare(left.fingerprintSha256, right.fingerprintSha256));
}

function parseBonniPublicTrust(raw) {
  assertExactKeys(
    raw,
    new Set(["schema", "storeId", "createdAt", "keys"]),
    new Set(["schema", "storeId", "createdAt", "keys"]),
    "PUBLIC_CERTIFICATION_TRUST_INVALID",
  );
  if (raw.schema !== PUBLIC_CERTIFICATION_INPUT_SCHEMA) fail("PUBLIC_CERTIFICATION_TRUST_SCHEMA_UNSUPPORTED");
  if (typeof raw.storeId !== "string" || !UUID_V4.test(raw.storeId)) fail("PUBLIC_CERTIFICATION_TRUST_INVALID");
  canonicalTimestamp(raw.createdAt, "PUBLIC_CERTIFICATION_TRUST_INVALID");
  if (!Array.isArray(raw.keys) || raw.keys.length < 2 || raw.keys.length > MAX_PUBLIC_KEY_COUNT) {
    fail("PUBLIC_CERTIFICATION_TRUST_INVALID");
  }
  const seenIds = new Set();
  const seenScopes = new Set();
  const seenFingerprints = new Set();
  const keys = raw.keys.map((entry) => {
    assertExactKeys(
      entry,
      new Set(["keyId", "scope", "algorithm", "publicKeyPem", "fingerprintSha256"]),
      new Set(["keyId", "scope", "algorithm", "publicKeyPem", "fingerprintSha256"]),
      "PUBLIC_CERTIFICATION_TRUST_INVALID",
    );
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId) || seenIds.has(entry.keyId)) {
      fail("PUBLIC_CERTIFICATION_TRUST_INVALID");
    }
    if (typeof entry.scope !== "string" || !TRUST_SCOPE.test(entry.scope) || seenScopes.has(entry.scope)) {
      fail("PUBLIC_CERTIFICATION_TRUST_INVALID");
    }
    if (entry.algorithm !== "Ed25519") fail("PUBLIC_CERTIFICATION_TRUST_INVALID");
    const parsed = parseEd25519PublicKey(entry.publicKeyPem, "PUBLIC_CERTIFICATION_TRUST_INVALID");
    if (
      !SHA256_HEX.test(entry.fingerprintSha256 || "")
      || entry.fingerprintSha256 !== parsed.fingerprintSha256
      || seenFingerprints.has(parsed.fingerprintSha256)
    ) fail("PUBLIC_CERTIFICATION_TRUST_INVALID");
    seenIds.add(entry.keyId);
    seenScopes.add(entry.scope);
    seenFingerprints.add(parsed.fingerprintSha256);
    return {
      keyId: entry.keyId,
      purpose: entry.scope,
      algorithm: "Ed25519",
      publicKeyPem: parsed.publicKeyPem,
      fingerprintSha256: parsed.fingerprintSha256,
      sourceType: "bonni-public-trust",
    };
  });
  if (!seenScopes.has("offline-root") || !seenScopes.has("release-set")) {
    fail("PUBLIC_CERTIFICATION_TRUST_REQUIRED_SCOPE_MISSING");
  }
  return { format: "bonni-public-trust", keys: normalizeKeys(keys) };
}

function parsePublicKeyPem(text) {
  const blocks = splitExactPemBlocks(text, "PUBLIC KEY");
  if (blocks.length < 1 || blocks.length > MAX_PUBLIC_KEY_COUNT) {
    fail("PUBLIC_CERTIFICATION_SOURCE_FORMAT_INVALID");
  }
  const keys = blocks.map((block) => {
    const parsed = parseEd25519PublicKey(block);
    return {
      keyId: `ed25519-${parsed.fingerprintSha256.slice(0, 24)}`,
      purpose: "github-release",
      algorithm: "Ed25519",
      publicKeyPem: parsed.publicKeyPem,
      fingerprintSha256: parsed.fingerprintSha256,
      sourceType: "public-key",
    };
  });
  return { format: "public-key-pem", keys: normalizeKeys(keys) };
}

function parseCertificatePem(text, now) {
  const blocks = splitExactPemBlocks(text, "CERTIFICATE");
  if (blocks.length < 1 || blocks.length > 32) fail("PUBLIC_CERTIFICATION_SOURCE_FORMAT_INVALID");
  let certificates;
  try {
    certificates = blocks.map((block) => new crypto.X509Certificate(block));
  } catch (cause) {
    fail("PUBLIC_CERTIFICATION_CERTIFICATE_INVALID", "", { cause });
  }
  const timestamp = now().getTime();
  if (!Number.isFinite(timestamp)) fail("PUBLIC_CERTIFICATION_CLOCK_INVALID");
  for (const certificate of certificates) {
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || timestamp < validFrom || timestamp > validTo) {
      fail("PUBLIC_CERTIFICATION_CERTIFICATE_EXPIRED");
    }
    canonicalPublicKey(certificate.publicKey, "PUBLIC_CERTIFICATION_CERTIFICATE_KEY_INVALID");
  }
  const roots = new Set();
  for (const certificate of certificates) {
    if (certificate.subject === certificate.issuer) {
      if (!certificate.verify(certificate.publicKey)) fail("PUBLIC_CERTIFICATION_CERTIFICATE_SIGNATURE_INVALID");
      roots.add(certificate.fingerprint256);
      continue;
    }
    const issuers = certificates.filter((candidate) => candidate.subject === certificate.issuer);
    if (issuers.length !== 1 || !certificate.verify(issuers[0].publicKey)) {
      fail("PUBLIC_CERTIFICATION_CERTIFICATE_CHAIN_INVALID");
    }
  }
  if (roots.size < 1) fail("PUBLIC_CERTIFICATION_CERTIFICATE_ROOT_MISSING");
  for (const certificate of certificates) {
    const visited = new Set();
    let cursor = certificate;
    while (cursor.subject !== cursor.issuer) {
      if (visited.has(cursor.fingerprint256)) fail("PUBLIC_CERTIFICATION_CERTIFICATE_CHAIN_INVALID");
      visited.add(cursor.fingerprint256);
      cursor = certificates.find((candidate) => candidate.subject === cursor.issuer);
      if (!cursor) fail("PUBLIC_CERTIFICATION_CERTIFICATE_CHAIN_INVALID");
    }
  }
  const keys = certificates.map((certificate) => {
    const parsed = canonicalPublicKey(certificate.publicKey, "PUBLIC_CERTIFICATION_CERTIFICATE_KEY_INVALID");
    return {
      keyId: `x509-ed25519-${parsed.fingerprintSha256.slice(0, 24)}`,
      purpose: "github-release",
      algorithm: "Ed25519",
      publicKeyPem: parsed.publicKeyPem,
      fingerprintSha256: parsed.fingerprintSha256,
      sourceType: "x509-certificate",
    };
  });
  return { format: "x509-certificate-pem", keys: normalizeKeys(keys) };
}

function parseCertificateDer(bytes, now) {
  let certificate;
  try {
    certificate = new crypto.X509Certificate(bytes);
  } catch (cause) {
    fail("PUBLIC_CERTIFICATION_SOURCE_FORMAT_INVALID", "", { cause });
  }
  const pem = certificate.toString();
  return parseCertificatePem(pem, now);
}

export function parsePublicCertificationSource(bytes, { now = () => new Date() } = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || "");
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) fail("PUBLIC_CERTIFICATION_SOURCE_SIZE_INVALID");
  const text = bytes.toString("utf8");
  if (PRIVATE_KEY_MARKER.test(text)) fail("PUBLIC_CERTIFICATION_PRIVATE_KEY_FORBIDDEN");
  if (text.includes("\0")) return parseCertificateDer(bytes, now);
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch (cause) {
      fail("PUBLIC_CERTIFICATION_SOURCE_FORMAT_INVALID", "", { cause });
    }
    return parseBonniPublicTrust(raw);
  }
  if (trimmed.startsWith("-----BEGIN PUBLIC KEY-----")) return parsePublicKeyPem(trimmed);
  if (trimmed.startsWith("-----BEGIN CERTIFICATE-----")) return parseCertificatePem(trimmed, now);
  return parseCertificateDer(bytes, now);
}

async function lstatOrNull(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathIsWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertPrivateMode(state, code, detail) {
  if (process.platform !== "win32" && (Number(state.mode) & 0o077) !== 0) fail(code, detail);
}

function assertNotGroupOrWorldWritable(state, code, detail) {
  if (process.platform !== "win32" && (Number(state.mode) & 0o022) !== 0) fail(code, detail);
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code, target);
  assertPrivateMode(state, code, target);
  if (!sameResolvedPath(await fs.realpath(target), target)) fail(code, target);
  return state;
}

async function ensureCertificationDirectory(productRoot) {
  await assertPlainDirectory(productRoot, "PUBLIC_CERTIFICATION_PRODUCT_ROOT_UNSAFE");
  let cursor = productRoot;
  for (const segment of ["SIGNATUR", "TRUST"]) {
    cursor = path.join(cursor, segment);
    if (!await lstatOrNull(cursor)) await fs.mkdir(cursor, { mode: 0o700 });
    await assertPlainDirectory(cursor, "PUBLIC_CERTIFICATION_DIRECTORY_UNSAFE");
  }
  return cursor;
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readSecureFile(file, code, { maxBytes = MAX_SOURCE_BYTES, privateAccess = true } = {}) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    fail(code, file, { cause });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) {
      fail(code, file);
    }
    if (privateAccess) assertPrivateMode(before, code, file);
    else assertNotGroupOrWorldWritable(before, code, file);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(bytes.length) !== before.size) fail(code, file);
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSafeSource(sourceFile, productRoot) {
  const sourceParent = path.dirname(sourceFile);
  const parentState = await lstatOrNull(sourceParent);
  if (!parentState || !parentState.isDirectory() || parentState.isSymbolicLink()) {
    fail("PUBLIC_CERTIFICATION_SOURCE_UNSAFE");
  }
  const realParent = await fs.realpath(sourceParent).catch(() => null);
  const realSource = await fs.realpath(sourceFile).catch(() => null);
  if (!realParent || !realSource || !sameResolvedPath(realParent, sourceParent) || !sameResolvedPath(realSource, sourceFile)) {
    fail("PUBLIC_CERTIFICATION_SOURCE_UNSAFE");
  }
  const realProductRoot = await fs.realpath(productRoot);
  if (pathIsWithin(realProductRoot, realSource)) {
    const first = path.relative(realProductRoot, realSource).split(path.sep).filter(Boolean)[0]?.toUpperCase();
    if (!first || FORBIDDEN_PRODUCT_SOURCE_ROOTS.has(first) || first !== "SIGNATUR") {
      fail("PUBLIC_CERTIFICATION_SOURCE_FORBIDDEN");
    }
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"]).has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusiveLinked(target, bytes) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporary, target);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function storePaths(productRoot) {
  const directory = path.join(productRoot, PUBLIC_CERTIFICATION_RELATIVE_DIRECTORY);
  return {
    directory,
    storeFile: path.join(directory, STORE_FILE_NAME),
    receiptFile: path.join(directory, RECEIPT_FILE_NAME),
  };
}

function validateStore(raw) {
  assertExactKeys(
    raw,
    new Set(["schema", "createdAt", "sourceFormat", "sourceSha256", "keys"]),
    new Set(["schema", "createdAt", "sourceFormat", "sourceSha256", "keys"]),
    "PUBLIC_CERTIFICATION_STORE_INVALID",
  );
  if (raw.schema !== PUBLIC_CERTIFICATION_STORE_SCHEMA) fail("PUBLIC_CERTIFICATION_STORE_INVALID");
  canonicalTimestamp(raw.createdAt, "PUBLIC_CERTIFICATION_STORE_INVALID");
  if (!new Set(["bonni-public-trust", "public-key-pem", "x509-certificate-pem"]).has(raw.sourceFormat)) {
    fail("PUBLIC_CERTIFICATION_STORE_INVALID");
  }
  if (!SHA256_HEX.test(raw.sourceSha256 || "")) fail("PUBLIC_CERTIFICATION_STORE_INVALID");
  return { ...raw, keys: normalizeKeys(raw.keys, "PUBLIC_CERTIFICATION_STORE_INVALID") };
}

function validateReceipt(raw, storeBytes, store) {
  assertExactKeys(
    raw,
    new Set(["schema", "validatedAt", "storeSha256", "sourceSha256", "keyCount", "fingerprints"]),
    new Set(["schema", "validatedAt", "storeSha256", "sourceSha256", "keyCount", "fingerprints"]),
    "PUBLIC_CERTIFICATION_RECEIPT_INVALID",
  );
  if (raw.schema !== PUBLIC_CERTIFICATION_RECEIPT_SCHEMA) fail("PUBLIC_CERTIFICATION_RECEIPT_INVALID");
  canonicalTimestamp(raw.validatedAt, "PUBLIC_CERTIFICATION_RECEIPT_INVALID");
  if (raw.storeSha256 !== sha256(storeBytes) || raw.sourceSha256 !== store.sourceSha256) {
    fail("PUBLIC_CERTIFICATION_RECEIPT_HASH_MISMATCH");
  }
  const fingerprints = store.keys.map((entry) => entry.fingerprintSha256).sort(bytewiseCompare);
  if (
    raw.keyCount !== store.keys.length
    || !Array.isArray(raw.fingerprints)
    || stableStringify(raw.fingerprints) !== stableStringify(fingerprints)
  ) fail("PUBLIC_CERTIFICATION_RECEIPT_INVALID");
  return raw;
}

async function readValidatedStore(productRoot) {
  const paths = storePaths(productRoot);
  const storeBytes = await readSecureFile(paths.storeFile, "PUBLIC_CERTIFICATION_STORE_UNSAFE");
  const receiptBytes = await readSecureFile(paths.receiptFile, "PUBLIC_CERTIFICATION_RECEIPT_UNSAFE");
  let store;
  let receipt;
  try {
    store = validateStore(JSON.parse(storeBytes.toString("utf8")));
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    if (error instanceof PublicCertificationError) throw error;
    fail("PUBLIC_CERTIFICATION_STORE_INVALID");
  }
  validateReceipt(receipt, storeBytes, store);
  return { paths, store, receipt, storeBytes };
}

export async function getPublicCertificationStatus({ productRoot } = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("PUBLIC_CERTIFICATION_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  await assertPlainDirectory(resolvedProductRoot, "PUBLIC_CERTIFICATION_PRODUCT_ROOT_UNSAFE");
  const paths = storePaths(resolvedProductRoot);
  const storeState = await lstatOrNull(paths.storeFile);
  const receiptState = await lstatOrNull(paths.receiptFile);
  if (!storeState && !receiptState) {
    return Object.freeze({ certified: false, state: "not-configured", keyCount: 0, fingerprints: [] });
  }
  if (!storeState || !receiptState) fail("PUBLIC_CERTIFICATION_INCOMPLETE");
  const validated = await readValidatedStore(resolvedProductRoot);
  return Object.freeze({
    certified: true,
    state: "public-trust-validated",
    keyCount: validated.store.keys.length,
    fingerprints: validated.store.keys.map((entry) => entry.fingerprintSha256),
    sourceFormat: validated.store.sourceFormat,
    validatedAt: validated.receipt.validatedAt,
    storeSha256: validated.receipt.storeSha256,
  });
}

export async function importPublicCertification({
  productRoot,
  sourceBytes,
  sourceFile = "",
  expectedSha256 = "",
  now = () => new Date(),
} = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("PUBLIC_CERTIFICATION_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  await assertPlainDirectory(resolvedProductRoot, "PUBLIC_CERTIFICATION_PRODUCT_ROOT_UNSAFE");
  let bytes;
  if (sourceFile) {
    if (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile)) {
      fail("PUBLIC_CERTIFICATION_SOURCE_ABSOLUTE_REQUIRED");
    }
    const resolvedSourceFile = path.resolve(sourceFile);
    await assertSafeSource(resolvedSourceFile, resolvedProductRoot);
    bytes = await readSecureFile(resolvedSourceFile, "PUBLIC_CERTIFICATION_SOURCE_UNSAFE", { privateAccess: false });
  } else {
    bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes || "");
  }
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) fail("PUBLIC_CERTIFICATION_SOURCE_SIZE_INVALID");
  const sourceSha256 = sha256(bytes);
  if (expectedSha256 && (!SHA256_HEX.test(expectedSha256) || expectedSha256 !== sourceSha256)) {
    fail("PUBLIC_CERTIFICATION_SOURCE_HASH_MISMATCH");
  }
  const parsed = parsePublicCertificationSource(bytes, { now });
  const timestamp = now().toISOString();
  canonicalTimestamp(timestamp, "PUBLIC_CERTIFICATION_CLOCK_INVALID");
  const store = {
    schema: PUBLIC_CERTIFICATION_STORE_SCHEMA,
    createdAt: timestamp,
    sourceFormat: parsed.format,
    sourceSha256,
    keys: parsed.keys,
  };
  const storeBytes = Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8");
  const receipt = {
    schema: PUBLIC_CERTIFICATION_RECEIPT_SCHEMA,
    validatedAt: timestamp,
    storeSha256: sha256(storeBytes),
    sourceSha256,
    keyCount: parsed.keys.length,
    fingerprints: parsed.keys.map((entry) => entry.fingerprintSha256).sort(bytewiseCompare),
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const directory = await ensureCertificationDirectory(resolvedProductRoot);
  const paths = storePaths(resolvedProductRoot);
  const storeState = await lstatOrNull(paths.storeFile);
  const receiptState = await lstatOrNull(paths.receiptFile);
  if (storeState || receiptState) {
    if (!storeState || !receiptState) fail("PUBLIC_CERTIFICATION_INCOMPLETE");
    const existing = await readValidatedStore(resolvedProductRoot);
    const existingFingerprints = existing.store.keys.map((entry) => entry.fingerprintSha256).sort(bytewiseCompare);
    if (stableStringify(existingFingerprints) !== stableStringify(receipt.fingerprints)) {
      fail("PUBLIC_CERTIFICATION_CONFLICT");
    }
    return Object.freeze({
      initialized: false,
      certified: true,
      state: "public-trust-validated",
      keyCount: existing.store.keys.length,
      fingerprints: existingFingerprints,
      storeSha256: existing.receipt.storeSha256,
    });
  }
  try {
    await writeExclusiveLinked(paths.storeFile, storeBytes);
    await writeExclusiveLinked(paths.receiptFile, receiptBytes);
  } catch (cause) {
    if (cause?.code === "EEXIST") fail("PUBLIC_CERTIFICATION_CONFLICT", "", { cause });
    throw cause;
  }
  await syncDirectory(directory);
  const status = await getPublicCertificationStatus({ productRoot: resolvedProductRoot });
  return Object.freeze({ initialized: true, ...status });
}
