import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireLocalHostBackendRuntimeLease,
  assertLocalHostBackendRuntimeLease,
  bindLocalHostBackendRuntimeChild,
} from "./runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBackendRoot = path.resolve(scriptDirectory, "../..");
const defaultProductRoot = path.resolve(defaultBackendRoot, "../..");
const MAXIMUM_ENV_BYTES = 128 * 1024;
const STABLE_ENV_FORBIDDEN_KEYS = new Set([
  "BONNI_PRODUCT_ROOT",
  "BONNI_PROGRAM_ROOT",
  "BONNI_PROJECT_ROOT",
  "BONNI_MODULE_PACKAGE_ROOT",
  "BONNI_PROGRAM_SLOT_ROOT",
  "BONNI_PROGRAM_SLOT_ID",
  "BONNI_PROGRAM_SLOT_ROLE",
  "BONNI_RUN_INSTALL_ROOT",
  "BONNI_RUN_SYSTEM_ROOT",
  "BONNI_PROGRAM_SLOTS_ROOT",
  "BONNI_RUNTIME_STATE_ROOT",
  "RUNCONTAINER_ROOT",
  "SYSTEM_SLOT_ROLE",
  "SYSTEM_UPDATE_PROBE_MODE",
]);
const START_REPAIR_ID = "bonni-core-0120-start-automation-v2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const START_REPAIR_PROGRAM_PATHS = Object.freeze([
  "SYSTEM/backend/scripts/runtime/local-source-update-start-gate.mjs",
  "SYSTEM/backend/scripts/runtime/runtime-mode-exclusion.mjs",
  "SYSTEM/backend/scripts/setup/local-source-update.mjs",
  "SYSTEM/backend/src/system/routes/control-api/update-center/local-source-inbox.service.ts",
  "SYSTEM/backend/src/system/boot/run-system/run-system.paths.ts",
  "SYSTEM/backend/src/core/config/env.ts",
  "SYSTEM/backend/src/platform/module-manager/project-root.ts",
  "SYSTEM/backend/src/core/logger/logger.ts",
  "SYSTEM/backend/src/system/server/run-server.ts",
  "SYSTEM/backend/src/system/server/local-supervisor-shutdown.ts",
  "SYSTEM/backend/scripts/runtime/start-backend.mjs",
  "SYSTEM/backend/scripts/setup/local-source-update-supervisor.mjs",
  "SYSTEM/backend/scripts/local-run-controller/acceptance-gate.mjs",
  "SYSTEM/backend/scripts/local-run-controller/controller-state.mjs",
  "SYSTEM/backend/scripts/local-run-controller/local-run-proxy.mjs",
  "SYSTEM/backend/scripts/local-run-controller/slot-launcher.mjs",
  "SYSTEM/backend/scripts/setup/local-candidate-compatibility.mjs",
  "SYSTEM/backend/scripts/runcontainer/candidate-data-clone.mjs",
  "SYSTEM/backend/scripts/runcontainer/candidate-update-stage.mjs",
  "SYSTEM/backend/scripts/runcontainer/candidate-control-state-promotion.mjs",
  "SYSTEM/backend/scripts/runcontainer/runcontainer-lib.mjs",
  "SYSTEM/backend/scripts/runcontainer/run-layout.mjs",
  "SYSTEM/backend/scripts/runcontainer/frontend-slot-health.mjs",
  "SYSTEM/backend/scripts/runcontainer/canonical-system-commit.mjs",
  "SYSTEM/frontend/platform/control-center/update/CoreUpdatePage.jsx",
  "SYSTEM/frontend/platform/control-center/update/CoreUpdatePage.css",
  "SYSTEM/frontend/platform/control-center/update/localUpdateMonitorApi.js",
  "SYSTEM/frontend/platform/control-center/update/localUpdatePresentation.js",
  "SYSTEM/frontend/platform/control-center/update/DeploymentLifecyclePanel.jsx",
]);

