import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCKER_RUNTIME_ACTIVATION_SCHEMA = "bonni.docker-runtime-activation/v1";
export const DOCKER_RUNTIME_DEACTIVATION_SCHEMA = "bonni.docker-runtime-deactivation/v1";
export const LOCAL_HOST_BACKEND_RUNTIME_SCHEMA = "bonni.local-host-backend-runtime/v1";
const LOCAL_SUPERVISOR_HEARTBEAT_SCHEMA = "bonni.local-source-update-heartbeat/v1";
const MAX_RECEIPT_BYTES = 32 * 1024;
const ACTIVATION_FILE = "docker-runtime-activation.json";
const DEACTIVATION_FILE = "docker-runtime-deactivation.json";
const SUPERVISOR_LOCK_FILE = "supervisor.lock.json";
const CORE_CHILD_FILE = "core-child.json";
const HEARTBEAT_FILE = "heartbeat.json";
const UPDATE_COMMAND_LOCK_FILE = "update-command.lock";
const HOST_BACKEND_RUNTIME_FILE = "host-backend-runtime.json";
const HOST_BACKEND_RESTART_RECOVERY_FILE = "host-backend-runtime.restart-recovery.json";
const HOST_BACKEND_RESTART_RECOVERY_SCHEMA = "bonni.local-host-backend-restart-recovery/v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const WINDOWS_EVENT_RECORD_ID = /^(?:[1-9][0-9]{0,19})$/u;
const WINDOWS_KERNEL_GENERAL_PROVIDER_ID = "a68ca8b7-004f-d7b6-a698-07e2de0f1f5d";
const WINDOWS_KERNEL_BOOT_PROVIDER_ID = "15ca44ff-4d7a-4baa-bba5-0998955e531e";
const WINDOWS_EVENT_MACHINE_NAME = /^[^\u0000-\u001f\u007f]{1,255}$/u;
const WINDOWS_BOOT_EVENT_CLUSTER_MS = 15 * 1_000;
const HOST_BACKEND_BIND_SETTLE_ATTEMPTS = 200;
const HOST_BACKEND_BIND_SETTLE_DELAY_MS = 25;

function exclusionError(code, detail = "") {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function exactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateActivationReceipt(value) {
  const keys = ["schemaVersion", "pid", "token", "startedAt"];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== DOCKER_RUNTIME_ACTIVATION_SCHEMA
    || !validPid(value.pid)
    || typeof value.token !== "string" || !TOKEN.test(value.token)
    || !validTimestamp(value.startedAt)) {
    throw exclusionError("DOCKER_RUNTIME_ACTIVATION_RECEIPT_INVALID");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    pid: value.pid,
    token: value.token,
    startedAt: value.startedAt,
  });
}

function validateDeactivationReceipt(value) {
  const keys = ["schemaVersion", "pid", "token", "startedAt"];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== DOCKER_RUNTIME_DEACTIVATION_SCHEMA
    || !validPid(value.pid)
    || typeof value.token !== "string" || !TOKEN.test(value.token)
    || !validTimestamp(value.startedAt)) {
    throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_RECEIPT_INVALID");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    pid: value.pid,
    token: value.token,
    startedAt: value.startedAt,
  });
}

function validateUpdateCommandLock(value) {
  const keys = ["pid", "ownerToken", "createdAt"];
  if (!exactKeys(value, keys)
    || !validPid(value.pid)
    || typeof value.ownerToken !== "string" || !/^[a-f0-9]{64}$/u.test(value.ownerToken)
    || !validTimestamp(value.createdAt)) {
    throw exclusionError("LOCAL_SOURCE_UPDATE_COMMAND_LOCK_INVALID");
  }
  return Object.freeze(value);
}

function validateSetupProgress(value) {
  const keys = [
    "schemaVersion", "updateId", "status", "stage", "stageIndex",
    "stageCount", "message", "updatedAt",
  ];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== "bonni.local-source-update-setup-progress/v1"
    || typeof value.updateId !== "string" || !IDENTIFIER.test(value.updateId)
    || !["running", "completed", "failed"].includes(value.status)
    || typeof value.stage !== "string" || !IDENTIFIER.test(value.stage)
    || !Number.isSafeInteger(value.stageIndex) || value.stageIndex < 0
    || !Number.isSafeInteger(value.stageCount) || value.stageCount < 0
    || value.stageIndex > value.stageCount
    || typeof value.message !== "string" || value.message.length < 1 || value.message.length > 2_048
    || !validTimestamp(value.updatedAt)) {
    throw exclusionError("LOCAL_SOURCE_UPDATE_SETUP_PROGRESS_INVALID");
  }
  return Object.freeze(value);
}

function validateHostBackendRuntime(value) {
  const keys = ["schemaVersion", "pid", "childPid", "token", "entry", "startedAt"];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== LOCAL_HOST_BACKEND_RUNTIME_SCHEMA
    || !validPid(value.pid)
    || !(value.childPid === null || validPid(value.childPid))
    || typeof value.token !== "string" || !TOKEN.test(value.token)
    || typeof value.entry !== "string" || !IDENTIFIER.test(value.entry)
    || !validTimestamp(value.startedAt)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_RECEIPT_INVALID");
  }
  return Object.freeze(value);
}

function validateHostBackendRestartRecovery(value) {
  const keys = [
    "schemaVersion", "receiptPid", "receiptToken", "receiptEntry",
    "receiptStartedAt", "armedBootRecordId", "armedBootTime",
    "armedBootProviderId", "armedBootMachineName", "armedAt",
  ];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== HOST_BACKEND_RESTART_RECOVERY_SCHEMA
    || !validPid(value.receiptPid)
    || typeof value.receiptToken !== "string" || !TOKEN.test(value.receiptToken)
    || value.receiptEntry !== "start"
    || !validTimestamp(value.receiptStartedAt)
    || typeof value.armedBootRecordId !== "string"
    || !WINDOWS_EVENT_RECORD_ID.test(value.armedBootRecordId)
    || !validTimestamp(value.armedBootTime)
    || value.armedBootProviderId !== WINDOWS_KERNEL_GENERAL_PROVIDER_ID
    || typeof value.armedBootMachineName !== "string"
    || !WINDOWS_EVENT_MACHINE_NAME.test(value.armedBootMachineName)
    || !validTimestamp(value.armedAt)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RESTART_RECOVERY_INVALID");
  }
  return Object.freeze(value);
}

function validWindowsBootEvent(value, expectedProviderId = WINDOWS_KERNEL_GENERAL_PROVIDER_ID) {
  return exactKeys(value, ["recordId", "timeCreated", "providerId", "machineName"])
    && typeof value.recordId === "string"
    && WINDOWS_EVENT_RECORD_ID.test(value.recordId)
    && validTimestamp(value.timeCreated)
    && value.providerId === expectedProviderId
    && typeof value.machineName === "string"
    && WINDOWS_EVENT_MACHINE_NAME.test(value.machineName);
}

