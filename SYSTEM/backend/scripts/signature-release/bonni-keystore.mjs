import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { appDirectoryFromId } from "../setup/app-registry.mjs";

export const BONNI_KEYSTORE_SCHEMA = "bonni.keystore/v1";
export const BONNI_KEYSTORE_CONTENT_SCHEMA = "bonni.keystore-content/v1";
export const BONNI_KEYSTORE_KDF = Object.freeze({
  name: "scrypt",
  N: 65_536,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 128 * 1024 * 1024,
});

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SCOPE = /^(?:offline-root|release-set|component:(?:SYSTEM|WINDOWS|LINUX|CONTAINER)|app:[a-z0-9][a-z0-9._-]{1,63})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_KEY_COUNT = 256;

export const DEFAULT_KEY_DEFINITIONS = Object.freeze([
  Object.freeze({ keyId: "bonni-offline-root-01", scope: "offline-root" }),
  Object.freeze({ keyId: "bonni-release-set-01", scope: "release-set" }),
  Object.freeze({ keyId: "bonni-system-01", scope: "component:SYSTEM" }),
  Object.freeze({ keyId: "bonni-windows-01", scope: "component:WINDOWS" }),
  Object.freeze({ keyId: "bonni-linux-01", scope: "component:LINUX" }),
  Object.freeze({ keyId: "bonni-container-01", scope: "component:CONTAINER" }),
  Object.freeze({ keyId: "bonni-app-stueberlapp-01", scope: "app:stueberlapp" }),
  Object.freeze({ keyId: "bonni-app-kontorapp-01", scope: "app:kontorapp" }),
  Object.freeze({ keyId: "bonni-app-hocketapp-01", scope: "app:hocketapp" }),
  Object.freeze({ keyId: "bonni-app-kassenapp-01", scope: "app:kassenapp" }),
]);

export class BonniKeystoreError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "BonniKeystoreError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new BonniKeystoreError(code, detail, options);
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

function normalizePassword(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 1024 || value.includes("\0")) {
    fail("BONNI_KEYSTORE_MASTER_PASSWORD_INVALID");
  }
  return value.normalize("NFKC");
}

function normalizeDefinitions(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_KEY_COUNT) {
    fail("BONNI_KEYSTORE_KEY_DEFINITIONS_INVALID");
  }
  const keyIds = new Set();
  const scopes = new Set();
  const result = value.map((entry) => {
    assertExactKeys(entry, ["keyId", "scope"], "BONNI_KEYSTORE_KEY_DEFINITION_INVALID");
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)) {
      fail("BONNI_KEYSTORE_KEY_ID_INVALID", String(entry.keyId || ""));
    }
    if (typeof entry.scope !== "string" || !SCOPE.test(entry.scope)) {
      fail("BONNI_KEYSTORE_KEY_SCOPE_INVALID", String(entry.scope || ""));
    }
    if (keyIds.has(entry.keyId)) fail("BONNI_KEYSTORE_KEY_ID_DUPLICATE", entry.keyId);
    if (scopes.has(entry.scope)) fail("BONNI_KEYSTORE_KEY_SCOPE_DUPLICATE", entry.scope);
    keyIds.add(entry.keyId);
    scopes.add(entry.scope);
    return { keyId: entry.keyId, scope: entry.scope };
  });
  if (!scopes.has("offline-root") || !scopes.has("release-set")) {
    fail("BONNI_KEYSTORE_REQUIRED_SCOPE_MISSING");
  }
  return result.sort((left, right) => Buffer.compare(Buffer.from(left.scope), Buffer.from(right.scope)));
}

function parseEd25519PrivateKey(value) {
  let key;
  try {
    key = crypto.createPrivateKey(value);
  } catch (error) {
    fail("BONNI_KEYSTORE_PRIVATE_KEY_INVALID", "", { cause: error });
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("BONNI_KEYSTORE_PRIVATE_KEY_INVALID");
  }
  return key;
}

function parseEd25519PublicKey(value) {
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch (error) {
    fail("BONNI_KEYSTORE_PUBLIC_KEY_INVALID", "", { cause: error });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("BONNI_KEYSTORE_PUBLIC_KEY_INVALID");
  }
  return key;
}

