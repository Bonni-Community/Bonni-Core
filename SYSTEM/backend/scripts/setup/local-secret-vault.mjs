import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const LOCAL_SECRET_VAULT_SCHEMA = "bonni.local-secret-vault/v1";
export const LOCAL_SECRET_VAULT_CONTENT_SCHEMA = "bonni.local-secret-vault-content/v1";
export const LOCAL_SECRET_VAULT_RELATIVE_DIRECTORY = path.join("SIGNATUR", "PRIVATE");
export const LOCAL_SECRET_VAULT_FILE_NAME = "BONNI-MASTER-VAULT.bonni";
export const LOCAL_SECRET_VAULT_BACKUP_FILE_NAME = "BONNI-MASTER-VAULT.previous.bonni";
export const LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID = "developer-profile";
// The personal vault password follows the agreed minimum of 8 characters.
export const LOCAL_SECRET_VAULT_MIN_PASSWORD_BYTES = 8;
export const LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER = Object.freeze({
  schema: "bonni.community-enrollment-verifier/v1",
  kdf: Object.freeze({
    name: "scrypt",
    salt: "cPnL9QsNaUOz2jNqlhgCTGmsobCEypGrA+I2hk+w1I0=",
    N: 65_536,
    r: 8,
    p: 1,
    keyLength: 32,
  }),
  digest: "EEeMelg61uv99ISbCDmQCcFg1gX2Zc+6liNopXcAUOc=",
});
export const LOCAL_SECRET_VAULT_KDF = Object.freeze({
  name: "scrypt",
  N: 65_536,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 128 * 1024 * 1024,
});

const CONTENT_MAGIC = Buffer.from("BNV1", "ascii");
const MAX_VAULT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_COUNT = 64;
const MAX_SECRET_BYTES = 4096;
const MAX_HEADER_BYTES = 128 * 1024;
const MIN_PARTIAL_LOCK_AGE_MILLISECONDS = 30_000;
const MAX_EXPECTED_LOCK_AGE_MILLISECONDS = 10 * 60_000;
const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const PURPOSES = new Set(["developer-area", "github-release"]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class LocalSecretVaultError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "LocalSecretVaultError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new LocalSecretVaultError(code, detail, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, code) {
  if (!isPlainObject(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(code);
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

function decodeBase64(value, expectedBytes, code) {
  if (typeof value !== "string" || !BASE64.test(value)) fail(code);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== expectedBytes || bytes.toString("base64") !== value) fail(code);
  return bytes;
}

function ownedSecretBytes(value, code, { password = false } = {}) {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (typeof value === "string" ? Buffer.from(value, "utf8") : null);
  const minimum = password ? LOCAL_SECRET_VAULT_MIN_PASSWORD_BYTES : 1;
  const maximum = password ? 1024 : MAX_SECRET_BYTES;
  if (
    !bytes
    || bytes.length < minimum
    || bytes.length > maximum
    || bytes.includes(0)
    || bytes.includes(10)
    || bytes.includes(13)
  ) {
    bytes?.fill(0);
    fail(password ? "LOCAL_SECRET_VAULT_PASSWORD_INVALID" : code);
  }
  return bytes;
}

function normalizeEntryId(value) {
  if (typeof value !== "string" || !ENTRY_ID.test(value)) fail("LOCAL_SECRET_VAULT_ENTRY_ID_INVALID");
  return value;
}

function normalizeExpectedVaultId(value) {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    fail("LOCAL_SECRET_VAULT_EXPECTED_ID_INVALID");
  }
  return value;
}

function normalizePurposes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > PURPOSES.size) {
    fail("LOCAL_SECRET_VAULT_PURPOSE_INVALID");
  }
  const normalized = [...new Set(value)];
  if (normalized.length !== value.length || normalized.some((purpose) => !PURPOSES.has(purpose))) {
    fail("LOCAL_SECRET_VAULT_PURPOSE_INVALID");
  }
  return normalized.sort();
}

function developerProfileContext(unlocked) {
  const profile = unlocked.entries.find(
    (candidate) => candidate.id === LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID,
  );
  if (
    !profile
    || profile.purposes.length !== 1
    || profile.purposes[0] !== "developer-area"
  ) {
    fail("LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_NOT_CONFIGURED");
  }
  return Object.freeze({
    vaultId: unlocked.vaultId,
    developerProfileEntryId: LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID,
    developerProfileSha256: crypto.createHash("sha256").update(profile.secret).digest("hex"),
  });
}

function canonicalAad(envelope) {
  return Buffer.from(JSON.stringify({
    schema: envelope.schema,
    vaultId: envelope.vaultId,
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    kdf: envelope.kdf,
    cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
  }), "utf8");
}

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, LOCAL_SECRET_VAULT_KDF.keyLength, {
      N: LOCAL_SECRET_VAULT_KDF.N,
      r: LOCAL_SECRET_VAULT_KDF.r,
      p: LOCAL_SECRET_VAULT_KDF.p,
      maxmem: LOCAL_SECRET_VAULT_KDF.maxmem,
    }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function verifyCommunityEnrollmentCode(value, verifier = LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER) {
  const codeBytes = ownedSecretBytes(value, "LOCAL_SECRET_VAULT_ENROLLMENT_CODE_INVALID");
  let salt;
  let expected;
  let observed;
  try {
    assertExactKeys(verifier, ["schema", "kdf", "digest"], "LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER_INVALID");
    if (verifier.schema !== "bonni.community-enrollment-verifier/v1") {
      fail("LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER_INVALID");
    }
    assertExactKeys(
      verifier.kdf,
      ["name", "salt", "N", "r", "p", "keyLength"],
      "LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER_INVALID",
    );
    if (
      verifier.kdf.name !== LOCAL_SECRET_VAULT_KDF.name
      || verifier.kdf.N !== LOCAL_SECRET_VAULT_KDF.N
      || verifier.kdf.r !== LOCAL_SECRET_VAULT_KDF.r
      || verifier.kdf.p !== LOCAL_SECRET_VAULT_KDF.p
      || verifier.kdf.keyLength !== LOCAL_SECRET_VAULT_KDF.keyLength
    ) fail("LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER_INVALID");
    salt = decodeBase64(verifier.kdf.salt, 32, "LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER_INVALID");
    expected = decodeBase64(verifier.digest, 32, "LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER_INVALID");
    observed = await deriveKey(codeBytes, salt);
    if (!crypto.timingSafeEqual(observed, expected)) fail("LOCAL_SECRET_VAULT_ENROLLMENT_CODE_REJECTED");
    return true;
  } finally {
    codeBytes.fill(0);
    salt?.fill(0);
    expected?.fill(0);
    observed?.fill(0);
  }
}

