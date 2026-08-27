import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
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
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;

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

export async function runtimeControlRoot(productRoot, { create = false } = {}) {
  const root = path.resolve(productRoot);
  if (root === path.parse(root).root) throw exclusionError("LOCAL_SOURCE_RUNTIME_PRODUCT_ROOT_INVALID");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw exclusionError("LOCAL_SOURCE_RUNTIME_PRODUCT_ROOT_INVALID");
  }
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
  const [lock, core, heartbeat, updateCommand, hostBackend] = await Promise.all([
    readReceipt(path.join(controlRoot, SUPERVISOR_LOCK_FILE), validateSupervisorLock),
    readReceipt(path.join(controlRoot, CORE_CHILD_FILE), validateCoreChild),
    readReceipt(path.join(controlRoot, HEARTBEAT_FILE), validateHeartbeat),
    readReceipt(path.join(controlRoot, UPDATE_COMMAND_LOCK_FILE), validateUpdateCommandLock),
    readReceipt(path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE), validateHostBackendRuntime),
  ]);
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
      parsePort(environment.LOCAL_AUTH_PORT, 4_001, "local-auth"),
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
  const hostBackend = await readReceipt(
    path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE),
    validateHostBackendRuntime,
  );
  if (!hostBackend) return { ok: true };
  const permittedPid = Number(environment.BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID || 0);
  const permittedToken = String(environment.BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN || "");
  if (hostBackend.value.pid === permittedPid
    && hostBackend.value.token === permittedToken
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
  now = () => new Date(),
  isPidAlive = defaultPidAlive,
  probePort = defaultProbePort,
  environment = process.env,
} = {}) {
  if (!validPid(ownerPid)) throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_PID_INVALID");
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
      childPid: null,
      token: crypto.randomBytes(32).toString("base64url"),
      entry,
      startedAt: now().toISOString(),
    };
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
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
        const current = await readReceipt(file, validateHostBackendRuntime);
        const handleStat = await handle.stat();
        if (!current || current.value.token !== receipt.token
          || current.dev !== handleStat.dev || current.ino !== handleStat.ino) {
          throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_OWNERSHIP_LOST");
        }
        receipt.childPid = childPid;
        await handle.truncate(0);
        await handle.write(`${JSON.stringify(receipt, null, 2)}\n`, 0, "utf8");
        await handle.sync();
      };
      const release = async () => {
        if (released) return true;
        released = true;
        const handleStat = await handle.stat().catch(() => null);
        await handle.close().catch(() => undefined);
        const current = await readReceipt(file, validateHostBackendRuntime);
        if (!handleStat || !current || current.value.token !== receipt.token
          || current.dev !== handleStat.dev || current.ino !== handleStat.ino) {
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
      if (handle) {
        const handleStat = await handle.stat().catch(() => null);
        await handle.close().catch(() => undefined);
        const current = await readReceipt(file, validateHostBackendRuntime).catch(() => null);
        if (handleStat && current && current.value.token === receipt.token
          && current.dev === handleStat.dev && current.ino === handleStat.ino) {
          await removeExact(file, current, "LOCAL_HOST_BACKEND_RUNTIME_OWNER_RACE").catch(() => undefined);
        }
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = await readReceipt(file, validateHostBackendRuntime);
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
  const receipt = await readReceipt(
    path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE),
    validateHostBackendRuntime,
  );
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
  const file = path.join(controlRoot, HOST_BACKEND_RUNTIME_FILE);
  const observed = await readReceipt(file, validateHostBackendRuntime);
  if (!observed || observed.value.pid !== ownerPid || observed.value.token !== token) {
    throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_PROOF_NOT_OWNED");
  }
  const handle = await fs.open(file, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    const handleStat = await handle.stat();
    if (handleStat.dev !== observed.dev || handleStat.ino !== observed.ino) {
      throw exclusionError("LOCAL_HOST_BACKEND_RUNTIME_OWNERSHIP_LOST");
    }
    const updated = { ...observed.value, childPid };
    await handle.truncate(0);
    await handle.write(`${JSON.stringify(updated, null, 2)}\n`, 0, "utf8");
    await handle.sync();
    return Object.freeze(updated);
  } finally {
    await handle.close().catch(() => undefined);
  }
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
