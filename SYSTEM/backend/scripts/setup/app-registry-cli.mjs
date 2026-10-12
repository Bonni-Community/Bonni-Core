#!/usr/bin/env node

import crypto, { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BONNI_APP_REGISTRY_FILE_NAME,
  BonniAppRegistryError,
  appDirectoryFromId,
  createBonniAppRegistry,
  readBonniAppRegistryFile,
  serializeBonniAppRegistry,
} from "./app-registry.mjs";

const COMMANDS = new Set(["register", "status", "list"]);
const APP_ID_INPUT = /^[A-Z][A-Z0-9._-]{1,63}$/u;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const DEFAULT_REGISTRY_ID = "bonni-official";
const APP_REGISTRY_LOCK_SCHEMA = "bonni.app-registry-lock/v1";
const APP_REGISTRY_LOCK_OWNER = /^[a-f0-9]{64}$/u;
const APP_REGISTRY_LOCK_MAX_BYTES = 4 * 1024;
export const APP_REGISTRY_LOCK_STALE_AFTER_MS = 1_000;
const PROCESS_STARTED_AT_MS = Math.max(
  1,
  Math.floor(Date.now() - (process.uptime() * 1_000)),
);

function fail(code, detail = "", options = undefined) {
  throw new BonniAppRegistryError(code, detail, options);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function registryPath(productRoot) {
  return path.join(productRoot, "SIGNATUR", "TRUST", BONNI_APP_REGISTRY_FILE_NAME);
}

function normalizeProductRoot(productRoot) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("BONNI_APP_REGISTRY_CLI_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  return path.resolve(productRoot);
}

function normalizeAppId(value) {
  if (typeof value !== "string" || !APP_ID_INPUT.test(value)) {
    fail("BONNI_APP_REGISTRY_CLI_APP_ID_INVALID");
  }
  return value;
}

function parsePublicKey(bytes) {
  const pem = bytes.toString("utf8");
  if (
    !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/u.test(pem)
    || /PRIVATE KEY/u.test(pem)
  ) fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_PEM_REQUIRED");
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch (cause) {
    fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_INVALID", "", { cause });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_NOT_ED25519");
  }
  const publicKeyPem = key.export({ type: "spki", format: "pem" }).toString();
  const fingerprintSha256 = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  return Object.freeze({ publicKeyPem, fingerprintSha256 });
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code);
}

async function ensureRegistryDirectory(productRoot) {
  await assertPlainDirectory(productRoot, "BONNI_APP_REGISTRY_CLI_PRODUCT_ROOT_UNSAFE");
  let current = productRoot;
  for (const segment of ["SIGNATUR", "TRUST"]) {
    current = path.join(current, segment);
    const state = await lstatOrNull(current);
    if (!state) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (cause) {
        if (cause?.code !== "EEXIST") throw cause;
      }
    }
    await assertPlainDirectory(current, "BONNI_APP_REGISTRY_CLI_DIRECTORY_UNSAFE");
  }
  return current;
}

async function inspectRegistryDirectory(productRoot) {
  await assertPlainDirectory(productRoot, "BONNI_APP_REGISTRY_CLI_PRODUCT_ROOT_UNSAFE");
  let current = productRoot;
  for (const segment of ["SIGNATUR", "TRUST"]) {
    current = path.join(current, segment);
    const state = await lstatOrNull(current);
    if (!state) return null;
    if (!state.isDirectory() || state.isSymbolicLink()) {
      fail("BONNI_APP_REGISTRY_CLI_DIRECTORY_UNSAFE");
    }
  }
  return current;
}

async function readPublicKeyFile(file) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_FILE_UNSAFE", "", { cause });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(MAX_PUBLIC_KEY_BYTES)
    ) fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_FILE_UNSAFE");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== before.size
    ) fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_FILE_CHANGED");
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRegistryIfPresent(file) {
  const state = await lstatOrNull(file);
  if (!state) return null;
  return readBonniAppRegistryFile(file);
}

function createRegistryLockRecord() {
  const createdAtMs = Date.now();
  return Object.freeze({
    schema: APP_REGISTRY_LOCK_SCHEMA,
    ownerId: crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    processStartedAtMs: Math.min(PROCESS_STARTED_AT_MS, createdAtMs),
    createdAtMs,
  });
}

