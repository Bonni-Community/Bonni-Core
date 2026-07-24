import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DUMP_PATH = "/tmp/bonni-candidate.dump";
const ALLOWED_TARGET_ROOTS = new Set(["/candidate-storage", "/candidate-run-system"]);

function postgresEnvironment(rawUrl) {
  const connection = new URL(rawUrl);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) {
    throw new Error("Candidate-Bootstrap unterstützt ausschließlich PostgreSQL.");
  }
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
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "inherit", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-12_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} wurde mit Status ${code} beendet.`));
    });
  });
}

function normalizedRelative(root, entry) {
  return path.relative(root, entry).replaceAll("\\", "/");
}

function shouldSkip(relative) {
  return relative === "system/backups"
    || relative.startsWith("system/backups/")
    || relative === "system/update-center/downloads"
    || relative.startsWith("system/update-center/downloads/")
    || relative === "system/restore-request.json";
}

async function clearCandidateRoot(target) {
  const resolved = path.resolve(target);
  if (!ALLOWED_TARGET_ROOTS.has(resolved)) {
    throw new Error(`Unsicheres Candidate-Ziel verweigert: ${resolved}`);
  }
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(resolved);
  for (const entry of entries) {
    await fs.rm(path.join(resolved, entry), { recursive: true, force: true });
  }
}

async function copyTree(sourceRoot, targetRoot, current = sourceRoot) {
  if (!existsSync(current)) return;
  const relative = normalizedRelative(sourceRoot, current);
  if (relative && shouldSkip(relative)) return;

  const stat = await fs.lstat(current);
  if (stat.isSymbolicLink()) return;

  const destination = relative ? path.join(targetRoot, relative) : targetRoot;
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: stat.mode & 0o777 });
    const entries = await fs.readdir(current);
    for (const entry of entries) {
      await copyTree(sourceRoot, targetRoot, path.join(current, entry));
    }
    return;
  }

  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(current, destination);
    await fs.chmod(destination, stat.mode & 0o777);
  }
}

const sourceUrl = String(process.env.SOURCE_DATABASE_URL || "").trim();
const targetUrl = String(process.env.TARGET_DATABASE_URL || "").trim();
if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) {
  throw new Error("Candidate-Bootstrap benötigt unterschiedliche SOURCE_DATABASE_URL und TARGET_DATABASE_URL.");
}

const targetConnection = new URL(targetUrl);
const expectedTargetHost = String(process.env.BONNI_CANDIDATE_DATABASE_HOST || "db-candidate").trim();
if (targetConnection.hostname !== expectedTargetHost) {
  throw new Error(`Candidate-Datenbankziel ${targetConnection.hostname} ist nicht erlaubt.`);
}

const sourceStorage = path.resolve(process.env.SOURCE_STORAGE_ROOT || "/source-storage");
const targetStorage = path.resolve(process.env.TARGET_STORAGE_ROOT || "/candidate-storage");
const sourceRunSystem = path.resolve(process.env.SOURCE_RUN_SYSTEM_ROOT || "/source-run-system");
const targetRunSystem = path.resolve(process.env.TARGET_RUN_SYSTEM_ROOT || "/candidate-run-system");

console.log("[bonni-core] Candidate-Datenbankkopie wird erstellt.");
await run("pg_dump", [
  "--format=custom",
  "--no-owner",
  "--no-privileges",
  "--file",
  DUMP_PATH,
], postgresEnvironment(sourceUrl));

await run("psql", [
  "--set=ON_ERROR_STOP=1",
  "--command=DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
], postgresEnvironment(targetUrl));

await run("pg_restore", [
  "--no-owner",
  "--no-privileges",
  "--single-transaction",
  DUMP_PATH,
], postgresEnvironment(targetUrl));

console.log("[bonni-core] Candidate-Dateikopie wird erstellt.");
await clearCandidateRoot(targetStorage);
await clearCandidateRoot(targetRunSystem);
await copyTree(sourceStorage, targetStorage);
await copyTree(sourceRunSystem, targetRunSystem);
await fs.unlink(DUMP_PATH).catch(() => undefined);
console.log("[bonni-core] Isolierter Candidate-Stand ist vorbereitet.");