function startRepairInvalid(detail) {
  throw new Error(`BONNI_START_REPAIR_STATE_INVALID:${detail}`);
}

function exactKeys(value, keys, detail) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    startRepairInvalid(detail);
  }
  return value;
}

function exactIso(value, detail) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) startRepairInvalid(detail);
}

async function readStartRepairFile(file, label, maximumBytes = 16 * 1024 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
      || opened.dev !== named.dev || opened.ino !== named.ino
      || opened.nlink !== 1 || named.nlink !== 1
      || opened.size < 2 || opened.size > maximumBytes) {
      throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${label}`);
    }
    const bytes = await handle.readFile();
    const [after, current] = await Promise.all([handle.stat(), fs.lstat(file).catch(() => null)]);
    if (!current || after.dev !== opened.dev || after.ino !== opened.ino
      || current.dev !== opened.dev || current.ino !== opened.ino
      || after.size !== opened.size || after.nlink !== 1 || current.nlink !== 1) {
      throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${label}-race`);
    }
    return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), state: opened };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSafeRelativePath(root, relative, label) {
  if (!relative || relative.includes("\0") || relative.includes("\\")
    || path.posix.normalize(relative) !== relative || relative.startsWith("../")
    || path.posix.isAbsolute(relative)) startRepairInvalid(label);
  let cursor = path.resolve(root);
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    const state = await fs.lstat(cursor).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!state) return cursor;
    if (state.isSymbolicLink()) throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${label}-symlink`);
  }
  return cursor;
}

function validateDistProof(value, kind) {
  const anchor = kind === "backend" ? "entrySha256" : "indexHtmlSha256";
  exactKeys(value, ["state", "treeSha256", "fileCount", "totalBytes", anchor], `${kind}-dist-proof`);
  if (value.state !== "present" || !SHA256_PATTERN.test(String(value.treeSha256 || ""))
    || !SHA256_PATTERN.test(String(value[anchor] || ""))
    || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1 || value.fileCount > 20_000
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > 512 * 1024 * 1024) {
    startRepairInvalid(`${kind}-dist-proof`);
  }
  return value;
}

function validateDistIntent(value, kind) {
  exactKeys(value, ["transactionId", "previous"], `${kind}-dist-intent`);
  if (!/^[a-f0-9]{24}$/u.test(String(value.transactionId || ""))) startRepairInvalid(`${kind}-transaction-id`);
  // The previous tree may be absent; its complete closed proof is still bound
  // by the raw intent digest and is not startup authority.
  const anchor = kind === "backend" ? "entrySha256" : "indexHtmlSha256";
  exactKeys(value.previous, ["state", "treeSha256", "fileCount", "totalBytes", anchor], `${kind}-previous`);
  if (value.previous.state === "absent") {
    if (value.previous.treeSha256 !== null || value.previous.fileCount !== 0
      || value.previous.totalBytes !== 0 || value.previous[anchor] !== null) startRepairInvalid(`${kind}-previous`);
  } else {
    validateDistProof(value.previous, kind);
  }
  return value;
}

function validateRunActive(value) {
  if (value?.state === "absent") {
    exactKeys(value, ["state", "pointerRevision"], "run-active-absent");
    if (!Number.isSafeInteger(value.pointerRevision) || value.pointerRevision < 0) startRepairInvalid("run-active-revision");
    return value;
  }
  exactKeys(value, ["state", "pointerRevision", "active"], "run-active");
  if (value.state !== "present" || !Number.isSafeInteger(value.pointerRevision) || value.pointerRevision < 1) startRepairInvalid("run-active");
  const required = ["role", "slotId", "slotRoot", "programRoot", "stateRoot", "receipt", "receiptSha256", "version", "updateId"];
  const actualKeys = Object.keys(value.active || {}).sort().join("\0");
  const normal = [...required].sort().join("\0");
  const retained = [...required, "retainUntil"].sort().join("\0");
  if (actualKeys !== normal && actualKeys !== retained) startRepairInvalid("run-active-pointer");
  const slotId = String(value.active.slotId || "");
  if (value.active.role !== "active" || !/^slot-[a-f0-9-]{36}$/u.test(slotId)
    || value.active.slotRoot !== `slots/${slotId}` || value.active.programRoot !== `slots/${slotId}/program`
    || value.active.stateRoot !== `state/${slotId}` || value.active.receipt !== `slots/${slotId}/program-slot.json`
    || !SHA256_PATTERN.test(String(value.active.receiptSha256 || ""))
    || typeof value.active.version !== "string" || !value.active.version.trim()
    || !(value.active.updateId === null || (typeof value.active.updateId === "string" && value.active.updateId.trim()))) {
    startRepairInvalid("run-active-pointer");
  }
  if (Object.hasOwn(value.active, "retainUntil")
    && !(value.active.retainUntil === null || (exactIso(value.active.retainUntil, "run-active-retain"), true))) {
    startRepairInvalid("run-active-retain");
  }
  return value;
}

function validateProgramFiles(files) {
  if (!Array.isArray(files) || files.length !== START_REPAIR_PROGRAM_PATHS.length) startRepairInvalid("program-files");
  for (let index = 0; index < files.length; index += 1) {
    const entry = exactKeys(files[index], ["path", "previousSha256", "previousSizeBytes", "sha256", "sizeBytes"], "program-file");
    if (entry.path !== START_REPAIR_PROGRAM_PATHS[index]
      || !(entry.previousSha256 === null || SHA256_PATTERN.test(String(entry.previousSha256)))
      || !Number.isSafeInteger(entry.previousSizeBytes) || entry.previousSizeBytes < 0
      || ((entry.previousSha256 === null) !== (entry.previousSizeBytes === 0))
      || !SHA256_PATTERN.test(String(entry.sha256 || ""))
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1) startRepairInvalid(`program-file-${index}`);
  }
  return files;
}

async function inventoryDistTree(root, kind) {
  const rootState = await fs.lstat(root).catch(() => null);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${kind}-dist`);
  const inventory = [];
  let totalBytes = 0;
  let anchorSha256 = null;
  const anchorPath = kind === "backend" ? "system/server/run-server.js" : "index.html";
  const visit = async (directory, relative = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      const state = await fs.lstat(child);
      if (state.isSymbolicLink()) throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${kind}-dist-symlink`);
      if (state.isDirectory()) { await visit(child, childRelative); continue; }
      if (!state.isFile() || state.nlink !== 1) throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${kind}-dist-file`);
      const proof = await readStartRepairFile(child, `${kind}-dist-file`, 64 * 1024 * 1024);
      inventory.push({ path: childRelative, sizeBytes: proof.state.size, sha256: proof.sha256 });
      totalBytes += proof.state.size;
      if (inventory.length > 20_000 || totalBytes > 512 * 1024 * 1024) startRepairInvalid(`${kind}-dist-size`);
      if (childRelative === anchorPath) anchorSha256 = proof.sha256;
    }
  };
  await visit(root);
  if (!anchorSha256) startRepairInvalid(`${kind}-dist-anchor`);
  return {
    state: "present",
    treeSha256: crypto.createHash("sha256").update(Buffer.from(JSON.stringify(inventory), "utf8")).digest("hex"),
    fileCount: inventory.length,
    totalBytes,
    [kind === "backend" ? "entrySha256" : "indexHtmlSha256"]: anchorSha256,
  };
}

