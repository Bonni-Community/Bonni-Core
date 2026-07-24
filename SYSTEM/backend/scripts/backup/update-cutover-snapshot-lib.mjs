import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const CUTOVER_SNAPSHOT_SCHEMA_VERSION = 1;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const BACKUP_ID = /^backup-[A-Za-z0-9._-]{4,120}$/;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} ist ungültig.`);
  return value;
}

function safeBackupId(value) {
  if (typeof value !== "string" || !BACKUP_ID.test(value)) throw new Error("Backup-ID ist ungültig.");
  return value;
}

function safeVersion(value) {
  if (typeof value !== "string" || !STRICT_SEMVER.test(value)) throw new Error("Ausgangsversion ist ungültig.");
  return value;
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeRoot(root, label) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved.length < 8) {
    throw new Error(`${label} ist als Dateisystemwurzel nicht erlaubt.`);
  }
  return resolved;
}

async function assertDirectoryWithoutSymlink(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} ist kein sicheres Verzeichnis.`);
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export function snapshotDirectory(snapshotBase, snapshotId) {
  const base = assertSafeRoot(snapshotBase, "Snapshot-Basis");
  const id = safeIdentifier(snapshotId, "Snapshot-ID");
  const target = path.join(base, `snapshot-${id}`);
  if (!isInside(target, base)) throw new Error("Snapshot-Ziel verlässt die Snapshot-Basis.");
  return target;
}

export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyTreeStrict(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Symbolischer Link im Produktionsstand ist nicht erlaubt: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: stat.mode & 0o777 });
    await fs.chmod(destination, stat.mode & 0o777);
    const entries = await fs.readdir(source);
    entries.sort(compareText);
    for (const entry of entries) await copyTreeStrict(path.join(source, entry), path.join(destination, entry));
    await syncDirectory(destination);
    return;
  }
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, stat.mode & 0o777);
    const handle = await fs.open(destination, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    return;
  }
  throw new Error(`Spezialdatei im Produktionsstand ist nicht erlaubt: ${source}`);
}

export async function inventoryTree(root, current = root) {
  const rootResolved = path.resolve(root);
  const currentResolved = path.resolve(current);
  if (!isInside(currentResolved, rootResolved)) throw new Error("Inventarpfad verlässt den erlaubten Wurzelpfad.");
  const stat = await fs.lstat(currentResolved);
  if (stat.isSymbolicLink()) throw new Error(`Symbolischer Link im Snapshot ist nicht erlaubt: ${currentResolved}`);
  const relative = path.relative(rootResolved, currentResolved).replaceAll("\\", "/");
  const entries = [];
  if (relative) {
    if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory", mode: stat.mode & 0o777 });
    } else if (stat.isFile()) {
      entries.push({
        path: relative,
        kind: "file",
        mode: stat.mode & 0o777,
        sizeBytes: stat.size,
        sha256: await sha256File(currentResolved),
      });
      return entries;
    } else {
      throw new Error(`Spezialdatei im Snapshot ist nicht erlaubt: ${currentResolved}`);
    }
  }
  if (!stat.isDirectory()) return entries;
  const children = await fs.readdir(currentResolved);
  children.sort(compareText);
  for (const child of children) entries.push(...await inventoryTree(rootResolved, path.join(currentResolved, child)));
  return entries;
}

function normalizeManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Snapshot-Manifest fehlt.");
  const allowed = [
    "schemaVersion", "id", "requestId", "workflowId", "backupId", "currentVersion",
    "status", "createdAt", "files",
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Snapshot-Manifest enthält unbekannte Felder: ${unknown.join(", ")}`);
  if (input.schemaVersion !== CUTOVER_SNAPSHOT_SCHEMA_VERSION || input.status !== "completed") {
    throw new Error("Snapshot ist nicht vollständig abgeschlossen.");
  }
  const id = safeIdentifier(input.id, "Snapshot-ID");
  const requestId = safeIdentifier(input.requestId, "Request-ID");
  const workflowId = safeIdentifier(input.workflowId, "Workflow-ID");
  if (id !== requestId) throw new Error("Snapshot-ID und Request-ID stimmen nicht überein.");
  const backupId = safeBackupId(input.backupId);
  const currentVersion = safeVersion(input.currentVersion);
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Snapshot-Zeitstempel ist ungültig.");
  }
  if (!Array.isArray(input.files) || input.files.length < 3) throw new Error("Snapshot-Inventar ist unvollständig.");
  const seen = new Set();
  const files = input.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !safeRelativePath(entry.path) || seen.has(entry.path)) {
      throw new Error("Snapshot-Inventar enthält einen ungültigen oder doppelten Pfad.");
    }
    seen.add(entry.path);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error(`Ungültiger Modus: ${entry.path}`);
    if (entry.kind === "directory") {
      if (Object.keys(entry).some((key) => !["path", "kind", "mode"].includes(key))) {
        throw new Error(`Ungültiger Verzeichniseintrag: ${entry.path}`);
      }
      return { path: entry.path, kind: "directory", mode: entry.mode };
    }
    if (entry.kind !== "file"
      || Object.keys(entry).some((key) => !["path", "kind", "mode", "sizeBytes", "sha256"].includes(key))
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !SHA256.test(entry.sha256 || "")) {
      throw new Error(`Ungültiger Dateieintrag: ${entry.path}`);
    }
    return { path: entry.path, kind: "file", mode: entry.mode, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  });
  for (const required of ["database/database.dump", "storage", "run-system"]) {
    if (!seen.has(required)) throw new Error(`Snapshot-Pflichtbestandteil fehlt: ${required}`);
  }
  const database = files.find((entry) => entry.path === "database/database.dump");
  if (database?.kind !== "file") throw new Error("Snapshot-Datenbankdump ist ungültig.");
  if (files.find((entry) => entry.path === "storage")?.kind !== "directory"
    || files.find((entry) => entry.path === "run-system")?.kind !== "directory") {
    throw new Error("Snapshot-Dateiwurzeln sind ungültig.");
  }
  const sorted = [...files].sort((left, right) => compareText(left.path, right.path));
  if (files.some((entry, index) => entry.path !== sorted[index].path)) throw new Error("Snapshot-Inventar ist nicht kanonisch sortiert.");
  return {
    schemaVersion: CUTOVER_SNAPSHOT_SCHEMA_VERSION,
    id,
    requestId,
    workflowId,
    backupId,
    currentVersion,
    status: "completed",
    createdAt: new Date(input.createdAt).toISOString(),
    files,
  };
}

export async function verifyCutoverSnapshot(options) {
  const root = snapshotDirectory(options.snapshotBase, options.snapshotId);
  await assertDirectoryWithoutSymlink(root, "Snapshot");
  const manifestFile = path.join(root, "manifest.json");
  const manifestStat = await fs.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size <= 0 || manifestStat.size > 128 * 1024 * 1024) {
    throw new Error("Snapshot-Manifest ist keine sichere reguläre Datei.");
  }
  const manifest = normalizeManifest(JSON.parse(await fs.readFile(manifestFile, "utf8")));
  if (options.workflowId && manifest.workflowId !== options.workflowId) throw new Error("Snapshot gehört zu einem anderen Workflow.");
  if (options.backupId && manifest.backupId !== options.backupId) throw new Error("Snapshot gehört zu einem anderen Rückkehrpunkt.");
  if (options.currentVersion && manifest.currentVersion !== options.currentVersion) throw new Error("Snapshot gehört zu einer anderen Ausgangsversion.");
  const actual = (await inventoryTree(root)).filter((entry) => entry.path !== "manifest.json");
  if (actual.length !== manifest.files.length) throw new Error("Snapshot-Inventar und Dateisystem unterscheiden sich.");
  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const observed = actual[index];
    if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`Snapshot-Prüfung fehlgeschlagen: ${expected.path}`);
  }
  return {
    ok: true,
    root,
    manifest,
    manifestPath: manifestFile,
    manifestSha256: await sha256File(manifestFile),
    databaseDumpPath: path.join(root, "database", "database.dump"),
  };
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function createCutoverSnapshot(options) {
  const base = assertSafeRoot(options.snapshotBase, "Snapshot-Basis");
  const finalRoot = snapshotDirectory(base, options.snapshotId);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await assertDirectoryWithoutSymlink(base, "Snapshot-Basis");
  try {
    const existing = await verifyCutoverSnapshot(options);
    return { ...existing, reused: true };
  } catch (error) {
    const exists = await fs.lstat(finalRoot).then(() => true).catch((failure) => {
      if (failure?.code === "ENOENT") return false;
      throw failure;
    });
    if (exists) throw new Error(`Vorhandener Snapshot ist ungültig und wird nicht überschrieben: ${error.message}`);
  }

  const sourceStorage = assertSafeRoot(options.sourceStorage, "Produktions-Storage");
  const sourceRunSystem = assertSafeRoot(options.sourceRunSystem, "Produktions-Run-System");
  await assertDirectoryWithoutSymlink(sourceStorage, "Produktions-Storage");
  await assertDirectoryWithoutSymlink(sourceRunSystem, "Produktions-Run-System");
  const temporary = path.join(base, `.snapshot-${safeIdentifier(options.snapshotId, "Snapshot-ID")}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.mkdir(temporary, { mode: 0o700 });
    await fs.mkdir(path.join(temporary, "database"), { recursive: true, mode: 0o700 });
    const dumpPath = path.join(temporary, "database", "database.dump");
    await options.dumpDatabase(dumpPath);
    const dumpStat = await fs.lstat(dumpPath);
    if (!dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.size <= 0) throw new Error("Cutover-Datenbankdump ist leer oder ungültig.");
    await fs.chmod(dumpPath, 0o600);
    const dumpHandle = await fs.open(dumpPath, "r");
    try { await dumpHandle.sync(); } finally { await dumpHandle.close(); }
    await options.validateDatabaseDump?.(dumpPath);
    await copyTreeStrict(sourceStorage, path.join(temporary, "storage"));
    await copyTreeStrict(sourceRunSystem, path.join(temporary, "run-system"));
    const files = (await inventoryTree(temporary)).filter((entry) => entry.path !== "manifest.json");
    const manifest = normalizeManifest({
      schemaVersion: CUTOVER_SNAPSHOT_SCHEMA_VERSION,
      id: options.snapshotId,
      requestId: options.snapshotId,
      workflowId: options.workflowId,
      backupId: options.backupId,
      currentVersion: options.currentVersion,
      status: "completed",
      createdAt: (options.now || new Date()).toISOString(),
      files,
    });
    await writeJsonAtomic(path.join(temporary, "manifest.json"), manifest);
    await syncDirectory(temporary);
    await fs.rename(temporary, finalRoot);
    await syncDirectory(base);
    const verified = await verifyCutoverSnapshot(options);
    return { ...verified, reused: false };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function clearRootContents(root, allowedRoot) {
  const resolved = assertSafeRoot(root, "Restore-Ziel");
  if (resolved !== path.resolve(allowedRoot)) throw new Error(`Nicht freigegebenes Restore-Ziel: ${resolved}`);
  await assertDirectoryWithoutSymlink(resolved, "Restore-Ziel");
  const entries = await fs.readdir(resolved);
  for (const entry of entries) {
    const target = path.join(resolved, entry);
    if (!isInside(target, resolved) || target === resolved) throw new Error("Unsicheres Restore-Löschziel.");
    await fs.rm(target, { recursive: true, force: true });
  }
  await syncDirectory(resolved);
}

async function verifyRestoredRoot(snapshotRoot, targetRoot, snapshotPrefix) {
  const expected = (await inventoryTree(snapshotRoot))
    .filter((entry) => entry.path === snapshotPrefix || entry.path.startsWith(`${snapshotPrefix}/`))
    .map((entry) => ({ ...entry, path: entry.path === snapshotPrefix ? "" : entry.path.slice(snapshotPrefix.length + 1) }))
    .filter((entry) => entry.path);
  const actual = (await inventoryTree(targetRoot)).filter((entry) => entry.path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Restore-Prüfung fehlgeschlagen: ${snapshotPrefix}`);
}

export async function restoreCutoverSnapshot(options) {
  const verified = await verifyCutoverSnapshot(options);
  await options.validateDatabaseDump?.(verified.databaseDumpPath);
  await options.restoreDatabase(verified.databaseDumpPath);

  const targetStorage = assertSafeRoot(options.targetStorage, "Produktions-Storage-Ziel");
  const targetRunSystem = assertSafeRoot(options.targetRunSystem, "Produktions-Run-System-Ziel");
  await clearRootContents(targetStorage, options.allowedTargetStorage || targetStorage);
  await copyTreeStrict(path.join(verified.root, "storage"), targetStorage);
  await clearRootContents(targetRunSystem, options.allowedTargetRunSystem || targetRunSystem);
  await copyTreeStrict(path.join(verified.root, "run-system"), targetRunSystem);
  await verifyRestoredRoot(verified.root, targetStorage, "storage");
  await verifyRestoredRoot(verified.root, targetRunSystem, "run-system");

  const result = {
    schemaVersion: 1,
    ok: true,
    snapshotId: verified.manifest.id,
    restoreAttemptId: safeIdentifier(options.restoreAttemptId, "Restore-Versuchs-ID"),
    manifestSha256: verified.manifestSha256,
    restoredAt: (options.now || new Date()).toISOString(),
  };
  const resultBase = assertSafeRoot(options.resultBase, "Restore-Ergebnisbasis");
  if (resultBase === path.resolve(options.snapshotBase)) throw new Error("Restore-Ergebnisse müssen außerhalb des Snapshot-Volumes liegen.");
  await writeJsonAtomic(path.join(resultBase, `${verified.manifest.id}.json`), result);
  return { ...verified, result };
}