function validWindowsBootEvidence(value) {
  if (!exactKeys(value, [
    "recordId", "timeCreated", "providerId", "machineName", "bootType",
    "bootEvent", "uptimeConsistent", "recentEvents",
  ])
    || !validWindowsBootEvent({
      recordId: value?.recordId,
      timeCreated: value?.timeCreated,
      providerId: value?.providerId,
      machineName: value?.machineName,
    })
    || !Array.isArray(value.recentEvents)
    || value.recentEvents.length < 1 || value.recentEvents.length > 16
    || !value.recentEvents.every((event) => validWindowsBootEvent(event))
    || value.recentEvents[0].recordId !== value.recordId
    || value.recentEvents[0].timeCreated !== value.timeCreated
    || value.recentEvents[0].providerId !== value.providerId
    || value.recentEvents[0].machineName !== value.machineName
    || typeof value.bootType !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value.bootType)
    || !validWindowsBootEvent(value.bootEvent, WINDOWS_KERNEL_BOOT_PROVIDER_ID)
    || value.bootEvent.machineName !== value.machineName
    || Math.abs(Date.parse(value.bootEvent.timeCreated) - Date.parse(value.timeCreated))
      > WINDOWS_BOOT_EVENT_CLUSTER_MS
    || typeof value.uptimeConsistent !== "boolean") return false;
  return new Set(value.recentEvents.map(
    (event) => `${event.recordId}\0${event.timeCreated}\0${event.providerId}\0${event.machineName}`,
  )).size === value.recentEvents.length;
}

function validateSupervisorLock(value) {
  const keys = ["pid", "instanceId", "startedAt"];
  if (!exactKeys(value, keys)
    || !validPid(value.pid)
    || typeof value.instanceId !== "string" || !IDENTIFIER.test(value.instanceId)
    || !validTimestamp(value.startedAt)) {
    throw exclusionError("LOCAL_SOURCE_SUPERVISOR_LOCK_INVALID");
  }
  return Object.freeze(value);
}

function validateCoreChild(value) {
  const keys = ["pid", "supervisorInstanceId", "startedAt"];
  if (!exactKeys(value, keys)
    || !validPid(value.pid)
    || typeof value.supervisorInstanceId !== "string" || !IDENTIFIER.test(value.supervisorInstanceId)
    || !validTimestamp(value.startedAt)) {
    throw exclusionError("LOCAL_SOURCE_CORE_RECEIPT_INVALID");
  }
  return Object.freeze(value);
}

function validateHeartbeat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== LOCAL_SUPERVISOR_HEARTBEAT_SCHEMA
    || !validPid(value.pid)
    || typeof value.instanceId !== "string" || !IDENTIFIER.test(value.instanceId)
    || typeof value.available !== "boolean"
    || !validTimestamp(value.updatedAt)) {
    throw exclusionError("LOCAL_SOURCE_SUPERVISOR_HEARTBEAT_INVALID");
  }
  return Object.freeze(value);
}

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function permittedHostBackendFromEnvironment(environment = process.env) {
  const pid = Number(environment?.BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID || 0);
  const token = String(environment?.BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN || "");
  return validPid(pid) && TOKEN.test(token) ? Object.freeze({ pid, token }) : null;
}

function parsePort(value, fallback, label) {
  const selected = value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(selected) || selected < 1 || selected > 65_535) {
    throw exclusionError("LOCAL_SOURCE_RUNTIME_PORT_INVALID", label);
  }
  return selected;
}

function defaultProbePort(port, timeoutMs = 750) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (error, open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(
      exclusionError("LOCAL_SOURCE_RUNTIME_PORT_PROBE_INDETERMINATE", String(port)),
    ));
    socket.once("connect", () => finish(null, true));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED") finish(null, false);
      else finish(exclusionError(
        "LOCAL_SOURCE_RUNTIME_PORT_PROBE_INDETERMINATE",
        `${port}:${error?.code || "unknown"}`,
      ));
    });
  });
}

async function ensureRealDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw exclusionError("LOCAL_SOURCE_RUNTIME_CONTROL_ROOT_INVALID", directory);
  }
}

export async function assertNoWindowsStartRepairTransaction({ productRoot } = {}) {
  const root = path.resolve(productRoot);
  if (root === path.parse(root).root) {
    throw exclusionError("WINDOWS_START_REPAIR_PRODUCT_ROOT_INVALID");
  }
  const rootState = await fs.lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw exclusionError("WINDOWS_START_REPAIR_PRODUCT_ROOT_INVALID");
  }
  const backupRoot = path.join(root, "BACKUP");
  const transactionRoot = path.join(backupRoot, ".bonni-windows-start-repair");
  for (const directory of [backupRoot, transactionRoot]) {
    const state = await fs.lstat(directory).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) return { ok: true, active: false };
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw exclusionError("WINDOWS_START_REPAIR_TRANSACTION_ROOT_UNSAFE", directory);
    }
  }
  const activeJournal = path.join(transactionRoot, "active.json");
  const active = await fs.lstat(activeJournal).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (active) {
    throw exclusionError("WINDOWS_START_REPAIR_TRANSACTION_ACTIVE");
  }
  return { ok: true, active: false };
}

export async function runtimeControlRoot(productRoot, { create = false } = {}) {
  const root = path.resolve(productRoot);
  if (root === path.parse(root).root) throw exclusionError("LOCAL_SOURCE_RUNTIME_PRODUCT_ROOT_INVALID");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw exclusionError("LOCAL_SOURCE_RUNTIME_PRODUCT_ROOT_INVALID");
  }
  // The repair installer replaces this module first and restores it last.
  // Consequently every mixed program tree remains fail-closed after a crash,
  // even while the older prestart gate is still installed.
  await assertNoWindowsStartRepairTransaction({ productRoot: root });
  const parts = ["SYSTEM", ".bonni-source-update", "control-center"];
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    current = path.join(current, part);
    if (create) {
      await ensureRealDirectory(current);
      continue;
    }
    const stat = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      for (const remaining of parts.slice(index + 1)) current = path.join(current, remaining);
      return current;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw exclusionError("LOCAL_SOURCE_RUNTIME_CONTROL_ROOT_INVALID", current);
    }
  }
  return current;
}

async function readReceipt(file, validator) {
  const handle = await fs.open(file, "r").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    const pathStat = await fs.lstat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES
      || pathStat.isSymbolicLink() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw exclusionError("LOCAL_SOURCE_RUNTIME_RECEIPT_INVALID", path.basename(file));
    }
    const parsed = JSON.parse(await handle.readFile("utf8"));
    return { value: validator(parsed), dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw exclusionError("LOCAL_SOURCE_RUNTIME_RECEIPT_INVALID", path.basename(file));
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function removeReceiptArtifact(file, observed, code) {
  const current = await fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current || current.isSymbolicLink()
    || current.dev !== observed.dev || current.ino !== observed.ino) {
    throw exclusionError(code, path.basename(file));
  }
  await fs.unlink(file);
}

async function readObservedSwapReceipt(file, observedState, validator, {
  allowStableInvalid = false,
} = {}) {
  if (!file || !observedState) {
    return Object.freeze({ receipt: null, changed: false, invalid: false });
  }
  try {
    const receipt = await readReceipt(file, validator);
    if (!receipt
      || receipt.dev !== observedState.dev
      || receipt.ino !== observedState.ino) {
      return Object.freeze({ receipt: null, changed: true, invalid: false });
    }
    return Object.freeze({ receipt, changed: false, invalid: false });
  } catch (error) {
    const current = await fs.lstat(file).catch((stateError) => {
      if (stateError?.code === "ENOENT") return null;
      throw stateError;
    });
    if (!current
      || current.dev !== observedState.dev
      || current.ino !== observedState.ino) {
      return Object.freeze({ receipt: null, changed: true, invalid: false });
    }
    if (allowStableInvalid) {
      return Object.freeze({ receipt: null, changed: false, invalid: true });
    }
    throw error;
  }
}

