import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../../../../core/config/env.js";
import { prisma } from "../../../../core/database/prisma.js";
import { getSystemRuntimeConfig } from "../../../runtime/runtime.config.js";

export type SystemBackupComponentStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type SystemBackupManifest = {
  schemaVersion: 1;
  id: string;
  status: "running" | "completed" | "failed";
  reason: string;
  coreVersion: string;
  createdAt: string;
  finishedAt?: string;
  error?: string;
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
};

const BACKUP_ID_PATTERN = /^backup-[a-zA-Z0-9._-]+$/;
let activeBackupId: string | null = null;

function persistentStorageRoot() {
  if (process.env.BONNI_STORAGE_ROOT) return path.resolve(process.env.BONNI_STORAGE_ROOT);
  const runtimeStorage = path.resolve(process.cwd(), "../storage");
  return existsSync(runtimeStorage) ? runtimeStorage : path.resolve(process.cwd(), "storage");
}

export function systemBackupsRoot() {
  return process.env.BONNI_BACKUP_ROOT
    ? path.resolve(process.env.BONNI_BACKUP_ROOT)
    : path.join(persistentStorageRoot(), "system", "backups");
}

export function systemRestoreRequestPath() {
  return path.join(persistentStorageRoot(), "system", "restore-request.json");
}

function backupDirectory(id: string) {
  if (!BACKUP_ID_PATTERN.test(id)) throw new Error("INVALID_BACKUP_ID");
  return path.join(systemBackupsRoot(), id);
}

function manifestPath(id: string) {
  return path.join(backupDirectory(id), "manifest.json");
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

function databaseProcessEnvironment() {
  const connection = new URL(env.DATABASE_URL);
  return {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: decodeURIComponent(connection.pathname.replace(/^\//, "")),
    PGCONNECT_TIMEOUT: "10",
  };
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
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} wurde mit Status ${code} beendet.`));
    });
  });
}

async function dumpDatabase(target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await runCommand("pg_dump", [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file",
    target,
  ], databaseProcessEnvironment());
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
  const root = backupDirectory(id);
  const startedAt = new Date();
  let databaseRecordId: string | null = null;
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
  };

  try {
    await fs.mkdir(root, { recursive: true });
    await writeJson(manifestPath(id), manifest);
    const databaseRecord = await safeDatabaseRecord({ action: "create", status: "running", filePath: root, startedAt });
    databaseRecordId = databaseRecord?.id || null;

    const databaseComponent = manifest.components[0];
    databaseComponent.status = "running";
    await options.onProgress?.({ backupId: id, component: databaseComponent.key, status: "running" });
    await writeJson(manifestPath(id), manifest);
    await dumpDatabase(path.join(root, databaseComponent.relativePath));
    databaseComponent.status = "completed";
    await options.onProgress?.({ backupId: id, component: databaseComponent.key, status: "completed" });

    const configComponent = manifest.components[1];
    configComponent.status = "running";
    await options.onProgress?.({ backupId: id, component: configComponent.key, status: "running" });
    await writeJson(manifestPath(id), manifest);
    await copyDirectory(path.resolve(process.cwd(), "config"), path.join(root, configComponent.relativePath));
    configComponent.status = "completed";
    await options.onProgress?.({ backupId: id, component: configComponent.key, status: "completed" });

    const storageComponent = manifest.components[2];
    storageComponent.status = "running";
    await options.onProgress?.({ backupId: id, component: storageComponent.key, status: "running" });
    await writeJson(manifestPath(id), manifest);
    const storageRoot = persistentStorageRoot();
    await copyDirectory(storageRoot, path.join(root, storageComponent.relativePath), [
      systemBackupsRoot(),
      path.join(storageRoot, "system", "update-center", "downloads"),
    ]);
    storageComponent.status = "completed";
    await options.onProgress?.({ backupId: id, component: storageComponent.key, status: "completed" });

    manifest.files = await buildFileManifest(root);
    for (const component of manifest.components) {
      const files = manifest.files.filter((file) => file.path === component.relativePath || file.path.startsWith(`${component.relativePath}/`));
      component.fileCount = files.length;
      component.sizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    }
    manifest.status = "completed";
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath(id), manifest);
    if (databaseRecordId) {
      await safeDatabaseRecord({ action: "finish", id: databaseRecordId, status: "completed", finishedAt: new Date() });
    }

    return { ok: true, backup: manifest };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath(id), manifest).catch(() => undefined);
    if (databaseRecordId) {
      await safeDatabaseRecord({ action: "finish", id: databaseRecordId, status: "failed", finishedAt: new Date() });
    }
    return { ok: false, error: "BACKUP_FAILED", message, backup: manifest };
  } finally {
    activeBackupId = null;
  }
}

export async function listSystemBackups() {
  await fs.mkdir(systemBackupsRoot(), { recursive: true });
  const entries = await fs.readdir(systemBackupsRoot(), { withFileTypes: true });
  const backups = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
    .map((entry) => readJson<SystemBackupManifest>(manifestPath(entry.name)))))
    .filter((entry): entry is SystemBackupManifest => Boolean(entry));

  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function validateSystemBackup(id: string) {
  const manifest = await readJson<SystemBackupManifest>(manifestPath(id));
  if (!manifest) return { ok: false, error: "BACKUP_NOT_FOUND", id };
  if (manifest.status !== "completed") return { ok: false, error: "BACKUP_NOT_COMPLETE", id, backup: manifest };

  const root = backupDirectory(id);
  const errors: Array<{ path: string; reason: string }> = [];
  const expectedPaths = new Set<string>();
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
    const stat = await fs.stat(file);
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

  return {
    ok: errors.length === 0,
    id,
    checkedAt: new Date().toISOString(),
    checkedFiles: manifest.files.length,
    errors,
    backup: manifest,
  };
}

export async function requestSystemRestore(id: string, confirmation: string) {
  if (confirmation !== id) return { ok: false, error: "RESTORE_CONFIRMATION_REQUIRED", id };
  const validation = await validateSystemBackup(id);
  if (!validation.ok) return { ok: false, error: "BACKUP_VALIDATION_FAILED", validation };

  const safetyBackup = await createSystemBackup({ reason: `before-restore:${id}` });
  if (!safetyBackup.ok) return { ok: false, error: "SAFETY_BACKUP_FAILED", safetyBackup };

  const finalValidation = await validateSystemBackup(id);
  if (!finalValidation.ok) {
    return { ok: false, error: "BACKUP_CHANGED_DURING_PREPARATION", validation: finalValidation };
  }

  const request = {
    schemaVersion: 1,
    backupId: id,
    backupPath: backupDirectory(id),
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