export async function assertStartRepairTransactionRootsClosed(productRoot, {
  backendTransactionId,
  frontendTransactionId,
} = {}) {
  if (!/^[a-f0-9]{24}$/u.test(String(backendTransactionId || ""))) {
    startRepairInvalid("backend-transaction-id");
  }
  if (!/^[a-f0-9]{24}$/u.test(String(frontendTransactionId || ""))) {
    startRepairInvalid("frontend-transaction-id");
  }
  const resolvedRoot = path.resolve(productRoot);
  const roots = [
    [
      path.join(
        resolvedRoot,
        "SYSTEM",
        "backend",
        `.bonni-${START_REPAIR_ID}-backend-dist-${backendTransactionId}`,
      ),
      "backend-transaction-open",
    ],
    [
      path.join(
        resolvedRoot,
        "SYSTEM",
        "frontend",
        `.bonni-${START_REPAIR_ID}-frontend-dist-${frontendTransactionId}`,
      ),
      "frontend-transaction-open",
    ],
    [
      path.join(
        resolvedRoot,
        "SYSTEM",
        ".bonni-source-update",
        "f",
        "start-repair",
        frontendTransactionId,
      ),
      "frontend-external-transaction-open",
    ],
  ];
  for (const [transactionRoot, detail] of roots) {
    const state = await fs.lstat(transactionRoot).catch((error) => (
      error?.code === "ENOENT" ? null : Promise.reject(error)
    ));
    if (state) startRepairInvalid(detail);
  }
}

