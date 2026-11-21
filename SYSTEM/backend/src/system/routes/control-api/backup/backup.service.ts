import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../../../../core/config/env.js";
import { prisma } from "../../../../core/database/prisma.js";
import { getSystemRuntimeConfig } from "../../../runtime/runtime.config.js";
import { resolvePostgreSqlTool } from "./postgres-tool.service.js";
import { resolvePersistentStorageRoot } from "../../../../../scripts/storage/persistent-storage-root.mjs";
import { BackupFolderError, findBackupLocation, listBackupLocations, resolveBackupFolder, type BackupLocation } from "../../../../../scripts/backup/backup-paths.mjs";
import { acquirePersistentSnapshotLock } from "../../../../core/storage/persistent-snapshot-lock.js";

export type SystemBackupComponentStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type SystemBackupManifest = {
  schemaVersion: 1;
  id: string;
  status: "running" | "completed" | "failed";
  reason: string;
  coreVersion: string;
  createdAt: string;
  directory?: string;
  finishedAt?: string;
  error?: string;
  errorCode?: string;
  components: Array<{
    key: "database" | "configuration" | "storage";
    label: string;
    status: SystemBackupComponentStatus;
    relativePath: string;
    sizeBytes?: number;
    fileCount?: number;
    error?: string;
  }>;
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
  domainDatabases?: Array<{ domain: string; relativePath: string }>;
};

let activeBackupId: string | null = null;

function persistentStorageRoot() {
  return resolvePersistentStorageRoot();
}

export function systemBackupsRoot() {
  return process.env.BONNI_BACKUP_ROOT
    ? path.resolve(process.env.BONNI_BACKUP_ROOT)
    : path.join(persistentStorageRoot(), "system", "backups");
}