function publicFingerprint(publicKey) {
  return crypto.createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function canonicalAad(envelope) {
  return Buffer.from(JSON.stringify({
    schema: envelope.schema,
    kdf: envelope.kdf,
    cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
  }), "utf8");
}

function deriveKey(password, salt, parameters) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: parameters.maxmem,
    }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function validateEnvelope(value) {
  assertExactKeys(value, ["schema", "kdf", "cipher", "ciphertext"], "BONNI_KEYSTORE_ENVELOPE_INVALID");
  if (value.schema !== BONNI_KEYSTORE_SCHEMA) fail("BONNI_KEYSTORE_SCHEMA_UNSUPPORTED");
  assertExactKeys(value.kdf, ["name", "salt", "N", "r", "p", "keyLength"], "BONNI_KEYSTORE_KDF_INVALID");
  if (
    value.kdf.name !== BONNI_KEYSTORE_KDF.name
    || value.kdf.N !== BONNI_KEYSTORE_KDF.N
    || value.kdf.r !== BONNI_KEYSTORE_KDF.r
    || value.kdf.p !== BONNI_KEYSTORE_KDF.p
    || value.kdf.keyLength !== BONNI_KEYSTORE_KDF.keyLength
  ) fail("BONNI_KEYSTORE_KDF_UNSUPPORTED");
  decodeBase64(value.kdf.salt, 32, "BONNI_KEYSTORE_SALT_INVALID");
  assertExactKeys(value.cipher, ["name", "iv", "tag"], "BONNI_KEYSTORE_CIPHER_INVALID");
  if (value.cipher.name !== "AES-256-GCM") fail("BONNI_KEYSTORE_CIPHER_UNSUPPORTED");
  decodeBase64(value.cipher.iv, 12, "BONNI_KEYSTORE_IV_INVALID");
  decodeBase64(value.cipher.tag, 16, "BONNI_KEYSTORE_TAG_INVALID");
  if (typeof value.ciphertext !== "string" || !BASE64.test(value.ciphertext)) {
    fail("BONNI_KEYSTORE_CIPHERTEXT_INVALID");
  }
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  if (ciphertext.length < 64 || ciphertext.length > 4 * 1024 * 1024 || ciphertext.toString("base64") !== value.ciphertext) {
    fail("BONNI_KEYSTORE_CIPHERTEXT_INVALID");
  }
  return value;
}

function validateContent(value) {
  assertExactKeys(value, ["schema", "storeId", "createdAt", "keys"], "BONNI_KEYSTORE_CONTENT_INVALID");
  if (value.schema !== BONNI_KEYSTORE_CONTENT_SCHEMA) fail("BONNI_KEYSTORE_CONTENT_SCHEMA_UNSUPPORTED");
  if (typeof value.storeId !== "string" || !/^[a-f0-9-]{36}$/u.test(value.storeId)) {
    fail("BONNI_KEYSTORE_STORE_ID_INVALID");
  }
  canonicalTimestamp(value.createdAt, "BONNI_KEYSTORE_CREATED_AT_INVALID");
  if (!Array.isArray(value.keys) || value.keys.length < 2 || value.keys.length > MAX_KEY_COUNT) {
    fail("BONNI_KEYSTORE_KEYS_INVALID");
  }
  const definitions = normalizeDefinitions(value.keys.map(({ keyId, scope }) => ({ keyId, scope })));
  const definitionsByScope = new Map(definitions.map((entry) => [entry.scope, entry.keyId]));
  const keys = value.keys.map((entry) => {
    assertExactKeys(
      entry,
      ["keyId", "scope", "algorithm", "createdAt", "privateKeyPem", "publicKeyPem", "fingerprintSha256"],
      "BONNI_KEYSTORE_KEY_INVALID",
    );
    if (definitionsByScope.get(entry.scope) !== entry.keyId) fail("BONNI_KEYSTORE_KEY_DEFINITION_MISMATCH");
    if (entry.algorithm !== "Ed25519") fail("BONNI_KEYSTORE_KEY_ALGORITHM_INVALID");
    canonicalTimestamp(entry.createdAt, "BONNI_KEYSTORE_KEY_CREATED_AT_INVALID");
    const privateKey = parseEd25519PrivateKey(entry.privateKeyPem);
    const publicKey = parseEd25519PublicKey(entry.publicKeyPem);
    const expectedPublic = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const observedPublic = publicKey.export({ type: "spki", format: "der" });
    if (!crypto.timingSafeEqual(expectedPublic, observedPublic)) fail("BONNI_KEYSTORE_KEY_PAIR_MISMATCH");
    const fingerprintSha256 = publicFingerprint(publicKey);
    if (entry.fingerprintSha256 !== fingerprintSha256) fail("BONNI_KEYSTORE_FINGERPRINT_MISMATCH");
    return { ...entry, privateKey, publicKey };
  });
  return { schema: value.schema, storeId: value.storeId, createdAt: value.createdAt, keys };
}

