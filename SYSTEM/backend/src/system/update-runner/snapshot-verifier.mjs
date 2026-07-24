import fs from "node:fs/promises";
import path from "node:path";

import { sha256File } from "./release-verifier.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const BACKUP_ID = /^backup-[A-Za-z0-9._-]{4,120}$/;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && !value.includes("\\") && !path.posix.isAbsolute(value)
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

async function inventory(root, current = root) {
  const base = path.resolve(root);
  const target = path.resolve(current);
  if (!isInside(target, base)) throw new Error("CUTOVER_SNAPSHOT_PATH_ESCAPE");
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error("CUTOVER_SNAPSHOT_SYMLINK_FORBIDDEN");
  const relative = path.relative(base, target).replaceAll("\\", "/");
  const result = [];
  if (relative) {
    if (stat.isDirectory()) result.push({ path: relative, kind: "directory", mode: stat.mode & 0o777 });
    else if (stat.isFile()) {
      result.push({ path: relative, kind: "file", mode: stat.mode & 0o777, sizeBytes: stat.size, sha256: await sha256File(target) });
      return result;
    } else throw new Error("CUTOVER_SNAPSHOT_SPECIAL_FILE_FORBIDDEN");
  }
  if (!stat.isDirectory()) return result;
  const children = await fs.readdir(target);
  children.sort(compareText);
  for (const child of children) result.push(...await inventory(base, path.join(target, child)));
  return result;
}

export function cutoverSnapshotPath(base, id) {
  if (!IDENTIFIER.test(String(id || ""))) throw new Error("CUTOVER_SNAPSHOT_ID_INVALID");
  const root = path.resolve(base);
  if (root === path.parse(root).root || root.length < 8) throw new Error("CUTOVER_SNAPSHOT_ROOT_INVALID");
  const target = path.join(root, `snapshot-${id}`);
  if (!isInside(target, root)) throw new Error("CUTOVER_SNAPSHOT_PATH_ESCAPE");
  return target;
}

function validateManifest(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1 || value.status !== "completed"
    || !IDENTIFIER.test(String(value.id || "")) || value.id !== value.requestId
    || value.id !== expected.snapshotId || value.workflowId !== expected.workflowId
    || !BACKUP_ID.test(String(value.backupId || "")) || value.backupId !== expected.backupId
    || !STRICT_SEMVER.test(String(value.currentVersion || "")) || value.currentVersion !== expected.currentVersion
    || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.files)) {
    throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
  }
  const allowed = new Set(["schemaVersion", "id", "requestId", "workflowId", "backupId", "currentVersion", "status", "createdAt", "files"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
  const seen = new Set();
  for (const entry of value.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !safeRelative(entry.path) || seen.has(entry.path)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
    }
    seen.add(entry.path);
    const keys = Object.keys(entry);
    if (entry.kind === "directory") {
      if (keys.some((key) => !["path", "kind", "mode"].includes(key))) throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
    } else if (entry.kind === "file") {
      if (keys.some((key) => !["path", "kind", "mode", "sizeBytes", "sha256"].includes(key))
        || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !SHA256.test(String(entry.sha256 || ""))) {
        throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
      }
    } else throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
  }
  if (!seen.has("database/database.dump") || !seen.has("storage") || !seen.has("run-system")) {
    throw new Error("CUTOVER_SNAPSHOT_COMPONENT_MISSING");
  }
  const sorted = [...value.files].sort((left, right) => compareText(left.path, right.path));
  if (value.files.some((entry, index) => entry.path !== sorted[index].path)) throw new Error("CUTOVER_SNAPSHOT_MANIFEST_NOT_CANONICAL");
  return value;
}

export async function verifyCutoverSnapshot(options) {
  const root = cutoverSnapshotPath(options.snapshotBase, options.snapshotId);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("CUTOVER_SNAPSHOT_ROOT_INVALID");
  const manifestPath = path.join(root, "manifest.json");
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size <= 0 || manifestStat.size > 128 * 1024 * 1024) {
    throw new Error("CUTOVER_SNAPSHOT_MANIFEST_INVALID");
  }
  const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")), options);
  const actual = (await inventory(root)).filter((entry) => entry.path !== "manifest.json");
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("CUTOVER_SNAPSHOT_CONTENT_MISMATCH");
  return {
    ok: true,
    root,
    manifest,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
  };
}

export async function verifyCutoverRestoreResult(options) {
  const snapshot = await verifyCutoverSnapshot(options);
  if (!IDENTIFIER.test(String(options.restoreAttemptId || ""))) throw new Error("CUTOVER_RESTORE_ATTEMPT_ID_INVALID");
  const resultRoot = path.resolve(options.resultBase || "");
  if (resultRoot === path.parse(resultRoot).root || resultRoot.length < 8 || resultRoot === path.resolve(options.snapshotBase)) {
    throw new Error("CUTOVER_RESTORE_RESULT_ROOT_INVALID");
  }
  const resultPath = path.join(resultRoot, `${options.snapshotId}.json`);
  const stat = await fs.lstat(resultPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16_384) throw new Error("CUTOVER_RESTORE_RESULT_INVALID");
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  const allowed = new Set(["schemaVersion", "ok", "snapshotId", "restoreAttemptId", "manifestSha256", "restoredAt"]);
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some((key) => !allowed.has(key))
    || result.schemaVersion !== 1 || result.ok !== true || result.snapshotId !== options.snapshotId
    || result.restoreAttemptId !== options.restoreAttemptId
    || result.manifestSha256 !== snapshot.manifestSha256 || !Number.isFinite(Date.parse(result.restoredAt))) {
    throw new Error("CUTOVER_RESTORE_RESULT_INVALID");
  }
  return { ...snapshot, result };
}