function validateEnvelope(value) {
  assertExactKeys(
    value,
    ["schema", "vaultId", "revision", "updatedAt", "kdf", "cipher", "ciphertext"],
    "LOCAL_SECRET_VAULT_ENVELOPE_INVALID",
  );
  if (value.schema !== LOCAL_SECRET_VAULT_SCHEMA) fail("LOCAL_SECRET_VAULT_SCHEMA_UNSUPPORTED");
  if (typeof value.vaultId !== "string" || !UUID_V4.test(value.vaultId)) {
    fail("LOCAL_SECRET_VAULT_ID_INVALID");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail("LOCAL_SECRET_VAULT_REVISION_INVALID");
  canonicalTimestamp(value.updatedAt, "LOCAL_SECRET_VAULT_UPDATED_AT_INVALID");
  assertExactKeys(value.kdf, ["name", "salt", "N", "r", "p", "keyLength"], "LOCAL_SECRET_VAULT_KDF_INVALID");
  if (
    value.kdf.name !== LOCAL_SECRET_VAULT_KDF.name
    || value.kdf.N !== LOCAL_SECRET_VAULT_KDF.N
    || value.kdf.r !== LOCAL_SECRET_VAULT_KDF.r
    || value.kdf.p !== LOCAL_SECRET_VAULT_KDF.p
    || value.kdf.keyLength !== LOCAL_SECRET_VAULT_KDF.keyLength
  ) fail("LOCAL_SECRET_VAULT_KDF_UNSUPPORTED");
  decodeBase64(value.kdf.salt, 32, "LOCAL_SECRET_VAULT_SALT_INVALID").fill(0);
  assertExactKeys(value.cipher, ["name", "iv", "tag"], "LOCAL_SECRET_VAULT_CIPHER_INVALID");
  if (value.cipher.name !== "AES-256-GCM") fail("LOCAL_SECRET_VAULT_CIPHER_UNSUPPORTED");
  decodeBase64(value.cipher.iv, 12, "LOCAL_SECRET_VAULT_IV_INVALID").fill(0);
  decodeBase64(value.cipher.tag, 16, "LOCAL_SECRET_VAULT_TAG_INVALID").fill(0);
  if (typeof value.ciphertext !== "string" || !BASE64.test(value.ciphertext)) {
    fail("LOCAL_SECRET_VAULT_CIPHERTEXT_INVALID");
  }
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  if (
    ciphertext.length < 64
    || ciphertext.length > MAX_VAULT_BYTES
    || ciphertext.toString("base64") !== value.ciphertext
  ) fail("LOCAL_SECRET_VAULT_CIPHERTEXT_INVALID");
  ciphertext.fill(0);
  return value;
}

function encodeContent(content) {
  const secretParts = [];
  let offset = 0;
  const entries = content.entries.map((entry) => {
    const secret = Buffer.from(entry.secret);
    secretParts.push(secret);
    const headerEntry = {
      id: entry.id,
      purposes: [...entry.purposes],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      offset,
      length: secret.length,
    };
    offset += secret.length;
    return headerEntry;
  });
  const header = Buffer.from(JSON.stringify({
    schema: LOCAL_SECRET_VAULT_CONTENT_SCHEMA,
    vaultId: content.vaultId,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    revision: content.revision,
    entries,
  }), "utf8");
  if (header.length < 2 || header.length > MAX_HEADER_BYTES) fail("LOCAL_SECRET_VAULT_CONTENT_INVALID");
  const output = Buffer.allocUnsafe(8 + header.length + offset);
  CONTENT_MAGIC.copy(output, 0);
  output.writeUInt32BE(header.length, 4);
  header.copy(output, 8);
  let cursor = 8 + header.length;
  for (const secret of secretParts) {
    secret.copy(output, cursor);
    cursor += secret.length;
    secret.fill(0);
  }
  header.fill(0);
  return output;
}

function decodeContent(plaintext, envelope) {
  if (
    plaintext.length < 10
    || !crypto.timingSafeEqual(plaintext.subarray(0, 4), CONTENT_MAGIC)
  ) fail("LOCAL_SECRET_VAULT_CONTENT_INVALID");
  const headerLength = plaintext.readUInt32BE(4);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || 8 + headerLength > plaintext.length) {
    fail("LOCAL_SECRET_VAULT_CONTENT_INVALID");
  }
  let header;
  try {
    header = JSON.parse(plaintext.subarray(8, 8 + headerLength).toString("utf8"));
  } catch (cause) {
    fail("LOCAL_SECRET_VAULT_CONTENT_INVALID", "", { cause });
  }
  assertExactKeys(
    header,
    ["schema", "vaultId", "createdAt", "updatedAt", "revision", "entries"],
    "LOCAL_SECRET_VAULT_CONTENT_INVALID",
  );
  if (
    header.schema !== LOCAL_SECRET_VAULT_CONTENT_SCHEMA
    || header.vaultId !== envelope.vaultId
    || header.revision !== envelope.revision
    || header.updatedAt !== envelope.updatedAt
  ) fail("LOCAL_SECRET_VAULT_CONTENT_MISMATCH");
  canonicalTimestamp(header.createdAt, "LOCAL_SECRET_VAULT_CONTENT_INVALID");
  canonicalTimestamp(header.updatedAt, "LOCAL_SECRET_VAULT_CONTENT_INVALID");
  if (!Array.isArray(header.entries) || header.entries.length > MAX_ENTRY_COUNT) {
    fail("LOCAL_SECRET_VAULT_ENTRIES_INVALID");
  }
  const ids = new Set();
  const secretRegion = plaintext.subarray(8 + headerLength);
  let expectedOffset = 0;
  const entries = [];
  try {
    for (const entry of header.entries) {
      assertExactKeys(
        entry,
        ["id", "purposes", "createdAt", "updatedAt", "offset", "length"],
        "LOCAL_SECRET_VAULT_ENTRY_INVALID",
      );
      const id = normalizeEntryId(entry.id);
      if (ids.has(id)) fail("LOCAL_SECRET_VAULT_ENTRY_DUPLICATE");
      ids.add(id);
      const purposes = normalizePurposes(entry.purposes);
      if (
        id === LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID
        && (purposes.length !== 1 || purposes[0] !== "developer-area")
      ) fail("LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_INVALID");
      canonicalTimestamp(entry.createdAt, "LOCAL_SECRET_VAULT_ENTRY_INVALID");
      canonicalTimestamp(entry.updatedAt, "LOCAL_SECRET_VAULT_ENTRY_INVALID");
      if (
        !Number.isSafeInteger(entry.offset)
        || entry.offset !== expectedOffset
        || !Number.isSafeInteger(entry.length)
        || entry.length < 1
        || entry.length > MAX_SECRET_BYTES
        || entry.offset + entry.length > secretRegion.length
      ) fail("LOCAL_SECRET_VAULT_ENTRY_INVALID");
      const secret = Buffer.from(secretRegion.subarray(entry.offset, entry.offset + entry.length));
      if (secret.includes(0) || secret.includes(10) || secret.includes(13)) {
        secret.fill(0);
        fail("LOCAL_SECRET_VAULT_SECRET_INVALID");
      }
      expectedOffset += entry.length;
      entries.push({ id, purposes, createdAt: entry.createdAt, updatedAt: entry.updatedAt, secret });
    }
    if (expectedOffset !== secretRegion.length) fail("LOCAL_SECRET_VAULT_CONTENT_INVALID");
    return {
      schema: header.schema,
      vaultId: header.vaultId,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      revision: header.revision,
      entries,
    };
  } catch (error) {
    for (const entry of entries) entry.secret.fill(0);
    throw error;
  }
}