async function recoverHostBackendReceiptSwap(controlRoot, { isPidAlive = defaultPidAlive } = {}) {
  const file = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  const entries = await fs.readdir(controlRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const stagedNames = entries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(`${HOST_BACKEND_RUNTIME_FILE}.bind-staged-`));
  const previousNames = entries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(`${HOST_BACKEND_RUNTIME_FILE}.bind-previous-`));
  if (stagedNames.length > 1 || previousNames.length > 1) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_ARTIFACT_INVALID");
  }
  const stagedFile = stagedNames[0] ? path.join(controlRoot, stagedNames[0]) : null;
  const previousFile = previousNames[0] ? path.join(controlRoot, previousNames[0]) : null;
  const [canonicalState, stagedState, previousState] = await Promise.all(
    [file, stagedFile, previousFile].map((target) => target ? fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }) : null),
  );
  for (const [target, state] of [[file, canonicalState], [stagedFile, stagedState], [previousFile, previousState]]) {
    if (state && (!state.isFile() || state.isSymbolicLink())) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_ARTIFACT_INVALID", path.basename(target));
    }
  }
  if (!stagedState && !previousState) return;
  const [canonicalRead, stagedRead, previousRead] = await Promise.all([
    readObservedSwapReceipt(file, canonicalState, validateHostBackendRuntime),
    readObservedSwapReceipt(stagedFile, stagedState, validateHostBackendRuntime, {
      allowStableInvalid: true,
    }),
    readObservedSwapReceipt(previousFile, previousState, validateHostBackendRuntime),
  ]);
  if (canonicalRead.changed || stagedRead.changed || previousRead.changed) {
    return Object.freeze({ deferred: true, canonicalPresent: false });
  }
  const canonical = canonicalRead.receipt;
  const staged = stagedRead.receipt;
  const stagedInvalid = stagedRead.invalid;
  const previous = previousRead.receipt;
  const artifactToken = (name, marker) => name?.slice(name.indexOf(marker) + marker.length) || "";
  const stagedToken = artifactToken(stagedNames[0], ".bind-staged-");
  const previousToken = artifactToken(previousNames[0], ".bind-previous-");
  if ((stagedState && !TOKEN.test(stagedToken))
    || (previousState && !TOKEN.test(previousToken))) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_ARTIFACT_INVALID");
  }
  const sameOwner = (left, right) => left && right
    && left.value.pid === right.value.pid
    && left.value.token === right.value.token
    && left.value.entry === right.value.entry
    && left.value.startedAt === right.value.startedAt;

  // Readers can arrive while a live parent is updating childPid: first the
  // staged file is synced, then the canonical name is displaced for a very
  // short Windows rename window. No reader may consume a live transaction.
  // After it settles, the higher-level gate independently checks whether the
  // caller inherited the exact owner PID and secret token. Dead owners still
  // take the strict recovery path below.
  const artifactTokens = [
    stagedState ? stagedToken : null,
    previousState ? previousToken : null,
  ].filter(Boolean);
  const ownerReceipts = [canonical, staged, previous].filter(Boolean);
  const artifactOwner = ownerReceipts[0] || null;
  const artifactOwnerIsLive = artifactOwner
    && artifactTokens.length > 0
    && artifactTokens.every((token) => token === artifactOwner.value.token)
    && ownerReceipts.length > 0
    && ownerReceipts.every((receipt) => sameOwner(artifactOwner, receipt))
    && await Promise.resolve(isPidAlive(artifactOwner.value.pid));
  if (artifactOwnerIsLive) {
    return Object.freeze({ deferred: true, canonicalPresent: Boolean(canonical) });
  }

  if (previous) {
    if (previousToken !== previous.value.token || (stagedState && stagedToken !== previous.value.token)) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_RECOVERY_INVALID");
    }
    if (!canonical) {
      if ((!staged && !stagedInvalid) || (staged && !sameOwner(previous, staged))) {
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_RECOVERY_INVALID");
      }
      await fs.rename(previousFile, file);
      const restored = await readReceipt(file, validateHostBackendRuntime);
      if (!restored || restored.dev !== previous.dev || restored.ino !== previous.ino) {
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE");
      }
      await removeReceiptArtifact(stagedFile, staged || {
        dev: stagedState.dev, ino: stagedState.ino,
      }, "LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE");
      return Object.freeze({ deferred: false, canonicalPresent: true });
    }
    if (staged || !sameOwner(previous, canonical)) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_RECOVERY_INVALID");
    }
    await removeReceiptArtifact(
      previousFile,
      previous,
      "LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE",
    );
    return Object.freeze({ deferred: false, canonicalPresent: true });
  }
  if (!canonical || stagedToken !== canonical.value.token
    || (!stagedInvalid && (!staged || !sameOwner(canonical, staged)))) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_RECOVERY_INVALID");
  }
  await removeReceiptArtifact(
    stagedFile,
    staged || { dev: stagedState.dev, ino: stagedState.ino },
    "LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE",
  );
  return Object.freeze({ deferred: false, canonicalPresent: true });
}

async function readHostBackendRuntime(controlRoot, {
  isPidAlive = defaultPidAlive,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const file = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  for (let attempt = 0; attempt < HOST_BACKEND_BIND_SETTLE_ATTEMPTS; attempt += 1) {
    const recovery = await recoverHostBackendReceiptSwap(controlRoot, { isPidAlive });
    if (recovery?.deferred) {
      if (attempt === HOST_BACKEND_BIND_SETTLE_ATTEMPTS - 1) {
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_IN_PROGRESS");
      }
      await wait(HOST_BACKEND_BIND_SETTLE_DELAY_MS);
      continue;
    }
    let receipt = await readReceipt(file, validateHostBackendRuntime);
    if (!receipt) return null;
    const createPrefix = `${HOST_BACKEND_RUNTIME_FILE}.create-`;
    const entries = await fs.readdir(controlRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.name.startsWith(createPrefix) || !entry.name.endsWith(".tmp")) continue;
      const temporary = path.join(controlRoot, entry.name);
      const state = await fs.lstat(temporary);
      if (state.isFile() && !state.isSymbolicLink()
        && state.dev === receipt.dev && state.ino === receipt.ino) {
        await fs.unlink(temporary);
      }
    }
    receipt = await readReceipt(file, validateHostBackendRuntime);
    if (receipt) return receipt;
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE");
  }
  throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_IN_PROGRESS");
}

async function replaceHostBackendRuntimeReceipt({
  controlRoot,
  observed,
  updated,
  testHooks = {},
}) {
  const file = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  const stagedFile = `${file}.bind-staged-${observed.value.token}`;
  const previousFile = `${file}.bind-previous-${observed.value.token}`;
  await recoverHostBackendReceiptSwap(controlRoot);
  if (await fs.lstat(stagedFile).catch(() => null)
    || await fs.lstat(previousFile).catch(() => null)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_ARTIFACT_PRESENT");
  }
  const handle = await fs.open(stagedFile, "wx", 0o600);
  try {
    if (testHooks.afterBindStagedCreated) await testHooks.afterBindStagedCreated(stagedFile);
    await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    if (testHooks.afterBindStagedSynced) await testHooks.afterBindStagedSynced(stagedFile);
    const current = await readReceipt(file, validateHostBackendRuntime);
    if (!current || current.dev !== observed.dev || current.ino !== observed.ino
      || current.value.token !== observed.value.token) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_OWNERSHIP_LOST");
    }
    await fs.rename(file, previousFile);
    if (testHooks.afterBindOwnerDisplaced) await testHooks.afterBindOwnerDisplaced(previousFile);
    await fs.rename(stagedFile, file);
    if (testHooks.afterBindReplacementActivated) await testHooks.afterBindReplacementActivated(file);
    const installed = await readReceipt(file, validateHostBackendRuntime);
    if (!installed || installed.value.token !== updated.token
      || installed.value.pid !== updated.pid || installed.value.childPid !== updated.childPid) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_VERIFY_FAILED");
    }
    const previous = await readReceipt(previousFile, validateHostBackendRuntime);
    if (!previous || previous.dev !== observed.dev || previous.ino !== observed.ino) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE");
    }
    await removeReceiptArtifact(
      previousFile,
      previous,
      "LOCAL_HOST_BACKEND_RUNTIME_BIND_OWNER_RACE",
    );
    return installed;
  } catch (error) {
    await recoverHostBackendReceiptSwap(controlRoot).catch(() => undefined);
    throw error;
  }
}

