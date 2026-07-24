import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function storageRoot() {
  if (process.env.BONNI_STORAGE_ROOT) return path.resolve(process.env.BONNI_STORAGE_ROOT);
  const runtimeStorage = path.resolve(process.cwd(), "../storage");
  return existsSync(runtimeStorage) ? runtimeStorage : path.resolve(process.cwd(), "storage");
}

function backupsRoot() {
  return process.env.BONNI_BACKUP_ROOT
    ? path.resolve(process.env.BONNI_BACKUP_ROOT)
    : path.join(storageRoot(), "system", "backups");
}

const requestFile = path.join(storageRoot(), "system", "restore-request.json");
const resultFile = path.join(storageRoot(), "system", "restore-result.json");

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function listFiles(root, current = root) {
  if (!existsSync(current)) return [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function databaseEnvironment() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL fehlt.");
  const connection = new URL(process.env.DATABASE_URL);
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

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || `${command} wurde mit Status ${code} beendet.`)));
  });
}

async function copyTree(source, destination, filter = () => true, root = source) {
  if (!existsSync(source) || !filter(source, path.relative(root, source).replaceAll("\\", "/"))) return;
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source);
    for (const entry of entries) {
      await copyTree(path.join(source, entry), path.join(destination, entry), filter, root);
    }
    return;
  }
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function validateBackup(root, manifest) {
  if (manifest?.status !== "completed" || !Array.isArray(manifest.files)) {
    throw new Error("Backup ist nicht vollständig abgeschlossen.");
  }
  const expectedPaths = new Set();
  for (const expected of manifest.files) {
    const normalizedPath = String(expected.path || "").replaceAll("\\", "/");
    if (!normalizedPath || expectedPaths.has(normalizedPath)) {
      throw new Error(`Ungültiger oder doppelter Backup-Eintrag: ${normalizedPath || "(leer)"}`);
    }
    expectedPaths.add(normalizedPath);
    const file = path.resolve(root, expected.path);
    if (!isInside(file, root) || !existsSync(file)) throw new Error(`Backup-Datei fehlt: ${expected.path}`);
    const stat = await fs.stat(file);
    if (stat.size !== expected.sizeBytes) throw new Error(`Backup-Größe stimmt nicht: ${expected.path}`);
    if (await sha256File(file) !== expected.sha256) throw new Error(`Backup-Prüfsumme stimmt nicht: ${expected.path}`);
  }
  const rootManifest = path.resolve(root, "manifest.json");
  const actualFiles = (await listFiles(root))
    .filter((file) => path.resolve(file) !== rootManifest)
    .map((file) => path.relative(root, file).replaceAll("\\", "/"));
  const unexpected = actualFiles.find((file) => !expectedPaths.has(file));
  if (unexpected) throw new Error(`Unerwartete Datei im Backup: ${unexpected}`);
}

async function restore() {
  const request = await readJson(requestFile);
  if (!request || request.status !== "pending-restart") return;

  const role = String(process.env.SYSTEM_SLOT_ROLE || "active").toLowerCase();
  if (!["active", "previous"].includes(role)) return;

  const id = String(request.backupId || "");
  if (!/^backup-[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Ungültige Backup-ID.");
  const root = path.join(backupsRoot(), id);
  const manifest = await readJson(path.join(root, "manifest.json"));
  await validateBackup(root, manifest);

  const databaseDump = path.join(root, "database", "database.dump");
  await run("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--single-transaction",
    databaseDump,
  ], databaseEnvironment());

  const storedFiles = path.join(root, "storage");
  if (existsSync(storedFiles)) {
    await copyTree(storedFiles, storageRoot(), (_entry, relative) => (
      relative !== "system/backups"
      && !relative.startsWith("system/backups/")
      && relative !== "system/restore-request.json"
    ));
  }

  const configuration = path.join(root, "configuration");
  if (existsSync(configuration)) {
    await copyTree(configuration, path.resolve(process.cwd(), "config"));
  }

  await writeJson(resultFile, {
    ok: true,
    backupId: id,
    safetyBackupId: request.safetyBackupId || null,
    restoredAt: new Date().toISOString(),
  });
  await fs.unlink(requestFile);
}

try {
  await restore();
} catch (error) {
  const request = await readJson(requestFile);
  await writeJson(requestFile, {
    ...(request || {}),
    status: "failed",
    failedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
  console.error("[bonni-core] Wiederherstellung fehlgeschlagen:", error instanceof Error ? error.message : error);
  process.exit(1);
}
