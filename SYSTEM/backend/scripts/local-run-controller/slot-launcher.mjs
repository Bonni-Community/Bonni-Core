import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { buildSlotLaunchPlan } from "../runcontainer/runcontainer-lib.mjs";

function ensureAbsoluteSafeRoot(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!value || resolved === path.parse(resolved).root) throw new Error(`LOCAL_RUN_LAUNCH_ROOT_INVALID:${label}`);
  return resolved;
}

async function assertRegularFile(file, code) {
  const state = await fs.lstat(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error(`${code}:${file}`);
}

/**
 * Resolve the generation-bound Active program and its direct compiled entry.
 * The public proxy owns PORT 4000; this backend always receives an internal
 * loopback port (4100 by default).
 */
export async function resolveActiveSlotBackend(options = {}) {
  const environment = options.environment || process.env;
  const productRoot = ensureAbsoluteSafeRoot(
    options.productRoot || environment.BONNI_PRODUCT_ROOT || environment.BONNI_PROJECT_ROOT || process.cwd(),
    "product-root",
  );
  const runRoot = ensureAbsoluteSafeRoot(
    options.runRoot || environment.BONNI_PROGRAM_SLOTS_ROOT || path.join(productRoot, "RUN"),
    "run-root",
  );
  const productionRunSystemRoot = ensureAbsoluteSafeRoot(
    options.productionRunSystemRoot || environment.RUN_SYSTEM_ROOT || path.join(productRoot, "run_system"),
    "production-run-system-root",
  );
  const productionStorageRoot = ensureAbsoluteSafeRoot(
    options.productionStorageRoot || options.storageRoot
      || environment.BONNI_STORAGE_ROOT || path.join(productionRunSystemRoot, "storage"),
    "production-storage-root",
  );
  const productionLogRoot = ensureAbsoluteSafeRoot(
    options.productionLogRoot || options.logRoot
      || environment.BONNI_LOG_ROOT || path.join(productionRunSystemRoot, "logs"),
    "production-log-root",
  );
  const internalPort = Number(options.internalPort || environment.BONNI_ACTIVE_INTERNAL_PORT || 4100);
  const slotOptions = {
    runRoot,
    installationRoot: productRoot,
    productionRunSystemRoot,
    productionStorageRoot,
    productionLogRoot,
    storageRoot: productionStorageRoot,
    logRoot: productionLogRoot,
    productionMediaStorageRoot: options.productionMediaStorageRoot,
    productionArchivRoot: options.productionArchivRoot,
    environment,
    serverPorts: {
      active: internalPort,
      candidate: Number(options.candidateInternalPort || environment.BONNI_CANDIDATE_INTERNAL_PORT || 4300),
      previous: Number(options.previousInternalPort || environment.BONNI_PREVIOUS_INTERNAL_PORT || 4400),
    },
    localAuthPorts: {
      active: Number(options.localAuthPort || environment.BONNI_ACTIVE_LOCAL_AUTH_PORT || 4101),
      candidate: Number(options.candidateLocalAuthPort || environment.BONNI_CANDIDATE_LOCAL_AUTH_PORT || 4301),
      previous: Number(options.previousLocalAuthPort || environment.BONNI_PREVIOUS_LOCAL_AUTH_PORT || 4401),
    },
    reservedPorts: [
      Number(options.publicPort || environment.PORT || 4000),
      Number(environment.BONNI_INSTALLATION_MONITOR_PORT || 4198),
    ],
    databaseUrls: options.databaseUrls,
  };
  const plan = await buildSlotLaunchPlan("active", slotOptions);
  // The run-slot launch plan is authoritative for the immutable generation
  // and for the production data roots bound to the Active role.
  const programRoot = plan.programRoot;
  const backendRoot = plan.backendRoot;
  const entry = plan.serverEntry;
  await assertRegularFile(entry, "LOCAL_RUN_ACTIVE_BACKEND_ENTRY_MISSING");

  const stateRoot = ensureAbsoluteSafeRoot(plan.env.RUN_SYSTEM_ROOT, "state-root");
  const storageRoot = ensureAbsoluteSafeRoot(plan.env.BONNI_STORAGE_ROOT, "storage-root");
  const logRoot = productionLogRoot;
  await Promise.all([
    fs.mkdir(storageRoot, { recursive: true }),
    fs.mkdir(logRoot, { recursive: true }),
    fs.mkdir(path.join(stateRoot, "system"), { recursive: true }),
  ]);
  return {
    schemaVersion: 1,
    role: "active",
    slotId: plan.slotId,
    receiptSha256: plan.receiptSha256,
    command: process.execPath,
    args: [entry],
    cwd: backendRoot,
    internalEndpoint: { host: "127.0.0.1", port: internalPort },
    proxyTarget: {
      host: "127.0.0.1",
      port: internalPort,
      slotRole: "active",
      slotId: plan.slotId,
      receiptSha256: plan.receiptSha256,
    },
    env: {
      ...environment,
      ...plan.env,
      BONNI_PRODUCT_ROOT: productRoot,
      // Legacy BONNI_PROJECT_ROOT is intentionally the immutable code root.
      // Only BONNI_PRODUCT_ROOT points at the stable installation.
      BONNI_PROJECT_ROOT: programRoot,
      BONNI_PROGRAM_ROOT: programRoot,
      BONNI_MODULE_PACKAGE_ROOT: path.join(productRoot, "SYSTEM"),
      RUN_SYSTEM_ROOT: stateRoot,
      RUN_SYSTEM_SYSTEM_ROOT: path.join(stateRoot, "system"),
      RUN_SYSTEM_STORAGE_ROOT: storageRoot,
      RUN_SYSTEM_LOG_ROOT: logRoot,
      BONNI_STORAGE_ROOT: storageRoot,
      BONNI_LOG_ROOT: logRoot,
      SYSTEM_SERVER_BIND: "127.0.0.1",
      LOCAL_AUTH_BIND: "127.0.0.1",
      PORT: String(internalPort),
      SYSTEM_SLOT_ROLE: "active",
      SYSTEM_UPDATE_PROBE_MODE: "false",
      BONNI_PROGRAM_SLOT_ROLE: "active",
      BONNI_PROGRAM_SLOT_ID: plan.slotId,
      BONNI_PROGRAM_SLOT_RECEIPT_SHA256: plan.receiptSha256,
    },
  };
}

export function spawnActiveSlotBackend(plan, options = {}) {
  if (!plan || plan.role !== "active" || plan.proxyTarget?.slotRole !== "active") {
    throw new Error("LOCAL_RUN_ACTIVE_LAUNCH_PLAN_INVALID");
  }
  return spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: options.stdio || "inherit",
    windowsHide: true,
    detached: options.detached ?? process.platform !== "win32",
  });
}
