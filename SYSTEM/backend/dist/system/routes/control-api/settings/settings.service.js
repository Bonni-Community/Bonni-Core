import { getLocalAuthProviderStatus } from "../../../../platform/auth/providers/local/index.js";
import { env } from "../../../../core/config/env.js";
import { prisma } from "../../../../core/database/prisma.js";
const DATABASE_SETTING_KEYS = [
    "system.displayName",
    "system.maintenanceMode",
    "system.language",
    "system.json.enabled",
    "system.json.backup.enabled",
    "system.json.backup.path",
    "auth.mode",
    "auth.oidc.enabled",
    "auth.oidc.issuerUrl",
    "auth.oidc.clientId",
    "auth.oidc.clientSecret",
    "auth.oidc.redirectUri",
    "auth.oidc.postLogoutRedirectUri",
    "auth.jwt.expiresIn",
    "runtime.database.operationMode",
    "runtime.database.syncMode",
    "runtime.database.databaseUrl",
    "runtime.database.localDatabaseUrl",
    "runtime.database.serverDatabaseUrl",
    "runtime.database.backupDatabaseUrl",
    "media.publicBasePath",
    "media.maxUploadBytes",
    "timecapsule.fileMaxBytes",
    "timecapsule.emergencyMode",
    "featureModules.installMode",
    "featureModules.requireRestartAfterInstall",
    "update.inboxRoot",
];
async function loadDatabaseSettings() {
    try {
        const rows = await prisma.systemSetting.findMany({
            where: {
                key: {
                    in: DATABASE_SETTING_KEYS,
                },
            },
            orderBy: {
                key: "asc",
            },
        });
        const values = Object.fromEntries(rows.map((row) => {
            if (row.key === "auth.oidc.clientSecret") {
                return [row.key, row.value ? "configured" : ""];
            }
            return [row.key, row.value];
        }));
        return {
            available: true,
            values,
            count: rows.length,
            source: "database",
        };
    }
    catch (error) {
        return {
            available: false,
            values: {},
            count: 0,
            source: "database",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function boolSetting(values, key, fallback = false) {
    const value = values[key];
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on", "enabled", "aktiv"].includes(normalized))
            return true;
        if (["0", "false", "no", "off", "disabled", "inaktiv", ""].includes(normalized))
            return false;
    }
    return fallback;
}
function textSetting(values, key, fallback = "") {
    const value = values[key];
    return typeof value === "string" ? value : fallback;
}
export async function getSystemSettingsOverview() {
    const databaseSettings = await loadDatabaseSettings();
    const settings = databaseSettings.values;
    const oidcEnabled = boolSetting(settings, "auth.oidc.enabled", env.OIDC_ENABLED);
    const oidcIssuerUrl = textSetting(settings, "auth.oidc.issuerUrl", env.OIDC_ISSUER_URL);
    const oidcClientId = textSetting(settings, "auth.oidc.clientId", env.OIDC_CLIENT_ID);
    const oidcClientSecretConfigured = Boolean(textSetting(settings, "auth.oidc.clientSecret", env.OIDC_CLIENT_SECRET));
    const oidcRedirectUri = textSetting(settings, "auth.oidc.redirectUri", env.OIDC_REDIRECT_URI);
    return {
        ok: true,
        area: "settings",
        configRule: {
            env: ["MASTER_KEY", "DATABASE_URL", "RUN_SYSTEM_ROOT", "PORT?", "LOCAL_AUTH_PORT?"],
            database: "Systemkonfiguration, die nach dem Start geändert werden kann, liegt in SystemSetting.",
            frontendEnv: false,
        },
        databaseSettings,
        auth: {
            local: {
                ...getLocalAuthProviderStatus(),
                bind: env.LOCAL_AUTH_BIND,
                port: env.LOCAL_AUTH_PORT,
                purpose: ["sandbox", "emergency", "development", "technical-administration"],
            },
            oidc: {
                id: "oidc",
                enabled: oidcEnabled,
                port: env.PORT,
                configured: Boolean(oidcIssuerUrl && oidcClientId && oidcRedirectUri),
                clientSecretConfigured: oidcClientSecretConfigured,
                reason: oidcEnabled
                    ? oidcIssuerUrl && oidcClientId && oidcRedirectUri
                        ? undefined
                        : "OIDC_NOT_CONFIGURED"
                    : "OIDC_DISABLED",
                source: "database",
            },
        },
    };
}
export async function getAuthSettingsOverview() {
    return (await getSystemSettingsOverview()).auth;
}
