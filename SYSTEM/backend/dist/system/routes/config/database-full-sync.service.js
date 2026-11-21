import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginDatabaseFullSync, disconnectDatabaseTarget, finishDatabaseFullSync, getDatabaseTargetConnectionString, } from "../../../core/database/database.js";
import { withPersistentSnapshotLock } from "../../../core/storage/persistent-snapshot-lock.js";
const FULL_SYNC_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDERR_CHARS = 64_000;
function connectionEnvironment(connectionString) {
    const parsed = new URL(connectionString);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    const sslMode = parsed.searchParams.get("sslmode") || "prefer";
    return {
        database,
        identity: `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${database}`,
        env: {
            ...process.env,
            PGHOST: parsed.hostname,
            PGPORT: parsed.port || "5432",
            PGUSER: decodeURIComponent(parsed.username || "postgres"),
            PGPASSWORD: decodeURIComponent(parsed.password || ""),
            PGDATABASE: database,
            PGSSLMODE: sslMode,
            PGAPPNAME: "bonni-control-center-full-sync",
        },
    };
}
function executable(name) {
    const override = name === "pg_dump" ? process.env.PG_DUMP_PATH : process.env.PG_RESTORE_PATH;
    return override?.trim() || name;
}
function runPostgresTool(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            child.kill("SIGTERM");
            settled = true;
            reject(Object.assign(new Error("DATABASE_FULL_SYNC_TIMEOUT"), {
                statusCode: 504,
                code: "DATABASE_FULL_SYNC_TIMEOUT",
            }));
        }, FULL_SYNC_TIMEOUT_MS);
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
        });
        child.once("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const missing = error.code === "ENOENT";
            reject(Object.assign(new Error(missing ? "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED" : "DATABASE_FULL_SYNC_TOOL_FAILED"), {
                statusCode: missing ? 503 : 500,
                code: missing ? "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED" : error.code,
            }));
        });
        child.once("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve();
                return;
            }
            console.error("[bonni-core] PostgreSQL-Vollabgleich fehlgeschlagen", {
                command: path.basename(command),
                exitCode: code,
                stderr: stderr.slice(-2_000),
            });
            reject(Object.assign(new Error("DATABASE_FULL_SYNC_TOOL_FAILED"), {
                statusCode: 500,
                code: "DATABASE_FULL_SYNC_TOOL_FAILED",
                exitCode: code,
            }));
        });
    });
}
function expectedConfirmation(target) {
    return target === "normal"
        ? "NORMALE DATENBANK ÜBERSCHREIBEN"
        : "REDUNDANTE DATENBANK ÜBERSCHREIBEN";
}
export function getDatabaseFullSyncConfirmation(target) {
    return expectedConfirmation(target);
}
export async function runDatabaseFullSync(input, dependencies = {}) {
    const body = input && typeof input === "object" ? input : {};
    const source = body.source === "normal" || body.source === "redundant"
        ? body.source
        : null;
    const target = body.target === "normal" || body.target === "redundant"
        ? body.target
        : null;
    const confirmation = String(body.confirmation || "").trim();
    if (!source || !target || source === target) {
        throw Object.assign(new Error("DATABASE_FULL_SYNC_DIRECTION_INVALID"), { statusCode: 400 });
    }
    const expected = expectedConfirmation(target);
    if (confirmation !== expected) {
        throw Object.assign(new Error("DATABASE_FULL_SYNC_CONFIRMATION_REQUIRED"), {
            statusCode: 400,
            code: "DATABASE_FULL_SYNC_CONFIRMATION_REQUIRED",
            details: { expected },
        });
    }
    const getConnectionString = dependencies.getConnectionString || getDatabaseTargetConnectionString;
    const beginMaintenance = dependencies.beginMaintenance || beginDatabaseFullSync;
    const finishMaintenance = dependencies.finishMaintenance || finishDatabaseFullSync;
    const disconnectTarget = dependencies.disconnectTarget || disconnectDatabaseTarget;
    const runTool = dependencies.runTool || runPostgresTool;
    const withSnapshotLock = dependencies.withSnapshotLock || withPersistentSnapshotLock;
    const sourceConnection = connectionEnvironment(getConnectionString(source));
    const targetConnection = connectionEnvironment(getConnectionString(target));
    if (sourceConnection.identity === targetConnection.identity) {
        throw Object.assign(new Error("DATABASE_FULL_SYNC_SOURCE_EQUALS_TARGET"), { statusCode: 409 });
    }
    const startedAt = Date.now();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-db-full-sync-"));
    const dumpFile = path.join(temporaryDirectory, "database.dump");
    try {
        return await withSnapshotLock("database-full-sync", async () => {
            // Lock ordering is always persistent snapshot lock -> DB maintenance.
            // Branding mutations use the same order, preventing a maintenance/lock
            // inversion while keeping dump and restore one immutable phase.
            let maintenanceAcquired = false;
            let succeeded = false;
            try {
                beginMaintenance(source, target);
                maintenanceAcquired = true;
                await runTool(executable("pg_dump"), [
                    "--format=custom",
                    "--no-owner",
                    "--no-acl",
                    `--file=${dumpFile}`,
                ], sourceConnection.env);
                await disconnectTarget(target);
                await runTool(executable("pg_restore"), [
                    "--clean",
                    "--if-exists",
                    "--no-owner",
                    "--no-acl",
                    "--single-transaction",
                    `--dbname=${targetConnection.database}`,
                    dumpFile,
                ], targetConnection.env);
                succeeded = true;
                return {
                    ok: true,
                    source,
                    target,
                    completedAt: new Date().toISOString(),
                    durationMs: Date.now() - startedAt,
                    message: `${target === "normal" ? "Normale" : "Redundante"} Datenbank wurde vollständig aus der ${source === "normal" ? "normalen" : "redundanten"} Datenbank wiederhergestellt.`,
                };
            }
            finally {
                if (maintenanceAcquired) {
                    await finishMaintenance(source, target, succeeded);
                }
            }
        });
    }
    finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
}
