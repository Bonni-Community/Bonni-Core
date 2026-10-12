import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { getProductRoot, getProjectRoot } from "../../../boot/run-system/run-system.paths.js";
import { createSystemBackup, validateSystemBackup } from "../backup/index.js";
import { queueLocalSourceUpdate } from "./local-source-inbox.service.js";
import { localSourceVersionRequiresLifecycle } from "./local-source-lifecycle-policy.js";
import { removeCoreLicenseVersion } from "../../../../platform/module-manager/licensing/central-license-catalog.service.js";

const SCHEMA = "bonni.local-source-deployment-lifecycle/v1";
const HOLD_DAYS = 14;
const HOLD_MS = HOLD_DAYS * 24 * 60 * 60_000;
const HOLD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ROLLBACK_INTENT_SCHEMA = "bonni.local-source-deployment-rollback-intent/v1";
const LIFECYCLE_LOCK_STALE_MS = 15 * 60_000;
const LIFECYCLE_LOCK_HEARTBEAT_MS = 5_000;
const LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;
const LIFECYCLE_LOCK_RETRY_MS = 40;

type LocalDeploymentState = "holding" | "rolling-back" | "rolled-back" | "finalized";

type LocalDeploymentLifecycle = {
  schemaVersion: typeof SCHEMA;
  protocol: "bonni-deployment-lifecycle/1";
  mode: "local-source";
  status: LocalDeploymentState;
  state: LocalDeploymentState;
  generation: number;
  holdId: string;
  holdDays: typeof HOLD_DAYS;
  activatedAt: string;
  holdUntil: string;
  previousVersion: string;
  targetVersion: string;
  activeVersion: string;
  sourceUpdateId: string;
  sourceManifestSha256: string;
  rollbackUpdateId: string;
  rollbackManifestSha256: string;
  holdPath: string;
  blocksUpdates: boolean;
  followUpdatesBlocked: boolean;
  canFinalize: boolean;
  canRollback: boolean;
  blockReason: string | null;
  finalizeReason?: string | null;
  finalizedAt?: string | null;
  rollbackRequestedAt?: string | null;
  rolledBackAt?: string | null;
  rollbackIntentId?: string | null;
};

type LifecycleReceipt = {
  lifecycle: LocalDeploymentLifecycle;
  sha256: string;
};

type RollbackIntentPhase = "staging" | "prepared" | "published" | "queued";

type RollbackIntent = {
  schemaVersion: typeof ROLLBACK_INTENT_SCHEMA;
  intentId: string;
  phase: RollbackIntentPhase;
  holdId: string;
  lifecycleGeneration: number;
  lifecycleSha256: string;
  rollbackUpdateId: string;
  rollbackManifestSha256: string;
  backupId: string | null;
  createdAt: string;
  updatedAt: string;
};

function stateRoot() {
  return path.join(getProductRoot(), "SYSTEM", ".bonni-source-update");
}

function lifecycleFile() {
  return path.join(stateRoot(), "deployment-lifecycle.json");
}

function lifecycleLockRoot() {
  return path.join(stateRoot(), "deployment-lifecycle.lock");
}

function rollbackIntentFile() {
  return path.join(stateRoot(), "rollback-intent.json");
}

function rollbackStagingRoot(intentId: string) {
  return path.join(stateRoot(), "rollback-staging", intentId);
}

function rollbackStagingPackage(intentId: string) {
  return path.join(rollbackStagingRoot(intentId), "package");
}

function rollbackInboxTarget(updateId: string) {
  return path.join(getProductRoot(), "UPDATE", "inbox", updateId);
}

function validVersion(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
}

