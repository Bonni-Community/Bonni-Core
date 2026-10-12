import crypto, { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const BONNI_APP_REGISTRY_SCHEMA = "bonni.app-registry/v1";
export const BONNI_APP_REGISTRY_BINDING_SCHEMA = "bonni.app-registry-binding/v1";
export const BONNI_APP_REGISTRY_FILE_NAME = "APP-REGISTRY.json";
export const BONNI_APP_REGISTRY_PAYLOAD_PATH = `PAYLOAD/SYSTEM/${BONNI_APP_REGISTRY_FILE_NAME}`;

const APP_ID = /^[A-Z][A-Z0-9._-]{1,63}$/u;
const RESERVED_APP_IDS = new Set(["SYSTEM", "WINDOWS", "LINUX", "CONTAINER"]);
const APP_DIRECTORY = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const WINDOWS_RESERVED_DIRECTORY = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REGISTRY_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_APP_COUNT = 128;

export class BonniAppRegistryError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "BonniAppRegistryError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new BonniAppRegistryError(code, detail, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, code) {
  if (
    !isPlainObject(value)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) fail(code);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function appIdFromDirectory(value) {
  if (
    typeof value !== "string"
    || !APP_DIRECTORY.test(value)
    || value.endsWith(".")
    || WINDOWS_RESERVED_DIRECTORY.test(value)
  ) {
    fail("BONNI_APP_REGISTRY_DIRECTORY_INVALID", String(value || ""));
  }
  const id = value.toUpperCase();
  if (!APP_ID.test(id) || RESERVED_APP_IDS.has(id)) fail("BONNI_APP_REGISTRY_ID_INVALID", id);
  return id;
}

export function appDirectoryFromId(value) {
  if (typeof value !== "string" || !APP_ID.test(value) || RESERVED_APP_IDS.has(value)) {
    fail("BONNI_APP_REGISTRY_ID_INVALID", String(value || ""));
  }
  const directory = value.toLowerCase();
  if (
    !APP_DIRECTORY.test(directory)
    || directory.endsWith(".")
    || WINDOWS_RESERVED_DIRECTORY.test(directory)
  ) {
    fail("BONNI_APP_REGISTRY_DIRECTORY_INVALID", directory);
  }
  return directory;
}

export function appManifestScope(value) {
  appDirectoryFromId(value);
  return `APP:${value}`;
}

export function appTrustScope(value) {
  return `app:${appDirectoryFromId(value)}`;
}

function parsePublicKey(value, code) {
  if (typeof value !== "string") fail(code);
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch (cause) {
    fail(code, "", { cause });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") fail(code);
  return key;
}

function fingerprint(publicKey) {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

function parseRegistryApp(entry) {
  assertExactKeys(
    entry,
    [
      "id",
      "directory",
      "displayName",
      "keyId",
      "algorithm",
      "publicKeyPem",
      "fingerprintSha256",
    ],
    "BONNI_APP_REGISTRY_ENTRY_INVALID",
  );
  if (typeof entry.id !== "string" || !APP_ID.test(entry.id) || RESERVED_APP_IDS.has(entry.id)) {
    fail("BONNI_APP_REGISTRY_ID_INVALID", String(entry.id || ""));
  }
  if (
    typeof entry.directory !== "string"
    || !APP_DIRECTORY.test(entry.directory)
    || appIdFromDirectory(entry.directory) !== entry.id
  ) fail("BONNI_APP_REGISTRY_DIRECTORY_INVALID", String(entry.directory || ""));
  if (
    typeof entry.displayName !== "string"
    || !entry.displayName.trim()
    || entry.displayName !== entry.displayName.trim()
    || entry.displayName !== entry.displayName.normalize("NFC")
    || Buffer.byteLength(entry.displayName, "utf8") > 128
    || /[\u0000-\u001f\u007f]/u.test(entry.displayName)
  ) fail("BONNI_APP_REGISTRY_DISPLAY_NAME_INVALID", entry.id);
  if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)) {
    fail("BONNI_APP_REGISTRY_KEY_ID_INVALID", entry.id);
  }
  if (entry.algorithm !== "Ed25519") fail("BONNI_APP_REGISTRY_ALGORITHM_INVALID", entry.id);
  const publicKey = parsePublicKey(entry.publicKeyPem, "BONNI_APP_REGISTRY_PUBLIC_KEY_INVALID");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprintSha256 = fingerprint(publicKey);
  if (
    typeof entry.fingerprintSha256 !== "string"
    || !SHA256.test(entry.fingerprintSha256)
    || entry.fingerprintSha256 !== fingerprintSha256
  ) fail("BONNI_APP_REGISTRY_FINGERPRINT_MISMATCH", entry.id);
  return Object.freeze({
    id: entry.id,
    directory: entry.directory,
    displayName: entry.displayName,
    keyId: entry.keyId,
    algorithm: "Ed25519",
    publicKeyPem,
    fingerprintSha256,
  });
}

export function parseBonniAppRegistry(raw) {
  assertExactKeys(
    raw,
    ["schema", "registryId", "sequence", "apps"],
    "BONNI_APP_REGISTRY_INVALID",
  );
  if (raw.schema !== BONNI_APP_REGISTRY_SCHEMA) {
    fail("BONNI_APP_REGISTRY_SCHEMA_UNSUPPORTED", String(raw.schema || ""));
  }
  if (typeof raw.registryId !== "string" || !REGISTRY_ID.test(raw.registryId)) {
    fail("BONNI_APP_REGISTRY_IDENTITY_INVALID");
  }
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
    fail("BONNI_APP_REGISTRY_SEQUENCE_INVALID");
  }
  if (!Array.isArray(raw.apps) || raw.apps.length > MAX_APP_COUNT) {
    fail("BONNI_APP_REGISTRY_APPS_INVALID");
  }
  const apps = raw.apps.map(parseRegistryApp);
  const ids = new Set();
  const directories = new Set();
  const keyIds = new Set();
  const fingerprints = new Set();
  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];
    if (index > 0 && bytewiseCompare(apps[index - 1].id, app.id) >= 0) {
      fail("BONNI_APP_REGISTRY_ORDER_INVALID", app.id);
    }
    if (ids.has(app.id)) fail("BONNI_APP_REGISTRY_ID_DUPLICATE", app.id);
    if (directories.has(app.directory)) {
      fail("BONNI_APP_REGISTRY_DIRECTORY_DUPLICATE", app.directory);
    }
    if (keyIds.has(app.keyId)) fail("BONNI_APP_REGISTRY_KEY_ID_DUPLICATE", app.keyId);
    if (fingerprints.has(app.fingerprintSha256)) {
      fail("BONNI_APP_REGISTRY_PUBLIC_KEY_REUSED", app.id);
    }
    ids.add(app.id);
    directories.add(app.directory);
    keyIds.add(app.keyId);
    fingerprints.add(app.fingerprintSha256);
  }
  return Object.freeze({
    schema: BONNI_APP_REGISTRY_SCHEMA,
    registryId: raw.registryId,
    sequence: raw.sequence,
    apps: Object.freeze(apps),
  });
}