function parseRegistryLockRecord(bytes, state) {
  const source = bytes.toString("utf8");
  const legacy = /^([1-9][0-9]{0,9})\r?\n?$/u.exec(source);
  if (legacy) {
    const pid = Number.parseInt(legacy[1], 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      return Object.freeze({
        schema: "legacy-pid/v0",
        ownerId: null,
        pid,
        processStartedAtMs: null,
        createdAtMs: Math.floor(state.mtimeMs),
      });
    }
  }

  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !raw
    || typeof raw !== "object"
    || Array.isArray(raw)
    || Object.keys(raw).sort().join("\0")
      !== ["schema", "ownerId", "pid", "processStartedAtMs", "createdAtMs"].sort().join("\0")
    || raw.schema !== APP_REGISTRY_LOCK_SCHEMA
    || typeof raw.ownerId !== "string"
    || !APP_REGISTRY_LOCK_OWNER.test(raw.ownerId)
    || !Number.isSafeInteger(raw.pid)
    || raw.pid < 1
    || !Number.isSafeInteger(raw.processStartedAtMs)
    || raw.processStartedAtMs < 1
    || !Number.isSafeInteger(raw.createdAtMs)
    || raw.createdAtMs < 1
    || raw.processStartedAtMs > raw.createdAtMs
  ) return null;
  return Object.freeze({
    schema: raw.schema,
    ownerId: raw.ownerId,
    pid: raw.pid,
    processStartedAtMs: raw.processStartedAtMs,
    createdAtMs: raw.createdAtMs,
  });
}

function sameLockIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
  );
}

async function inspectRegistryLock(lockFile) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(lockFile, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    if (cause?.code === "ELOOP") fail("BONNI_APP_REGISTRY_CLI_LOCK_UNSAFE");
    throw cause;
  }
  try {
    const pathState = await fs.lstat(lockFile, { bigint: true });
    const before = await handle.stat({ bigint: true });
    if (
      pathState.isSymbolicLink()
      || !pathState.isFile()
      || !before.isFile()
      || pathState.nlink < 1n
      || pathState.nlink > 2n
      || before.nlink !== pathState.nlink
      || !sameLockIdentity(pathState, before)
      || before.size < 1n
      || before.size > BigInt(APP_REGISTRY_LOCK_MAX_BYTES)
    ) fail("BONNI_APP_REGISTRY_CLI_LOCK_UNSAFE");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameLockIdentity(before, after)
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== before.size
    ) fail("BONNI_APP_REGISTRY_CLI_LOCK_CHANGED");
    const state = Object.freeze({
      dev: before.dev,
      ino: before.ino,
      mtimeMs: Number(before.mtimeMs),
    });
    const record = parseRegistryLockRecord(bytes, state);
    if (!record) fail("BONNI_APP_REGISTRY_CLI_LOCK_INVALID");
    return Object.freeze({ lockFile, state, record });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isSameRegistryLock(left, right) {
  return Boolean(
    left
    && right
    && sameLockIdentity(left.state, right.state)
    && left.record.schema === right.record.schema
    && left.record.ownerId === right.record.ownerId
    && left.record.pid === right.record.pid
    && left.record.processStartedAtMs === right.record.processStartedAtMs
    && left.record.createdAtMs === right.record.createdAtMs
  );
}

function registryLockProcessIsAlive(record) {
  if (
    record.pid === process.pid
    && Number.isSafeInteger(record.processStartedAtMs)
    && Math.abs(record.processStartedAtMs - PROCESS_STARTED_AT_MS) > 5_000
  ) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (cause) {
    if (cause?.code === "ESRCH") return false;
    return true;
  }
}

function registryLockIsStale(lock, now = Date.now()) {
  const newestTimestamp = Math.max(lock.state.mtimeMs, lock.record.createdAtMs);
  const ageMs = now - newestTimestamp;
  if (!Number.isFinite(ageMs) || ageMs < APP_REGISTRY_LOCK_STALE_AFTER_MS) return false;
  return !registryLockProcessIsAlive(lock.record);
}