function parseLifecycle(value: unknown): LocalDeploymentLifecycle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = String(record.status || "");
  const activatedAt = Date.parse(String(record.activatedAt || ""));
  const holdUntil = Date.parse(String(record.holdUntil || ""));
  if (
    record.schemaVersion !== SCHEMA
    || record.protocol !== "bonni-deployment-lifecycle/1"
    || record.mode !== "local-source"
    || !["holding", "rolling-back", "rolled-back", "finalized"].includes(status)
    || record.state !== status
    || !Number.isSafeInteger(record.generation) || Number(record.generation) <= 0
    || !HOLD_ID.test(String(record.holdId || ""))
    || record.holdDays !== HOLD_DAYS
    || !Number.isFinite(activatedAt)
    || !Number.isFinite(holdUntil)
    || holdUntil - activatedAt !== HOLD_MS
    || !validVersion(record.previousVersion)
    || !validVersion(record.targetVersion)
    || !validVersion(record.activeVersion)
    || !UPDATE_ID.test(String(record.sourceUpdateId || ""))
    || !SHA256.test(String(record.sourceManifestSha256 || ""))
    || !UPDATE_ID.test(String(record.rollbackUpdateId || ""))
    || !SHA256.test(String(record.rollbackManifestSha256 || ""))
    || record.holdPath !== `deployment-holds/${record.holdId}`
    || typeof record.blocksUpdates !== "boolean"
    || typeof record.followUpdatesBlocked !== "boolean"
    || typeof record.canFinalize !== "boolean"
    || typeof record.canRollback !== "boolean"
    || (record.rollbackIntentId !== undefined
      && record.rollbackIntentId !== null
      && !HOLD_ID.test(String(record.rollbackIntentId)))
  ) return null;

  const activeIsTarget = record.activeVersion === record.targetVersion;
  const activeIsPrevious = record.activeVersion === record.previousVersion;
  const blocked = record.blocksUpdates === true && record.followUpdatesBlocked === true;
  const unblocked = record.blocksUpdates === false && record.followUpdatesBlocked === false;
  if (
    (status === "holding" && (
      !activeIsTarget
      || !blocked
      || record.canFinalize !== true
      || record.canRollback !== true
      || typeof record.blockReason !== "string"
      || !record.blockReason
    ))
    || (status === "rolling-back" && (
      !activeIsTarget
      || !blocked
      || record.canFinalize !== false
      || record.canRollback !== false
      || typeof record.blockReason !== "string"
      || !record.blockReason
      || !Number.isFinite(Date.parse(String(record.rollbackRequestedAt || "")))
    ))
    || (status === "finalized" && (
      !activeIsTarget
      || !unblocked
      || record.canFinalize !== false
      || record.canRollback !== false
      || record.blockReason !== null
      || !["developer", "automatic-14-day-expiry"].includes(String(record.finalizeReason || ""))
      || !Number.isFinite(Date.parse(String(record.finalizedAt || "")))
    ))
    || (status === "rolled-back" && (
      !activeIsPrevious
      || !unblocked
      || record.canFinalize !== false
      || record.canRollback !== false
      || record.blockReason !== null
      || !Number.isFinite(Date.parse(String(record.rolledBackAt || "")))
    ))
  ) return null;

  return record as unknown as LocalDeploymentLifecycle;
}

async function readJson(file: string) {
  const source = await fs.readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return null;
  try { return JSON.parse(source); } catch { throw new Error("LOCAL_DEPLOYMENT_STATE_INVALID"); }
}

async function readLifecycle() {
  const receipt = await readLifecycleReceipt();
  return receipt?.lifecycle || null;
}

function activeManifestRequiresLifecycle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const marker = record.localDeploymentLifecycle;
  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    const lifecycleMarker = marker as Record<string, unknown>;
    if (
      lifecycleMarker.schemaVersion === SCHEMA
      && lifecycleMarker.mode === "local-source"
      && lifecycleMarker.required === true
    ) return true;
  }

  // Only the exact historic 0.1.19+a bootstrap predates lifecycle receipts.
  // Every later maintenance revision, including 0.1.20+e, must remain bound
  // to the ordinary 14-day lifecycle contract.
  return localSourceVersionRequiresLifecycle(
    (record.versions as Record<string, unknown> | undefined)?.coreVersion,
  );
}

export async function isLocalSourceDeploymentLifecycleExpected() {
  const [active, backendPackage] = await Promise.all([
    readJson(path.join(stateRoot(), "active-manifest.json")),
    readJson(path.join(getProjectRoot(), "SYSTEM", "backend", "package.json")),
  ]);
  return activeManifestRequiresLifecycle(active)
    || localSourceVersionRequiresLifecycle((backendPackage as Record<string, unknown> | null)?.version);
}

async function readLifecycleReceipt(): Promise<LifecycleReceipt | null> {
  const source = await fs.readFile(lifecycleFile(), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error("LOCAL_DEPLOYMENT_STATE_INVALID"); }
  const lifecycle = parseLifecycle(raw);
  if (!lifecycle) throw new Error("LOCAL_DEPLOYMENT_STATE_INVALID");
  if (["holding", "rolling-back", "finalized"].includes(lifecycle.status)) {
    await assertForwardActive(lifecycle);
  } else {
    await assertRolledBackActive(lifecycle);
  }
  if (["holding", "rolling-back"].includes(lifecycle.status)) {
    await assertRollbackHoldPackage(lifecycle);
  }
  return {
    lifecycle,
    sha256: crypto.createHash("sha256").update(source, "utf8").digest("hex"),
  };
}