async function validateCompletedStartRepair(productRoot, intentProof, receiptProof) {
  let intent;
  let receipt;
  try { intent = JSON.parse(intentProof.bytes.toString("utf8")); receipt = JSON.parse(receiptProof.bytes.toString("utf8")); }
  catch { startRepairInvalid("json"); }
  exactKeys(intent, ["schemaVersion", "repairId", "predecessor", "createdAt", "backupPath", "backupManifestSha256", "backendDist", "frontendDist", "runActive", "files"], "intent-keys");
  exactKeys(receipt, ["schemaVersion", "repairId", "coreVersion", "predecessor", "installedAt", "backupPath", "backupManifestSha256", "archivedRuntimeReceipt", "intentSha256", "backendDist", "frontendDist", "runActive", "files"], "receipt-keys");
  const predecessor = { updateId: "u-020-0193-0827-15", manifestSha256: "56473fbb920e4ad3cbce835a53899f1dd3ec473c5af28992497db08f6e68e400" };
  exactKeys(intent.predecessor, ["updateId", "manifestSha256"], "intent-predecessor");
  exactKeys(receipt.predecessor, ["updateId", "manifestSha256"], "receipt-predecessor");
  if (intent.schemaVersion !== "bonni.core-start-automation-repair-intent/v2" || intent.repairId !== START_REPAIR_ID
    || receipt.schemaVersion !== "bonni.core-start-automation-repair/v2" || receipt.repairId !== START_REPAIR_ID
    || receipt.coreVersion !== "0.1.20" || JSON.stringify(intent.predecessor) !== JSON.stringify(predecessor)
    || JSON.stringify(receipt.predecessor) !== JSON.stringify(predecessor)) startRepairInvalid("identity");
  exactIso(intent.createdAt, "intent-time"); exactIso(receipt.installedAt, "receipt-time");
  if (!/^BACKUP\/start-automation-repair-[A-Za-z0-9-]+$/u.test(String(intent.backupPath || ""))
    || receipt.backupPath !== intent.backupPath || !SHA256_PATTERN.test(String(intent.backupManifestSha256 || ""))
    || receipt.backupManifestSha256 !== intent.backupManifestSha256 || receipt.intentSha256 !== intentProof.sha256
    || !(receipt.archivedRuntimeReceipt === null || /^host-backend-runtime\.json\.stale-[A-Za-z0-9-]+$/u.test(receipt.archivedRuntimeReceipt))) startRepairInvalid("receipt-binding");
  validateDistIntent(intent.backendDist, "backend"); validateDistIntent(intent.frontendDist, "frontend");
  for (const kind of ["backend", "frontend"]) {
    exactKeys(receipt[`${kind}Dist`], ["transactionId", "target"], `${kind}-receipt`);
    if (receipt[`${kind}Dist`].transactionId !== intent[`${kind}Dist`].transactionId) startRepairInvalid(`${kind}-binding`);
    validateDistProof(receipt[`${kind}Dist`].target, kind);
  }
  validateRunActive(intent.runActive); validateRunActive(receipt.runActive);
  validateProgramFiles(intent.files); validateProgramFiles(receipt.files);
  if (JSON.stringify(receipt.runActive) !== JSON.stringify(intent.runActive)
    || JSON.stringify(receipt.files) !== JSON.stringify(intent.files)) startRepairInvalid("program-run-binding");

  const resolvedRoot = path.resolve(productRoot);
  for (const entry of receipt.files) {
    const file = await assertSafeRelativePath(resolvedRoot, entry.path, "program-path");
    const proof = await readStartRepairFile(file, "program-file");
    if (proof.sha256 !== entry.sha256 || proof.state.size !== entry.sizeBytes) startRepairInvalid(`program-current:${entry.path}`);
  }
  const backupRoot = path.resolve(resolvedRoot, ...intent.backupPath.split("/"));
  if (!backupRoot.startsWith(`${path.resolve(resolvedRoot, "BACKUP")}${path.sep}`)) startRepairInvalid("backup-path");
  const backupManifestProof = await readStartRepairFile(path.join(backupRoot, "backup-manifest.json"), "backup-manifest");
  if (backupManifestProof.sha256 !== intent.backupManifestSha256) startRepairInvalid("backup-manifest-hash");
  let backup;
  try { backup = JSON.parse(backupManifestProof.bytes.toString("utf8")); } catch { startRepairInvalid("backup-json"); }
  exactKeys(backup, ["schemaVersion", "repairId", "createdAt", "files"], "backup-keys");
  exactIso(backup.createdAt, "backup-time");
  if (backup.schemaVersion !== "bonni.core-start-automation-repair-backup/v2" || backup.repairId !== START_REPAIR_ID
    || !Array.isArray(backup.files) || backup.files.length !== intent.files.length) startRepairInvalid("backup");
  for (let index = 0; index < backup.files.length; index += 1) {
    const actual = exactKeys(backup.files[index], ["path", "state", "sha256", "sizeBytes", "backupPath"], "backup-file");
    const expected = intent.files[index];
    const absent = expected.previousSha256 === null;
    if (actual.path !== expected.path || actual.state !== (absent ? "absent" : "present")
      || actual.sha256 !== expected.previousSha256 || actual.sizeBytes !== expected.previousSizeBytes
      || actual.backupPath !== (absent ? null : expected.path)) startRepairInvalid(`backup-file-${index}`);
    if (!absent) {
      const backupFile = await assertSafeRelativePath(backupRoot, actual.backupPath, "backup-file-path");
      const proof = await readStartRepairFile(backupFile, "backup-file");
      if (proof.sha256 !== actual.sha256 || proof.state.size !== actual.sizeBytes) startRepairInvalid(`backup-file-content-${index}`);
    }
  }
  const backendRoot = path.join(resolvedRoot, "SYSTEM", "backend");
  const frontendRoot = path.join(resolvedRoot, "SYSTEM", "frontend");
  await assertStartRepairTransactionRootsClosed(resolvedRoot, {
    backendTransactionId: intent.backendDist.transactionId,
    frontendTransactionId: intent.frontendDist.transactionId,
  });
  const [backendDist, frontendDist] = await Promise.all([
    inventoryDistTree(path.join(backendRoot, "dist"), "backend"),
    inventoryDistTree(path.join(frontendRoot, "dist"), "frontend"),
  ]);
  if (JSON.stringify(backendDist) !== JSON.stringify(receipt.backendDist.target)) startRepairInvalid("backend-dist-current");
  if (JSON.stringify(frontendDist) !== JSON.stringify(receipt.frontendDist.target)) startRepairInvalid("frontend-dist-current");
}