async function removeExact(file, observed, ownerRaceCode = "DOCKER_RUNTIME_ACTIVATION_OWNER_RACE") {
  const current = await fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return true;
  if (current.isSymbolicLink() || current.dev !== observed.dev || current.ino !== observed.ino) return false;
  const moved = `${file}.stale-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.rename(file, moved);
  const movedStat = await fs.lstat(moved);
  if (movedStat.dev !== observed.dev || movedStat.ino !== observed.ino) {
    // Another owner replaced the pathname between the identity check and the
    // rename. Put that foreign receipt back when the canonical path is still
    // empty; otherwise preserve both receipts for diagnosis. Never delete it.
    // POSIX rename() would overwrite a third owner's newly-created canonical
    // receipt. Restore by hard-linking with no-clobber semantics instead. On
    // EEXIST both receipts are deliberately retained for diagnosis.
    let restored = false;
    try {
      await fs.link(moved, file);
      restored = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (restored) await fs.unlink(moved);
    throw exclusionError(ownerRaceCode);
  }
  await fs.rm(moved, { force: true });
  return true;
}

async function archiveExact(file, observed, ownerRaceCode, now = () => new Date()) {
  const current = await fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return null;
  if (current.isSymbolicLink() || current.dev !== observed.dev || current.ino !== observed.ino) {
    throw exclusionError(ownerRaceCode);
  }
  const timestamp = now().toISOString().replace(/[-:.]/gu, "");
  const moved = `${file}.stale-${timestamp}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.rename(file, moved);
  const movedStat = await fs.lstat(moved);
  if (movedStat.dev !== observed.dev || movedStat.ino !== observed.ino) {
    let restored = false;
    try {
      await fs.link(moved, file);
      restored = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (restored) await fs.unlink(moved);
    throw exclusionError(ownerRaceCode);
  }
  return moved;
}

export async function reconcileStaleLocalHostBackendRuntime({
  productRoot,
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
  deferUnboundToRestartRecovery = false,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
} = {}) {
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const file = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  const observed = await readHostBackendRuntime(controlRoot, { isPidAlive, wait });
  if (!observed) return Object.freeze({ reconciled: false, reason: "absent" });

  // On Windows only, the caller can route this one ambiguous spawn window to
  // the boot-evidence recovery before trusting a numeric PID. After a reboot
  // that PID may already belong to an unrelated process. The specialized
  // recovery still checks a live owner on the armed boot and ignores it only
  // after a full-restart proof.
  if (!observed.value.childPid && deferUnboundToRestartRecovery) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_STALE_UNBOUND", observed.value.entry);
  }
  for (const pid of [observed.value.pid, observed.value.childPid]) {
    if (pid && await Promise.resolve(isPidAlive(pid))) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ACTIVE", String(pid));
    }
  }
  // Ohne gebundene Child-PID könnte ein unmittelbar vor dem Bind abgestürzter
  // Wrapper einen noch startenden Waisenprozess hinterlassen haben. Dieser
  // seltene Zustand bleibt bewusst fail-closed und wird nicht automatisch
  // umbenannt.
  if (!observed.value.childPid) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_STALE_UNBOUND", observed.value.entry);
  }

  const ports = [...new Set([
    4_198,
    4_000,
    4_101,
    4_201,
    parsePort(environment.BONNI_INSTALLATION_MONITOR_PORT, 4_198, "monitor"),
    parsePort(environment.PORT, 4_000, "core"),
    // Der lokale Host-Core bindet standardmäßig 4101. Das prestart-Gate lädt
    // bewusst keine .env-Datei; deshalb muss bereits der Fallback dem echten
    // Host-Default entsprechen, damit ein verwaister Endpunkt nicht übersehen
    // und sein Laufzeitbeleg irrtümlich archiviert wird.
    parsePort(environment.LOCAL_AUTH_PORT, 4_101, "local-auth"),
    parsePort(environment.MODULE_MANAGER_PORT, 4_201, "module-manager"),
  ])];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const port of ports) {
      if (await probePort(port)) {
        throw exclusionError("LOCAL_SOURCE_RUNTIME_CORE_PORT_ACTIVE", String(port));
      }
    }
    if (pass === 0) await wait(250);
  }

  const rechecked = await readHostBackendRuntime(controlRoot, { isPidAlive, wait });
  if (!rechecked) return Object.freeze({ reconciled: false, reason: "already-reconciled" });
  if (
    rechecked.dev !== observed.dev
    || rechecked.ino !== observed.ino
    || rechecked.value.token !== observed.value.token
  ) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_RECONCILE_RACE");
  }
  for (const pid of [rechecked.value.pid, rechecked.value.childPid]) {
    if (pid && await Promise.resolve(isPidAlive(pid))) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ACTIVE", String(pid));
    }
  }
  const archivedPath = await archiveExact(
    file,
    rechecked,
    "LOCAL_HOST_BACKEND_RUNTIME_RECONCILE_RACE",
    now,
  );
  return Object.freeze({
    reconciled: Boolean(archivedPath),
    reason: archivedPath ? "stale-archived" : "already-reconciled",
    archivedPath,
    entry: rechecked.value.entry,
  });
}

