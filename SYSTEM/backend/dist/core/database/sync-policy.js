import { env } from "../config/env.js";
import { isLocalToServerSyncAllowed } from "./database-context.js";
export function assertManualLocalToServerSyncAllowed() {
    if (!isLocalToServerSyncAllowed()) {
        throw new Error("Manual Local → Server synchronization is not allowed in the current database operation mode.");
    }
}
export function assertServerToLocalSyncBlocked() {
    throw new Error("Server → Local synchronization is intentionally blocked by architecture rule.");
}
export function getDatabaseSyncPolicy() {
    return {
        operationMode: env.DATABASE_OPERATION_MODE,
        syncMode: env.DATABASE_SYNC_MODE,
        direction: "local-to-server",
        automaticSyncAllowed: false,
        serverToLocalAllowed: false,
        storageRecoveryTargets: [
            "local",
            "local-then-server",
            "server-direct",
        ],
        recommendedStorageRecoveryTarget: "local",
    };
}