export async function assertNoOpenStartAutomationRepair(productRoot = defaultProductRoot) {
  const repairsRoot = path.join(
    path.resolve(productRoot), "SYSTEM", ".bonni-source-update", "repairs",
  );
  const intent = path.join(repairsRoot, `${START_REPAIR_ID}.intent.json`);
  const receipt = path.join(repairsRoot, `${START_REPAIR_ID}.json`);
  const [intentState, receiptState] = await Promise.all([
    fs.lstat(intent).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
    fs.lstat(receipt).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
  ]);
  for (const [label, state] of [["intent", intentState], ["receipt", receiptState]]) {
    if (state && (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1)) {
      throw new Error(`BONNI_START_REPAIR_STATE_UNSAFE:${label}`);
    }
  }
  if (intentState && !receiptState) {
    throw new Error("BONNI_START_REPAIR_INCOMPLETE:Startreparatur erneut ausfuehren");
  }
  if (!intentState && receiptState) {
    throw new Error("BONNI_START_REPAIR_STATE_INCOMPLETE:receipt-without-intent");
  }
  if (intentState && receiptState) await validateCompletedStartRepair(
    path.resolve(productRoot),
    await readStartRepairFile(intent, "intent"),
    await readStartRepairFile(receipt, "receipt"),
  );
  return { blocked: false, installed: Boolean(intentState && receiptState) };
}

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