export function systemRestoreRequestPath() {
  return path.join(persistentStorageRoot(), "system", "restore-request.json");
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function backupId() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `backup-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function copyDirectory(source: string, destination: string, excludedRoots: string[] = []) {
  const resolved = path.resolve(source);
  if (excludedRoots.some((excluded) => isInside(resolved, excluded))) return;
  if (!existsSync(resolved)) {
    await fs.mkdir(destination, { recursive: true });
    return;
  }

  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(resolved);
    for (const entry of entries) {
      await copyDirectory(path.join(resolved, entry), path.join(destination, entry), excludedRoots);
    }
    return;
  }
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(resolved, destination);
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function listFiles(root: string, current = root): Promise<string[]> {
  if (!existsSync(current)) return [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function buildFileManifest(root: string) {
  const rootManifest = path.resolve(root, "manifest.json");
  const files = (await listFiles(root)).filter((file) => path.resolve(file) !== rootManifest);
  return Promise.all(files.map(async (file) => {
    const stat = await fs.stat(file);
    return {
      path: path.relative(root, file).replaceAll("\\", "/"),
      sizeBytes: stat.size,
      sha256: await sha256File(file),
    };
  }));
}

function databaseProcessEnvironment(connectionString = env.DATABASE_URL) {
  const connection = new URL(connectionString);
  return {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: decodeURIComponent(connection.pathname.replace(/^\//, "")),
    PGCONNECT_TIMEOUT: "10",
    ...(connection.searchParams.get("sslmode") ? { PGSSLMODE: connection.searchParams.get("sslmode")! } : {}),
  };
}

type BackupToolError = Error & {
  code?: string;
  technicalMessage?: string;
};

function backupToolError(code: string, message: string, technicalMessage?: string): BackupToolError {
  return Object.assign(new Error(message), { code, technicalMessage });
}

function runCommand(command: string, args: string[], commandEnv: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: commandEnv,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(backupToolError(
          "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED",
          "Das PostgreSQL-Sicherungswerkzeug wurde beim Start nicht gefunden. Hinterlege den vollständigen Pfad in PG_DUMP_PATH und versuche die Aktualisierung erneut.",
          error.message,
        ));
        return;
      }
      if (error.code === "EACCES") {
        reject(backupToolError(
          "POSTGRESQL_TOOL_NOT_EXECUTABLE",
          "Das gefundene PostgreSQL-Sicherungswerkzeug darf nicht ausgeführt werden. Prüfe die Dateiberechtigungen oder PG_DUMP_PATH.",
          error.message,
        ));
        return;
      }
      reject(backupToolError(
        "POSTGRESQL_BACKUP_PROCESS_FAILED",
        "Das PostgreSQL-Sicherungswerkzeug konnte nicht gestartet werden.",
        error.message,
      ));
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(backupToolError(
        "POSTGRESQL_DATABASE_BACKUP_FAILED",
        "Die PostgreSQL-Datenbank konnte nicht gesichert werden. Prüfe, ob PostgreSQL läuft und die hinterlegten Datenbankzugänge stimmen.",
        stderr.trim() || `${path.basename(command)} wurde mit Status ${code} beendet.`,
      ));
    });
  });
}

async function dumpDatabase(target: string, connectionString?: string, schema?: string) {
  const tool = resolvePostgreSqlTool("pg_dump");
  if (!tool.ok) throw backupToolError(tool.code, tool.message);

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.partial`;
  try {
    await runCommand(tool.command, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...(schema ? ["--schema", schema] : []),
      "--file",
      temporary,
    ], databaseProcessEnvironment(connectionString));
    const stat = await fs.stat(temporary).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      throw backupToolError(
        "POSTGRESQL_DATABASE_BACKUP_EMPTY",
        "PostgreSQL hat keine verwertbare Sicherungsdatei erstellt. Die Aktualisierung wurde sicher abgebrochen.",
      );
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function safeDatabaseRecord(data: Record<string, unknown>) {
  try {
    if (data.action === "create") {
      return await prisma.systemBackup.create({
        data: {
          status: String(data.status || "running"),
          filePath: String(data.filePath || ""),
          startedAt: data.startedAt as Date,
        },
      });
    }
    if (data.action === "finish" && data.id) {
      return await prisma.systemBackup.update({
        where: { id: String(data.id) },
        data: {
          status: String(data.status || "completed"),
          finishedAt: data.finishedAt as Date,
        },
      });
    }
  } catch {
    // Die Dateisicherung bleibt auch bei ausgefallener Datenbank verwertbar.
  }
  return null;
}

export async function createSystemBackup(options: {
  reason?: string;
  directory?: unknown;
  /** Host-only: isolated runtime domains, never supplied by a browser. */
  domainDatabases?: Array<{ domain: string; url: string }>;
  onProgress?: (progress: {
    backupId: string;
    component: SystemBackupManifest["components"][number]["key"];
    status: SystemBackupComponentStatus;
  }) => Promise<void> | void;
} = {}) {
  if (activeBackupId) {
    return { ok: false, error: "BACKUP_ALREADY_RUNNING", activeBackupId };
  }

  const id = backupId();
  activeBackupId = id;
  const startedAt = new Date();
  let databaseRecordId: string | null = null;
  let manifestFile: string | undefined;
  const manifest: SystemBackupManifest = {
    schemaVersion: 1,
    id,
    status: "running",
    reason: options.reason || "manual",
    coreVersion: getSystemRuntimeConfig().version,
    createdAt: startedAt.toISOString(),
    components: [
      { key: "database", label: "PostgreSQL-Datenbank", status: "pending", relativePath: "database/database.dump" },
      { key: "configuration", label: "Systemkonfiguration", status: "pending", relativePath: "configuration" },
      { key: "storage", label: "Persistente Dateien", status: "pending", relativePath: "storage" },
    ],
    files: [],
    ...(options.domainDatabases ? { domainDatabases: options.domainDatabases.map(d => ({ domain: d.domain,
      relativePath: `database/domains/${d.domain}.dump` })) } : {}),
  };

  try {
    const configuredRoot = systemBackupsRoot();
    const folder = await resolveBackupFolder(configuredRoot, options.directory, { create: true });
    if (folder.relativePath) manifest.directory = folder.relativePath;
    const root = path.join(folder.absolutePath, id);
    await fs.mkdir(root, { mode: 0o700 });
    manifestFile = path.join(root, "manifest.json");
    const excludedBackupRoots = [configuredRoot, folder.root];
    await writeJson(manifestFile, manifest);
    const databaseRecord = await safeDatabaseRecord({ action: "create", status: "running", filePath: root, startedAt });
    databaseRecordId = databaseRecord?.id || null;

    // The dump and persistent-storage copy are one logical snapshot. Branding
    // replace/reset uses this same cross-process lock, so a dump can never
    // reference a logo which disappears before the storage phase copies it.
    const releasePersistentSnapshot = await acquirePersistentSnapshotLock({
      operation: `system-backup:${id}`,
    });
    try {
    const databaseComponent = manifest.components[0];
    databaseComponent.status = "running";
    await options.onProgress?.({ backupId: id, component: databaseComponent.key, status: "running" });
    await writeJson(manifestFile, manifest);
    await dumpDatabase(path.join(root, databaseComponent.relativePath));
    if (options.domainDatabases) {
      const seen = new Set<string>();
      for (const item of options.domainDatabases) {
        if (!/^[a-z][a-z0-9_]{0,40}$/.test(item.domain) || seen.has(item.domain)) throw new Error("BACKUP_DOMAIN_INVALID");
        seen.add(item.domain);
        await dumpDatabase(path.join(root, "database", "domains", item.domain + ".dump"), item.url, item.domain);
      }
    }
    databaseComponent.status = "completed";
    await options.onProgress?.({ backupId: id, component: databaseComponent.key, status: "completed" });

    const configComponent = manifest.components[1];
    configComponent.status = "running";
    await options.onProgress?.({ backupId: id, component: configComponent.key, status: "running" });
    await writeJson(manifestFile, manifest);
    const configRoot = path.resolve(process.cwd(), "config");
    await copyDirectory(configRoot, path.join(root, configComponent.relativePath),
      excludedBackupRoots.filter(excluded => isInside(excluded, configRoot)));
    configComponent.status = "completed";
    await options.onProgress?.({ backupId: id, component: configComponent.key, status: "completed" });

    const storageComponent = manifest.components[2];
    storageComponent.status = "running";
    await options.onProgress?.({ backupId: id, component: storageComponent.key, status: "running" });
    await writeJson(manifestFile, manifest);
    const storageRoot = persistentStorageRoot();
    await copyDirectory(storageRoot, path.join(root, storageComponent.relativePath), [
      ...excludedBackupRoots,
      path.join(storageRoot, "system", "update-center", "downloads"),
      path.join(storageRoot, "system", "locks"),
    ]);
    storageComponent.status = "completed";
    await options.onProgress?.({ backupId: id, component: storageComponent.key, status: "completed" });
    } finally {
      await releasePersistentSnapshot();
    }

    manifest.files = await buildFileManifest(root);
    for (const component of manifest.components) {
      const files = manifest.files.filter((file) => file.path === component.relativePath || file.path.startsWith(`${component.relativePath}/`));
      component.fileCount = files.length;
      component.sizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    }
    manifest.status = "completed";
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestFile, manifest);
    if (databaseRecordId) {
      await safeDatabaseRecord({ action: "finish", id: databaseRecordId, status: "completed", finishedAt: new Date() });
    }

    return { ok: true, backup: manifest };
  } catch (error) {
    if (error instanceof BackupFolderError) {
      return { ok: false, error: error.code, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = String((error as BackupToolError | null)?.code || "BACKUP_FAILED");
    const technicalMessage = (error as BackupToolError | null)?.technicalMessage;
    const running = manifest.components.find((component) => component.status === "running");
    if (running) {
      running.status = "failed";
      running.error = message;
      try {
        await options.onProgress?.({ backupId: id, component: running.key, status: "failed" });
      } catch {
        // Der ursprüngliche Sicherungsfehler bleibt maßgeblich.
      }
    }
    manifest.status = "failed";
    manifest.error = message;
    manifest.errorCode = errorCode;
    manifest.finishedAt = new Date().toISOString();
    if (manifestFile) await writeJson(manifestFile, manifest).catch(() => undefined);
    if (databaseRecordId) {
      await safeDatabaseRecord({ action: "finish", id: databaseRecordId, status: "failed", finishedAt: new Date() });
    }
    return {
      ok: false,
      error: "BACKUP_FAILED",
      causeCode: errorCode,
      message,
      technicalMessage,
      backup: manifest,
    };
  } finally {
    activeBackupId = null;
  }
}

export async function listSystemBackups() {
  const entries = await listBackupLocations(systemBackupsRoot());
  const counts = new Map<string, number>();
  for (const { id } of entries) counts.set(id, (counts.get(id) || 0) + 1);
  const backups = (await Promise.all(entries
    .filter((entry) => counts.get(entry.id) === 1)
    .map(async (entry): Promise<SystemBackupManifest | null> => {
      // The update page polls while its mandatory safety backup is being
      // created. A concurrently replaced, stale or damaged manifest must not
      // take the complete update-status endpoint down with HTTP 500. Backup
      // validation remains fail-closed; this tolerant read is only used for
      // the non-authoritative overview.
      const value = await readBackupManifest(entry.absolutePath).catch(() => null);
      if (
        !value
        || value.schemaVersion !== 1
        || value.id !== entry.id
        || !["running", "completed", "failed"].includes(String(value.status))
        || typeof value.reason !== "string"
        || typeof value.coreVersion !== "string"
        || typeof value.createdAt !== "string"
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Array.isArray(value.components)
        || !Array.isArray(value.files)
      ) return null;
      return { ...value, directory: entry.directory || undefined };
    })))
    .filter((entry): entry is SystemBackupManifest => Boolean(entry));

  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listSystemBackupFolder(directory: unknown, details = false) {
  const folder = await resolveBackupFolder(systemBackupsRoot(), directory);
  const listing = await fs.readdir(folder.absolutePath, { withFileTypes: true });
  const entries: Array<{ name: string; directory: boolean; sizeBytes?: number; modifiedAt?: string }> = [];
  for (const item of listing) {
    if (!item.isDirectory() && !item.isFile()) continue;
    const entry = { name: item.name, directory: item.isDirectory() };
    if (!details) {
      entries.push(entry);
      continue;
    }
    const info = await fs.lstat(path.join(folder.absolutePath, item.name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isFile() || info?.isDirectory()) {
      entries.push({ ...entry, directory: info.isDirectory(), sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
    }
  }
  return {
    ok: true,
    directory: folder.relativePath,
    entries: entries.sort((left, right) => left.name.localeCompare(right.name, "de")),
  };
}

async function readBackupManifest(root: string) {
  const file = path.join(root, "manifest.json");
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  return info?.isFile() ? readJson<SystemBackupManifest>(file) : null;
}

async function validateLocatedBackup(id: string, location: BackupLocation | undefined) {
  const manifest = location && await readBackupManifest(location.absolutePath);
  if (!location || !manifest || manifest.id !== id) return { ok: false, error: "BACKUP_NOT_FOUND", id };
  if (manifest.status !== "completed") return { ok: false, error: "BACKUP_NOT_COMPLETE", id, backup: manifest };

  const root = location.absolutePath;
  const errors: Array<{ path: string; reason: string }> = [];
  const expectedPaths = new Set<string>();
  if (!Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.components) ||
    manifest.components.some(c => c.status !== "completed")) return { ok: false, error: "BACKUP_MANIFEST_INCOMPLETE", id, backup: manifest };
  for (const expected of manifest.files) {
    const normalizedPath = String(expected.path || "").replaceAll("\\", "/");
    if (!normalizedPath || expectedPaths.has(normalizedPath)) {
      errors.push({ path: normalizedPath || "(leer)", reason: "INVALID_OR_DUPLICATE_MANIFEST_ENTRY" });
      continue;
    }
    expectedPaths.add(normalizedPath);
    const file = path.resolve(root, expected.path);
    if (!isInside(file, root) || !existsSync(file)) {
      errors.push({ path: expected.path, reason: "FILE_MISSING" });
      continue;
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || path.relative(file, await fs.realpath(file))) {
      errors.push({ path: expected.path, reason: "INVALID_BACKUP_FILE" });
      continue;
    }
    if (stat.size !== expected.sizeBytes) {
      errors.push({ path: expected.path, reason: "SIZE_MISMATCH" });
      continue;
    }
    if (await sha256File(file) !== expected.sha256) {
      errors.push({ path: expected.path, reason: "CHECKSUM_MISMATCH" });
    }
  }

  const rootManifest = path.resolve(root, "manifest.json");
  const actualFiles = (await listFiles(root))
    .filter((file) => path.resolve(file) !== rootManifest)
    .map((file) => path.relative(root, file).replaceAll("\\", "/"));
  for (const actualPath of actualFiles) {
    if (!expectedPaths.has(actualPath)) errors.push({ path: actualPath, reason: "UNEXPECTED_FILE" });
  }
  if (!expectedPaths.has("database/database.dump")) errors.push({ path: "database/database.dump", reason: "DATABASE_DUMP_MISSING" });
  for (const domain of manifest.domainDatabases || []) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(domain.domain) || domain.relativePath !== `database/domains/${domain.domain}.dump` ||
      !manifest.files.some(f => f.path === domain.relativePath && f.sizeBytes > 0)) errors.push({ path: domain.relativePath, reason: "DOMAIN_DUMP_MISSING" });
  }

  return {
    ok: errors.length === 0,
    id,
    checkedAt: new Date().toISOString(),
    checkedFiles: manifest.files.length,
    errors,
    backup: manifest,
  };
}

export async function validateSystemBackup(id: string) {
  return validateLocatedBackup(id, await findBackupLocation(systemBackupsRoot(), id));
}

export async function requestSystemRestore(id: string, confirmation: string) {
  if (confirmation !== id) return { ok: false, error: "RESTORE_CONFIRMATION_REQUIRED", id };
  const validation = await validateSystemBackup(id);
  if (!validation.ok) return { ok: false, error: "BACKUP_VALIDATION_FAILED", validation };
  const erasures = await readJson<{ entries: Array<{ completedAt: string }> }>(path.join(persistentStorageRoot(), "system", "erasure-ledger.json"));
  if (erasures?.entries?.some(e => Date.parse(e.completedAt) >= Date.parse(validation.backup!.createdAt))) {
    return { ok: false, error: "RESTORE_ERASURE_REPLAY_REQUIRED", message: "Diese Sicherung würde bereits gelöschte Benutzerdaten zurückbringen. Eine kontrollierte Wiederherstellung mit erneuter Löschung ist erforderlich." };
  }
  if (validation.backup?.domainDatabases?.length) return { ok: false, error: "RESTORE_ISOLATED_DOMAINS_REQUIRED",
    message: "Diese Sicherung enthält getrennte Datenbanken. Sie muss über den dokumentierten Wiederherstellungsablauf für alle enthaltenen Datenbereiche zurückgespielt werden." };

  const safetyBackup = await createSystemBackup({ reason: `before-restore:${id}` });
  if (!safetyBackup.ok) return { ok: false, error: "SAFETY_BACKUP_FAILED", safetyBackup };

  const location = await findBackupLocation(systemBackupsRoot(), id);
  const finalValidation = await validateLocatedBackup(id, location);
  if (!location || !finalValidation.ok) {
    return { ok: false, error: "BACKUP_CHANGED_DURING_PREPARATION", validation: finalValidation };
  }

  const request = {
    schemaVersion: 1,
    backupId: id,
    backupPath: location.absolutePath,
    ...(location.directory ? { backupDirectory: location.directory } : {}),
    requestedAt: new Date().toISOString(),
    status: "pending-restart",
    safetyBackupId: safetyBackup.backup?.id,
  };
  await writeJson(systemRestoreRequestPath(), request);

  return {
    ok: true,
    restore: request,
    restartRequired: true,
    message: "Die Wiederherstellung ist geprüft und wird beim nächsten kontrollierten Backend-Start ausgeführt.",
  };
}

/** Rotate only erasure safety backups, after a validated newer post-erasure
 * snapshot exists. Open/failed cases pin their preceding safety snapshot. */
export async function rotateErasureBackups(options: { retentionDays: number; verifiedPostBackupId: string; protectedIds: string[] }) {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) throw new Error("ERASURE_BACKUP_RETENTION_INVALID");
  const proof = await validateSystemBackup(options.verifiedPostBackupId);
  if (!proof.ok || !proof.backup?.reason.startsWith("after-erasure:")) throw new Error("ERASURE_POST_BACKUP_REQUIRED");
  const cutoff = Date.now() - options.retentionDays * 86_400_000;
  const release = await acquirePersistentSnapshotLock({ operation: "erasure-backup-rotation" });
  const removed: string[] = [];
  try {
    for (const item of await listSystemBackups()) {
      if (item.status !== "completed" || !/^(before|after)-erasure:/.test(item.reason) ||
        item.id === options.verifiedPostBackupId || options.protectedIds.includes(item.id) ||
        Date.parse(item.createdAt) >= cutoff || item.createdAt >= proof.backup.createdAt) continue;
      const location = await findBackupLocation(systemBackupsRoot(), item.id);
      if (location) {
        await fs.rm(location.absolutePath, { recursive: true });
        removed.push(item.id);
      }
    }
  } finally { await release(); }
  return { removed };
}

export async function getSystemBackupOverview() {
  const [backups, restoreRequest] = await Promise.all([
    listSystemBackups(),
    readJson<Record<string, unknown>>(systemRestoreRequestPath()),
  ]);

  return {
    ok: true,
    area: "backup",
    status: activeBackupId ? "running" : "ready",
    localAvailable: true,
    activeBackupId,
    backupRoot: systemBackupsRoot(),
    latest: backups[0] || null,
    backups,
    restoreRequest,
    capabilities: {
      databaseDump: true,
      configurationCopy: true,
      persistentStorageCopy: true,
      checksumValidation: true,
      restoreOnControlledRestart: true,
    },
  };
}
