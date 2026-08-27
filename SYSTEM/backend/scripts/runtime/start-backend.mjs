import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLocalHostBackendRuntimeLease,
  assertLocalHostBackendRuntimeLease,
  bindLocalHostBackendRuntimeChild,
} from "./runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBackendRoot = path.resolve(scriptDirectory, "../..");
const defaultProductRoot = path.resolve(defaultBackendRoot, "../..");

export function isProductionEnvironment(environment = process.env) {
  return String(environment.NODE_ENV || "").trim().toLowerCase() === "production";
}

export function selectBackendEntry({
  backendRoot = defaultBackendRoot,
  environment = process.env,
} = {}) {
  return isProductionEnvironment(environment)
    ? path.join(path.resolve(backendRoot), "dist", "system", "server", "run-server.js")
    : path.join(path.resolve(backendRoot), "scripts", "setup", "local-source-update-supervisor.mjs");
}

async function isHostProductTree() {
  const expected = path.join(defaultProductRoot, "SYSTEM", "backend");
  const state = await fs.lstat(expected).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("LOCAL_HOST_BACKEND_PRODUCT_TREE_INVALID");
  }
  return await fs.realpath(expected) === await fs.realpath(defaultBackendRoot);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processOrGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function trackChild(child) {
  let spawnError = null;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, pid: child.pid, closed, spawnError: () => spawnError };
}

function waitForTrackedClose(tracked, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    tracked.closed.then(() => finish(true));
  });
}

async function waitForTreeOffline(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processOrGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

async function signalTree(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const result = await new Promise((resolve) => {
      const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", (error) => resolve({ error, code: null }));
      taskkill.once("close", (code) => resolve({ error: null, code }));
    });
    if (result.error || (result.code !== 0 && processOrGroupAlive(pid))) {
      throw result.error || new Error(`BONNI_BACKEND_TASKKILL_FAILED:${result.code}`);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateAndConfirmTree(tracked) {
  if (!tracked?.pid) {
    await tracked?.closed;
    if (tracked?.spawnError()) return;
    throw new Error("BONNI_BACKEND_CHILD_PID_UNAVAILABLE");
  }
  await signalTree(tracked.pid, "SIGTERM");
  await waitForTrackedClose(tracked, 10_000);
  if (!await waitForTreeOffline(tracked.pid, 1_000)) {
    await signalTree(tracked.pid, "SIGKILL");
    await waitForTrackedClose(tracked, 5_000);
  }
  if (!await waitForTreeOffline(tracked.pid, 2_000)) {
    throw new Error(`BONNI_BACKEND_PROCESS_TREE_STILL_RUNNING:${tracked.pid}`);
  }
}

async function waitForChild(tracked, signalFailure) {
  const { code, signal } = await Promise.race([tracked.closed, signalFailure]);
  if (tracked.spawnError()) throw tracked.spawnError();
  if (processOrGroupAlive(tracked.pid)) {
    await terminateAndConfirmTree(tracked);
    throw new Error(`BONNI_BACKEND_DESCENDANT_STILL_RUNNING:${tracked.pid}`);
  }
  if (code !== 0) {
    throw new Error(`BONNI_BACKEND_EXITED:${signal ? `signal-${signal}` : `exit-${code ?? "unknown"}`}`);
  }
}

export async function runSelectedBackend() {
  const hostTree = await isHostProductTree();
  const inheritedOwnerPid = Number(process.env.BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID || 0);
  const inheritedToken = String(process.env.BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN || "");
  const entry = selectBackendEntry();
  const assertEntry = async () => {
    const state = await fs.lstat(entry).catch(() => null);
    if (state?.isFile() && !state.isSymbolicLink()) return;
    throw new Error(`BONNI_BACKEND_ENTRY_MISSING:${entry}`);
  };
  await assertEntry();

  let ownedLease = null;
  let leaseOwnerPid = inheritedOwnerPid;
  let leaseToken = inheritedToken;
  if (hostTree) {
    if (inheritedOwnerPid && inheritedToken) {
      await assertLocalHostBackendRuntimeLease({
        productRoot: defaultProductRoot,
        ownerPid: inheritedOwnerPid,
        token: inheritedToken,
      });
    } else {
      ownedLease = await acquireLocalHostBackendRuntimeLease({
        productRoot: defaultProductRoot,
        entry: "start",
      });
      leaseOwnerPid = process.pid;
      leaseToken = ownedLease.token;
    }
  }

  let activeChild = null;
  let childStarted = false;
  let workflowCompletedCleanly = false;
  let rejectSignalFailure;
  const signalFailure = new Promise((_resolve, reject) => { rejectSignalFailure = reject; });
  const forward = (signal) => {
    const tracked = activeChild;
    if (!tracked?.pid) return;
    void (async () => {
      await signalTree(tracked.pid, signal);
      const closed = await waitForTrackedClose(tracked, 10_000);
      if (!closed && processOrGroupAlive(tracked.pid)) {
        await signalTree(tracked.pid, "SIGKILL");
      }
      if (!await waitForTreeOffline(tracked.pid, 2_000)) {
        throw new Error(`BONNI_BACKEND_PROCESS_TREE_STILL_RUNNING:${tracked.pid}`);
      }
    })().catch(rejectSignalFailure);
  };
  const forwardSigterm = () => forward("SIGTERM");
  const forwardSigint = () => forward("SIGINT");
  process.once("SIGTERM", forwardSigterm);
  process.once("SIGINT", forwardSigint);
  try {
    // Close the source-file validation -> lease acquisition race before fork.
    await assertEntry();
    const child = spawn(process.execPath, [entry], {
      cwd: defaultBackendRoot,
      env: {
        ...process.env,
        ...(hostTree ? {
          BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID: String(leaseOwnerPid),
          BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN: leaseToken,
        } : {}),
      },
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    childStarted = true;
    activeChild = trackChild(child);
    if (hostTree) {
      if (ownedLease) await ownedLease.bindChildPid(child.pid);
      else {
        await bindLocalHostBackendRuntimeChild({
          productRoot: defaultProductRoot,
          ownerPid: leaseOwnerPid,
          token: leaseToken,
          childPid: child.pid,
        });
      }
    }
    await waitForChild(activeChild, signalFailure);
    activeChild = null;
    workflowCompletedCleanly = true;
  } finally {
    process.removeListener("SIGTERM", forwardSigterm);
    process.removeListener("SIGINT", forwardSigint);
    let treeConfirmed = true;
    let treeError = null;
    if (activeChild) {
      try {
        await terminateAndConfirmTree(activeChild);
      } catch (error) {
        treeConfirmed = false;
        treeError = error;
      }
    }
    if (ownedLease) {
      if (treeConfirmed && (workflowCompletedCleanly || !childStarted)) await ownedLease.release();
      else console.error("[bonni-start] Host-Modusbeleg bleibt nach unklarem oder fehlerhaftem Prozessende fail-closed erhalten.");
    }
    if (treeError) throw treeError;
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  runSelectedBackend().catch((error) => {
    console.error("[bonni-start] Backend-Start fehlgeschlagen.");
    console.error(error);
    process.exitCode = 1;
  });
}
