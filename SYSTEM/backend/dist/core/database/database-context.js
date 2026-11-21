import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.js";
import { getDatabaseRoutingStatus } from "./database-routing.js";
export const databaseOperationModes = ["local-only", "server-only", "local-to-server"];
export const databaseRoles = ["local", "server"];
export const databaseSyncModes = ["disabled", "manual"];
export const databaseSurfaces = ["platform", "local"];
const databaseContextStorage = new AsyncLocalStorage();
function redactConnectionString(connectionString) {
    if (!connectionString) {
        return null;
    }
    try {
        const parsed = new URL(connectionString);
        if (parsed.password) {
            parsed.password = "***";
        }
        if (parsed.username) {
            parsed.username = parsed.username ? `${parsed.username}` : "";
        }
        return parsed.toString();
    }
    catch {
        return "configured";
    }
}
export function resolveDatabaseRoleForSurface(surface, operationMode = env.DATABASE_OPERATION_MODE) {
    if (surface === "local") {
        return "local";
    }
    if (operationMode === "local-only") {
        return "local";
    }
    return "server";
}
export function createDatabaseContext(surface) {
    return {
        role: resolveDatabaseRoleForSurface(surface),
        surface,
        operationMode: env.DATABASE_OPERATION_MODE,
        syncMode: env.DATABASE_SYNC_MODE,
        serverToLocalAllowed: false,
    };
}
export function runWithDatabaseContext(context, callback) {
    return databaseContextStorage.run(context, callback);
}
export function getDatabaseContext() {
    return databaseContextStorage.getStore() ?? createDatabaseContext("platform");
}
export function getActiveDatabaseRole() {
    return getDatabaseContext().role;
}
export function isLocalToServerSyncAllowed() {
    const context = getDatabaseContext();
    return context.operationMode === "local-to-server" && context.syncMode === "manual";
}
export function isServerToLocalSyncAllowed() {
    return false;
}
export function createDatabaseContextMiddleware(surface) {
    return (_req, res, next) => {
        const context = createDatabaseContext(surface);
        res.locals.databaseContext = context;
        runWithDatabaseContext(context, next);
    };
}
export function getDatabaseOperationStatus() {
    return {
        ok: true,
        operationMode: env.DATABASE_OPERATION_MODE,
        syncMode: env.DATABASE_SYNC_MODE,
        syncDirection: "local-to-server",
        serverToLocalAllowed: false,
        rules: {
            localOnly: "arbeitet nur mit lokaler Datenbank; keine Serverdatenbank nötig; keine Synchronisation",
            serverOnly: "arbeitet direkt gegen Serverdatenbank; lokale Datenbank ist nicht Quelle",
            localToServer: "lokale Datenbank ist führend; Server bekommt Daten nur bewusst aus Local",
            noServerToLocal: "Serverdaten werden niemals automatisch nach Local geschrieben",
        },
        urls: {
            local: {
                configured: Boolean(env.LOCAL_DATABASE_URL),
                value: redactConnectionString(env.LOCAL_DATABASE_URL),
            },
            server: {
                configured: Boolean(env.SERVER_DATABASE_URL),
                value: redactConnectionString(env.SERVER_DATABASE_URL),
            },
            legacyDatabaseUrl: {
                configured: Boolean(env.DATABASE_URL),
                value: redactConnectionString(env.DATABASE_URL),
            },
        },
        ports: {
            server: env.PORT,
            local: env.LOCAL_AUTH_PORT,
            localBind: env.LOCAL_AUTH_BIND,
        },
        surfaces: {
            platform: {
                role: resolveDatabaseRoleForSurface("platform"),
            },
            local: {
                role: resolveDatabaseRoleForSurface("local"),
            },
        },
        routing: getDatabaseRoutingStatus(),
    };
}