async function createHostBackendRestartRecoveryIntent({
  file,
  receipt,
  bootEvidence,
  now,
}) {
  const value = {
    schemaVersion: HOST_BACKEND_RESTART_RECOVERY_SCHEMA,
    receiptPid: receipt.value.pid,
    receiptToken: receipt.value.token,
    receiptEntry: receipt.value.entry,
    receiptStartedAt: receipt.value.startedAt,
    armedBootRecordId: bootEvidence.recordId,
    armedBootTime: bootEvidence.timeCreated,
    armedBootProviderId: bootEvidence.providerId,
    armedBootMachineName: bootEvidence.machineName,
    armedAt: now().toISOString(),
  };
  const temporary = `${file}.create-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await fs.link(temporary, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  const created = await readReceipt(file, validateHostBackendRestartRecovery);
  if (!created
    || created.value.receiptPid !== value.receiptPid
    || created.value.receiptToken !== value.receiptToken
    || created.value.receiptStartedAt !== value.receiptStartedAt
    || created.value.armedBootRecordId !== value.armedBootRecordId
    || created.value.armedBootTime !== value.armedBootTime
    || created.value.armedBootProviderId !== value.armedBootProviderId
    || created.value.armedBootMachineName !== value.armedBootMachineName) {
    throw exclusionError("LOCAL_HOST_BACKEND_RESTART_RECOVERY_RACE");
  }
  return created;
}

function restartRecoveryMatchesReceipt(recovery, receipt) {
  return recovery.value.receiptPid === receipt.value.pid
    && recovery.value.receiptToken === receipt.value.token
    && recovery.value.receiptEntry === receipt.value.entry
    && recovery.value.receiptStartedAt === receipt.value.startedAt;
}

export async function reconcileStaleUnboundLocalHostBackendRuntimeAfterRestart({
  productRoot,
  bootEvidence,
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
} = {}) {
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const receiptFile = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  const recoveryFile = path.join(controlRoot, HOST_BACKEND_RESTART_RECOVERY_FILE);
  const [observed, existingRecovery] = await Promise.all([
    readHostBackendRuntime(controlRoot, { isPidAlive, wait }),
    readReceipt(recoveryFile, validateHostBackendRestartRecovery),
  ]);

  // A crash can happen after the runtime receipt was archived but before its
  // restart intent was archived. The intent has no runtime authority of its
  // own and can be closed idempotently when no receipt remains.
  if (!observed) {
    if (!existingRecovery) return Object.freeze({ reconciled: false, reason: "absent" });
    const archivedRecoveryPath = await archiveExact(
      recoveryFile,
      existingRecovery,
      "LOCAL_HOST_BACKEND_RESTART_RECOVERY_RACE",
      now,
    );
    return Object.freeze({
      reconciled: false,
      reason: "orphan-recovery-archived",
      archivedRecoveryPath,
    });
  }
  if (!validWindowsBootEvidence(bootEvidence)) {
    throw exclusionError("LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_INVALID");
  }
  if (observed.value.childPid !== null) {
    if (existingRecovery) {
      throw exclusionError("LOCAL_HOST_BACKEND_RESTART_RECOVERY_RECEIPT_MISMATCH");
    }
    return Object.freeze({ reconciled: false, reason: "receipt-bound" });
  }
  if (observed.value.entry !== "start") {
    return Object.freeze({ reconciled: false, reason: "unsupported-entry" });
  }
  if (!existingRecovery && await Promise.resolve(isPidAlive(observed.value.pid))) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ACTIVE", String(observed.value.pid));
  }

  const recovery = existingRecovery || await createHostBackendRestartRecoveryIntent({
    file: recoveryFile,
    receipt: observed,
    bootEvidence,
    now,
  });
  if (!restartRecoveryMatchesReceipt(recovery, observed)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RESTART_RECOVERY_RECEIPT_MISMATCH");
  }
  const sameBootEvent = recovery.value.armedBootRecordId === bootEvidence.recordId
    && recovery.value.armedBootTime === bootEvidence.timeCreated
    && recovery.value.armedBootProviderId === bootEvidence.providerId
    && recovery.value.armedBootMachineName === bootEvidence.machineName;
  if (sameBootEvent) {
    if (await Promise.resolve(isPidAlive(observed.value.pid))) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ACTIVE", String(observed.value.pid));
    }
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_RESTART_REQUIRED", observed.value.entry);
  }
  // Both immutable fields must move together. A partial change points to an
  // event-log replacement or malformed evidence and must never unlock.
  if (recovery.value.armedBootRecordId === bootEvidence.recordId
    || recovery.value.armedBootTime === bootEvidence.timeCreated
    || recovery.value.armedBootProviderId !== bootEvidence.providerId) {
    throw exclusionError("LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_MISMATCH");
  }
  if (BigInt(bootEvidence.recordId) <= BigInt(recovery.value.armedBootRecordId)) {
    throw exclusionError("LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_NOT_NEWER");
  }
  const armedBootEventStillPresent = bootEvidence.recentEvents.some(
    (event) => event.recordId === recovery.value.armedBootRecordId
      && event.timeCreated === recovery.value.armedBootTime
      && event.providerId === recovery.value.armedBootProviderId
      && event.machineName === recovery.value.armedBootMachineName,
  );
  if (!armedBootEventStillPresent) {
    throw exclusionError("LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_ANCHOR_MISSING");
  }
  if (bootEvidence.bootType !== "0" || bootEvidence.uptimeConsistent !== true) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_RESTART_REQUIRED", "full-restart");
  }

  // Kernel-General event 12 identifies the current OS start. The reader binds
  // it to the OS uptime, and the changed-event path above accepts only the
  // Kernel-Boot full-restart type. Together they prove that an unrecorded child
  // from the old spawn window cannot still be alive. Ports are still checked
  // twice, including every immutable RUN slot.
  const ports = [...new Set([
    4_198,
    4_000,
    4_100,
    4_101,
    4_201,
    4_300,
    4_301,
    4_302,
    4_400,
    4_401,
    4_402,
    parsePort(environment.BONNI_INSTALLATION_MONITOR_PORT, 4_198, "monitor"),
    parsePort(environment.PORT, 4_000, "core"),
    parsePort(environment.LOCAL_AUTH_PORT, 4_101, "local-auth"),
    parsePort(environment.MODULE_MANAGER_PORT, 4_201, "module-manager"),
    parsePort(environment.BONNI_LOCAL_RUN_PUBLIC_PORT, 4_000, "public"),
    parsePort(environment.BONNI_ACTIVE_INTERNAL_PORT, 4_100, "active"),
    parsePort(environment.BONNI_ACTIVE_LOCAL_AUTH_PORT, 4_101, "active-local-auth"),
    parsePort(environment.BONNI_CANDIDATE_INTERNAL_PORT, 4_300, "candidate"),
    parsePort(environment.BONNI_CANDIDATE_LOCAL_AUTH_PORT, 4_301, "candidate-local-auth"),
    4_302,
    parsePort(environment.BONNI_PREVIOUS_INTERNAL_PORT, 4_400, "previous"),
    parsePort(environment.BONNI_PREVIOUS_LOCAL_AUTH_PORT, 4_401, "previous-local-auth"),
    4_402,
  ])];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const port of ports) {
      if (await probePort(port)) {
        throw exclusionError("LOCAL_SOURCE_RUNTIME_CORE_PORT_ACTIVE", String(port));
      }
    }
    if (pass === 0) await wait(1_000);
  }

  const [rechecked, recheckedRecovery] = await Promise.all([
    readHostBackendRuntime(controlRoot, { isPidAlive, wait }),
    readReceipt(recoveryFile, validateHostBackendRestartRecovery),
  ]);
  if (!rechecked
    || rechecked.dev !== observed.dev || rechecked.ino !== observed.ino
    || rechecked.value.token !== observed.value.token
    || rechecked.value.childPid !== null
    || !recheckedRecovery
    || recheckedRecovery.dev !== recovery.dev || recheckedRecovery.ino !== recovery.ino
    || !restartRecoveryMatchesReceipt(recheckedRecovery, rechecked)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RESTART_RECOVERY_RACE");
  }
  const archivedPath = await archiveExact(
    receiptFile,
    rechecked,
    "LOCAL_HOST_BACKEND_RESTART_RECOVERY_RACE",
    now,
  );
  const archivedRecoveryPath = await archiveExact(
    recoveryFile,
    recheckedRecovery,
    "LOCAL_HOST_BACKEND_RESTART_RECOVERY_RACE",
    now,
  );
  return Object.freeze({
    reconciled: true,
    reason: "restart-proven-stale-archived",
    archivedPath,
    archivedRecoveryPath,
    entry: rechecked.value.entry,
  });
}

export async function assertNoLiveLocalSourceRuntime({
  productRoot,
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
  probeCoreWithoutReceipts = false,
  allowIncompleteLocalUpdate = false,
  permittedHostBackend = null,
} = {}) {
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const [lock, core, heartbeat, updateCommand] = await Promise.all([
    readReceipt(path.join(controlRoot, SUPERVISOR_LOCK_FILE), validateSupervisorLock),
    readReceipt(path.join(controlRoot, CORE_CHILD_FILE), validateCoreChild),
    readReceipt(path.join(controlRoot, HEARTBEAT_FILE), validateHeartbeat),
    readReceipt(path.join(controlRoot, UPDATE_COMMAND_LOCK_FILE), validateUpdateCommandLock),
  ]);
  const hostBackend = await readHostBackendRuntime(controlRoot, {
    isPidAlive,
  });
  if (updateCommand) {
    // A dead owner is crash evidence, not permission to switch modes: source
    // files may already be partially changed and must first be recovered by
    // the local update path.
    const ownerState = await Promise.resolve(isPidAlive(updateCommand.value.pid)) ? "live" : "stale";
    throw exclusionError("LOCAL_SOURCE_UPDATE_COMMAND_PRESENT", ownerState);
  }
  const sourceStateRoot = path.dirname(controlRoot);
  if (!allowIncompleteLocalUpdate) {
    for (const evidencePath of [
      path.join(sourceStateRoot, "pending-update.json"),
      path.join(controlRoot, "request.json"),
      path.join(controlRoot, "request.processing.json"),
    ]) {
      const evidence = await fs.lstat(evidencePath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (evidence) {
        throw exclusionError("LOCAL_SOURCE_UPDATE_INCOMPLETE", path.basename(evidencePath));
      }
    }
    const setupProgress = await readReceipt(
      path.join(controlRoot, "setup-progress.json"),
      validateSetupProgress,
    );
    if (setupProgress && setupProgress.value.status !== "completed") {
      throw exclusionError("LOCAL_SOURCE_UPDATE_INCOMPLETE", "setup-progress.json");
    }
    const workRoot = path.join(path.resolve(productRoot), "UPDATE", ".bonni-work");
    const workState = await fs.lstat(workRoot).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (workState) {
      if (!workState.isDirectory() || workState.isSymbolicLink()) {
        throw exclusionError("LOCAL_SOURCE_UPDATE_INCOMPLETE", "work-root-invalid");
      }
      const workEntries = await fs.readdir(workRoot);
      if (workEntries.length) throw exclusionError("LOCAL_SOURCE_UPDATE_INCOMPLETE", "work-journal");
    }
  }
  if (lock && heartbeat && lock.value.instanceId !== heartbeat.value.instanceId) {
    throw exclusionError("LOCAL_SOURCE_SUPERVISOR_RECEIPT_MISMATCH");
  }
  const expectedInstance = lock?.value.instanceId || heartbeat?.value.instanceId || null;
  if (core && expectedInstance && core.value.supervisorInstanceId !== expectedInstance) {
    throw exclusionError("LOCAL_SOURCE_CORE_RECEIPT_MISMATCH");
  }
  for (const evidence of [lock, heartbeat, core]) {
    if (evidence && await Promise.resolve(isPidAlive(evidence.value.pid))) {
      throw exclusionError("LOCAL_SOURCE_RUNTIME_ACTIVE", String(evidence.value.pid));
    }
  }
  if (hostBackend) {
    const permitted = permittedHostBackend
      && hostBackend.value.pid === permittedHostBackend.pid
      && hostBackend.value.token === permittedHostBackend.token;
    if (permitted) {
      if (!await Promise.resolve(isPidAlive(hostBackend.value.pid))) {
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_STALE", hostBackend.value.entry);
      }
    } else {
    let liveHostPid = false;
    for (const pid of [hostBackend.value.pid, hostBackend.value.childPid]) {
      if (pid && await Promise.resolve(isPidAlive(pid))) {
        liveHostPid = true;
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ACTIVE", String(pid));
      }
    }
    if (!liveHostPid) {
      // A wrapper may have died immediately after OS spawn but before it could
      // bind the child PID. The child can still initialize later with every
      // port currently closed, so Docker activation must never reap this
      // receipt. A new local host entry may recover it explicitly instead.
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_STALE", hostBackend.value.entry);
    }
    }
  }

  const monitorPort = parsePort(environment.BONNI_INSTALLATION_MONITOR_PORT, 4_198, "monitor");
  if (await probePort(monitorPort)) {
    throw exclusionError("LOCAL_SOURCE_RUNTIME_MONITOR_PORT_ACTIVE", String(monitorPort));
  }
  if (probeCoreWithoutReceipts || lock || heartbeat || core || hostBackend) {
    const corePorts = [
      parsePort(environment.PORT, 4_000, "core"),
      parsePort(environment.LOCAL_AUTH_PORT, 4_101, "local-auth"),
    ];
    for (const port of new Set(corePorts)) {
      if (await probePort(port)) {
        throw exclusionError("LOCAL_SOURCE_RUNTIME_CORE_PORT_ACTIVE", String(port));
      }
    }
    if (hostBackend) {
      const moduleManagerPort = parsePort(environment.MODULE_MANAGER_PORT, 4_201, "module-manager");
      if (await probePort(moduleManagerPort)) {
        throw exclusionError("LOCAL_SOURCE_RUNTIME_CORE_PORT_ACTIVE", String(moduleManagerPort));
      }
    }
  }
  return { ok: true, controlRoot };
}

export async function assertContainerRuntimeActivationInactive({
  productRoot,
  isPidAlive = defaultPidAlive,
  environment = process.env,
} = {}) {
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const deactivation = await readReceipt(
    path.join(controlRoot, DEACTIVATION_FILE),
    validateDeactivationReceipt,
  );
  if (deactivation) {
    if (await Promise.resolve(isPidAlive(deactivation.value.pid))) {
      throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_IN_PROGRESS", String(deactivation.value.pid));
    }
    throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_STALE", String(deactivation.value.pid));
  }
  const activation = await readReceipt(
    path.join(controlRoot, ACTIVATION_FILE),
    validateActivationReceipt,
  );
  if (activation) {
    if (await Promise.resolve(isPidAlive(activation.value.pid))) {
      throw exclusionError("DOCKER_RUNTIME_ACTIVATION_IN_PROGRESS", String(activation.value.pid));
    }
    // A dead owner's marker remains fail closed for the local supervisor. Only a
    // new runtime:start invocation may reconcile it after checking all local
    // Supervisor/Core evidence and loopback ports.
    throw exclusionError("DOCKER_RUNTIME_ACTIVATION_STALE", String(activation.value.pid));
  }
  const permittedHostBackend = permittedHostBackendFromEnvironment(environment);
  const hostBackend = await readHostBackendRuntime(controlRoot, {
    isPidAlive,
  });
  if (!hostBackend) return { ok: true };
  if (hostBackend.value.pid === permittedHostBackend?.pid
    && hostBackend.value.token === permittedHostBackend?.token
    && await Promise.resolve(isPidAlive(hostBackend.value.pid))) {
    return { ok: true, inheritedHostLease: true };
  }
  for (const pid of [hostBackend.value.pid, hostBackend.value.childPid]) {
    if (pid && await Promise.resolve(isPidAlive(pid))) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ACTIVE", String(pid));
    }
  }
  throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_STALE", hostBackend.value.entry);
}

// Descriptive alias for runtime-gate callers. The generic name lets the local
// source Supervisor preserve its strict no-container-orchestration dependency.
export const assertDockerRuntimeActivationInactive = assertContainerRuntimeActivationInactive;

export async function acquireLocalHostBackendRuntimeLease({
  productRoot,
  entry,
  ownerPid = process.pid,
  initialChildPid = null,
  now = () => new Date(),
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
  testHooks = {},
} = {}) {
  if (!validPid(ownerPid)) throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_PID_INVALID");
  if (!(initialChildPid === null || validPid(initialChildPid))) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_CHILD_PID_INVALID");
  }
  if (typeof entry !== "string" || !IDENTIFIER.test(entry)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ENTRY_INVALID");
  }
  const allowIncompleteLocalUpdate = entry === "start"
    && String(environment.NODE_ENV || "").trim().toLowerCase() !== "production";
  await assertContainerRuntimeActivationInactive({ productRoot, isPidAlive, environment });
  await assertNoLiveLocalSourceRuntime({
    productRoot,
    isPidAlive,
    probePort,
    environment,
    probeCoreWithoutReceipts: true,
    allowIncompleteLocalUpdate,
  });
  const controlRoot = await runtimeControlRoot(productRoot, { create: true });
  const file = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const receipt = {
      schemaVersion: LOCAL_HOST_BACKEND_RUNTIME_SCHEMA,
      pid: ownerPid,
      childPid: initialChildPid,
      token: crypto.randomBytes(32).toString("base64url"),
      entry,
      startedAt: now().toISOString(),
    };
    let temporary = null;
    try {
      temporary = `${file}.create-${ownerPid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
      const createHandle = await fs.open(temporary, "wx", 0o600);
      try {
        if (testHooks.afterCreateTemporaryOpened) {
          await testHooks.afterCreateTemporaryOpened(temporary);
        }
        await createHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        await createHandle.sync();
      } finally {
        await createHandle.close().catch(() => undefined);
      }
      if (testHooks.afterCreateTemporarySynced) {
        await testHooks.afterCreateTemporarySynced(temporary);
      }
      await fs.link(temporary, file);
      if (testHooks.afterCreateCanonicalLinked) {
        await testHooks.afterCreateCanonicalLinked(file);
      }
      await fs.unlink(temporary);
      temporary = null;
      const created = await readHostBackendRuntime(controlRoot, { isPidAlive });
      if (!created || created.value.token !== receipt.token
        || created.value.pid !== ownerPid || created.value.childPid !== initialChildPid) {
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_CREATE_VERIFY_FAILED");
      }
      const leaseEnvironment = {
        ...environment,
        BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID: String(ownerPid),
        BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN: receipt.token,
      };
      await assertContainerRuntimeActivationInactive({
        productRoot,
        isPidAlive,
        environment: leaseEnvironment,
      });
      await assertNoLiveLocalSourceRuntime({
        productRoot,
        isPidAlive,
        probePort,
        environment,
        probeCoreWithoutReceipts: true,
        allowIncompleteLocalUpdate,
        permittedHostBackend: { pid: ownerPid, token: receipt.token },
      });
      let released = false;
      const bindChildPid = async (childPid) => {
        if (released || !validPid(childPid)) {
          throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_CHILD_PID_INVALID");
        }
        const current = await readHostBackendRuntime(controlRoot, { isPidAlive });
        if (!current || current.value.token !== receipt.token
          || current.value.pid !== ownerPid) {
          throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_OWNERSHIP_LOST");
        }
        receipt.childPid = childPid;
        await replaceHostBackendRuntimeReceipt({
          controlRoot,
          observed: current,
          updated: receipt,
          testHooks,
        });
      };
      const release = async () => {
        if (released) return true;
        released = true;
        const current = await readHostBackendRuntime(controlRoot, { isPidAlive });
        if (!current || current.value.token !== receipt.token
          || current.value.pid !== ownerPid) {
          throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_OWNERSHIP_LOST");
        }
        return removeExact(file, current, "LOCAL_HOST_BACKEND_RUNTIME_OWNER_RACE");
      };
      return Object.freeze({
        token: receipt.token,
        bindChildPid,
        release,
      });
    } catch (error) {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
      const current = await readHostBackendRuntime(controlRoot, { isPidAlive }).catch(() => null);
      if (current && current.value.token === receipt.token && current.value.pid === ownerPid) {
        await removeExact(file, current, "LOCAL_HOST_BACKEND_RUNTIME_OWNER_RACE").catch(() => undefined);
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = await readHostBackendRuntime(controlRoot, { isPidAlive });
      if (!existing) continue;
      const live = await Promise.all(
        [existing.value.pid, existing.value.childPid]
          .filter(Boolean)
          .map((pid) => Promise.resolve(isPidAlive(pid))),
      );
      if (live.some(Boolean)) {
        throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_ALREADY_RUNNING");
      }
      // Never infer that a spawned child is gone from a momentary port probe.
      // In particular, an owner may have crashed between spawn() and the PID
      // bind while the orphan is still delayed before DB initialization.
      throw exclusionError(
        existing.value.childPid === null
          ? "LOCAL_HOST_BACKEND_RUNTIME_STALE_UNBOUND"
          : "LOCAL_HOST_BACKEND_RUNTIME_STALE",
      );
    }
  }
  throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_RACE");
}