export function createBonniAppRegistry({ registryId = "bonni-official", sequence, apps } = {}) {
  if (!Array.isArray(apps)) fail("BONNI_APP_REGISTRY_APPS_INVALID");
  const normalizedApps = apps.map((entry) => ({ ...entry }))
    .sort((left, right) => bytewiseCompare(String(left.id || ""), String(right.id || "")));
  return parseBonniAppRegistry({
    schema: BONNI_APP_REGISTRY_SCHEMA,
    registryId,
    sequence,
    apps: normalizedApps,
  });
}

export function serializeBonniAppRegistry(registry) {
  return Buffer.from(`${JSON.stringify(parseBonniAppRegistry(registry), null, 2)}\n`, "utf8");
}

export function createBonniAppRegistryBinding(registry, bytes) {
  const parsed = parseBonniAppRegistry(registry);
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (value.length < 2 || value.length > MAX_REGISTRY_BYTES) {
    fail("BONNI_APP_REGISTRY_FILE_SIZE_INVALID");
  }
  return Object.freeze({
    schema: BONNI_APP_REGISTRY_BINDING_SCHEMA,
    path: BONNI_APP_REGISTRY_PAYLOAD_PATH,
    registryId: parsed.registryId,
    sequence: parsed.sequence,
    sizeBytes: value.length,
    sha256: sha256(value),
  });
}

export function parseBonniAppRegistryBinding(raw) {
  assertExactKeys(
    raw,
    ["schema", "path", "registryId", "sequence", "sizeBytes", "sha256"],
    "BONNI_APP_REGISTRY_BINDING_INVALID",
  );
  if (
    raw.schema !== BONNI_APP_REGISTRY_BINDING_SCHEMA
    || raw.path !== BONNI_APP_REGISTRY_PAYLOAD_PATH
    || typeof raw.registryId !== "string"
    || !REGISTRY_ID.test(raw.registryId)
    || !Number.isSafeInteger(raw.sequence)
    || raw.sequence < 1
    || !Number.isSafeInteger(raw.sizeBytes)
    || raw.sizeBytes < 2
    || raw.sizeBytes > MAX_REGISTRY_BYTES
    || typeof raw.sha256 !== "string"
    || !SHA256.test(raw.sha256)
  ) fail("BONNI_APP_REGISTRY_BINDING_INVALID");
  return Object.freeze({ ...raw });
}

export function verifyBonniAppRegistryBinding(registry, bytes, binding) {
  const parsed = parseBonniAppRegistry(registry);
  const normalizedBinding = parseBonniAppRegistryBinding(binding);
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  let parsedFromBytes;
  try {
    const text = value.toString("utf8");
    if (!value.equals(Buffer.from(text, "utf8"))) fail("BONNI_APP_REGISTRY_BYTES_INVALID");
    parsedFromBytes = parseBonniAppRegistry(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof BonniAppRegistryError) throw cause;
    fail("BONNI_APP_REGISTRY_BYTES_INVALID", "", { cause });
  }
  if (
    JSON.stringify(parsed) !== JSON.stringify(parsedFromBytes)
    ||
    parsed.registryId !== normalizedBinding.registryId
    || parsed.sequence !== normalizedBinding.sequence
    || value.length !== normalizedBinding.sizeBytes
    || sha256(value) !== normalizedBinding.sha256
  ) fail("BONNI_APP_REGISTRY_BINDING_MISMATCH");
  return parsedFromBytes;
}

export async function readBonniAppRegistryFile(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    fail("BONNI_APP_REGISTRY_FILE_ABSOLUTE_REQUIRED");
  }
  const resolved = path.resolve(file);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    fail("BONNI_APP_REGISTRY_FILE_UNSAFE", resolved, { cause });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 2n
      || before.size > BigInt(MAX_REGISTRY_BYTES)
    ) fail("BONNI_APP_REGISTRY_FILE_UNSAFE", resolved);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== before.size
    ) fail("BONNI_APP_REGISTRY_FILE_CHANGED", resolved);
    let raw;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      fail("BONNI_APP_REGISTRY_JSON_INVALID", resolved, { cause });
    }
    return Object.freeze({ file: resolved, bytes, registry: parseBonniAppRegistry(raw) });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