function serializableContent(unlocked) {
  return {
    schema: unlocked.schema,
    storeId: unlocked.storeId,
    createdAt: unlocked.createdAt,
    keys: unlocked.keys.map((entry) => ({
      keyId: entry.keyId,
      scope: entry.scope,
      algorithm: entry.algorithm,
      createdAt: entry.createdAt,
      privateKeyPem: entry.privateKeyPem,
      publicKeyPem: entry.publicKeyPem,
      fingerprintSha256: entry.fingerprintSha256,
    })),
  };
}

async function encryptContent(content, normalizedPassword, randomBytes) {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  if (!Buffer.isBuffer(salt) || salt.length !== 32 || !Buffer.isBuffer(iv) || iv.length !== 12) {
    fail("BONNI_KEYSTORE_RANDOM_SOURCE_INVALID");
  }
  const envelope = {
    schema: BONNI_KEYSTORE_SCHEMA,
    kdf: {
      name: BONNI_KEYSTORE_KDF.name,
      salt: salt.toString("base64"),
      N: BONNI_KEYSTORE_KDF.N,
      r: BONNI_KEYSTORE_KDF.r,
      p: BONNI_KEYSTORE_KDF.p,
      keyLength: BONNI_KEYSTORE_KDF.keyLength,
    },
    cipher: { name: "AES-256-GCM", iv: iv.toString("base64"), tag: "" },
    ciphertext: "",
  };
  const key = await deriveKey(normalizedPassword, salt, BONNI_KEYSTORE_KDF);
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(canonicalAad(envelope));
    const plaintext = Buffer.from(JSON.stringify(content), "utf8");
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      envelope.cipher.tag = cipher.getAuthTag().toString("base64");
      envelope.ciphertext = ciphertext.toString("base64");
      return `${JSON.stringify(envelope, null, 2)}\n`;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

function normalizeAppIdentity(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9._-]{1,63}$/u.test(value)) {
    fail("BONNI_KEYSTORE_APP_INVALID", String(value || ""));
  }
  const id = value;
  let directory;
  try {
    directory = appDirectoryFromId(id);
  } catch (cause) {
    fail("BONNI_KEYSTORE_APP_INVALID", id, { cause });
  }
  return Object.freeze({
    id,
    directory,
    scope: `app:${directory}`,
    keyId: `bonni-app-${directory}-01`,
  });
}

export async function createBonniKeystore({
  password,
  keyDefinitions = DEFAULT_KEY_DEFINITIONS,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
} = {}) {
  const normalizedPassword = normalizePassword(password);
  const definitions = normalizeDefinitions(keyDefinitions);
  const createdAt = now().toISOString();
  canonicalTimestamp(createdAt, "BONNI_KEYSTORE_CREATED_AT_INVALID");
  const content = {
    schema: BONNI_KEYSTORE_CONTENT_SCHEMA,
    storeId: randomUUID(),
    createdAt,
    keys: definitions.map(({ keyId, scope }) => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      return {
        keyId,
        scope,
        algorithm: "Ed25519",
        createdAt,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
        fingerprintSha256: publicFingerprint(publicKey),
      };
    }),
  };
  return encryptContent(content, normalizedPassword, randomBytes);
}

export async function unlockBonniKeystore(value, password) {
  const normalizedPassword = normalizePassword(password);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  } catch (error) {
    fail("BONNI_KEYSTORE_JSON_INVALID", "", { cause: error });
  }
  const envelope = validateEnvelope(parsed);
  const salt = decodeBase64(envelope.kdf.salt, 32, "BONNI_KEYSTORE_SALT_INVALID");
  const iv = decodeBase64(envelope.cipher.iv, 12, "BONNI_KEYSTORE_IV_INVALID");
  const tag = decodeBase64(envelope.cipher.tag, 16, "BONNI_KEYSTORE_TAG_INVALID");
  const key = await deriveKey(normalizedPassword, salt, BONNI_KEYSTORE_KDF);
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(canonicalAad(envelope));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch (error) {
    fail("BONNI_KEYSTORE_UNLOCK_FAILED", "", { cause: error });
  } finally {
    key.fill(0);
  }
  try {
    return validateContent(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof BonniKeystoreError) throw error;
    fail("BONNI_KEYSTORE_CONTENT_INVALID", "", { cause: error });
  } finally {
    plaintext?.fill(0);
  }
}

