#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

import {
  createCutoverSnapshot,
  restoreCutoverSnapshot,
} from "./update-cutover-snapshot-lib.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} fehlt.`);
  return value;
}

function postgresConnection() {
  const connection = new URL(required("DATABASE_URL"));
  if (!["postgres:", "postgresql:"].includes(connection.protocol)) throw new Error("Nur PostgreSQL wird unterstützt.");
  const database = decodeURIComponent(connection.pathname.replace(/^\//, ""));
  if (!database || database.includes("\0") || database === "template0" || database === "template1") {
    throw new Error("Ziel-Datenbank ist leer oder als PostgreSQL-Systemdatenbank geschützt.");
  }
  const maintenanceDatabase = database === "postgres" ? "template1" : "postgres";
  if (maintenanceDatabase === database) throw new Error("Maintenance- und Ziel-Datenbank müssen verschieden sein.");
  return {
    database,
    maintenanceDatabase,
    user: decodeURIComponent(connection.username),
    environment: {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "10",
    },
  };
}

const postgres = postgresConnection();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...postgres.environment, ...(options.env || {}) },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || `${command} wurde mit Status ${code} beendet.`)));
  });
}

async function dumpDatabase(target) {
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", target]);
}

async function validateDatabaseDump(target) {
  await run("pg_restore", ["--list", target]);
}

async function restoreDatabase(target) {
  // An object-level --clean leaves objects behind when only the failed release
  // created them. Force-drop and recreate the whole application database from
  // a distinct maintenance database, then restore the known dump atomically.
  await run("dropdb", [
    `--maintenance-db=${postgres.maintenanceDatabase}`, "--if-exists", "--force", "--", postgres.database,
  ], { env: { PGDATABASE: postgres.maintenanceDatabase } });
  await run("createdb", [
    `--maintenance-db=${postgres.maintenanceDatabase}`, "--template=template0", `--owner=${postgres.user}`,
    "--", postgres.database,
  ], { env: { PGDATABASE: postgres.maintenanceDatabase } });
  await run("pg_restore", [
    "--exit-on-error", "--single-transaction", `--dbname=${postgres.database}`,
    "--no-owner", "--no-privileges", target,
  ]);
}

const action = process.argv[2];
const snapshotBase = path.resolve(required("BONNI_UPDATE_ROLLBACK_SNAPSHOT_ROOT"));
const snapshotId = required("BONNI_UPDATE_SNAPSHOT_ID");
const shared = {
  snapshotBase,
  snapshotId,
  workflowId: required("BONNI_UPDATE_SNAPSHOT_WORKFLOW_ID"),
  backupId: required("BONNI_UPDATE_SNAPSHOT_BACKUP_ID"),
  currentVersion: required("BONNI_UPDATE_SNAPSHOT_CURRENT_VERSION"),
  validateDatabaseDump,
};

if (action === "create") {
  const result = await createCutoverSnapshot({
    ...shared,
    sourceStorage: path.resolve(required("BONNI_UPDATE_SOURCE_STORAGE_ROOT")),
    sourceRunSystem: path.resolve(required("BONNI_UPDATE_SOURCE_RUN_SYSTEM_ROOT")),
    dumpDatabase,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, action, id: result.manifest.id, manifestSha256: result.manifestSha256 })}\n`);
} else if (action === "restore") {
  const targetStorage = path.resolve(required("BONNI_UPDATE_TARGET_STORAGE_ROOT"));
  const targetRunSystem = path.resolve(required("BONNI_UPDATE_TARGET_RUN_SYSTEM_ROOT"));
  // These are fixed mount points in docker-compose.runtime.yml. Refuse every
  // host/config override before a recursive replacement can begin.
  if (targetStorage !== "/target-storage" || targetRunSystem !== "/target-run-system") {
    throw new Error("Restore-Ziele entsprechen nicht den festen Bonni-Mountpunkten.");
  }
  const result = await restoreCutoverSnapshot({
    ...shared,
    resultBase: path.resolve(required("BONNI_UPDATE_ROLLBACK_RESULT_ROOT")),
    restoreAttemptId: required("BONNI_UPDATE_RESTORE_ATTEMPT_ID"),
    targetStorage,
    targetRunSystem,
    allowedTargetStorage: "/target-storage",
    allowedTargetRunSystem: "/target-run-system",
    restoreDatabase,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, action, id: result.manifest.id, manifestSha256: result.manifestSha256 })}\n`);
} else {
  throw new Error("Aktion muss create oder restore sein.");
}