export async function loadStableBackendEnvironment({
  backendRoot = defaultBackendRoot,
  environment = process.env,
} = {}) {
  const merged = { ...environment };
  const envFile = path.join(path.resolve(backendRoot), ".env");
  const handle = await fs.open(envFile, "r").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return merged;
  let source;
  try {
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(envFile)]);
    if (
      !opened.isFile()
      || named.isSymbolicLink()
      || opened.nlink !== 1
      || opened.dev !== named.dev
      || opened.ino !== named.ino
      || opened.size > MAXIMUM_ENV_BYTES
    ) throw new Error("BONNI_STABLE_BACKEND_ENV_UNSAFE");
    source = await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
  const { parse } = await import("dotenv");
  const parsed = parse(source);
  for (const [key, value] of Object.entries(parsed)) {
    if (STABLE_ENV_FORBIDDEN_KEYS.has(key) || merged[key] !== undefined) continue;
    merged[key] = value;
  }
  return merged;
}

export async function bootstrapLocalRunActive({
  productRoot = defaultProductRoot,
  backendRoot = defaultBackendRoot,
  environment = process.env,
  runRoot = null,
} = {}) {
  const resolvedProductRoot = path.resolve(productRoot);
  const resolvedRunRoot = path.resolve(runRoot || path.join(resolvedProductRoot, "RUN"));
  const modulePath = path.join(path.resolve(backendRoot), "scripts", "runcontainer", "runcontainer-lib.mjs");
  const { resolveProgramSlot, stageProgramTree } = await import(pathToFileURL(modulePath).href);
  const active = await resolveProgramSlot("active", { runRoot: resolvedRunRoot, verify: true });
  if (active) return active;
  const packageJson = JSON.parse(await fs.readFile(path.join(path.resolve(backendRoot), "package.json"), "utf8"));
  return stageProgramTree({
    role: "active",
    sourceRoot: resolvedProductRoot,
    runRoot: resolvedRunRoot,
    version: String(packageJson.version || "unknown"),
    // A fallback Active slot is a runnable program generation, not only a
    // source snapshot. Keep the verified backend runtime dependencies inside
    // that generation while excluding npm command shims and frontend tooling.
    includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
    excludePaths: ["SYSTEM/backend/node_modules/.bin"],
    environment: {
      ...environment,
      BONNI_PRODUCT_ROOT: resolvedProductRoot,
      RUNCONTAINER_ROOT: resolvedRunRoot,
    },
  });
}