async function writeLifecycle(value: LocalDeploymentLifecycle) {
  await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  const target = lifecycleFile();
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporary, target);
}

async function assertLifecycleReceiptCurrent(receipt: LifecycleReceipt) {
  const current = await readLifecycleReceipt();
  if (
    !current
    || current.sha256 !== receipt.sha256
    || current.lifecycle.holdId !== receipt.lifecycle.holdId
    || current.lifecycle.generation !== receipt.lifecycle.generation
    || current.lifecycle.status !== receipt.lifecycle.status
  ) {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_LIFECYCLE_CAS_CONFLICT"), {
      code: "LOCAL_DEPLOYMENT_LIFECYCLE_CAS_CONFLICT",
      statusCode: 409,
    });
  }
}

async function writeLifecycleCas(receipt: LifecycleReceipt, value: LocalDeploymentLifecycle) {
  await assertLifecycleReceiptCurrent(receipt);
  await writeLifecycle(value);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLifecycleLock(operation: string) {
  await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  const lockRoot = lifecycleLockRoot();
  const token = `${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockRoot, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(lockRoot, "owner.json"), `${JSON.stringify({
          token,
          pid: process.pid,
          operation,
          acquiredAt: new Date().toISOString(),
        })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await fs.rm(lockRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockRoot, now, now).catch(() => undefined);
      }, LIFECYCLE_LOCK_HEARTBEAT_MS);
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        const owner = await readJson(path.join(lockRoot, "owner.json")).catch(() => null) as Record<string, unknown> | null;
        if (owner?.token !== token) return;
        const released = `${lockRoot}.released-${token}`;
        try {
          await fs.rename(lockRoot, released);
          await fs.rm(released, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const state = await fs.stat(lockRoot).catch((statError) => {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw statError;
      });
      if (state && Date.now() - state.mtimeMs > LIFECYCLE_LOCK_STALE_MS) {
        const stale = `${lockRoot}.stale-${token}`;
        try {
          await fs.rename(lockRoot, stale);
          await fs.rm(stale, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes((staleError as NodeJS.ErrnoException).code || "")) {
            throw staleError;
          }
        }
      }
      if (Date.now() - startedAt >= LIFECYCLE_LOCK_TIMEOUT_MS) {
        throw Object.assign(new Error("LOCAL_DEPLOYMENT_LIFECYCLE_BUSY"), {
          code: "LOCAL_DEPLOYMENT_LIFECYCLE_BUSY",
          statusCode: 409,
        });
      }
      await delay(LIFECYCLE_LOCK_RETRY_MS);
    }
  }
}

async function withLifecycleLock<T>(operation: string, action: () => Promise<T>) {
  const release = await acquireLifecycleLock(operation);
  try {
    return await action();
  } finally {
    await release();
  }
}

function parseRollbackIntent(value: unknown): RollbackIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== ROLLBACK_INTENT_SCHEMA
    || !HOLD_ID.test(String(record.intentId || ""))
    || !["staging", "prepared", "published", "queued"].includes(String(record.phase || ""))
    || !HOLD_ID.test(String(record.holdId || ""))
    || !Number.isSafeInteger(record.lifecycleGeneration)
    || Number(record.lifecycleGeneration) <= 0
    || !SHA256.test(String(record.lifecycleSha256 || ""))
    || !UPDATE_ID.test(String(record.rollbackUpdateId || ""))
    || !SHA256.test(String(record.rollbackManifestSha256 || ""))
    || (record.backupId !== null && (typeof record.backupId !== "string" || !record.backupId.trim() || record.backupId.length > 256))
    || !Number.isFinite(Date.parse(String(record.createdAt || "")))
    || !Number.isFinite(Date.parse(String(record.updatedAt || "")))
  ) return null;
  return record as unknown as RollbackIntent;
}

async function readRollbackIntent() {
  const raw = await readJson(rollbackIntentFile());
  if (raw === null) return null;
  const intent = parseRollbackIntent(raw);
  if (!intent) throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_INTENT_INVALID");
  return intent;
}

async function writeRollbackIntent(intent: RollbackIntent) {
  await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  const target = rollbackIntentFile();
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporary, target);
}

async function updateRollbackIntent(intent: RollbackIntent, phase: RollbackIntentPhase) {
  const next = {
    ...intent,
    phase,
    updatedAt: new Date().toISOString(),
  };
  await writeRollbackIntent(next);
  return next;
}