export function destroyUnlockedLocalSecretVault(unlocked) {
  if (!unlocked || !Array.isArray(unlocked.entries)) return;
  for (const entry of unlocked.entries) entry?.secret?.fill?.(0);
  unlocked.entries.length = 0;
}

export async function encryptLocalSecretVault(unlocked, password, { randomBytes = crypto.randomBytes } = {}) {
  const passwordBytes = ownedSecretBytes(password, "LOCAL_SECRET_VAULT_PASSWORD_INVALID", { password: true });
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const envelope = {
    schema: LOCAL_SECRET_VAULT_SCHEMA,
    vaultId: unlocked.vaultId,
    revision: unlocked.revision,
    updatedAt: unlocked.updatedAt,
    kdf: {
      name: LOCAL_SECRET_VAULT_KDF.name,
      salt: salt.toString("base64"),
      N: LOCAL_SECRET_VAULT_KDF.N,
      r: LOCAL_SECRET_VAULT_KDF.r,
      p: LOCAL_SECRET_VAULT_KDF.p,
      keyLength: LOCAL_SECRET_VAULT_KDF.keyLength,
    },
    cipher: { name: "AES-256-GCM", iv: iv.toString("base64"), tag: "" },
    ciphertext: "",
  };
  let key;
  let plaintext;
  try {
    key = await deriveKey(passwordBytes, salt);
    plaintext = encodeContent(unlocked);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(canonicalAad(envelope));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    envelope.cipher.tag = cipher.getAuthTag().toString("base64");
    envelope.ciphertext = ciphertext.toString("base64");
    ciphertext.fill(0);
    return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  } finally {
    passwordBytes.fill(0);
    salt.fill(0);
    iv.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

export async function unlockLocalSecretVault(serialized, password) {
  const passwordBytes = ownedSecretBytes(password, "LOCAL_SECRET_VAULT_PASSWORD_INVALID", { password: true });
  const bytes = Buffer.isBuffer(serialized) ? Buffer.from(serialized) : Buffer.from(serialized || "", "utf8");
  if (bytes.length < 64 || bytes.length > MAX_VAULT_BYTES) {
    passwordBytes.fill(0);
    bytes.fill(0);
    fail("LOCAL_SECRET_VAULT_FILE_SIZE_INVALID");
  }
  let parsed;
  try {
    parsed = validateEnvelope(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    passwordBytes.fill(0);
    if (error instanceof LocalSecretVaultError) throw error;
    fail("LOCAL_SECRET_VAULT_JSON_INVALID", "", { cause: error });
  } finally {
    bytes.fill(0);
  }
  const salt = decodeBase64(parsed.kdf.salt, 32, "LOCAL_SECRET_VAULT_SALT_INVALID");
  const iv = decodeBase64(parsed.cipher.iv, 12, "LOCAL_SECRET_VAULT_IV_INVALID");
  const tag = decodeBase64(parsed.cipher.tag, 16, "LOCAL_SECRET_VAULT_TAG_INVALID");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64");
  let key;
  let plaintext;
  try {
    key = await deriveKey(passwordBytes, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(canonicalAad(parsed));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decodeContent(plaintext, parsed);
  } catch (error) {
    if (error instanceof LocalSecretVaultError) throw error;
    fail("LOCAL_SECRET_VAULT_UNLOCK_FAILED", "", { cause: error });
  } finally {
    passwordBytes.fill(0);
    salt.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

function vaultPaths(productRoot) {
  const directory = path.join(productRoot, LOCAL_SECRET_VAULT_RELATIVE_DIRECTORY);
  return {
    directory,
    file: path.join(directory, LOCAL_SECRET_VAULT_FILE_NAME),
    backup: path.join(directory, LOCAL_SECRET_VAULT_BACKUP_FILE_NAME),
    lock: path.join(directory, ".BONNI-MASTER-VAULT.lock"),
  };
}

async function lstatOrNull(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code);
  return state;
}

async function assertSafeVaultFile(target, { required = true } = {}) {
  const state = await lstatOrNull(target);
  if (!state) {
    if (required) fail("LOCAL_SECRET_VAULT_NOT_CONFIGURED");
    return null;
  }
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size < 64 || state.size > MAX_VAULT_BYTES) {
    fail("LOCAL_SECRET_VAULT_FILE_UNSAFE");
  }
  return state;
}

async function ensureVaultDirectory(productRoot) {
  await assertPlainDirectory(productRoot, "LOCAL_SECRET_VAULT_PRODUCT_ROOT_UNSAFE");
  const signatureRoot = path.join(productRoot, "SIGNATUR");
  const signatureState = await lstatOrNull(signatureRoot);
  if (!signatureState) await fs.mkdir(signatureRoot, { mode: 0o700 });
  await assertPlainDirectory(signatureRoot, "LOCAL_SECRET_VAULT_DIRECTORY_UNSAFE");
  const paths = vaultPaths(productRoot);
  const privateState = await lstatOrNull(paths.directory);
  if (!privateState) await fs.mkdir(paths.directory, { mode: 0o700 });
  await assertPlainDirectory(paths.directory, "LOCAL_SECRET_VAULT_DIRECTORY_UNSAFE");
  await fs.chmod(paths.directory, 0o700).catch(() => {});
  return paths;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeTemporary(directory, basename, bytes) {
  const temporary = path.join(directory, `.${basename}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await fs.chmod(temporary, 0o600).catch(() => {});
  return temporary;
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
  );
}

async function removeLockOwnedByHandle(paths, openedState) {
  const current = await lstatOrNull(paths.lock);
  if (
    !current
    || !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || !sameFileIdentity(openedState, current)
  ) return false;
  await fs.rm(paths.lock);
  await syncDirectory(paths.directory);
  return true;
}

async function atomicReplace(target, bytes, { preserveBackup = false, recovery = false } = {}) {
  const directory = path.dirname(target);
  const paths = { backup: path.join(directory, LOCAL_SECRET_VAULT_BACKUP_FILE_NAME) };
  const temporary = await writeTemporary(directory, path.basename(target), bytes);
  let backupTemporary = null;
  try {
    let existing;
    if (recovery) {
      existing = await lstatOrNull(target);
      if (
        existing
        && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > MAX_VAULT_BYTES)
      ) fail("LOCAL_SECRET_VAULT_FILE_UNSAFE");
    } else {
      existing = await assertSafeVaultFile(target, { required: false });
    }
    if (existing && !preserveBackup) {
      backupTemporary = path.join(directory, `.${LOCAL_SECRET_VAULT_BACKUP_FILE_NAME}.${crypto.randomUUID()}.tmp`);
      await fs.copyFile(target, backupTemporary, fsConstants.COPYFILE_EXCL);
      await fs.chmod(backupTemporary, 0o600).catch(() => {});
      let backupHandle;
      try {
        backupHandle = await fs.open(backupTemporary, "r");
        await backupHandle.sync();
      } finally {
        await backupHandle?.close();
      }
      await fs.rename(backupTemporary, paths.backup);
      backupTemporary = null;
    }
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
    await syncDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (backupTemporary) await fs.rm(backupTemporary, { force: true }).catch(() => {});
  }
}

async function replaceVaultAndRecovery(paths, serialized) {
  // Write the sanitized recovery copy first. If the primary replacement later
  // fails, no automatically restorable generation containing an old password
  // or a retired/deleted secret remains. The primary still determines whether
  // the mutation committed; the recovery copy is only an authenticated copy of
  // the intended post-mutation state.
  await atomicReplace(paths.backup, serialized, {
    preserveBackup: true,
    recovery: true,
  });
  await atomicReplace(paths.file, serialized, { preserveBackup: true });
}

async function withVaultLock(paths, action) {
  await removeStaleVaultLock(paths);
  let handle;
  let openedState;
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    handle = await fs.open(paths.lock, "wx", 0o600);
    openedState = await handle.stat();
    await handle.writeFile(`${JSON.stringify({
      schema: "bonni.local-secret-vault-lock/v1",
      pid: process.pid,
      processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
      createdAt,
      token,
    })}\n`, "utf8");
    await handle.sync();
  } catch (cause) {
    await handle?.close().catch(() => {});
    handle = null;
    if (openedState) await removeLockOwnedByHandle(paths, openedState).catch(() => {});
    if (cause?.code === "EEXIST") fail("LOCAL_SECRET_VAULT_BUSY", "", { cause });
    throw cause;
  }
  try {
    return await action();
  } finally {
    await handle?.close().catch(() => {});
    let owned = false;
    try {
      const lockBytes = await fs.readFile(paths.lock);
      const lock = JSON.parse(lockBytes.toString("utf8"));
      owned = lock?.schema === "bonni.local-secret-vault-lock/v1"
        && lock?.pid === process.pid
        && lock?.createdAt === createdAt
        && lock?.token === token;
      lockBytes.fill(0);
    } catch {}
    if (owned) await fs.rm(paths.lock, { force: true }).catch(() => {});
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function readValidatedVaultLock(lockFile) {
  const state = await lstatOrNull(lockFile);
  if (!state) return null;
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size < 32 || state.size > 2048) {
    fail("LOCAL_SECRET_VAULT_LOCK_UNSAFE");
  }
  const bytes = await fs.readFile(lockFile);
  try {
    const lock = JSON.parse(bytes.toString("utf8"));
    assertExactKeys(
      lock,
      ["schema", "pid", "processStartedAt", "createdAt", "token"],
      "LOCAL_SECRET_VAULT_LOCK_UNSAFE",
    );
    if (
      lock.schema !== "bonni.local-secret-vault-lock/v1"
      || !Number.isSafeInteger(lock.pid)
      || lock.pid < 1
      || typeof lock.token !== "string"
      || !UUID_V4.test(lock.token)
    ) fail("LOCAL_SECRET_VAULT_LOCK_UNSAFE");
    canonicalTimestamp(lock.processStartedAt, "LOCAL_SECRET_VAULT_LOCK_UNSAFE");
    canonicalTimestamp(lock.createdAt, "LOCAL_SECRET_VAULT_LOCK_UNSAFE");
    return { lock, state };
  } catch (error) {
    if (error instanceof LocalSecretVaultError) throw error;
    fail("LOCAL_SECRET_VAULT_LOCK_UNSAFE");
  } finally {
    bytes.fill(0);
  }
}

async function removeStableLockFile(paths, state, {
  minAgeMilliseconds = 0,
  nowMilliseconds = Date.now(),
} = {}) {
  if (
    !state
    || !state.isFile()
    || state.isSymbolicLink()
    || state.nlink !== 1
    || state.size > 2048
  ) fail("LOCAL_SECRET_VAULT_LOCK_UNSAFE");
  const ageMilliseconds = nowMilliseconds - state.mtimeMs;
  if (!Number.isFinite(ageMilliseconds) || ageMilliseconds < minAgeMilliseconds) {
    fail("LOCAL_SECRET_VAULT_LOCK_RECOVERY_DELAY_REQUIRED");
  }
  const firstBytes = await fs.readFile(paths.lock);
  const firstHash = crypto.createHash("sha256").update(firstBytes).digest("hex");
  firstBytes.fill(0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const repeatedState = await lstatOrNull(paths.lock);
  if (
    !repeatedState
    || !repeatedState.isFile()
    || repeatedState.isSymbolicLink()
    || repeatedState.nlink !== 1
    || !sameFileIdentity(state, repeatedState)
    || repeatedState.size !== state.size
    || repeatedState.mtimeMs !== state.mtimeMs
  ) fail("LOCAL_SECRET_VAULT_LOCK_CHANGED");
  const repeatedBytes = await fs.readFile(paths.lock);
  const repeatedHash = crypto.createHash("sha256").update(repeatedBytes).digest("hex");
  repeatedBytes.fill(0);
  if (repeatedHash !== firstHash) fail("LOCAL_SECRET_VAULT_LOCK_CHANGED");
  const finalState = await lstatOrNull(paths.lock);
  if (
    !finalState
    || !sameFileIdentity(repeatedState, finalState)
    || finalState.size !== repeatedState.size
    || finalState.mtimeMs !== repeatedState.mtimeMs
  ) fail("LOCAL_SECRET_VAULT_LOCK_CHANGED");
  await fs.rm(paths.lock);
  await syncDirectory(paths.directory);
  return true;
}

async function removeStaleVaultLock(paths) {
  let observed;
  try {
    observed = await readValidatedVaultLock(paths.lock);
  } catch (error) {
    if (!(error instanceof LocalSecretVaultError) || error.code !== "LOCAL_SECRET_VAULT_LOCK_UNSAFE") throw error;
    // A crash can happen after exclusive creation but before the JSON lock is
    // completely synced. On first setup there is no vault password yet, so an
    // unchanged, plain partial lock is automatically recoverable after 30 s.
    if (await lstatOrNull(paths.file) || await lstatOrNull(paths.backup)) throw error;
    const partialState = await lstatOrNull(paths.lock);
    await removeStableLockFile(paths, partialState, {
      minAgeMilliseconds: MIN_PARTIAL_LOCK_AGE_MILLISECONDS,
    });
    return true;
  }
  if (!observed) return false;
  if (processIsAlive(observed.lock.pid)) return false;
  const repeated = await readValidatedVaultLock(paths.lock);
  if (!repeated) return true;
  if (
    repeated.lock.pid !== observed.lock.pid
    || repeated.lock.token !== observed.lock.token
    || repeated.lock.createdAt !== observed.lock.createdAt
    || repeated.state.size !== observed.state.size
    || repeated.state.mtimeMs !== observed.state.mtimeMs
  ) fail("LOCAL_SECRET_VAULT_LOCK_CHANGED");
  await fs.rm(paths.lock);
  await syncDirectory(paths.directory);
  return true;
}

async function readVaultFile(file) {
  await assertSafeVaultFile(file);
  const bytes = await fs.readFile(file);
  if (bytes.length < 64 || bytes.length > MAX_VAULT_BYTES) {
    bytes.fill(0);
    fail("LOCAL_SECRET_VAULT_FILE_SIZE_INVALID");
  }
  return bytes;
}

function resolvedProductRoot(productRoot) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("LOCAL_SECRET_VAULT_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  return path.resolve(productRoot);
}

function publicEntry(entry) {
  return Object.freeze({
    id: entry.id,
    purposes: Object.freeze([...entry.purposes]),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

export async function getLocalSecretVaultStatus({ productRoot } = {}) {
  const root = resolvedProductRoot(productRoot);
  await assertPlainDirectory(root, "LOCAL_SECRET_VAULT_PRODUCT_ROOT_UNSAFE");
  const paths = vaultPaths(root);
  const privateState = await lstatOrNull(paths.directory);
  if (!privateState) {
    return Object.freeze({ configured: false, backupAvailable: false, busy: false, staleLock: false });
  }
  await assertPlainDirectory(paths.directory, "LOCAL_SECRET_VAULT_DIRECTORY_UNSAFE");
  await removeStaleVaultLock(paths);
  const fileState = await lstatOrNull(paths.file);
  const backupState = await lstatOrNull(paths.backup);
  const lockState = await readValidatedVaultLock(paths.lock);
  const busy = Boolean(lockState && processIsAlive(lockState.lock.pid));
  const staleLock = Boolean(lockState && !busy);
  if (!fileState) {
    if (backupState) fail("LOCAL_SECRET_VAULT_PRIMARY_MISSING");
    return Object.freeze({ configured: false, backupAvailable: false, busy, staleLock });
  }
  await assertSafeVaultFile(paths.file);
  if (backupState) await assertSafeVaultFile(paths.backup);
  const bytes = await readVaultFile(paths.file);
  try {
    const envelope = validateEnvelope(JSON.parse(bytes.toString("utf8")));
    return Object.freeze({
      configured: true,
      vaultId: envelope.vaultId,
      revision: envelope.revision,
      updatedAt: envelope.updatedAt,
      backupAvailable: Boolean(backupState),
      busy,
      staleLock,
    });
  } catch (error) {
    if (error instanceof LocalSecretVaultError) throw error;
    fail("LOCAL_SECRET_VAULT_JSON_INVALID");
  } finally {
    bytes.fill(0);
  }
}

export async function initializeLocalSecretVault({
  productRoot,
  password,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  const root = resolvedProductRoot(productRoot);
  const paths = await ensureVaultDirectory(root);
  return withVaultLock(paths, async () => {
    if (await lstatOrNull(paths.file)) fail("LOCAL_SECRET_VAULT_ALREADY_EXISTS");
    if (await lstatOrNull(paths.backup)) fail("LOCAL_SECRET_VAULT_BACKUP_CONFLICT");
    const timestamp = now().toISOString();
    canonicalTimestamp(timestamp, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
    const unlocked = {
      schema: LOCAL_SECRET_VAULT_CONTENT_SCHEMA,
      vaultId: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
      entries: [],
    };
    if (!UUID_V4.test(unlocked.vaultId)) fail("LOCAL_SECRET_VAULT_ID_INVALID");
    const serialized = await encryptLocalSecretVault(unlocked, password);
    try {
      await atomicReplace(paths.file, serialized);
    } finally {
      serialized.fill(0);
    }
    return Object.freeze({ configured: true, vaultId: unlocked.vaultId, revision: 1, entryCount: 0 });
  });
}

export async function enrollCommunityDeveloperVault({
  productRoot,
  enrollmentCode,
  password,
  enrollmentVerifier = LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
} = {}) {
  const root = resolvedProductRoot(productRoot);
  const paths = await ensureVaultDirectory(root);
  return withVaultLock(paths, async () => {
    if (await lstatOrNull(paths.file) || await lstatOrNull(paths.backup)) {
      fail("LOCAL_SECRET_VAULT_ENROLLMENT_CLOSED");
    }
    await verifyCommunityEnrollmentCode(enrollmentCode, enrollmentVerifier);
    const timestamp = now().toISOString();
    canonicalTimestamp(timestamp, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
    const randomSecret = randomBytes(32);
    const developerSecret = Buffer.from(randomSecret.toString("base64url"), "ascii");
    randomSecret.fill(0);
    const unlocked = {
      schema: LOCAL_SECRET_VAULT_CONTENT_SCHEMA,
      vaultId: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
      entries: [{
        id: LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID,
        purposes: ["developer-area"],
        createdAt: timestamp,
        updatedAt: timestamp,
        secret: developerSecret,
      }],
    };
    if (!UUID_V4.test(unlocked.vaultId)) {
      developerSecret.fill(0);
      fail("LOCAL_SECRET_VAULT_ID_INVALID");
    }
    let serialized;
    try {
      serialized = await encryptLocalSecretVault(unlocked, password);
      await atomicReplace(paths.file, serialized);
      return Object.freeze({
        enrolled: true,
        vaultId: unlocked.vaultId,
        revision: 1,
        developerAccessConfigured: true,
        developerProfileSha256: crypto.createHash("sha256").update(developerSecret).digest("hex"),
      });
    } finally {
      serialized?.fill(0);
      destroyUnlockedLocalSecretVault(unlocked);
    }
  });
}

export async function enrollExistingCommunityDeveloperProfile({
  productRoot,
  enrollmentCode,
  password,
  enrollmentVerifier = LOCAL_SECRET_VAULT_ENROLLMENT_VERIFIER,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const root = resolvedProductRoot(productRoot);
  const paths = await ensureVaultDirectory(root);
  return withVaultLock(paths, async () => {
    if (!await lstatOrNull(paths.file)) {
      if (await lstatOrNull(paths.backup)) fail("LOCAL_SECRET_VAULT_PRIMARY_MISSING");
      fail("LOCAL_SECRET_VAULT_NOT_CONFIGURED");
    }
    const bytes = await readVaultFile(paths.file);
    let unlocked;
    let developerSecret;
    try {
      // The existing personal password is deliberately verified before the
      // community code. Neither factor alone can authorize a vault mutation.
      unlocked = await unlockLocalSecretVault(bytes, password);
      if (unlocked.entries.some(
        (entry) => entry.id === LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID,
      )) fail("LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ALREADY_CONFIGURED");
      if (unlocked.entries.length >= MAX_ENTRY_COUNT) fail("LOCAL_SECRET_VAULT_ENTRY_LIMIT");
      await verifyCommunityEnrollmentCode(enrollmentCode, enrollmentVerifier);

      const timestamp = now().toISOString();
      canonicalTimestamp(timestamp, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
      const randomSecret = randomBytes(32);
      try {
        developerSecret = Buffer.from(randomSecret.toString("base64url"), "ascii");
      } finally {
        randomSecret.fill(0);
      }
      unlocked.entries.push({
        id: LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID,
        purposes: ["developer-area"],
        createdAt: timestamp,
        updatedAt: timestamp,
        secret: developerSecret,
      });
      unlocked.entries.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
      await writeMutatedVault(paths, unlocked, password, now, { sanitizeRecovery: true });
      return Object.freeze({
        enrolled: true,
        existingVault: true,
        vaultId: unlocked.vaultId,
        revision: unlocked.revision,
        developerAccessConfigured: true,
        developerProfileSha256: crypto.createHash("sha256").update(developerSecret).digest("hex"),
      });
    } finally {
      bytes.fill(0);
      // destroyUnlockedLocalSecretVault owns and clears developerSecret after
      // it was inserted. If insertion did not happen, clear it explicitly.
      if (developerSecret && !unlocked?.entries?.some((entry) => entry.secret === developerSecret)) {
        developerSecret.fill(0);
      }
      destroyUnlockedLocalSecretVault(unlocked);
    }
  });
}

export async function importEncryptedLocalSecretVault({ productRoot, password, sourceFile } = {}) {
  const root = resolvedProductRoot(productRoot);
  if (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile)) {
    fail("LOCAL_SECRET_VAULT_IMPORT_SOURCE_ABSOLUTE_REQUIRED");
  }
  const source = path.resolve(sourceFile);
  const sourceState = await lstatOrNull(source);
  if (
    !sourceState
    || !sourceState.isFile()
    || sourceState.isSymbolicLink()
    || sourceState.nlink !== 1
    || sourceState.size < 64
    || sourceState.size > MAX_VAULT_BYTES
  ) fail("LOCAL_SECRET_VAULT_IMPORT_SOURCE_UNSAFE");
  const paths = await ensureVaultDirectory(root);
  if (source === paths.file || source === paths.backup) fail("LOCAL_SECRET_VAULT_IMPORT_SOURCE_UNSAFE");
  return withVaultLock(paths, async () => {
    if (await lstatOrNull(paths.file)) fail("LOCAL_SECRET_VAULT_ALREADY_EXISTS");
    if (await lstatOrNull(paths.backup)) fail("LOCAL_SECRET_VAULT_BACKUP_CONFLICT");
    const bytes = await fs.readFile(source);
    let unlocked;
    try {
      unlocked = await unlockLocalSecretVault(bytes, password);
      await atomicReplace(paths.file, bytes);
      return Object.freeze({
        imported: true,
        vaultId: unlocked.vaultId,
        revision: unlocked.revision,
        entryCount: unlocked.entries.length,
      });
    } finally {
      bytes.fill(0);
      destroyUnlockedLocalSecretVault(unlocked);
    }
  });
}

async function authenticatedOperation(productRoot, password, action) {
  const root = resolvedProductRoot(productRoot);
  const paths = await ensureVaultDirectory(root);
  return withVaultLock(paths, async () => {
    const bytes = await readVaultFile(paths.file);
    let unlocked;
    try {
      unlocked = await unlockLocalSecretVault(bytes, password);
      return await action({ root, paths, unlocked });
    } finally {
      bytes.fill(0);
      destroyUnlockedLocalSecretVault(unlocked);
    }
  });
}

export async function listLocalSecretVaultEntries({ productRoot, password } = {}) {
  return authenticatedOperation(productRoot, password, async ({ unlocked }) => Object.freeze({
    vaultId: unlocked.vaultId,
    revision: unlocked.revision,
    entries: Object.freeze(unlocked.entries.map(publicEntry)),
  }));
}

async function writeMutatedVault(paths, unlocked, password, now, {
  sanitizeRecovery = false,
} = {}) {
  const timestamp = now().toISOString();
  canonicalTimestamp(timestamp, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
  unlocked.revision += 1;
  unlocked.updatedAt = timestamp;
  const serialized = await encryptLocalSecretVault(unlocked, password);
  try {
    if (sanitizeRecovery) {
      await replaceVaultAndRecovery(paths, serialized);
    } else {
      await atomicReplace(paths.file, serialized);
    }
  } finally {
    serialized.fill(0);
  }
}

export async function putLocalSecretVaultEntry({
  productRoot,
  password,
  entryId,
  purposes,
  secret,
  now = () => new Date(),
} = {}) {
  const id = normalizeEntryId(entryId);
  const normalizedPurposes = normalizePurposes(purposes);
  const secretBytes = ownedSecretBytes(secret, "LOCAL_SECRET_VAULT_SECRET_INVALID");
  try {
    return await authenticatedOperation(productRoot, password, async ({ paths, unlocked }) => {
      if (unlocked.entries.length >= MAX_ENTRY_COUNT) fail("LOCAL_SECRET_VAULT_ENTRY_LIMIT");
      if (unlocked.entries.some((entry) => entry.id === id)) fail("LOCAL_SECRET_VAULT_ENTRY_EXISTS");
      if (id === LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID) {
        fail("LOCAL_SECRET_VAULT_ENTRY_RESERVED");
      }
      if (
        normalizedPurposes.includes("developer-area")
        && !unlocked.entries.some((entry) => entry.purposes.includes("developer-area"))
      ) fail("LOCAL_SECRET_VAULT_DEVELOPER_ENROLLMENT_REQUIRED");
      const timestamp = now().toISOString();
      canonicalTimestamp(timestamp, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
      unlocked.entries.push({
        id,
        purposes: normalizedPurposes,
        createdAt: timestamp,
        updatedAt: timestamp,
        secret: Buffer.from(secretBytes),
      });
      unlocked.entries.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
      await writeMutatedVault(paths, unlocked, password, now, { sanitizeRecovery: true });
      return Object.freeze({ stored: true, revision: unlocked.revision, entry: publicEntry(unlocked.entries.find((entry) => entry.id === id)) });
    });
  } finally {
    secretBytes.fill(0);
  }
}

export async function rotateLocalSecretVaultEntry({
  productRoot,
  password,
  entryId,
  secret,
  now = () => new Date(),
} = {}) {
  const id = normalizeEntryId(entryId);
  const secretBytes = ownedSecretBytes(secret, "LOCAL_SECRET_VAULT_SECRET_INVALID");
  try {
    return await authenticatedOperation(productRoot, password, async ({ paths, unlocked }) => {
      const entry = unlocked.entries.find((candidate) => candidate.id === id);
      if (!entry) fail("LOCAL_SECRET_VAULT_ENTRY_NOT_FOUND");
      if (id === LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID) {
        fail("LOCAL_SECRET_VAULT_ENTRY_RESERVED");
      }
      entry.secret.fill(0);
      entry.secret = Buffer.from(secretBytes);
      entry.updatedAt = now().toISOString();
      canonicalTimestamp(entry.updatedAt, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
      await writeMutatedVault(paths, unlocked, password, now, { sanitizeRecovery: true });
      return Object.freeze({ rotated: true, revision: unlocked.revision, entry: publicEntry(entry) });
    });
  } finally {
    secretBytes.fill(0);
  }
}

export async function removeLocalSecretVaultEntry({ productRoot, password, entryId, now = () => new Date() } = {}) {
  const id = normalizeEntryId(entryId);
  return authenticatedOperation(productRoot, password, async ({ paths, unlocked }) => {
    const index = unlocked.entries.findIndex((entry) => entry.id === id);
    if (index < 0) fail("LOCAL_SECRET_VAULT_ENTRY_NOT_FOUND");
    if (id === LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID) {
      fail("LOCAL_SECRET_VAULT_ENTRY_RESERVED");
    }
    unlocked.entries[index].secret.fill(0);
    unlocked.entries.splice(index, 1);
    await writeMutatedVault(paths, unlocked, password, now, { sanitizeRecovery: true });
    return Object.freeze({ removed: true, revision: unlocked.revision, entryId: id });
  });
}

export async function changeLocalSecretVaultPassword({
  productRoot,
  password,
  newPassword,
  now = () => new Date(),
} = {}) {
  const newPasswordBytes = ownedSecretBytes(newPassword, "LOCAL_SECRET_VAULT_PASSWORD_INVALID", { password: true });
  try {
    return await authenticatedOperation(productRoot, password, async ({ paths, unlocked }) => {
      const timestamp = now().toISOString();
      canonicalTimestamp(timestamp, "LOCAL_SECRET_VAULT_CLOCK_INVALID");
      unlocked.revision += 1;
      unlocked.updatedAt = timestamp;
      const serialized = await encryptLocalSecretVault(unlocked, newPasswordBytes);
      try {
        await replaceVaultAndRecovery(paths, serialized);
      } finally {
        serialized.fill(0);
      }
      return Object.freeze({ changed: true, revision: unlocked.revision });
    });
  } finally {
    newPasswordBytes.fill(0);
  }
}

export async function verifyLocalSecretVaultPurpose({ productRoot, password, purpose } = {}) {
  const normalized = normalizePurposes([purpose])[0];
  return authenticatedOperation(productRoot, password, async ({ unlocked }) => {
    if (normalized === "developer-area") {
      const profile = developerProfileContext(unlocked);
      return Object.freeze({
        verified: true,
        purpose: normalized,
        entryCount: 1,
        revision: unlocked.revision,
        vaultId: profile.vaultId,
        developerProfileEntryId: profile.developerProfileEntryId,
        developerProfileSha256: profile.developerProfileSha256,
      });
    }
    const matching = unlocked.entries.filter((entry) => entry.purposes.includes(normalized));
    if (matching.length < 1) fail("LOCAL_SECRET_VAULT_PURPOSE_NOT_CONFIGURED");
    return Object.freeze({ verified: true, purpose: normalized, entryCount: matching.length, revision: unlocked.revision });
  });
}

export async function withLocalSecretVaultEntry({
  productRoot,
  password,
  entryId,
  purpose,
  expectedVaultId = "",
  requiredPurpose = "",
} = {}, callback) {
  if (typeof callback !== "function") fail("LOCAL_SECRET_VAULT_CALLBACK_REQUIRED");
  const id = normalizeEntryId(entryId);
  const normalizedPurpose = normalizePurposes([purpose])[0];
  const boundVaultId = expectedVaultId ? normalizeExpectedVaultId(expectedVaultId) : "";
  const requiredVaultPurpose = requiredPurpose ? normalizePurposes([requiredPurpose])[0] : "";
  return authenticatedOperation(productRoot, password, async ({ unlocked }) => {
    if (boundVaultId && unlocked.vaultId !== boundVaultId) {
      fail("LOCAL_SECRET_VAULT_EXPECTED_ID_MISMATCH");
    }
    let callbackContext = Object.freeze({ vaultId: unlocked.vaultId });
    if (requiredVaultPurpose === "developer-area") {
      callbackContext = developerProfileContext(unlocked);
    } else if (requiredVaultPurpose
      && !unlocked.entries.some((candidate) => candidate.purposes.includes(requiredVaultPurpose))) {
      fail("LOCAL_SECRET_VAULT_PURPOSE_NOT_CONFIGURED");
    }
    const entry = unlocked.entries.find((candidate) => candidate.id === id);
    if (!entry) fail("LOCAL_SECRET_VAULT_ENTRY_NOT_FOUND");
    if (!entry.purposes.includes(normalizedPurpose)) fail("LOCAL_SECRET_VAULT_PURPOSE_FORBIDDEN");
    const secret = Buffer.from(entry.secret);
    try {
      return await callback(secret, publicEntry(entry), callbackContext);
    } finally {
      secret.fill(0);
    }
  });
}

export async function restoreLocalSecretVaultBackup({ productRoot, password } = {}) {
  const root = resolvedProductRoot(productRoot);
  const paths = await ensureVaultDirectory(root);
  return withVaultLock(paths, async () => {
    await assertSafeVaultFile(paths.backup);
    const backupBytes = await readVaultFile(paths.backup);
    let unlocked;
    try {
      unlocked = await unlockLocalSecretVault(backupBytes, password);
      await atomicReplace(paths.file, backupBytes, { preserveBackup: true, recovery: true });
      return Object.freeze({ restored: true, revision: unlocked.revision, entryCount: unlocked.entries.length });
    } finally {
      backupBytes.fill(0);
      destroyUnlockedLocalSecretVault(unlocked);
    }
  });
}

export async function recoverLocalSecretVaultStaleLock({
  productRoot,
  password,
  now = () => new Date(),
} = {}) {
  const root = resolvedProductRoot(productRoot);
  const paths = await ensureVaultDirectory(root);

  // A manual repair is authorized by a successful vault unlock. It never
  // treats possession of the Windows account alone as sufficient.
  const vaultBytes = await readVaultFile(paths.file);
  let unlocked;
  try {
    unlocked = await unlockLocalSecretVault(vaultBytes, password);
  } finally {
    vaultBytes.fill(0);
    destroyUnlockedLocalSecretVault(unlocked);
  }

  const state = await lstatOrNull(paths.lock);
  if (!state) return Object.freeze({ recovered: false, reason: "not-locked" });
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 2048) {
    fail("LOCAL_SECRET_VAULT_LOCK_UNSAFE");
  }

  let lock = null;
  try {
    lock = (await readValidatedVaultLock(paths.lock))?.lock || null;
  } catch (error) {
    if (!(error instanceof LocalSecretVaultError) || error.code !== "LOCAL_SECRET_VAULT_LOCK_UNSAFE") throw error;
  }
  const lockAgeMilliseconds = lock ? now().getTime() - Date.parse(lock.createdAt) : NaN;
  if (
    lock
    && processIsAlive(lock.pid)
    && (!Number.isFinite(lockAgeMilliseconds) || lockAgeMilliseconds < MAX_EXPECTED_LOCK_AGE_MILLISECONDS)
  ) fail("LOCAL_SECRET_VAULT_BUSY");

  // A partial record can only exist if the process stopped between exclusive
  // creation and its first synced write. Wait 30 seconds before explicit
  // cleanup and require byte/stat identity across a second observation.
  await removeStableLockFile(paths, state, {
    minAgeMilliseconds: lock ? 0 : MIN_PARTIAL_LOCK_AGE_MILLISECONDS,
    nowMilliseconds: now().getTime(),
  });
  const reason = !lock
    ? "partial-record"
    : (processIsAlive(lock.pid) ? "expired-owner" : "dead-owner");
  return Object.freeze({ recovered: true, reason });
}
