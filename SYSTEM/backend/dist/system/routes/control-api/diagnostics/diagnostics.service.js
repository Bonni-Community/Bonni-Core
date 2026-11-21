import { diagnosticCatalog, readCoreDiagnostics, validDiagnosticId } from "../../../../core/logger/diagnostic-journal.js";
import { isDiagnosticModuleKey, rememberDiagnosticModule } from "../../../../core/logger/diagnostic-context.js";
import { getLocalAuthProviderStatus } from "../../../../platform/auth/providers/local/index.js";
import { getOidcAuthProviderStatus } from "../../../../platform/auth/providers/oidc/index.js";
import { listModuleManifests } from "../../../../platform/module-manager/manifests/index.js";
import { listInstalledModulesStrict } from "../../../../platform/module-manager/registry/index.js";
import { env } from "../../../../core/config/env.js";
import { CORE_ERROR_FILE_NAME, CORE_LOG_FILE_NAME, CORE_LOG_RETENTION_COUNT, CORE_LOG_ROTATION_INTERVAL_MS, readCoreLogFile, readCoreLogSnapshot, resolveCoreLogPaths, } from "../../../../core/logger/coreLogStorage.js";
export function getSystemDiagnostics() {
    return {
        ok: true,
        area: "diagnostics",
        runtime: {
            nodeEnv: env.NODE_ENV,
            platformPort: env.PORT,
            localSystem: {
                bind: env.LOCAL_AUTH_BIND,
                port: env.LOCAL_AUTH_PORT,
                alwaysAvailable: true,
            },
        },
        auth: {
            local: getLocalAuthProviderStatus(),
            oidc: getOidcAuthProviderStatus(),
        },
        boundaries: {
            localSurfaceLoadsApplicationModules: false,
            systemDependsOnOidc: false,
        },
        coreLogging: {
            root: resolveCoreLogPaths().displayRoot,
            logFile: CORE_LOG_FILE_NAME,
            errorFile: CORE_ERROR_FILE_NAME,
            rotationHours: CORE_LOG_ROTATION_INTERVAL_MS / (60 * 60 * 1000),
            retainedFilesPerStream: CORE_LOG_RETENTION_COUNT,
        },
    };
}
async function readDiagnosticApplications() {
    // Package discovery and the installation database can fail independently.
    // The file journal remains readable if one or both are unavailable.
    const [manifests, installed] = await Promise.allSettled([listModuleManifests(), listInstalledModulesStrict()]);
    const applications = new Map();
    function add(module) {
        if (!isDiagnosticModuleKey(module.key))
            return;
        rememberDiagnosticModule(module.key);
        applications.set(module.key, { id: module.key, kind: module.kind, name: module.name, version: module.version });
    }
    if (installed.status === "fulfilled") {
        for (const module of installed.value) {
            // Retain the identity of removed packages for the journal's history.
            rememberDiagnosticModule(module.key);
            if (module.installed)
                add(module);
        }
    }
    if (manifests.status === "fulfilled") {
        for (const manifest of manifests.value)
            add(manifest);
    }
    return {
        applications: [...applications.values()],
        applicationRegistryAvailable: manifests.status === "fulfilled" && installed.status === "fulfilled",
    };
}
function selectedCategory(category) {
    return Object.hasOwn(diagnosticCatalog.categories, category) ? category : "all";
}
export async function getSystemDiagnosticsLogs(limit, category = "all", moduleId) {
    const selected = selectedCategory(category);
    if (selected === "applications") {
        const inventory = await readDiagnosticApplications();
        return {
            ...inventory,
            root: resolveCoreLogPaths().displayRoot,
            journal: readCoreDiagnostics({ category: selected, limit, moduleId }),
        };
    }
    if (selected === "all")
        await readDiagnosticApplications();
    return {
        ...await readCoreLogSnapshot({ limit }),
        journal: readCoreDiagnostics({ category: selected, limit, moduleId }),
    };
}
export async function getSystemDiagnosticsJournal(category = "all", { errorsOnly = false, operationId, moduleId } = {}) {
    const selected = selectedCategory(category);
    if (selected === "applications" || selected === "all")
        await readDiagnosticApplications();
    const snapshot = readCoreDiagnostics({ category: selected, moduleId, all: true });
    const entries = snapshot.entries
        .filter(entry => !errorsOnly || entry.level === "error" || entry.level === "critical")
        .filter(entry => !operationId || (validDiagnosticId(operationId) && entry.operationId === operationId && (!moduleId || entry.moduleId === moduleId)));
    const lines = entries.map(entry => {
        const operation = entry.operationId ? `[Vorgang ${entry.operationId}] ` : "";
        const label = diagnosticCatalog.stages[entry.phase || ""]?.[0] || entry.message || entry.code || "Technische Meldung";
        return `${entry.timestamp} ${entry.level.toUpperCase()} [${entry.moduleId}] ${operation}${label} ${JSON.stringify(entry)}`;
    });
    return [
        `Bonni Core – ${diagnosticCatalog.categories[selected]}`,
        `Gesamtjournal: ${snapshot.available ? "verfügbar" : "möglicherweise unvollständig"}; höchstens 72 Stunden / 3×2 MB`,
        ...lines,
        "",
    ].join("\n");
}
export async function getSystemDiagnosticsLogFile(stream) {
    return readCoreLogFile(stream);
}