export async function assertLocalHostBackendRuntimeLease({
  productRoot,
  ownerPid,
  token,
} = {}) {
  if (!validPid(ownerPid) || typeof token !== "string" || !TOKEN.test(token)) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_PROOF_INVALID");
  }
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const receipt = await readHostBackendRuntime(controlRoot);
  if (!receipt || receipt.value.pid !== ownerPid || receipt.value.token !== token) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_PROOF_NOT_OWNED");
  }
  return receipt.value;
}

export async function bindLocalHostBackendRuntimeChild({
  productRoot,
  ownerPid,
  token,
  childPid,
} = {}) {
  if (!validPid(childPid)) throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_CHILD_PID_INVALID");
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const observed = await readHostBackendRuntime(controlRoot);
  if (!observed || observed.value.pid !== ownerPid || observed.value.token !== token) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_PROOF_NOT_OWNED");
  }
  const updated = { ...observed.value, childPid };
  await replaceHostBackendRuntimeReceipt({ controlRoot, observed, updated });
  return Object.freeze(updated);
}

export async function readDockerRuntimeDeactivationIntent({ productRoot } = {}) {
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  return (await readReceipt(
    path.join(controlRoot, DEACTIVATION_FILE),
    validateDeactivationReceipt,
  ))?.value || null;
}