export async function resolveHostRunLayout({
  productRoot = defaultProductRoot,
  backendRoot = defaultBackendRoot,
  environment = process.env,
} = {}) {
  const resolvedProductRoot = path.resolve(productRoot);
  const modulePath = path.join(
    path.resolve(backendRoot),
    "scripts",
    "runcontainer",
    "run-layout.mjs",
  );
  const moduleState = await fs.lstat(modulePath).catch(() => null);
  if (!moduleState?.isFile() || moduleState.isSymbolicLink()) {
    return Object.freeze({
      version: 1,
      programSlotsRoot: path.resolve(environment.RUNCONTAINER_ROOT || path.join(resolvedProductRoot, "RUN")),
      runtimeStateRoot: path.resolve(environment.RUN_SYSTEM_ROOT || path.join(resolvedProductRoot, "run_system")),
      storageRoot: path.resolve(environment.BONNI_STORAGE_ROOT || path.join(resolvedProductRoot, "run_system", "storage")),
    });
  }
  const { readRunLayoutReceipt, resolveRunLayout } = await import(pathToFileURL(modulePath).href);
  const v2Environment = { ...environment };
  delete v2Environment.RUNCONTAINER_ROOT;
  delete v2Environment.RUN_SYSTEM_ROOT;
  const layout = resolveRunLayout({ productRoot: resolvedProductRoot, environment: v2Environment });
  const receipt = await readRunLayoutReceipt(layout, { allowMissing: true });
  if (receipt) {
    return Object.freeze({
      version: 2,
      receipt,
      runInstallRoot: layout.runInstallRoot,
      runSystemRoot: layout.runSystemRoot,
      programSlotsRoot: layout.programSlotsRoot,
      controllerRoot: layout.controllerRoot,
      runtimeStateRoot: layout.runtimeStateRoot,
      storageRoot: path.join(layout.runtimeStateRoot, "storage"),
    });
  }
  const uncommittedProgramRoot = await fs.lstat(layout.programSlotsRoot).catch(() => null);
  if (uncommittedProgramRoot) {
    throw new Error("BONNI_RUN_LAYOUT_V2_RECEIPT_MISSING");
  }
  return Object.freeze({
    version: 1,
    programSlotsRoot: path.resolve(environment.RUNCONTAINER_ROOT || path.join(resolvedProductRoot, "RUN")),
    runtimeStateRoot: path.resolve(environment.RUN_SYSTEM_ROOT || path.join(resolvedProductRoot, "run_system")),
    storageRoot: path.resolve(environment.BONNI_STORAGE_ROOT || path.join(resolvedProductRoot, "run_system", "storage")),
  });
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

export async function signalTree(pid, signal, {
  platform = process.platform,
  spawnProcess = spawn,
  waitForTreeOfflineImpl = waitForTreeOffline,
  killProcess = process.kill.bind(process),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    const result = await new Promise((resolve) => {
      const taskkill = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", (error) => resolve({ error, code: null }));
      taskkill.once("close", (code) => resolve({ error: null, code }));
    });
    if (result.error) throw result.error;
    if (result.code !== 0 && !await waitForTreeOfflineImpl(pid, 2_000)) {
      throw new Error(`BONNI_BACKEND_TASKKILL_FAILED:${result.code}`);
    }
    return;
  }
  try {
    killProcess(-pid, signal);
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
  const stableEnvironment = hostTree
    ? await loadStableBackendEnvironment({ backendRoot: defaultBackendRoot, environment: process.env })
    : { ...process.env };
  const inheritedOwnerPid = Number(stableEnvironment.BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID || 0);
  const inheritedToken = String(stableEnvironment.BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN || "");
  const entry = hostTree
    ? path.join(defaultBackendRoot, "scripts", "setup", "local-source-update-supervisor.mjs")
    : selectBackendEntry({ environment: stableEnvironment });
  const localRunEnabled = hostTree;
  const hostRunLayout = localRunEnabled
    ? await resolveHostRunLayout({
      productRoot: defaultProductRoot,
      backendRoot: defaultBackendRoot,
      environment: stableEnvironment,
    })
    : null;
  const assertEntry = async () => {
    const state = await fs.lstat(entry).catch(() => null);
    if (state?.isFile() && !state.isSymbolicLink()) return;
    throw new Error(`BONNI_BACKEND_ENTRY_MISSING:${entry}`);
  };
  await assertEntry();

  if (hostTree) await assertNoOpenStartAutomationRepair(defaultProductRoot);

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
  let pendingSignal = null;
  let rejectSignalFailure;
  const signalFailure = new Promise((_resolve, reject) => { rejectSignalFailure = reject; });
  const forward = (signal) => {
    const tracked = activeChild;
    if (!tracked?.pid) {
      pendingSignal = signal;
      return;
    }
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
    // The host lease already exists here. Keep the first RUN-slot bootstrap
    // inside the ownership cleanup as well: a normal bootstrap failure must
    // not leave an unbound host receipt that blocks every following start.
    if (localRunEnabled) {
      await bootstrapLocalRunActive({
        productRoot: defaultProductRoot,
        backendRoot: defaultBackendRoot,
        environment: stableEnvironment,
        runRoot: hostRunLayout.programSlotsRoot,
      });
    }

    if (pendingSignal) {
      throw new Error(`BONNI_BACKEND_START_ABORTED:${pendingSignal}`);
    }

    // Close the source-file validation -> lease acquisition race before fork.
    await assertEntry();
    if (pendingSignal) {
      throw new Error(`BONNI_BACKEND_START_ABORTED:${pendingSignal}`);
    }
    const child = spawn(process.execPath, [entry], {
      cwd: defaultBackendRoot,
      env: {
        ...stableEnvironment,
        ...(localRunEnabled ? {
          BONNI_LOCAL_RUN_SLOTS: "1",
          BONNI_PRODUCT_ROOT: defaultProductRoot,
          BONNI_MODULE_PACKAGE_ROOT: path.join(defaultProductRoot, "SYSTEM"),
          ...(hostRunLayout.version === 2 ? {
            BONNI_RUN_INSTALL_ROOT: hostRunLayout.runInstallRoot,
            BONNI_RUN_SYSTEM_ROOT: hostRunLayout.runSystemRoot,
            BONNI_PROGRAM_SLOTS_ROOT: hostRunLayout.programSlotsRoot,
            BONNI_RUNTIME_STATE_ROOT: hostRunLayout.runtimeStateRoot,
          } : {}),
          RUNCONTAINER_ROOT: hostRunLayout.programSlotsRoot,
          RUN_SYSTEM_ROOT: hostRunLayout.runtimeStateRoot,
          BONNI_STORAGE_ROOT: hostRunLayout.storageRoot,
          BONNI_LOCAL_RUN_PUBLIC_PORT: "4000",
          BONNI_ACTIVE_INTERNAL_PORT: "4100",
          BONNI_CANDIDATE_INTERNAL_PORT: "4300",
        } : {}),
        ...(hostTree ? {
          BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID: String(leaseOwnerPid),
          BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN: leaseToken,
        } : {}),
      },
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    activeChild = trackChild(child);
    if (!Number.isSafeInteger(activeChild.pid) || activeChild.pid <= 0) {
      // spawn() reports launch failures asynchronously on Windows. Wait for
      // that definitive error before the finally block releases the still
      // unbound, exactly-owned lease.
      await activeChild.closed;
      if (activeChild.spawnError()) throw activeChild.spawnError();
      throw new Error("BONNI_BACKEND_CHILD_PID_UNAVAILABLE");
    }
    childStarted = true;
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
