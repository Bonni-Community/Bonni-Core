import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { parseEd25519SpkiPublicKey } from "../../src/system/update-runner/trusted-keys.mjs";
import { verifyUpdatePackageAuthenticity } from "./update-package-manifest.mjs";

export const UPDATE_PUBLIC_TRUST_SCHEMA = "bonni.public-trust/v1";
export const UPDATE_SEQUENCE_SCHEMA = "bonni.update-sequence/v1";
export const UPDATE_SEQUENCE_COMMIT_OWNER_SCHEMA = "bonni.update-sequence-commit-owner/v1";

const TRUST_RELATIVE_PATH = path.join("RUN_INSTALL", "trust", "UPDATE-PUBLIC-TRUST.json");
const SEQUENCE_RELATIVE_PATH = path.join("RUN_INSTALL", "trust", "UPDATE-SEQUENCE.json");
const SEQUENCE_LOCK_RELATIVE_PATH = path.join("RUN_INSTALL", "trust", ".UPDATE-SEQUENCE.commit-lock");
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const STORE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const TRUST_SCOPE = /^(?:offline-root|release-set|component:(?:SYSTEM|WINDOWS|LINUX|CONTAINER)|app:[a-z0-9][a-z0-9._-]{1,63})$/u;
const SCOPE_MAP = Object.freeze({
  "release-set": "RELEASE",
  "component:SYSTEM": "SYSTEM",
  "component:WINDOWS": "WINDOWS",
  "component:LINUX": "LINUX",
  "component:CONTAINER": "CONTAINER",
});

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
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifestScopeForTrustScope(scope) {
  const componentScope = SCOPE_MAP[scope];
  if (componentScope) return componentScope;
  if (scope.startsWith("app:")) return `APP:${scope.slice("app:".length).toUpperCase()}`;
  return null;
}

