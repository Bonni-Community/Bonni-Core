import { getSystemRuntimeConfig } from "./runtime.config.js";
import { getDatabaseOperationStatus, getServerPrismaClient } from "../../core/database/database.js";
import { getRuntimeJsonFallbackStatus } from "./runtime-json-fallback.service.js";
async function withTimeout(promise, timeoutMs, label) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
async function checkDatabaseReady() {
    try {
        const prisma = getServerPrismaClient();
        await withTimeout(prisma.$queryRaw `SELECT 1`, 2_000, "database readiness check");
        return {
            ok: true,
            message: "Database connection is ready.",
        };
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
export function getRuntimeLiveStatus() {
    const runtime = getSystemRuntimeConfig();
    const now = new Date();
    return {
        ok: true,
        state: "live",
        runtime: {
            slotName: runtime.slotName,
            slotRole: runtime.slotRole,
            version: runtime.version,
            imageVersion: runtime.imageVersion,
            updateProbeMode: runtime.updateProbeMode,
            emergencyHoldDays: runtime.emergencyHoldDays,
            bootKeyRequired: runtime.bootKeyRequired,
            startedAt: runtime.startedAt.toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            pid: runtime.pid,
        },
        checkedAt: now.toISOString(),
    };
}
export async function getRuntimeReadyStatus() {
    const live = getRuntimeLiveStatus();
    const [database, runtimeJsonFallback] = await Promise.all([
        checkDatabaseReady(),
        getRuntimeJsonFallbackStatus(),
    ]);
    const notlaufReady = runtimeJsonFallback.active && runtimeJsonFallback.json.ok;
    const ok = database.ok || notlaufReady;
    return {
        ...live,
        ok,
        state: database.ok
            ? "ready"
            : notlaufReady
                ? "degraded"
                : "unready",
        database: {
            ...getDatabaseOperationStatus(),
            ready: database.ok,
            message: database.message,
        },
        runtimeFallback: runtimeJsonFallback,
        notlauf: {
            active: runtimeJsonFallback.active,
            source: runtimeJsonFallback.runtimeSource,
            reason: runtimeJsonFallback.reason,
            restrictions: runtimeJsonFallback.restrictions,
        },
    };
}