function assertIntentMatchesLifecycle(
  intent: RollbackIntent,
  lifecycle: LocalDeploymentLifecycle,
  lifecycleSha256?: string,
) {
  const generationMatches = lifecycle.status === "holding"
    ? lifecycle.generation === intent.lifecycleGeneration
    : lifecycle.status === "rolling-back"
      && lifecycle.generation === intent.lifecycleGeneration + 1;
  if (
    intent.holdId !== lifecycle.holdId
    || (lifecycle.status === "holding" && lifecycleSha256 !== intent.lifecycleSha256)
    || intent.rollbackUpdateId !== lifecycle.rollbackUpdateId
    || intent.rollbackManifestSha256 !== lifecycle.rollbackManifestSha256
    || !generationMatches
    || (lifecycle.rollbackIntentId && lifecycle.rollbackIntentId !== intent.intentId)
  ) {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_ROLLBACK_INTENT_MISMATCH"), {
      code: "LOCAL_DEPLOYMENT_ROLLBACK_INTENT_MISMATCH",
      statusCode: 409,
    });
  }
}

function publicLifecycle(lifecycle: LocalDeploymentLifecycle) {
  return {
    protocol: lifecycle.protocol,
    mode: lifecycle.mode,
    status: lifecycle.status,
    state: lifecycle.state,
    generation: lifecycle.generation,
    holdId: lifecycle.holdId,
    holdDays: lifecycle.holdDays,
    activatedAt: lifecycle.activatedAt,
    holdUntil: lifecycle.holdUntil,
    previousVersion: lifecycle.previousVersion,
    targetVersion: lifecycle.targetVersion,
    activeVersion: lifecycle.activeVersion,
    blocksUpdates: lifecycle.blocksUpdates,
    followUpdatesBlocked: lifecycle.followUpdatesBlocked,
    canFinalize: lifecycle.canFinalize,
    canRollback: lifecycle.canRollback,
    blockReason: lifecycle.blockReason,
    finalizeReason: lifecycle.finalizeReason || null,
    finalizedAt: lifecycle.finalizedAt || null,
    rollbackRequestedAt: lifecycle.rollbackRequestedAt || null,
    rolledBackAt: lifecycle.rolledBackAt || null,
  };
}

function assertProof(lifecycle: LocalDeploymentLifecycle, input: { holdId: string; generation: number }) {
  if (input.holdId !== lifecycle.holdId || input.generation !== lifecycle.generation) {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_LIFECYCLE_PROOF_MISMATCH"), {
      code: "LOCAL_DEPLOYMENT_LIFECYCLE_PROOF_MISMATCH",
      statusCode: 409,
    });
  }
}

async function assertForwardActive(lifecycle: LocalDeploymentLifecycle) {
  const active = await readJson(path.join(stateRoot(), "active-manifest.json"));
  if (
    !active
    || typeof active !== "object"
    || Array.isArray(active)
    || (active as Record<string, unknown>).updateId !== lifecycle.sourceUpdateId
    || (active as Record<string, unknown>).manifestSha256 !== lifecycle.sourceManifestSha256
    || ((active as Record<string, unknown>).versions as Record<string, unknown> | undefined)?.coreVersion !== lifecycle.targetVersion
  ) {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_ACTIVE_RECEIPT_MISMATCH"), {
      code: "LOCAL_DEPLOYMENT_ACTIVE_RECEIPT_MISMATCH",
      statusCode: 409,
    });
  }
}

async function assertRolledBackActive(lifecycle: LocalDeploymentLifecycle) {
  const active = await readJson(path.join(stateRoot(), "active-manifest.json"));
  if (
    !active
    || typeof active !== "object"
    || Array.isArray(active)
    || (active as Record<string, unknown>).updateId !== lifecycle.rollbackUpdateId
    || (active as Record<string, unknown>).manifestSha256 !== lifecycle.rollbackManifestSha256
    || ((active as Record<string, unknown>).versions as Record<string, unknown> | undefined)?.coreVersion !== lifecycle.previousVersion
  ) {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_ACTIVE_RECEIPT_MISMATCH"), {
      code: "LOCAL_DEPLOYMENT_ACTIVE_RECEIPT_MISMATCH",
      statusCode: 409,
    });
  }
}