export class UpdatePackageTrustError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "UpdatePackageTrustError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new UpdatePackageTrustError(code, detail);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("UPDATE_TRUST_OBJECT_INVALID", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UPDATE_TRUST_FIELD_UNKNOWN", `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("UPDATE_TRUST_FIELD_MISSING", `${label}.${key}`);
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

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function assertNotGroupOrWorldWritable(state, code, detail) {
  if (process.platform !== "win32" && (Number(state.mode) & 0o022) !== 0) fail(code, detail);
}

async function assertPlainTrustPath(productRoot) {
  let cursor = productRoot;
  let realProductRoot = null;
  for (const [index, segment] of [null, "RUN_INSTALL", "trust"].entries()) {
    if (segment) cursor = path.join(cursor, segment);
    const state = await fs.lstat(cursor).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) fail(index === 0 ? "UPDATE_TRUST_PRODUCT_ROOT_MISSING" : "UPDATE_TRUST_DIRECTORY_MISSING", cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) fail("UPDATE_TRUST_DIRECTORY_UNSAFE", cursor);
    const real = await fs.realpath(cursor);
    if (index === 0) realProductRoot = real;
    const expectedReal = index === 0
      ? realProductRoot
      : path.join(realProductRoot, ...["RUN_INSTALL", "trust"].slice(0, index));
    const sameRealPath = process.platform === "win32"
      ? path.resolve(real).toLowerCase() === path.resolve(expectedReal).toLowerCase()
      : path.resolve(real) === path.resolve(expectedReal);
    if (!sameRealPath) fail("UPDATE_TRUST_DIRECTORY_UNSAFE", cursor);
    assertNotGroupOrWorldWritable(state, "UPDATE_TRUST_DIRECTORY_WRITABLE", cursor);
  }
  return cursor;
}

async function readSecureJson(file, missingCode, unsafeCode, invalidCode) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ENOENT") fail(missingCode, file);
    fail(unsafeCode, file);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size <= 0n
      || before.size > BigInt(4 * 1024 * 1024)
    ) fail(unsafeCode, file);
    assertNotGroupOrWorldWritable(before, unsafeCode, file);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(bytes.length) !== before.size) fail(unsafeCode, file);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof UpdatePackageTrustError) throw error;
    fail(invalidCode, file);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function publicKeyFingerprint(publicKey) {
  return crypto.createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function parseUpdatePublicTrust(raw) {
  assertExactKeys(
    raw,
    new Set(["schema", "storeId", "createdAt", "keys"]),
    new Set(["schema", "storeId", "createdAt", "keys"]),
    "trust",
  );
  if (raw.schema !== UPDATE_PUBLIC_TRUST_SCHEMA) fail("UPDATE_TRUST_SCHEMA_UNSUPPORTED");
  if (typeof raw.storeId !== "string" || !STORE_ID.test(raw.storeId)) {
    fail("UPDATE_TRUST_STORE_ID_INVALID");
  }
  const createdAt = canonicalTimestamp(raw.createdAt, "UPDATE_TRUST_CREATED_AT_INVALID");
  if (!Array.isArray(raw.keys) || raw.keys.length < 2 || raw.keys.length > 128) {
    fail("UPDATE_TRUST_KEYS_INVALID");
  }

  const trustedKeys = Object.create(null);
  const seenKeyIds = new Set();
  const seenScopes = new Set();
  const seenFingerprints = new Set();
  const normalizedKeys = [];
  for (let index = 0; index < raw.keys.length; index += 1) {
    const entry = raw.keys[index];
    const label = `trust.keys[${index}]`;
    assertExactKeys(
      entry,
      new Set(["keyId", "scope", "algorithm", "publicKeyPem", "fingerprintSha256"]),
      new Set(["keyId", "scope", "algorithm", "publicKeyPem", "fingerprintSha256"]),
      label,
    );
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId) || seenKeyIds.has(entry.keyId)) {
      fail("UPDATE_TRUST_KEY_ID_INVALID", String(entry.keyId || ""));
    }
    if (typeof entry.scope !== "string" || !TRUST_SCOPE.test(entry.scope)) {
      fail("UPDATE_TRUST_SCOPE_INVALID", String(entry.scope || ""));
    }
    if (entry.algorithm !== "Ed25519") fail("UPDATE_TRUST_ALGORITHM_INVALID", entry.keyId);
    let publicKey;
    try {
      publicKey = parseEd25519SpkiPublicKey(entry.publicKeyPem);
    } catch {
      fail("UPDATE_TRUST_PUBLIC_KEY_INVALID", entry.keyId);
    }
    const fingerprintSha256 = publicKeyFingerprint(publicKey);
    if (!SHA256_HEX.test(entry.fingerprintSha256 || "") || entry.fingerprintSha256 !== fingerprintSha256) {
      fail("UPDATE_TRUST_FINGERPRINT_MISMATCH", entry.keyId);
    }
    if (seenFingerprints.has(fingerprintSha256)) {
      fail("UPDATE_TRUST_PUBLIC_KEY_REUSED_ACROSS_SCOPES", entry.keyId);
    }
    seenKeyIds.add(entry.keyId);
    seenScopes.add(entry.scope);
    seenFingerprints.add(fingerprintSha256);
    normalizedKeys.push({ ...entry });
    const updateScope = manifestScopeForTrustScope(entry.scope);
    if (updateScope) {
      trustedKeys[entry.keyId] = { publicKey: entry.publicKeyPem, scopes: [updateScope] };
    }
  }
  if (!seenScopes.has("offline-root")) fail("UPDATE_TRUST_OFFLINE_ROOT_KEY_MISSING");
  if (!seenScopes.has("release-set")) fail("UPDATE_TRUST_RELEASE_KEY_MISSING");
  return {
    schema: UPDATE_PUBLIC_TRUST_SCHEMA,
    storeId: raw.storeId,
    createdAt,
    keys: normalizedKeys,
    trustedKeys,
  };
}

function parseSequenceState(raw, storeId) {
  assertExactKeys(
    raw,
    new Set(["schema", "storeId", "lastAcceptedReleaseSequence", "updateId", "acceptedAt"]),
    new Set(["schema", "storeId", "lastAcceptedReleaseSequence", "updateId", "acceptedAt"]),
    "sequence",
  );
  if (raw.schema !== UPDATE_SEQUENCE_SCHEMA) fail("UPDATE_SEQUENCE_SCHEMA_UNSUPPORTED");
  if (raw.storeId !== storeId) fail("UPDATE_SEQUENCE_TRUST_STORE_MISMATCH");
  if (!Number.isSafeInteger(raw.lastAcceptedReleaseSequence) || raw.lastAcceptedReleaseSequence < 0) {
    fail("UPDATE_SEQUENCE_VALUE_INVALID");
  }
  if (typeof raw.updateId !== "string" || !UPDATE_ID.test(raw.updateId)) {
    fail("UPDATE_SEQUENCE_UPDATE_ID_INVALID");
  }
  canonicalTimestamp(raw.acceptedAt, "UPDATE_SEQUENCE_ACCEPTED_AT_INVALID");
  return raw;
}

export async function loadProductionUpdateVerificationPolicy(productRoot) {
  if (typeof productRoot !== "string" || !productRoot) fail("UPDATE_TRUST_PRODUCT_ROOT_REQUIRED");
  const resolvedProductRoot = path.resolve(productRoot);
  await assertPlainTrustPath(resolvedProductRoot);
  const trustFile = path.join(resolvedProductRoot, TRUST_RELATIVE_PATH);
  const rawTrust = await readSecureJson(
    trustFile,
    "UPDATE_TRUST_NOT_INITIALIZED",
    "UPDATE_TRUST_FILE_UNSAFE",
    "UPDATE_TRUST_JSON_INVALID",
  );
  const trust = parseUpdatePublicTrust(rawTrust);
  const sequenceFile = path.join(resolvedProductRoot, SEQUENCE_RELATIVE_PATH);
  const sequenceState = await fs.lstat(sequenceFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  let lastAcceptedReleaseSequence = 0;
  let acceptedSequenceState = null;
  if (sequenceState) {
    const rawSequence = await readSecureJson(
      sequenceFile,
      "UPDATE_SEQUENCE_MISSING",
      "UPDATE_SEQUENCE_FILE_UNSAFE",
      "UPDATE_SEQUENCE_JSON_INVALID",
    );
    acceptedSequenceState = parseSequenceState(rawSequence, trust.storeId);
    lastAcceptedReleaseSequence = acceptedSequenceState.lastAcceptedReleaseSequence;
  }
  return {
    verificationMode: "production",
    packageSource: "local",
    trustedKeys: trust.trustedKeys,
    lastAcceptedReleaseSequence,
    trustStoreId: trust.storeId,
    trustFile,
    sequenceFile,
    acceptedSequenceState,
  };
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sequenceCommitOwnerIdentity(owner) {
  return sha256(stableStringify({
    schema: UPDATE_SEQUENCE_COMMIT_OWNER_SCHEMA,
    storeId: owner.storeId,
    releaseSequence: owner.releaseSequence,
    updateId: owner.updateId,
    manifestSha256: owner.manifestSha256,
  }));
}

function parseSequenceCommitOwner(raw) {
  assertExactKeys(
    raw,
    new Set([
      "schema",
      "ownerId",
      "storeId",
      "releaseSequence",
      "updateId",
      "manifestSha256",
      "acceptedAt",
    ]),
    new Set([
      "schema",
      "ownerId",
      "storeId",
      "releaseSequence",
      "updateId",
      "manifestSha256",
      "acceptedAt",
    ]),
    "sequenceCommitOwner",
  );
  if (raw.schema !== UPDATE_SEQUENCE_COMMIT_OWNER_SCHEMA) {
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_SCHEMA_UNSUPPORTED");
  }
  if (typeof raw.storeId !== "string" || !STORE_ID.test(raw.storeId)) {
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_STORE_ID_INVALID");
  }
  if (!Number.isSafeInteger(raw.releaseSequence) || raw.releaseSequence < 1) {
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_SEQUENCE_INVALID");
  }
  if (typeof raw.updateId !== "string" || !UPDATE_ID.test(raw.updateId)) {
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_UPDATE_ID_INVALID");
  }
  if (typeof raw.manifestSha256 !== "string" || !SHA256_HEX.test(raw.manifestSha256)) {
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_MANIFEST_HASH_INVALID");
  }
  canonicalTimestamp(raw.acceptedAt, "UPDATE_SEQUENCE_COMMIT_OWNER_ACCEPTED_AT_INVALID");
  if (
    typeof raw.ownerId !== "string"
    || !SHA256_HEX.test(raw.ownerId)
    || raw.ownerId !== sequenceCommitOwnerIdentity(raw)
  ) fail("UPDATE_SEQUENCE_COMMIT_OWNER_ID_INVALID");
  return { ...raw };
}

function createSequenceCommitOwner({ policy, manifest, releaseSequence, updateId, acceptedAt }) {
  const owner = {
    schema: UPDATE_SEQUENCE_COMMIT_OWNER_SCHEMA,
    ownerId: "",
    storeId: policy.trustStoreId,
    releaseSequence,
    updateId,
    manifestSha256: sha256(stableStringify(manifest)),
    acceptedAt,
  };
  owner.ownerId = sequenceCommitOwnerIdentity(owner);
  return owner;
}

async function readSequenceCommitOwner(lockRoot) {
  const lockState = await fs.lstat(lockRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!lockState) return null;
  if (!lockState.isDirectory() || lockState.isSymbolicLink()) {
    fail("UPDATE_SEQUENCE_COMMIT_LOCKED", lockRoot);
  }
  assertNotGroupOrWorldWritable(lockState, "UPDATE_SEQUENCE_COMMIT_LOCKED", lockRoot);
  try {
    const entries = await fs.readdir(lockRoot, { withFileTypes: true });
    if (
      entries.length !== 1
      || entries[0].name !== "OWNER.json"
      || !entries[0].isFile()
      || entries[0].isSymbolicLink()
    ) fail("UPDATE_SEQUENCE_COMMIT_LOCKED", lockRoot);
    const raw = await readSecureJson(
      path.join(lockRoot, "OWNER.json"),
      "UPDATE_SEQUENCE_COMMIT_OWNER_MISSING",
      "UPDATE_SEQUENCE_COMMIT_OWNER_UNSAFE",
      "UPDATE_SEQUENCE_COMMIT_OWNER_JSON_INVALID",
    );
    return parseSequenceCommitOwner(raw);
  } catch (error) {
    if (error instanceof UpdatePackageTrustError && error.code === "UPDATE_SEQUENCE_COMMIT_LOCKED") {
      throw error;
    }
    fail("UPDATE_SEQUENCE_COMMIT_LOCKED", lockRoot);
  }
}

async function writeSequenceCommitOwnerDirectory(directory, owner) {
  await fs.mkdir(directory, { mode: 0o700 });
  const handle = await fs.open(path.join(directory, "OWNER.json"), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

async function publishOrRecoverSequenceCommitLock(productRoot, proposedOwner) {
  const trustDirectory = await assertPlainTrustPath(productRoot);
  const lockRoot = path.join(productRoot, SEQUENCE_LOCK_RELATIVE_PATH);
  const stageRoot = path.join(
    trustDirectory,
    `.UPDATE-SEQUENCE.owner-${proposedOwner.ownerId}-${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    await writeSequenceCommitOwnerDirectory(stageRoot, proposedOwner);
    const existingBeforePublish = await fs.lstat(lockRoot).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existingBeforePublish) {
      const existingOwner = await readSequenceCommitOwner(lockRoot);
      if (!existingOwner || existingOwner.ownerId !== proposedOwner.ownerId) {
        fail("UPDATE_SEQUENCE_COMMIT_LOCKED", lockRoot);
      }
      return { lockRoot, owner: existingOwner, recovered: true };
    }
    try {
      // A complete non-empty owner directory is published atomically. Another
      // compliant writer can only race by publishing another non-empty owner
      // directory, which rename cannot replace on POSIX or Windows.
      await fs.rename(stageRoot, lockRoot);
      published = true;
      await syncDirectory(trustDirectory);
      return { lockRoot, owner: proposedOwner, recovered: false };
    } catch (error) {
      const existingState = await fs.lstat(lockRoot).catch((stateError) => {
        if (stateError?.code === "ENOENT") return null;
        throw stateError;
      });
      if (!existingState) throw error;
      const existingOwner = await readSequenceCommitOwner(lockRoot);
      if (!existingOwner || existingOwner.ownerId !== proposedOwner.ownerId) {
        fail("UPDATE_SEQUENCE_COMMIT_LOCKED", lockRoot);
      }
      return { lockRoot, owner: existingOwner, recovered: true };
    }
  } finally {
    if (!published) await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function releaseSequenceCommitLock(lockRoot, expectedOwner) {
  const observedOwner = await readSequenceCommitOwner(lockRoot);
  if (!observedOwner) return false;
  if (observedOwner.ownerId !== expectedOwner.ownerId) {
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_CHANGED", lockRoot);
  }
  const trustDirectory = path.dirname(lockRoot);
  const retiredRoot = path.join(
    trustDirectory,
    `.UPDATE-SEQUENCE.completed-${expectedOwner.ownerId}-${crypto.randomBytes(12).toString("hex")}`,
  );
  try {
    await fs.rename(lockRoot, retiredRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const retiredOwner = await readSequenceCommitOwner(retiredRoot);
  if (!retiredOwner || retiredOwner.ownerId !== expectedOwner.ownerId) {
    const activeState = await fs.lstat(lockRoot).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!activeState) await fs.rename(retiredRoot, lockRoot).catch(() => undefined);
    fail("UPDATE_SEQUENCE_COMMIT_OWNER_CHANGED", lockRoot);
  }
  await syncDirectory(trustDirectory);
  await fs.rm(retiredRoot, { recursive: true });
  await syncDirectory(trustDirectory);
  return true;
}

function authenticateSequenceManifest(manifest, policy) {
  const signed = manifest?.schema === "bonni.update/v2" ? manifest.signed : null;
  if (!signed || signed.channel !== "stable" || !Number.isSafeInteger(signed.releaseSequence)) {
    fail("UPDATE_SEQUENCE_MANIFEST_INVALID");
  }
  if (signed.releaseSequence < policy.lastAcceptedReleaseSequence) {
    fail("UPDATE_SEQUENCE_NOT_INCREASING");
  }
  const verificationLastSequence = signed.releaseSequence === policy.lastAcceptedReleaseSequence
    ? Math.max(0, policy.lastAcceptedReleaseSequence - 1)
    : policy.lastAcceptedReleaseSequence;
  const authenticated = verifyUpdatePackageAuthenticity(manifest, {
    verificationMode: "production",
    trustedKeys: policy.trustedKeys,
    lastAcceptedReleaseSequence: verificationLastSequence,
  });
  if (authenticated.authenticated !== true) fail("UPDATE_SEQUENCE_MANIFEST_NOT_AUTHENTICATED");
  if (
    signed.releaseSequence === policy.lastAcceptedReleaseSequence
    && policy.acceptedSequenceState?.updateId !== signed.updateId
  ) fail("UPDATE_SEQUENCE_IDENTITY_CONFLICT");
  return authenticated;
}

/**
 * Persists the anti-rollback floor after, and only after, the caller has made
 * the verified READY transaction the durable live system. Preparation and
 * READY publication deliberately never call this function. The function
 * authenticates the complete manifest again and is idempotent for recovery
 * after a successful write whose acknowledgement was lost.
 */
export async function recordAcceptedUpdateSequence({
  productRoot,
  manifest,
  now = () => new Date(),
  _testHooks = {},
} = {}) {
  if (typeof productRoot !== "string" || !productRoot) fail("UPDATE_TRUST_PRODUCT_ROOT_REQUIRED");
  if (!isPlainObject(_testHooks)) fail("UPDATE_SEQUENCE_TEST_HOOKS_INVALID");
  for (const hook of ["afterLockPublished", "afterSequencePublished"]) {
    if (Object.hasOwn(_testHooks, hook) && typeof _testHooks[hook] !== "function") {
      fail("UPDATE_SEQUENCE_TEST_HOOKS_INVALID", hook);
    }
  }
  const resolvedProductRoot = path.resolve(productRoot);
  const initialPolicy = await loadProductionUpdateVerificationPolicy(resolvedProductRoot);
  const initialAuthentication = authenticateSequenceManifest(manifest, initialPolicy);
  const { signed } = initialAuthentication.manifest;
  if (signed.releaseSequence === initialPolicy.lastAcceptedReleaseSequence) {
    const existingLock = await fs.lstat(path.join(resolvedProductRoot, SEQUENCE_LOCK_RELATIVE_PATH))
      .catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
    if (!existingLock) return initialPolicy.acceptedSequenceState;
  }
  const proposedAcceptedAt = now().toISOString();
  canonicalTimestamp(proposedAcceptedAt, "UPDATE_SEQUENCE_ACCEPTED_AT_INVALID");
  const proposedOwner = createSequenceCommitOwner({
    policy: initialPolicy,
    manifest: initialAuthentication.manifest,
    releaseSequence: signed.releaseSequence,
    updateId: signed.updateId,
    acceptedAt: proposedAcceptedAt,
  });
  const lock = await publishOrRecoverSequenceCommitLock(resolvedProductRoot, proposedOwner);
  await _testHooks.afterLockPublished?.({ ...lock });

  const policy = await loadProductionUpdateVerificationPolicy(resolvedProductRoot);
  if (policy.trustStoreId !== lock.owner.storeId) {
    fail("UPDATE_SEQUENCE_COMMIT_TRUST_STORE_CHANGED");
  }
  const authenticated = authenticateSequenceManifest(manifest, policy);
  if (sha256(stableStringify(authenticated.manifest)) !== lock.owner.manifestSha256) {
    fail("UPDATE_SEQUENCE_COMMIT_MANIFEST_CHANGED");
  }
  if (
    authenticated.manifest.signed.releaseSequence !== lock.owner.releaseSequence
    || authenticated.manifest.signed.updateId !== lock.owner.updateId
  ) fail("UPDATE_SEQUENCE_COMMIT_IDENTITY_CHANGED");

  if (signed.releaseSequence === policy.lastAcceptedReleaseSequence) {
    const existingState = policy.acceptedSequenceState;
    await releaseSequenceCommitLock(lock.lockRoot, lock.owner);
    return existingState;
  }

  const state = {
    schema: UPDATE_SEQUENCE_SCHEMA,
    storeId: policy.trustStoreId,
    lastAcceptedReleaseSequence: signed.releaseSequence,
    updateId: signed.updateId,
    acceptedAt: lock.owner.acceptedAt,
  };
  const parent = path.dirname(policy.sequenceFile);
  const temporary = path.join(parent, `.UPDATE-SEQUENCE.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    await fs.rename(temporary, policy.sequenceFile);
    await syncDirectory(parent);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await _testHooks.afterSequencePublished?.({ lockRoot: lock.lockRoot, owner: lock.owner, state });
  await releaseSequenceCommitLock(lock.lockRoot, lock.owner);
  return state;
}

export const updateTrustPaths = Object.freeze({
  trustRelativePath: TRUST_RELATIVE_PATH.replaceAll("\\", "/"),
  sequenceRelativePath: SEQUENCE_RELATIVE_PATH.replaceAll("\\", "/"),
  sequenceLockRelativePath: SEQUENCE_LOCK_RELATIVE_PATH.replaceAll("\\", "/"),
});