async function unlinkRegistryLockIfMatching(expected) {
  const current = await inspectRegistryLock(expected.lockFile);
  if (!current || !isSameRegistryLock(expected, current)) return false;
  try {
    await fs.unlink(expected.lockFile);
    return true;
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

async function unlinkRegistryLockCandidateIfMatching(lock) {
  if (!lock.record.ownerId) return;
  const candidate = `${lock.lockFile}.${lock.record.ownerId}.candidate`;
  const remaining = await inspectRegistryLock(candidate);
  if (remaining && isSameRegistryLock({ ...lock, lockFile: candidate }, remaining)) {
    await unlinkRegistryLockIfMatching(remaining);
  }
}

async function createOwnedRegistryLock(lockFile) {
  const record = createRegistryLockRecord();
  const candidate = `${lockFile}.${record.ownerId}.candidate`;
  let handle;
  let state;
  let published = false;
  try {
    handle = await fs.open(candidate, "wx", 0o600);
    const created = await handle.stat({ bigint: true });
    state = Object.freeze({
      dev: created.dev,
      ino: created.ino,
      mtimeMs: Number(created.mtimeMs),
    });
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    state = Object.freeze({
      dev: written.dev,
      ino: written.ino,
      mtimeMs: Number(written.mtimeMs),
    });
    await handle.close();
    handle = undefined;
    await fs.link(candidate, lockFile);
    published = true;
    await fs.unlink(candidate).catch((cause) => {
      if (cause?.code !== "ENOENT") throw cause;
    });
    const observed = await inspectRegistryLock(lockFile);
    if (
      !observed
      || !isSameRegistryLock({ lockFile, state, record }, observed)
    ) fail("BONNI_APP_REGISTRY_CLI_LOCK_OWNERSHIP_LOST");
    return Object.freeze({ lockFile, state: observed.state, record });
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    if (published && state) {
      await unlinkRegistryLockIfMatching({ lockFile, state, record }).catch(() => undefined);
    }
    await fs.unlink(candidate).catch((cleanupCause) => {
      if (cleanupCause?.code !== "ENOENT") throw cleanupCause;
    });
    throw cause;
  }
}

async function acquireRecoveryGuard(lockFile) {
  const recoveryFile = `${lockFile}.recovery`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createOwnedRegistryLock(recoveryFile);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
    }
    const observed = await inspectRegistryLock(recoveryFile);
    if (!observed) continue;
    if (!registryLockIsStale(observed)) fail("BONNI_APP_REGISTRY_CLI_BUSY");
    await unlinkRegistryLockIfMatching(observed);
  }
  fail("BONNI_APP_REGISTRY_CLI_BUSY");
}

async function releaseOwnedRegistryLock(lock) {
  const released = await unlinkRegistryLockIfMatching(lock);
  if (!released) fail("BONNI_APP_REGISTRY_CLI_LOCK_OWNERSHIP_LOST");
  await unlinkRegistryLockCandidateIfMatching(lock);
}

async function recoverStaleRegistryLock(observed) {
  const guard = await acquireRecoveryGuard(observed.lockFile);
  try {
    const current = await inspectRegistryLock(observed.lockFile);
    if (!current) return true;
    if (!isSameRegistryLock(observed, current) || !registryLockIsStale(current)) return false;
    const recovered = await unlinkRegistryLockIfMatching(current);
    if (recovered) await unlinkRegistryLockCandidateIfMatching(current);
    return recovered;
  } finally {
    await releaseOwnedRegistryLock(guard);
  }
}

async function acquireRegistryLock(directory) {
  const lockFile = path.join(directory, `${BONNI_APP_REGISTRY_FILE_NAME}.lock`);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return Object.freeze({ directory, ...(await createOwnedRegistryLock(lockFile)) });
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
    }
    const observed = await inspectRegistryLock(lockFile);
    if (!observed) continue;
    if (!registryLockIsStale(observed)) fail("BONNI_APP_REGISTRY_CLI_BUSY");
    if (await recoverStaleRegistryLock(observed)) continue;
  }
  fail("BONNI_APP_REGISTRY_CLI_BUSY");
}

async function releaseRegistryLock(lock) {
  await releaseOwnedRegistryLock(lock);
}