async function removeHold(lifecycle: LocalDeploymentLifecycle) {
  const expected = path.join(stateRoot(), "deployment-holds", lifecycle.holdId);
  const resolved = path.resolve(expected);
  const holdsRoot = path.resolve(stateRoot(), "deployment-holds");
  if (path.dirname(resolved) !== holdsRoot) throw new Error("LOCAL_DEPLOYMENT_HOLD_PATH_INVALID");
  const state = await fs.lstat(resolved).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!state) return;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("LOCAL_DEPLOYMENT_HOLD_PATH_UNSAFE");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function cleanupLifecycleLicenses(lifecycle: LocalDeploymentLifecycle) {
  // Core licenses are keyed by the visible version. Two developer builds with
  // the same version therefore share one catalog entry; deleting either side
  // would delete the license of the still-active program stand as well.
  if (lifecycle.previousVersion === lifecycle.targetVersion) return;
  const systemRoot = path.join(getProductRoot(), "SYSTEM");
  if (lifecycle.status === "finalized") {
    await removeCoreLicenseVersion(lifecycle.previousVersion, "lifecycle-finalized", systemRoot);
  } else if (lifecycle.status === "rolled-back") {
    await removeCoreLicenseVersion(lifecycle.targetVersion, "lifecycle-rolled-back", systemRoot);
  }
}

async function finalizeLifecycle(
  receipt: LifecycleReceipt,
  reason: "developer" | "automatic-14-day-expiry",
) {
  const lifecycle = receipt.lifecycle;
  if (lifecycle.status === "finalized") return lifecycle;
  if (lifecycle.status !== "holding") {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_LIFECYCLE_NOT_FINALIZABLE"), {
      code: "LOCAL_DEPLOYMENT_LIFECYCLE_NOT_FINALIZABLE",
      statusCode: 409,
    });
  }
  await assertForwardActive(lifecycle);
  const finalizedAt = new Date().toISOString();
  const finalized: LocalDeploymentLifecycle = {
    ...lifecycle,
    status: "finalized",
    state: "finalized",
    generation: lifecycle.generation + 1,
    activeVersion: lifecycle.targetVersion,
    blocksUpdates: false,
    followUpdatesBlocked: false,
    canFinalize: false,
    canRollback: false,
    blockReason: null,
    finalizeReason: reason,
    finalizedAt,
  };
  // Commit the non-rollbackable state before deleting the protected hold. A
  // crash can therefore only leave a harmless hold directory behind; the
  // next reconciliation removes it. It can never leave a holding lifecycle
  // whose rollback payload was already destroyed.
  await writeLifecycleCas(receipt, finalized);
  await cleanupLifecycleLicenses(finalized);
  await removeHold(finalized);
  return finalized;
}

export async function finalizeExpiredLocalSourceDeploymentLifecycle(now = Date.now()) {
  try {
    return await withLifecycleLock("automatic-finalize", async () => {
      let receipt = await reconcileRollbackIntentLocked(await readLifecycleReceipt());
      if (!receipt) return null;
      const { lifecycle } = receipt;
      if (lifecycle.status !== "holding") return publicLifecycle(lifecycle);
      if (Date.parse(lifecycle.holdUntil) > now) return publicLifecycle(lifecycle);
      return publicLifecycle(await finalizeLifecycle(receipt, "automatic-14-day-expiry"));
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "LOCAL_DEPLOYMENT_LIFECYCLE_BUSY") throw error;
    const lifecycle = await readLifecycle();
    return lifecycle ? publicLifecycle(lifecycle) : null;
  }
}

export async function getLocalSourceDeploymentLifecycle() {
  return finalizeExpiredLocalSourceDeploymentLifecycle();
}

export async function finalizeLocalSourceDeploymentLifecycle(input: { holdId: string; generation: number }) {
  const observed = await readLifecycle();
  if (!observed) return null;
  assertProof(observed, input);
  return withLifecycleLock("developer-finalize", async () => {
    const receipt = await reconcileRollbackIntentLocked(await readLifecycleReceipt());
    if (!receipt) return null;
    // The public proof is checked again only after the common exclusive lock
    // has been acquired. This closes the finalize-vs-rollback TOCTOU window.
    assertProof(receipt.lifecycle, input);
    const finalized = await finalizeLifecycle(receipt, "developer");
    return {
      ok: true,
      accepted: true,
      deploymentLifecycle: publicLifecycle(finalized),
    };
  });
}

async function copyTree(source: string, destination: string) {
  const state = await fs.lstat(source);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_PACKAGE_UNSAFE");
  await fs.mkdir(destination);
  const entries = await fs.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_PACKAGE_UNSAFE");
    const childSource = path.join(source, entry.name);
    const childDestination = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(childSource, childDestination);
      continue;
    }
    const childState = await fs.lstat(childSource);
    if (!childState.isFile() || childState.nlink > 1) throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_PACKAGE_UNSAFE");
    await fs.copyFile(childSource, childDestination, fsConstants.COPYFILE_EXCL);
  }
}