// Re-encrypt the same identity when moving an existing signer into managed storage.
export async function reencryptBonniKeystore({value,password,newPassword}) {
  const unlocked=await unlockBonniKeystore(value,password);
  try { return await encryptContent(serializableContent(unlocked),normalizePassword(newPassword),crypto.randomBytes); }
  finally { for(const entry of unlocked.keys) { entry.privateKeyPem='';entry.privateKey=null; } }
}

export async function extendBonniKeystoreWithApp({
  value,
  password,
  appId,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const normalizedPassword = normalizePassword(password);
  const identity = normalizeAppIdentity(appId);
  const unlocked = await unlockBonniKeystore(value, normalizedPassword);
  if (unlocked.keys.length >= MAX_KEY_COUNT) fail("BONNI_KEYSTORE_KEYS_LIMIT_REACHED");
  if (unlocked.keys.some((entry) => entry.scope === identity.scope)) {
    fail("BONNI_KEYSTORE_APP_SCOPE_EXISTS", identity.scope);
  }
  if (unlocked.keys.some((entry) => entry.keyId === identity.keyId)) {
    fail("BONNI_KEYSTORE_APP_KEY_ID_EXISTS", identity.keyId);
  }
  const createdAt = now().toISOString();
  canonicalTimestamp(createdAt, "BONNI_KEYSTORE_KEY_CREATED_AT_INVALID");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprintSha256 = publicFingerprint(publicKey);
  const nextContent = serializableContent(unlocked);
  nextContent.keys.push({
    keyId: identity.keyId,
    scope: identity.scope,
    algorithm: "Ed25519",
    createdAt,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
    fingerprintSha256,
  });
  const validated = validateContent(nextContent);
  const contents = await encryptContent(
    serializableContent(validated),
    normalizedPassword,
    randomBytes,
  );
  return Object.freeze({
    contents,
    storeId: unlocked.storeId,
    createdAt: unlocked.createdAt,
    keyCount: validated.keys.length,
    app: Object.freeze({
      id: identity.id,
      directory: identity.directory,
      keyId: identity.keyId,
      scope: identity.scope,
      algorithm: "Ed25519",
      publicKeyPem,
      fingerprintSha256,
    }),
  });
}

export function keyForScope(unlocked, scope) {
  if (!unlocked || !Array.isArray(unlocked.keys) || typeof scope !== "string" || !SCOPE.test(scope)) {
    fail("BONNI_KEYSTORE_SCOPE_INVALID", String(scope || ""));
  }
  const entry = unlocked.keys.find((candidate) => candidate.scope === scope);
  if (!entry) fail("BONNI_KEYSTORE_SCOPE_NOT_FOUND", scope);
  return entry;
}

export function publicTrustExport(unlocked) {
  if (!unlocked || !Array.isArray(unlocked.keys)) fail("BONNI_KEYSTORE_UNLOCKED_INVALID");
  return {
    schema: "bonni.public-trust/v1",
    storeId: unlocked.storeId,
    createdAt: unlocked.createdAt,
    keys: unlocked.keys.map(({ keyId, scope, algorithm, publicKeyPem, fingerprintSha256 }) => ({
      keyId,
      scope,
      algorithm,
      publicKeyPem,
      fingerprintSha256,
    })),
  };
}

export async function initializeBonniKeystore({ file, password, keyDefinitions, now } = {}) {
  if (typeof file !== "string" || !file) fail("BONNI_KEYSTORE_FILE_REQUIRED");
  const target = path.resolve(file);
  const parent = path.dirname(target);
  const parentState = await fs.lstat(parent).catch(() => null);
  if (!parentState || !parentState.isDirectory() || parentState.isSymbolicLink()) {
    fail("BONNI_KEYSTORE_PARENT_DIRECTORY_UNSAFE", parent);
  }
  const contents = await createBonniKeystore({ password, keyDefinitions, now });
  let handle;
  try {
    handle = await fs.open(target, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail("BONNI_KEYSTORE_ALREADY_EXISTS", target);
    throw error;
  } finally {
    await handle?.close();
  }
  return { file: target, bytes: Buffer.byteLength(contents) };
}
