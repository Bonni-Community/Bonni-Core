import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../../core/database/prisma.js";
import { getRunSystemSystemRoot } from "../boot/run-system/index.js";
const RUNTIME_FILE = "runtime.json";
const INSTALLED_RUNTIME_FILE = "installed-runtime.json";
const DEFAULT_DATABASE_PROBE_TIMEOUT_MS = 2_000;
function systemRoot() {
    return process.env.RUNCONTAINER_ROOT
        ? path.resolve(process.env.RUNCONTAINER_ROOT)
        : getRunSystemSystemRoot();
}
function slotPath(slot) {
    return path.join(systemRoot(), slot);
}
export function resolveRuntimeJsonSlot() {
    const role = String(process.env.SYSTEM_SLOT_ROLE ?? "active").trim().toLowerCase();
    const name = String(process.env.SYSTEM_SLOT_NAME ?? "").trim().toLowerCase();
    if (role === "emergency" || name.includes("emergency")) {
        return "emergency";
    }
    if (role === "candidate" || name.includes("candidate")) {
        return "candidate";
    }
    return "active";
}
export function runtimeJsonPath(slot = "active") {
    return path.join(slotPath(slot), RUNTIME_FILE);
}
export function installedRuntimeJsonPath(slot = "active") {
    return path.join(slotPath(slot), INSTALLED_RUNTIME_FILE);
}
async function readJson(file) {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        return null;
    }
}
function normalizeRuntimeSourceMode() {
    const raw = String(process.env.SYSTEM_RUNTIME_SOURCE ??
        process.env.RUNTIME_SOURCE ??
        process.env.NOTLAUF_RUNTIME_SOURCE ??
        "auto").trim().toLowerCase();
    if (["json", "file", "fallback", "notlauf", "emergency"].includes(raw)) {
        return "json";
    }
    if (["database", "db", "postgres", "postgresql"].includes(raw)) {
        return "database";
    }
    return "auto";
}
function databaseRequired() {
    return normalizeRuntimeSourceMode() === "database";
}
function timeoutMs() {
    const value = Number(process.env.RUNTIME_DATABASE_PROBE_TIMEOUT_MS ?? DEFAULT_DATABASE_PROBE_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_DATABASE_PROBE_TIMEOUT_MS;
}
async function withTimeout(promise, timeout, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
            }),
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export async function probeRuntimeDatabase() {
    const checkedAt = new Date().toISOString();
    try {
        const delegate = prisma;
        await withTimeout(delegate.$queryRawUnsafe("SELECT 1"), timeoutMs(), "runtime database probe");
        return { ok: true, checkedAt, error: null };
    }
    catch (error) {
        return { ok: false, checkedAt, error: errorMessage(error) };
    }
}
export async function readRuntimeJson(slot = "active") {
    return readJson(runtimeJsonPath(slot));
}
export async function readInstalledRuntimeJson(slot = "active") {
    return readJson(installedRuntimeJsonPath(slot));
}
export function installedRuntimeModules(installedRuntime) {
    if (Array.isArray(installedRuntime)) {
        return installedRuntime.filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
    }
    const modules = installedRuntime?.modules;
    return Array.isArray(modules)
        ? modules.filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        : [];
}
export async function getRuntimeJsonFallbackStatus() {
    const mode = normalizeRuntimeSourceMode();
    const slot = resolveRuntimeJsonSlot();
    const [database, runtime, installedRuntime] = await Promise.all([
        probeRuntimeDatabase(),
        readRuntimeJson(slot),
        readInstalledRuntimeJson(slot),
    ]);
    const runtimeAvailable = Boolean(runtime);
    const installedRuntimeAvailable = Boolean(installedRuntime);
    const jsonOk = runtimeAvailable && installedRuntimeAvailable;
    const forcedJson = mode === "json";
    const forcedDatabase = mode === "database";
    const active = forcedJson || (!forcedDatabase && !database.ok && jsonOk);
    const ok = database.ok || (active && jsonOk && !databaseRequired());
    return {
        ok,
        mode,
        slot,
        active,
        state: database.ok && !forcedJson ? "database" : active && jsonOk ? "notlauf" : "unavailable",
        reason: active
            ? forcedJson
                ? "RUNTIME_SOURCE_JSON_FORCED"
                : "DATABASE_UNAVAILABLE_USING_RUNTIME_JSON"
            : database.ok
                ? null
                : "DATABASE_UNAVAILABLE_AND_RUNTIME_JSON_NOT_READY",
        runtimeSource: active ? "json" : "database",
        fallbackSource: "json",
        database: {
            ...database,
            required: databaseRequired(),
        },
        json: {
            ok: jsonOk,
            slot,
            runtimePath: runtimeJsonPath(slot),
            installedRuntimePath: installedRuntimeJsonPath(slot),
            runtimeAvailable,
            installedRuntimeAvailable,
        },
        restrictions: {
            writes: active ? "limited-json-queue" : "database-required",
            allowed: active
                ? [
                    "Systemstatus lesen",
                    "Installierte Fachmodule lesen",
                    "operative Notlaufdaten vorbereiten",
                    "Bestellungen als spätere Abgleichdaten vormerken",
                ]
                : [
                    "voller Datenbankbetrieb",
                    "Fachmodul-Installation",
                    "Rechnungen",
                    "Geldtransfers",
                ],
            blocked: active
                ? [
                    "Rechnungen erstellen oder finalisieren",
                    "Kassenabschluss buchen",
                    "Geldtransfer ausführen",
                    "Fachmodule installieren oder entfernen",
                    "Datenbank-Migrationen ausführen",
                ]
                : [],
        },
    };
}
export async function shouldUseRuntimeJsonFallback() {
    return (await getRuntimeJsonFallbackStatus()).active;
}
export async function assertDatabaseRuntimeRequired(action) {
    const status = await getRuntimeJsonFallbackStatus();
    if (status.active || !status.database.ok) {
        const error = new Error(`DATABASE_REQUIRED:${action}`);
        error.status = 503;
        error.details = status;
        throw error;
    }
}