type RollbackPackageIdentity = Pick<LocalDeploymentLifecycle, "rollbackUpdateId" | "rollbackManifestSha256">;

async function assertRollbackPackage(root: string, identity: RollbackPackageIdentity) {
  const rootState = await fs.lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_PACKAGE_UNSAFE");
  }
  const manifest = path.join(root, "bonni-source-update.json");
  const manifestState = await fs.lstat(manifest);
  if (!manifestState.isFile() || manifestState.isSymbolicLink() || manifestState.nlink > 1) {
    throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_MANIFEST_UNSAFE");
  }
  const raw = await fs.readFile(manifest);
  const manifestSha256 = crypto.createHash("sha256").update(raw).digest("hex");
  if (manifestSha256 !== identity.rollbackManifestSha256) {
    throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_MANIFEST_CHANGED");
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch {
    throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_MANIFEST_INVALID");
  }
  if (parsed.updateId !== identity.rollbackUpdateId) {
    throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_MANIFEST_ID_MISMATCH");
  }
}

async function assertRollbackHoldPackage(lifecycle: LocalDeploymentLifecycle) {
  const holdRoot = path.join(stateRoot(), "deployment-holds", lifecycle.holdId);
  const packageSource = path.join(holdRoot, "package");
  await assertRollbackPackage(packageSource, lifecycle);
  return packageSource;
}

async function exactRollbackAlreadyQueued(identity: RollbackPackageIdentity) {
  const [request, processingRequest, pending] = await Promise.all([
    readJson(path.join(stateRoot(), "control-center", "request.json")).catch(() => null),
    readJson(path.join(stateRoot(), "control-center", "request.processing.json")).catch(() => null),
    readJson(path.join(stateRoot(), "pending-update.json")).catch(() => null),
  ]) as Array<Record<string, unknown> | null>;
  return [request, processingRequest, pending].some((record) => (
    record?.updateId === identity.rollbackUpdateId
    && record?.manifestSha256 === identity.rollbackManifestSha256
  ));
}