async function writeRegistryAtomically(file, bytes, directory) {
  const suffix = crypto.randomBytes(16).toString("hex");
  const temporary = path.join(directory, `.${BONNI_APP_REGISTRY_FILE_NAME}.${suffix}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((cause) => {
      if (cause?.code !== "ENOENT") throw cause;
    });
  }
}

function publicApp(entry) {
  return Object.freeze({
    id: entry.id,
    directory: entry.directory,
    displayName: entry.displayName,
    keyId: entry.keyId,
    algorithm: entry.algorithm,
    publicKeyPem: entry.publicKeyPem,
    fingerprintSha256: entry.fingerprintSha256,
  });
}

export function parseAppRegistryCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || !COMMANDS.has(argv[0])) {
    fail("BONNI_APP_REGISTRY_CLI_ARGUMENT_INVALID");
  }
  const command = argv[0];
  const allowed = new Set(["--product-root", "--app-id", "--public-key"]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--") || values.has(flag)) {
      fail("BONNI_APP_REGISTRY_CLI_ARGUMENT_INVALID");
    }
    values.set(flag, value);
    index += 1;
  }
  const productRoot = values.get("--product-root") || "";
  if (!path.isAbsolute(productRoot)) {
    fail("BONNI_APP_REGISTRY_CLI_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  if (command === "register") {
    if (values.size !== 3 || !values.has("--app-id") || !values.has("--public-key")) {
      fail("BONNI_APP_REGISTRY_CLI_ARGUMENT_INVALID");
    }
    if (!path.isAbsolute(values.get("--public-key"))) {
      fail("BONNI_APP_REGISTRY_CLI_PUBLIC_KEY_PATH_ABSOLUTE_REQUIRED");
    }
  } else if (values.size !== 1) {
    fail("BONNI_APP_REGISTRY_CLI_ARGUMENT_INVALID");
  }
  return Object.freeze({
    command,
    productRoot: path.resolve(productRoot),
    appId: command === "register" ? normalizeAppId(values.get("--app-id")) : "",
    publicKeyFile: command === "register" ? path.resolve(values.get("--public-key")) : "",
  });
}

export async function getAppRegistryStatus({ productRoot }) {
  const normalizedRoot = normalizeProductRoot(productRoot);
  const file = registryPath(normalizedRoot);
  const directory = await inspectRegistryDirectory(normalizedRoot);
  if (!directory) {
    return Object.freeze({
      exists: false,
      registryFile: file,
      registryId: DEFAULT_REGISTRY_ID,
      sequence: 0,
      appCount: 0,
    });
  }
  const observed = await readRegistryIfPresent(file);
  if (!observed) {
    return Object.freeze({
      exists: false,
      registryFile: file,
      registryId: DEFAULT_REGISTRY_ID,
      sequence: 0,
      appCount: 0,
    });
  }
  return Object.freeze({
    exists: true,
    registryFile: observed.file,
    registryId: observed.registry.registryId,
    sequence: observed.registry.sequence,
    appCount: observed.registry.apps.length,
  });
}

export async function listRegisteredApps({ productRoot }) {
  const status = await getAppRegistryStatus({ productRoot });
  if (!status.exists) return Object.freeze({ ...status, apps: Object.freeze([]) });
  const observed = await readBonniAppRegistryFile(status.registryFile);
  return Object.freeze({
    ...status,
    apps: Object.freeze(observed.registry.apps.map(publicApp)),
  });
}

export async function registerApp({ productRoot, appId, publicKeyFile }) {
  const normalizedRoot = normalizeProductRoot(productRoot);
  const normalizedId = normalizeAppId(appId);
  const directory = appDirectoryFromId(normalizedId);
  const keyId = `bonni-app-${directory}-01`;
  const publicIdentity = parsePublicKey(await readPublicKeyFile(publicKeyFile));
  const trustDirectory = await ensureRegistryDirectory(normalizedRoot);
  const file = registryPath(normalizedRoot);
  const lock = await acquireRegistryLock(trustDirectory);
  try {
    const observed = await readRegistryIfPresent(file);
    const existing = observed?.registry.apps.find((entry) => entry.id === normalizedId);
    if (existing) {
      if (
        existing.directory !== directory
        || existing.keyId !== keyId
        || existing.publicKeyPem !== publicIdentity.publicKeyPem
        || existing.fingerprintSha256 !== publicIdentity.fingerprintSha256
      ) fail("BONNI_APP_REGISTRY_CLI_KEY_CHANGE_NOT_ALLOWED");
      return Object.freeze({
        registered: false,
        unchanged: true,
        registryFile: file,
        registryId: observed.registry.registryId,
        sequence: observed.registry.sequence,
        app: publicApp(existing),
      });
    }

    const entry = Object.freeze({
      id: normalizedId,
      directory,
      displayName: normalizedId,
      keyId,
      algorithm: "Ed25519",
      publicKeyPem: publicIdentity.publicKeyPem,
      fingerprintSha256: publicIdentity.fingerprintSha256,
    });
    const registry = createBonniAppRegistry({
      registryId: observed?.registry.registryId || DEFAULT_REGISTRY_ID,
      sequence: observed ? observed.registry.sequence + 1 : 1,
      apps: [...(observed?.registry.apps || []), entry].sort((left, right) => (
        bytewiseCompare(left.id, right.id)
      )),
    });
    const bytes = serializeBonniAppRegistry(registry);
    await writeRegistryAtomically(file, bytes, trustDirectory);
    const verified = await readBonniAppRegistryFile(file);
    if (!verified.bytes.equals(bytes)) fail("BONNI_APP_REGISTRY_CLI_WRITEBACK_MISMATCH");
    return Object.freeze({
      registered: true,
      unchanged: false,
      registryFile: file,
      registryId: registry.registryId,
      sequence: registry.sequence,
      app: publicApp(entry),
    });
  } finally {
    await releaseRegistryLock(lock);
  }
}

export async function runAppRegistryCli(argv = process.argv.slice(2)) {
  const options = parseAppRegistryCliArguments(argv);
  if (options.command === "status") {
    return getAppRegistryStatus(options);
  }
  if (options.command === "list") {
    return listRegisteredApps(options);
  }
  return registerApp(options);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runAppRegistryCli().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    const code = typeof error?.code === "string"
      && /^BONNI_APP_REGISTRY(?:_CLI)?_[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : "BONNI_APP_REGISTRY_CLI_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 44;
  });
}