async function assertNoDeactivationIntent(productRoot) {
  const intent = await readDockerRuntimeDeactivationIntent({ productRoot });
  if (intent) throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_PRESENT", String(intent.pid));
}

export async function acquireDockerRuntimeActivation({
  productRoot,
  ownerPid,
  now = () => new Date(),
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
} = {}) {
  if (!validPid(ownerPid)) throw exclusionError("DOCKER_RUNTIME_ACTIVATION_PID_INVALID");
  const controlRoot = await runtimeControlRoot(productRoot, { create: true });
  const file = path.join(controlRoot, ACTIVATION_FILE);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertNoDeactivationIntent(productRoot);
    const receipt = Object.freeze({
      schemaVersion: DOCKER_RUNTIME_ACTIVATION_SCHEMA,
      pid: ownerPid,
      token: crypto.randomBytes(32).toString("base64url"),
      startedAt: now().toISOString(),
    });
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await assertNoLiveLocalSourceRuntime({
          productRoot,
          isPidAlive,
          probePort,
          environment,
          probeCoreWithoutReceipts: true,
        });
        await assertNoDeactivationIntent(productRoot);
      } catch (error) {
        await releaseDockerRuntimeActivation({ productRoot, ownerPid, token: receipt.token }).catch(() => false);
        throw error;
      }
      return receipt;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error?.code !== "EEXIST") throw error;
      const existing = await readReceipt(file, validateActivationReceipt);
      if (!existing) continue;
      if (await Promise.resolve(isPidAlive(existing.value.pid))) {
        throw exclusionError("DOCKER_RUNTIME_ACTIVATION_ALREADY_RUNNING", String(existing.value.pid));
      }
      // A successful runtime deliberately leaves a dead-owner marker. Never
      // create an unmarked takeover gap here; an operator must use the fully
      // gated runtime:stop flow before starting the mode again.
      throw exclusionError("DOCKER_RUNTIME_ACTIVATION_STALE", String(existing.value.pid));
    }
  }
  throw exclusionError("DOCKER_RUNTIME_ACTIVATION_RACE");
}

