#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLocalHostBackendRuntimeLease } from "./runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const productRoot = path.resolve(backendRoot, "../..");

async function isHostProductTree() {
  const expected = path.join(productRoot, "SYSTEM", "backend");
  const state = await fs.lstat(expected).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("LOCAL_HOST_BACKEND_PRODUCT_TREE_INVALID");
  }
  return await fs.realpath(expected) === await fs.realpath(backendRoot);
}

export function fixedCommand(action) {
  const maintenance = [process.execPath, [path.join(backendRoot, "scripts", "maintenance", "cleanup-stale-technical-data.mjs")]];
  const ensureJwt = [process.execPath, [path.join(backendRoot, "scripts", "auth", "ensure-jwt-secret.mjs")]];
  const tsx = [process.execPath, [path.join(backendRoot, "node_modules", "tsx", "dist", "cli.mjs")]];
  const commands = {
    start: [
      maintenance,
      ensureJwt,
      [process.execPath, [path.join(scriptDirectory, "start-backend.mjs")]],
    ],
    dev: [
      maintenance,
      ensureJwt,
      [tsx[0], [...tsx[1], "watch", path.join(backendRoot, "src", "system", "server", "run-server.ts")]],
    ],
    "dev-run": [
      maintenance,
      ensureJwt,
      [tsx[0], [...tsx[1], "watch", path.join(backendRoot, "src", "system", "server", "run-server.ts")]],
    ],
    "redundant-dev": [
      ensureJwt,
      [tsx[0], [...tsx[1], "watch", path.join(backendRoot, "src", "system", "server", "redundant-server.ts")]],
    ],
    "redundant-start": [
      ensureJwt,
      [process.execPath, [path.join(backendRoot, "dist", "system", "server", "redundant-server.js")]],
    ],
    "module-manager-dev": [
      [tsx[0], [...tsx[1], "watch", path.join(backendRoot, "src", "platform", "module-manager", "server", "module-manager-server.ts")]],
    ],
    "module-manager-start": [
      [process.execPath, [path.join(backendRoot, "dist", "platform", "module-manager", "server", "module-manager-server.js")]],
    ],
  };
  const selected = commands[action];
  if (!selected) throw new Error("LOCAL_HOST_BACKEND_ENTRY_ACTION_INVALID");
  return selected;
}

function runChild(command, args, environment) {
  const child = spawn(command, args, {
    cwd: backendRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  return child;
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
    await new Promise((resolve) => {
      const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", () => resolve());
      taskkill.once("close", () => resolve());
    });
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
    throw new Error("LOCAL_HOST_BACKEND_CHILD_PID_UNAVAILABLE");
  }
  await signalTree(tracked.pid, "SIGTERM");
  await Promise.race([tracked.closed, delay(10_000)]);
  if (!await waitForTreeOffline(tracked.pid, 1_000)) {
    await signalTree(tracked.pid, "SIGKILL");
    await Promise.race([tracked.closed, delay(5_000)]);
  }
  if (!await waitForTreeOffline(tracked.pid, 2_000)) {
    throw new Error(`LOCAL_HOST_BACKEND_PROCESS_TREE_STILL_RUNNING:${tracked.pid}`);
  }
}

async function waitForChild(tracked) {
  const { code, signal } = await tracked.closed;
  if (tracked.spawnError()) throw tracked.spawnError();
  if (processOrGroupAlive(tracked.pid)) {
    await terminateAndConfirmTree(tracked);
  }
  if (code !== 0) {
    throw new Error(`LOCAL_HOST_BACKEND_CHILD_FAILED:${signal ? `signal-${signal}` : `exit-${code ?? "unknown"}`}`);
  }
}

async function main() {
  const action = process.argv[2];
  const commands = fixedCommand(action);
  const hostTree = await isHostProductTree();
  const lease = hostTree
    ? await acquireLocalHostBackendRuntimeLease({ productRoot, entry: action })
    : null;
  let activeChild = null;
  let workflowCompletedCleanly = false;
  const forward = (signal) => {
    if (activeChild?.pid) void signalTree(activeChild.pid, signal);
  };
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  try {
    for (let index = 0; index < commands.length; index += 1) {
      const [command, args] = commands[index];
      const longRunning = index === commands.length - 1;
      activeChild = trackChild(runChild(command, args, {
        ...process.env,
        ...(lease && longRunning ? {
          BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID: String(process.pid),
          BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN: lease.token,
        } : {}),
      }));
      if (lease) await lease.bindChildPid(activeChild.pid);
      await waitForChild(activeChild);
      activeChild = null;
    }
    workflowCompletedCleanly = true;
  } finally {
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
    if (treeConfirmed && workflowCompletedCleanly) await lease?.release();
    else if (lease) console.error("[bonni-start] Host-Modusbeleg bleibt nach unklarem oder fehlerhaftem Prozessende fail-closed erhalten.");
    if (treeError) throw treeError;
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  main().catch((error) => {
    console.error("[bonni-start] Host-Backend-Einstieg wurde sicher abgebrochen.");
    console.error(error);
    process.exitCode = 1;
  });
}