async function prepareRollbackIntent(
  receipt: LifecycleReceipt,
  backupId: string,
) {
  const { lifecycle } = receipt;
  if (await readRollbackIntent()) {
    throw Object.assign(new Error("LOCAL_DEPLOYMENT_ROLLBACK_INTENT_ALREADY_PRESENT"), {
      code: "LOCAL_DEPLOYMENT_ROLLBACK_INTENT_ALREADY_PRESENT",
      statusCode: 409,
    });
  }
  const now = new Date().toISOString();
  let intent: RollbackIntent = {
    schemaVersion: ROLLBACK_INTENT_SCHEMA,
    intentId: `rollback-${Date.now()}-${crypto.randomBytes(12).toString("hex")}`,
    phase: "staging",
    holdId: lifecycle.holdId,
    lifecycleGeneration: lifecycle.generation,
    lifecycleSha256: receipt.sha256,
    rollbackUpdateId: lifecycle.rollbackUpdateId,
    rollbackManifestSha256: lifecycle.rollbackManifestSha256,
    backupId,
    createdAt: now,
    updatedAt: now,
  };
  await writeRollbackIntent(intent);

  const stagingRoot = rollbackStagingRoot(intent.intentId);
  try {
    const packageSource = await assertRollbackHoldPackage(lifecycle);
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await copyTree(packageSource, rollbackStagingPackage(intent.intentId));
    await assertRollbackPackage(rollbackStagingPackage(intent.intentId), lifecycle);
    intent = await updateRollbackIntent(intent, "prepared");
    return intent;
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    const current = await readRollbackIntent().catch(() => null);
    if (current?.intentId === intent.intentId) {
      await fs.rm(rollbackIntentFile(), { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function publishRollbackPackage(
  lifecycle: LocalDeploymentLifecycle,
  intent: RollbackIntent,
) {
  assertIntentMatchesLifecycle(intent, lifecycle);
  const inbox = path.join(getProductRoot(), "UPDATE", "inbox");
  const target = rollbackInboxTarget(lifecycle.rollbackUpdateId);
  await fs.mkdir(inbox, { recursive: true });
  const entries = await fs.readdir(inbox);
  if (entries.some((entry) => entry !== lifecycle.rollbackUpdateId)) {
    throw new Error("LOCAL_DEPLOYMENT_UPDATE_INBOX_NOT_EMPTY");
  }

  const targetState = await fs.lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (targetState) {
    await assertRollbackPackage(target, lifecycle);
    await fs.rm(rollbackStagingRoot(intent.intentId), { recursive: true, force: true });
    return target;
  }

  const stagingPackage = rollbackStagingPackage(intent.intentId);
  await assertRollbackPackage(stagingPackage, lifecycle);
  await fs.rename(stagingPackage, target);
  await assertRollbackPackage(target, lifecycle);
  await fs.rm(rollbackStagingRoot(intent.intentId), { recursive: true, force: true });
  return target;
}

async function cleanupRollbackIntent(
  intent: RollbackIntent,
  options: { removePublishedPackage: boolean },
) {
  await fs.rm(rollbackStagingRoot(intent.intentId), { recursive: true, force: true }).catch(() => undefined);
  if (options.removePublishedPackage && !await exactRollbackAlreadyQueued(intent)) {
    const target = rollbackInboxTarget(intent.rollbackUpdateId);
    const targetState = await fs.lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (targetState) {
      await assertRollbackPackage(target, intent);
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  const current = await readRollbackIntent().catch(() => null);
  if (current?.intentId === intent.intentId) {
    await fs.rm(rollbackIntentFile(), { force: true });
  }
}

async function queueRollbackIntent(
  lifecycle: LocalDeploymentLifecycle,
  intent: RollbackIntent,
) {
  if (await exactRollbackAlreadyQueued(lifecycle)) {
    const queuedIntent = await updateRollbackIntent(intent, "queued");
    await cleanupRollbackIntent(queuedIntent, { removePublishedPackage: false });
    return { ok: true, accepted: false, existing: true };
  }
  const queued = await queueLocalSourceUpdate({
    updateId: lifecycle.rollbackUpdateId,
    manifestSha256: lifecycle.rollbackManifestSha256,
  });
  if (!queued.ok && !await exactRollbackAlreadyQueued(lifecycle)) return queued;
  const queuedIntent = await updateRollbackIntent(intent, "queued");
  await cleanupRollbackIntent(queuedIntent, { removePublishedPackage: false });
  return queued.ok ? queued : { ok: true, accepted: false, existing: true };
}

function rollingBackLifecycle(
  lifecycle: LocalDeploymentLifecycle,
  intent: RollbackIntent,
) {
  return {
    ...lifecycle,
    status: "rolling-back",
    state: "rolling-back",
    generation: lifecycle.generation + 1,
    blocksUpdates: true,
    followUpdatesBlocked: true,
    canFinalize: false,
    canRollback: false,
    blockReason: "Der gesicherte Vorgängerstand wird jetzt kontrolliert wiederhergestellt.",
    rollbackRequestedAt: new Date().toISOString(),
    rollbackIntentId: intent.intentId,
  } satisfies LocalDeploymentLifecycle;
}

async function reconcileRollbackIntentLocked(receipt: LifecycleReceipt | null) {
  const intent = await readRollbackIntent();
  if (!receipt) {
    if (intent) await cleanupRollbackIntent(intent, { removePublishedPackage: true });
    return null;
  }
  let { lifecycle } = receipt;

  if (["finalized", "rolled-back"].includes(lifecycle.status)) {
    await cleanupLifecycleLicenses(lifecycle);
    await removeHold(lifecycle);
    if (intent) await cleanupRollbackIntent(intent, { removePublishedPackage: true });
    return readLifecycleReceipt();
  }

  if (!intent) {
    const target = rollbackInboxTarget(lifecycle.rollbackUpdateId);
    const targetState = await fs.lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!targetState) return receipt;
    await assertRollbackPackage(target, lifecycle);
    if (lifecycle.status === "holding") {
      if (!await exactRollbackAlreadyQueued(lifecycle)) {
        await fs.rm(target, { recursive: true, force: true });
      }
      return receipt;
    }
    if (await exactRollbackAlreadyQueued(lifecycle)) return receipt;
    const now = new Date().toISOString();
    const recoveredIntent: RollbackIntent = {
      schemaVersion: ROLLBACK_INTENT_SCHEMA,
      intentId: lifecycle.rollbackIntentId || `rollback-recovered-${crypto.randomBytes(12).toString("hex")}`,
      phase: "published",
      holdId: lifecycle.holdId,
      lifecycleGeneration: lifecycle.generation - 1,
      lifecycleSha256: receipt.sha256,
      rollbackUpdateId: lifecycle.rollbackUpdateId,
      rollbackManifestSha256: lifecycle.rollbackManifestSha256,
      backupId: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeRollbackIntent(recoveredIntent);
    await queueRollbackIntent(lifecycle, recoveredIntent);
    return readLifecycleReceipt();
  }

  assertIntentMatchesLifecycle(intent, lifecycle, receipt.sha256);
  if (lifecycle.status === "holding" && intent.phase === "staging") {
    await cleanupRollbackIntent(intent, { removePublishedPackage: true });
    return receipt;
  }
  if (lifecycle.status === "rolling-back" && intent.phase === "staging") {
    throw new Error("LOCAL_DEPLOYMENT_ROLLBACK_INTENT_INVALID_PHASE");
  }

  let currentIntent = intent;
  if (lifecycle.status === "holding") {
    await assertForwardActive(lifecycle);
    await assertLifecycleReceiptCurrent(receipt);
    const rollingBack = rollingBackLifecycle(lifecycle, currentIntent);
    await writeLifecycleCas(receipt, rollingBack);
    const current = await readLifecycleReceipt();
    if (!current) throw new Error("LOCAL_DEPLOYMENT_STATE_INVALID");
    receipt = current;
    lifecycle = current.lifecycle;
  }

  await publishRollbackPackage(lifecycle, currentIntent);
  if (currentIntent.phase !== "published" && currentIntent.phase !== "queued") {
    currentIntent = await updateRollbackIntent(currentIntent, "published");
  }
  await queueRollbackIntent(lifecycle, currentIntent);
  return readLifecycleReceipt();
}

export async function rollbackLocalSourceDeploymentLifecycle(input: { holdId: string; generation: number }) {
  const observed = await readLifecycle();
  if (!observed) return null;
  assertProof(observed, input);

  return withLifecycleLock("developer-rollback", async () => {
    let receipt = await reconcileRollbackIntentLocked(await readLifecycleReceipt());
    if (!receipt) return null;
    let { lifecycle } = receipt;
    // A stale UI proof must never race a finalize request. Check it again only
    // after obtaining the same exclusive lock used by finalize and expiry.
    assertProof(lifecycle, input);
    if (lifecycle.status !== "holding" || !lifecycle.canRollback) {
      throw Object.assign(new Error("LOCAL_DEPLOYMENT_LIFECYCLE_NOT_ROLLBACKABLE"), {
        code: "LOCAL_DEPLOYMENT_LIFECYCLE_NOT_ROLLBACKABLE",
        statusCode: 409,
      });
    }
    if (Date.parse(lifecycle.holdUntil) <= Date.now()) {
      await finalizeLifecycle(receipt, "automatic-14-day-expiry");
      throw Object.assign(new Error("LOCAL_DEPLOYMENT_LIFECYCLE_HOLD_EXPIRED"), {
        code: "LOCAL_DEPLOYMENT_LIFECYCLE_HOLD_EXPIRED",
        statusCode: 409,
      });
    }
    await assertForwardActive(lifecycle);

    const backupReason = `before-local-source-rollback:${lifecycle.rollbackUpdateId}:${lifecycle.rollbackManifestSha256}`;
    const backup = await createSystemBackup({ reason: backupReason });
    if (!backup.ok || !backup.backup) {
      return {
        ok: false,
        error: "LOCAL_DEPLOYMENT_ROLLBACK_BACKUP_FAILED",
        message: backup.message || "Die Sicherung vor dem Rückfall konnte nicht erstellt werden.",
      };
    }
    const validation = await validateSystemBackup(backup.backup.id);
    if (
      !validation.ok
      || validation.id !== backup.backup.id
      || validation.backup?.id !== backup.backup.id
      || validation.backup.reason !== backupReason
    ) {
      return {
        ok: false,
        error: "LOCAL_DEPLOYMENT_ROLLBACK_BACKUP_INVALID",
        message: "Die Sicherung vor dem Rückfall konnte nicht vollständig geprüft werden.",
      };
    }

    const intent = await prepareRollbackIntent(receipt, backup.backup.id);
    // Backup and staging may take time. Re-check both the caller proof and the
    // active receipt immediately before the CAS transition/publication.
    assertProof(lifecycle, input);
    await assertForwardActive(lifecycle);
    await assertLifecycleReceiptCurrent(receipt);
    const rollingBack = rollingBackLifecycle(lifecycle, intent);
    await writeLifecycleCas(receipt, rollingBack);
    const current = await readLifecycleReceipt();
    if (!current) throw new Error("LOCAL_DEPLOYMENT_STATE_INVALID");
    receipt = current;
    lifecycle = current.lifecycle;

    await publishRollbackPackage(lifecycle, intent);
    const publishedIntent = await updateRollbackIntent(intent, "published");
    const queued = await queueRollbackIntent(lifecycle, publishedIntent);
    return {
      ...queued,
      backupId: backup.backup.id,
      deploymentLifecycle: publicLifecycle(lifecycle),
    };
  });
}