export async function acquireDockerRuntimeDeactivationIntent({
  productRoot,
  ownerPid,
  now = () => new Date(),
  isPidAlive = defaultPidAlive,
} = {}) {
  if (!validPid(ownerPid)) throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_PID_INVALID");
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const activationFile = path.join(controlRoot, ACTIVATION_FILE);
  const activation = await readReceipt(activationFile, validateActivationReceipt);
  const file = path.join(controlRoot, DEACTIVATION_FILE);
  const initialIntent = await readReceipt(file, validateDeactivationReceipt);
  if (initialIntent && await Promise.resolve(isPidAlive(initialIntent.value.pid))) {
    throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_ALREADY_RUNNING", String(initialIntent.value.pid));
  }
  if (!activation) {
    if (!initialIntent) throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_RUNTIME_NOT_ACTIVE");
    // Crash recovery after activation removal: retain the dead owner's exact
    // deactivation receipt as the continuous fail-closed marker. The resumed
    // stop re-runs every private/Docker/port gate and finally releases this
    // original receipt by its recorded identity.
    const confirmed = await readReceipt(file, validateDeactivationReceipt);
    if (!confirmed || confirmed.dev !== initialIntent.dev || confirmed.ino !== initialIntent.ino) {
      throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_OWNER_RACE");
    }
    return initialIntent.value;
  }
  if (await Promise.resolve(isPidAlive(activation.value.pid))) {
    throw exclusionError("DOCKER_RUNTIME_ACTIVATION_IN_PROGRESS", String(activation.value.pid));
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const receipt = Object.freeze({
      schemaVersion: DOCKER_RUNTIME_DEACTIVATION_SCHEMA,
      pid: ownerPid,
      token: crypto.randomBytes(32).toString("base64url"),
      startedAt: now().toISOString(),
    });
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      const activationAfter = await readReceipt(activationFile, validateActivationReceipt);
      if (!activationAfter
        || activationAfter.dev !== activation.dev
        || activationAfter.ino !== activation.ino) {
        await releaseDockerRuntimeDeactivationIntent({
          productRoot,
          ownerPid,
          token: receipt.token,
        }).catch(() => false);
        throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_ACTIVATION_CHANGED");
      }
      return receipt;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error?.code !== "EEXIST") throw error;
      const existing = await readReceipt(file, validateDeactivationReceipt);
      if (!existing) continue;
      if (await Promise.resolve(isPidAlive(existing.value.pid))) {
        throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_ALREADY_RUNNING", String(existing.value.pid));
      }
      if (!await removeExact(file, existing, "DOCKER_RUNTIME_DEACTIVATION_OWNER_RACE")) {
        throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_OWNER_RACE");
      }
    }
  }
  throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_RACE");
}

export async function releaseDockerRuntimeDeactivationIntent({ productRoot, ownerPid, token } = {}) {
  if (!validPid(ownerPid) || typeof token !== "string" || !TOKEN.test(token)) return false;
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const file = path.join(controlRoot, DEACTIVATION_FILE);
  const existing = await readReceipt(file, validateDeactivationReceipt);
  if (!existing) return true;
  if (existing.value.pid !== ownerPid || existing.value.token !== token) return false;
  return removeExact(file, existing, "DOCKER_RUNTIME_DEACTIVATION_OWNER_RACE");
}

export async function releaseDockerRuntimeActivation({ productRoot, ownerPid, token } = {}) {
  if (!validPid(ownerPid) || typeof token !== "string" || !TOKEN.test(token)) return false;
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const file = path.join(controlRoot, ACTIVATION_FILE);
  const existing = await readReceipt(file, validateActivationReceipt);
  if (!existing) return true;
  if (existing.value.pid !== ownerPid || existing.value.token !== token) return false;
  return removeExact(file, existing);
}

export async function deactivateDockerRuntimeMode({
  productRoot,
  deactivationOwnerPid,
  deactivationToken,
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
} = {}) {
  const controlRoot = await runtimeControlRoot(productRoot, { create: false });
  const deactivation = await readReceipt(
    path.join(controlRoot, DEACTIVATION_FILE),
    validateDeactivationReceipt,
  );
  if (!deactivation
    || deactivation.value.pid !== deactivationOwnerPid
    || deactivation.value.token !== deactivationToken) {
    throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_INTENT_NOT_OWNED");
  }
  const file = path.join(controlRoot, ACTIVATION_FILE);
  const existing = await readReceipt(file, validateActivationReceipt);
  if (existing && await Promise.resolve(isPidAlive(existing.value.pid))) {
    throw exclusionError("DOCKER_RUNTIME_ACTIVATION_STILL_RUNNING", String(existing.value.pid));
  }
  await assertNoLiveLocalSourceRuntime({ productRoot, isPidAlive, probePort, environment });
  const ports = new Set([
    parsePort(environment.BACKEND_PORT, 4_000, "runtime-proxy"),
    parsePort(environment.BACKEND_EMERGENCY_LOCAL_AUTH_PORT, 4_001, "emergency-local-auth"),
    parsePort(environment.BONNI_INSTALLATION_MONITOR_PORT, 4_198, "monitor"),
    parsePort(environment.BACKEND_EMERGENCY_DIRECT_PORT, 4_199, "emergency-direct"),
  ]);
  for (const port of ports) {
    if (await probePort(port)) {
      throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_PORT_ACTIVE", String(port));
    }
  }
  if (!existing) return { ok: true, removed: false };
  if (!await removeExact(file, existing)) {
    throw exclusionError("DOCKER_RUNTIME_ACTIVATION_OWNER_RACE");
  }
  return { ok: true, removed: true };
}

async function main() {
  const [action, productRoot, pidText, token] = process.argv.slice(2);
  const ownerPid = Number(pidText);
  if (action === "acquire") {
    const receipt = await acquireDockerRuntimeActivation({ productRoot, ownerPid });
    process.stdout.write(`${receipt.token}\n`);
    return;
  }
  if (action === "check") {
    await assertNoLiveLocalSourceRuntime({ productRoot });
    return;
  }
  if (action === "release") {
    if (!await releaseDockerRuntimeActivation({ productRoot, ownerPid, token })) {
      throw exclusionError("DOCKER_RUNTIME_ACTIVATION_RELEASE_NOT_OWNED");
    }
    return;
  }
  if (action === "deactivate") {
    await deactivateDockerRuntimeMode({
      productRoot,
      deactivationOwnerPid: ownerPid,
      deactivationToken: token,
    });
    return;
  }
  if (action === "begin-deactivation") {
    const receipt = await acquireDockerRuntimeDeactivationIntent({ productRoot, ownerPid });
    process.stdout.write(`${receipt.pid}\t${receipt.token}\n`);
    return;
  }
  if (action === "end-deactivation") {
    if (!await releaseDockerRuntimeDeactivationIntent({ productRoot, ownerPid, token })) {
      throw exclusionError("DOCKER_RUNTIME_DEACTIVATION_RELEASE_NOT_OWNED");
    }
    return;
  }
  throw exclusionError("DOCKER_RUNTIME_ACTIVATION_ACTION_INVALID");
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  main().catch((error) => {
    console.error(`[bonni-runtime] Startmodus-Sperre fehlgeschlagen: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
