import { guardModuleWrite, withErasureWriteLock, guardErasurePort } from "../../auth/users/erasure-write-barrier.js";
import { moduleServicesRegistry } from '../../../core/module-services/module-services-runtime.js';
import { hubInstallationPolicy, usesHubProducts } from "../../../core/hub/hub-installation-policy.js";
import { hubProductsRegistry } from "../../../core/hub/hub-products-registry.js";
import { runtimeModuleIdentity } from "./module-runtime-identity.js";
import { ensureAppDatabaseRuntime } from "../distribution/app-database-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { logger as coreLogger } from "../../../core/logger/logger.js";
import { logError as logRuntimeError } from "../../../core/logger/errorLogger.js";
import { recordModuleDiagnostic } from "../../../core/logger/diagnostic-context.js";
import { readFile } from "node:fs/promises";
import { Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findModuleManifest, listModuleManifests } from "../manifests/index.js";
import { resolveBonniProjectRoot } from "../project-root.js";
import { listInstalledModulesStrict } from "../registry/index.js";
import { coreEventBus } from "../../../core/event-bus/event-bus.js";
import { createModuleDataAdapterRuntime } from "../../../core/data-adapters/index.js";
import { createModuleMediaRuntime } from "../../../core/media/index.js";
import { createModulePublicWebRuntime } from "../../../core/http/public-web.js";
import { createModuleFilesRuntime } from "../../../core/files/module-files-runtime.js";
import { createModuleVideoConferenceRuntime } from "../../../core/video-conferencing/index.js";
import { createModuleInstanceIdentityRuntime } from "../../../core/instance-identity/index.js";
import { createStagedModuleDomainMessageRuntime } from "../../../core/domain-messages/index.js";
import { createModuleProtectedPeopleRuntime } from "../../../core/protected-people/index.js";
import { createModuleProtectedOrganizationRuntime } from "../../../core/protected-organization/index.js";
import { createModuleArchiveRuntime } from "../../../core/archive/index.js";
import { createModuleSettingsRuntime } from "../../../core/module-settings/index.js";
import { createStagedModuleNetworkRequestRuntime } from "../../../core/network-requests/index.js";
import { createModuleNetworkPolicyAuthorizer } from "../../../core/network-policy/index.js";
import { createModuleMembersRuntime } from "../../auth/members/index.js";
import { createModuleRequestIdentityRuntime } from "../../auth/request-identity/index.js";
import { createModuleServiceAccountRuntime } from "../../auth/service-accounts/index.js";
import { createModuleTerminalAccountRuntime } from "../../auth/terminal-accounts/index.js";
import { registerUsersNetworkDataAdapter } from "../../auth/users/users-network-data-adapter.js";
import { getDataDomainPrismaClient, getDataDomainJsonNulls, getPrismaClient, } from "../../../core/database/database.js";
import { createModulePrivateDataRuntime } from "../../security/crypto/index.js";
import { createModuleNfcRuntime } from "../../security/nfc/index.js";
import { createModuleTwoFactorRuntime } from "../../security/two-factor/index.js";
import { createStagedModuleTwoFactorProviderRuntime } from "../../security/two-factor/two-factor-provider-registry.js";
import { createDynamicModuleRuntime, normalizeRuntimeModuleCleanup, } from "./dynamic-module-runtime.js";
import { createModuleDatabaseRuntime, moduleDatabaseDomain, } from "./module-database-runtime.js";
import { createModuleLoadGenerations } from "./module-load-generation.js";
let lastLoadedModules = [];
const moduleAttempts = new Map();
const loadingModules = new Map();
const deactivationBarriers = new Map();
const loadGenerations = createModuleLoadGenerations();
const managedRuntimeKeys = new Set();
const attachedRuntimeApps = new WeakSet();
const LOAD_CANCELLED = "MODULE_RUNTIME_LOAD_CANCELLED";
function moduleConfiguration(module) {
    return [
        module.version,
        module.sourcePath || "",
        module.installPath || "",
        module.backendEntry || "",
    ].join("\u0000");
}
function recordRuntimeModule(result) {
    lastLoadedModules = [
        ...lastLoadedModules.filter((entry) => entry.key !== result.key),
        result,
    ];
    return result;
}
function uniqueStrings(values) {
    return [...new Set(values.map((value) => value?.trim()).filter((value) => Boolean(value)))];
}
export function resolveRuntimeModuleEntry(module, manifest, root = resolveBonniProjectRoot()) {
    // Das gefundene Manifest beschreibt die aktuell vorhandene Paketstruktur.
    // In Prisma können nach einer Verschiebung noch alte installPath- oder
    // backendEntry-Werte stehen. Deshalb werden nur tatsächlich vorhandene
    // Kombinationen akzeptiert und die aktuellen Manifestwerte zuerst geprüft.
    const installPaths = uniqueStrings([
        manifest?.sourcePath,
        module.sourcePath,
        module.installPath,
    ]);
    const backendEntries = uniqueStrings([
        manifest?.backend?.entry,
        module.backendEntry,
    ]);
    for (const installPath of installPaths) {
        for (const backendEntry of backendEntries) {
            const entryPath = path.resolve(root, installPath, backendEntry);
            if (existsSync(entryPath)) {
                return { backendEntry, installPath, entryPath };
            }
        }
    }
    return null;
}
async function activeRuntimeModuleKeys() {
    // Activation, deactivation and startup already synchronise the registry
    // with this live set. Re-reading Prisma for every business request made a
    // transient database/registry failure look like a missing Express route:
    // all slots were removed and every module request fell through to 404.
    return [...managedRuntimeKeys];
}
const dynamicRuntime = createDynamicModuleRuntime(activeRuntimeModuleKeys);
export function runtimeModuleKeyForApiPath(requestPath) {
    const pathname = String(requestPath || "").split("?", 1)[0];
    const match = pathname.match(/^\/api\/(apps|addons|plugins)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\/|$)/i);
    return match ? `${match[1].toLowerCase().slice(0, -1)}.${match[2].toLowerCase()}` : null;
}
async function recoverMissingModuleRoute(request, response, next) {
    const key = runtimeModuleKeyForApiPath(request.path || request.originalUrl);
    if (!key || dynamicRuntime.hasRoute(key))
        return next();
    try {
        const module = (await listInstalledModulesStrict()).find((entry) => entry.key === key) || null;
        if (!module?.enabled)
            return next();
        const result = await ensureModuleLoaded(module, true);
        if (result.status === "loaded" && dynamicRuntime.hasRoute(key))
            return next();
        console.error(`[module:${key}] Fachroute konnte nicht wiederhergestellt werden: ${result.error || result.status}`);
        return response.status(503).json({
            ok: false,
            error: "MODULE_RUNTIME_LOAD_FAILED",
            module: key,
            message: result.error || "Das Modul konnte nicht vollständig gestartet werden.",
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[module:${key}] Wiederherstellung der Fachroute fehlgeschlagen.`, error);
        return response.status(503).json({
            ok: false,
            error: "MODULE_RUNTIME_RECOVERY_FAILED",
            module: key,
            message,
        });
    }
}
function attachRuntime(app) {
    if (attachedRuntimeApps.has(app))
        return;
    // If an enabled module failed during boot, retry it on its first business
    // request. Previously the dynamic router simply fell through to the global
    // 404 handler, hiding the real startup error behind dozens of misleading
    // "Route not found" messages in the feature UI.
    app.use(recoverMissingModuleRoute);
    app.use(dynamicRuntime.middleware);
    attachedRuntimeApps.add(app);
}
function cancelledModuleLoad(module) {
    return {
        key: module.key,
        kind: module.kind,
        name: module.name,
        version: module.version,
        status: "skipped",
        route: module.backendEntry || undefined,
        error: LOAD_CANCELLED,
    };
}
async function loadModule(module, isCurrent) {
    const loadAttemptId = randomUUID();
    const startedAt = performance.now();
    let phase = "discover-manifest";
    let loadedVersion = module.version;
    const observe = (status = "loading", extra = {}) => recordModuleDiagnostic(module.key, {
        loadAttemptId, registryVersion: module.version, selectedVersion: loadedVersion, phase, status, ...extra,
    });
    observe();
    let manifest;
    try {
        manifest = await findModuleManifest(module.key);
    }
    catch (error) {
        observe("error");
        logRuntimeError(error, { module: "module-manager", moduleId: module.key, phase, loadAttemptId });
        throw error;
    }
    const backendEntry = manifest?.backend?.entry || module.backendEntry || null;
    const installPath = manifest?.sourcePath || module.sourcePath || module.installPath || null;
    if (!module.enabled || !backendEntry || !installPath) {
        observe("skipped");
        return {
            key: module.key,
            kind: module.kind,
            name: module.name,
            version: module.version,
            status: "skipped",
            route: backendEntry || undefined,
        };
    }
    let registrationCleanup;
    let published = false;
    try {
        phase = "resolve-entry";
        observe();
        const resolvedEntry = resolveRuntimeModuleEntry(module, manifest);
        if (!resolvedEntry) {
            throw new Error(`MODULE_ENTRY_NOT_FOUND:${installPath}/${backendEntry}`);
        }
        const loadedModule = runtimeModuleIdentity(module, manifest, resolvedEntry);
        loadedVersion = loadedModule.version;
        phase = "check-hub-policy";
        observe();
        const hubCandidate = { ...loadedModule, manifestJson: manifest || loadedModule.manifestJson };
        if (usesHubProducts(hubCandidate)) {
            const [installedModules, manifests] = await Promise.all([listInstalledModulesStrict(), listModuleManifests()]);
            const hubPolicy = hubInstallationPolicy(installedModules, hubCandidate, manifests);
            if (hubPolicy.required && !hubPolicy.enabled) {
                throw Object.assign(new Error("HUB_REQUIRED_FOR_MULTIPLE_APPS"), {
                    code: "HUB_REQUIRED_FOR_MULTIPLE_APPS",
                    diagnostic: { phase, hubConsumerCount: hubPolicy.appKeys.length },
                });
            }
        }
        const codeHash = createHash("sha256").update(await readFile(resolvedEntry.entryPath)).digest("hex");
        phase = "prepare-database";
        observe("loading", { entrySha256: codeHash, backendEntry: resolvedEntry.backendEntry });
        await ensureAppDatabaseRuntime(path.resolve(resolveBonniProjectRoot(), resolvedEntry.installPath), module.key, manifest);
        phase = "import-entry";
        observe();
        const entry = await import(pathToFileURL(resolvedEntry.entryPath).href + "?bonni=" + codeHash);
        const register = entry.registerModule || entry.default;
        if (typeof register !== "function") {
            throw new Error("MODULE_ENTRY_EXPORT_NOT_FOUND");
        }
        if (!isCurrent())
            return cancelledModuleLoad(module);
        phase = "create-core-services";
        observe();
        const corePrisma = getPrismaClient();
        const declaredDependencies = new Set((manifest?.dependsOn || []).map((dependency) => String(dependency).trim()));
        const moduleServicesRuntime = declaredDependencies.has('core.module-services') && manifest ? moduleServicesRegistry.stage(module.key, manifest) : null;
        const hubRuntime = manifest ? hubProductsRegistry.stage(module.key, manifest) : null;
        const networkRequestRuntime = createStagedModuleNetworkRequestRuntime(module.key, createModuleNetworkPolicyAuthorizer(corePrisma));
        const twoFactorProviderRuntime = createStagedModuleTwoFactorProviderRuntime(module.key);
        // This port resolves the owning application data domain immediately.
        // A provider plugin such as 2FA owns no application domain, therefore the
        // runtime must exist only when the manifest explicitly requests it.
        const domainMessageRuntime = declaredDependencies.has("core.domain-messages")
            ? createStagedModuleDomainMessageRuntime(module.key, corePrisma)
            : null;
        registrationCleanup = normalizeRuntimeModuleCleanup(() => {
            hubRuntime?.dispose();
            moduleServicesRuntime?.dispose();
            domainMessageRuntime?.dispose();
            networkRequestRuntime.dispose();
            twoFactorProviderRuntime.dispose();
        });
        const dataDomain = moduleDatabaseDomain(module.key, manifest);
        const modulePrisma = dataDomain ? getDataDomainPrismaClient(dataDomain) : null;
        const database = createModuleDatabaseRuntime(module.key, modulePrisma, manifest, dataDomain ? () => getDataDomainJsonNulls(dataDomain) : undefined, { write: guardModuleWrite, transaction: withErasureWriteLock });
        const rawServices = {
            ...(moduleServicesRuntime ? { moduleServices: moduleServicesRuntime.runtime } : {}),
            ...(declaredDependencies.has('core.files') ? { files: createModuleFilesRuntime(module.key) } : {}),
            ...(declaredDependencies.has('core.public-web') ? { publicWeb: createModulePublicWebRuntime() } : {}),
            ...(hubRuntime?.providerRuntime ? { hubProvider: hubRuntime.providerRuntime } : {}),
            ...(hubRuntime?.client ? { hubProducts: hubRuntime.client } : {}),
            eventBus: coreEventBus,
            dataAdapters: createModuleDataAdapterRuntime(module.key),
            networkRequests: networkRequestRuntime.runtime,
            ...(domainMessageRuntime
                ? { domainMessages: domainMessageRuntime.runtime }
                : {}),
            ...(declaredDependencies.has("core.protected-people")
                ? {
                    protectedPeople: createModuleProtectedPeopleRuntime(module.key, corePrisma, getDataDomainPrismaClient("people"), getDataDomainPrismaClient("privacy")),
                }
                : {}),
            ...(declaredDependencies.has("core.protected-organization")
                ? {
                    protectedOrganization: createModuleProtectedOrganizationRuntime(module.key, getDataDomainPrismaClient("organization"), getDataDomainPrismaClient("privacy"), createModuleInstanceIdentityRuntime(corePrisma)),
                }
                : {}),
            serviceAccounts: createModuleServiceAccountRuntime(module.key),
            ...(declaredDependencies.has("core.terminal-accounts")
                ? {
                    terminalAccounts: createModuleTerminalAccountRuntime(module.key, manifest?.name || module.name, manifest?.metadata?.technicalAccounts),
                }
                : {}),
            ...(declaredDependencies.has("core.media")
                ? { media: createModuleMediaRuntime(module.key, corePrisma) }
                : {}),
            ...(declaredDependencies.has("core.video-conferencing")
                ? { videoConferencing: createModuleVideoConferenceRuntime(module.key) }
                : {}),
            ...(declaredDependencies.has("core.instance-identity")
                ? { instanceIdentity: createModuleInstanceIdentityRuntime(corePrisma) }
                : {}),
            ...(declaredDependencies.has("core.request-identity")
                ? {
                    requestIdentity: createModuleRequestIdentityRuntime(module.key, manifest?.metadata?.accessProfiles),
                }
                : {}),
            ...(declaredDependencies.has("core.members")
                ? {
                    members: createModuleMembersRuntime(module.key, manifest?.metadata?.accessProfiles, manifest?.metadata?.legacyAccessMappings, {
                        prisma: corePrisma,
                        memberDevicesEnabled: manifest?.metadata?.memberDevices?.contractVersion === "bonni.member-devices/v1",
                        moduleLabel: manifest?.name || module.name,
                        autoAssignDefaultProfile: manifest?.metadata?.autoAssignMemberAccess !== false,
                        technicalAccounts: manifest?.metadata?.technicalAccounts,
                    }),
                }
                : {}),
            ...(declaredDependencies.has("core.archive")
                ? { archive: createModuleArchiveRuntime(module.key, corePrisma) }
                : {}),
            ...(declaredDependencies.has("core.module-settings")
                ? { moduleSettings: createModuleSettingsRuntime(module.key, corePrisma) }
                : {}),
            ...(declaredDependencies.has("core.two-factor")
                ? { twoFactor: createModuleTwoFactorRuntime(module.key) }
                : {}),
            ...(declaredDependencies.has("core.nfc")
                ? {
                    nfc: createModuleNfcRuntime(module.key, manifest?.metadata?.nfcAccessProfiles),
                }
                : {}),
            ...(declaredDependencies.has("core.two-factor-provider")
                ? { twoFactorProvider: twoFactorProviderRuntime.runtime }
                : {}),
            ...(declaredDependencies.has("core.private-data")
                ? { privateData: createModulePrivateDataRuntime(module.key) }
                : {}),
            database,
            // Compatibility alias. It is either the delegate-restricted client or
            // a fail-closed proxy for explicitly database-less modules.
            prisma: database.client,
        };
        const guarded = ["members", "protectedPeople", "archive", "files", "media", "nfc", "moduleSettings"];
        const services = Object.freeze(Object.fromEntries(Object.entries(rawServices).map(([key, value]) => [key, guarded.includes(key) && value && typeof value === "object" ? guardErasurePort(value) : value])));
        const moduleRouter = Router();
        const logModule = (level, message, metadata) => {
            coreLogger.log(level, message, {
                module: module.key,
                moduleId: module.key,
                appVersion: loadedVersion,
                consoleArguments: metadata === undefined ? undefined : [metadata],
            });
        };
        const logger = Object.freeze({
            info(message, metadata) {
                logModule("info", message, metadata);
            },
            warn(message, metadata) {
                logModule("warn", message, metadata);
            },
            error(message, metadata) {
                logModule("error", message, metadata);
            },
        });
        phase = "register-module";
        observe();
        const registrationResult = await register({
            app: moduleRouter,
            module: loadedModule,
            services,
            prisma: services.prisma,
            logger,
        });
        const moduleCleanup = normalizeRuntimeModuleCleanup(registrationResult);
        registrationCleanup = normalizeRuntimeModuleCleanup(async () => {
            // Revoke every Core capability and abort in-flight work before awaiting
            // add-on cleanup. A slow disposer must not keep the module remotely
            // reachable or leave message subscriptions/retry timers alive.
            hubRuntime?.dispose();
            moduleServicesRuntime?.dispose();
            domainMessageRuntime?.dispose();
            networkRequestRuntime.dispose();
            twoFactorProviderRuntime.dispose();
            let cleanupError;
            try {
                await moduleCleanup?.();
            }
            catch (error) {
                cleanupError = error;
            }
            if (cleanupError)
                throw cleanupError;
        });
        phase = "publish-routes";
        observe();
        published = await dynamicRuntime.publish(module.key, moduleRouter, registrationCleanup, isCurrent, () => {
            hubRuntime?.activate();
            moduleServicesRuntime?.activate();
            domainMessageRuntime?.activate();
            networkRequestRuntime.activate();
            twoFactorProviderRuntime.activate();
        });
        if (!published)
            return cancelledModuleLoad(module);
        phase = "ready";
        observe("loaded");
        coreLogger.info("Fachmodul geladen", { module: "module-manager", moduleId: module.key, selectedVersion: loadedVersion, registryVersion: module.version, loadAttemptId, phase, durationMs: Math.round(performance.now() - startedAt) });
        const result = {
            key: module.key,
            kind: module.kind,
            name: loadedModule.name,
            version: loadedModule.version,
            status: "loaded",
            route: resolvedEntry.backendEntry,
        };
        return result;
    }
    catch (error) {
        if (!published && registrationCleanup) {
            await Promise.resolve(registrationCleanup()).catch(() => undefined);
        }
        const result = {
            key: module.key,
            kind: module.kind,
            name: module.name,
            version: loadedVersion,
            status: "error",
            route: backendEntry || undefined,
            error: error instanceof Error ? error.message : String(error),
        };
        observe("error");
        logRuntimeError(error, { module: "module-manager", moduleId: module.key, phase, loadAttemptId,
            selectedVersion: loadedVersion, registryVersion: module.version, durationMs: Math.round(performance.now() - startedAt) });
        return result;
    }
}
async function ensureModuleLoaded(module, retryFailed = false, observedGeneration = loadGenerations.current(module.key)) {
    const deactivation = deactivationBarriers.get(module.key);
    if (deactivation)
        await deactivation;
    if (loadGenerations.current(module.key) !== observedGeneration)
        return cancelledModuleLoad(module);
    const loading = loadingModules.get(module.key);
    if (loading)
        return loading;
    const configuration = moduleConfiguration(module);
    const previous = moduleAttempts.get(module.key);
    if (previous?.configuration === configuration) {
        if (previous.result.status === "loaded" && dynamicRuntime.hasRoute(module.key)) {
            dynamicRuntime.activate(module.key);
            managedRuntimeKeys.add(module.key);
            return recordRuntimeModule(previous.result);
        }
        if (previous.result.status === "skipped" || (!retryFailed && previous.result.status === "error")) {
            managedRuntimeKeys.delete(module.key);
            return recordRuntimeModule(previous.result);
        }
    }
    if (previous?.configuration !== configuration && previous?.result.status === "loaded") {
        // Node caches the complete imported dependency graph. Re-importing only
        // the entry file would silently mix old and new package code, therefore a
        // version/path change is closed until the process starts with a clean
        // module cache.
        const restartRequired = {
            key: module.key,
            kind: module.kind,
            name: module.name,
            version: module.version,
            status: "error",
            route: module.backendEntry || undefined,
            error: "MODULE_RUNTIME_RESTART_REQUIRED",
        };
        moduleAttempts.set(module.key, { configuration, result: restartRequired });
        await dynamicRuntime.deactivate(module.key).catch(() => undefined);
        managedRuntimeKeys.delete(module.key);
        return recordRuntimeModule(restartRequired);
    }
    const lease = loadGenerations.begin(module.key);
    const promise = loadModule(module, lease.isCurrent)
        .then(async (result) => {
        if (result.error === LOAD_CANCELLED)
            return result;
        moduleAttempts.set(module.key, { configuration, result });
        if (result.status === "loaded") {
            managedRuntimeKeys.add(module.key);
        }
        else {
            managedRuntimeKeys.delete(module.key);
            await dynamicRuntime.deactivate(module.key).catch(() => undefined);
        }
        return recordRuntimeModule(result);
    })
        .finally(() => {
        loadingModules.delete(module.key);
        lease.settle();
    });
    loadingModules.set(module.key, promise);
    return promise;
}
export async function refreshRuntimeModule(keyOrModule) {
    const key = typeof keyOrModule === "string" ? keyOrModule : keyOrModule.key;
    const module = typeof keyOrModule === "string"
        ? (await listInstalledModulesStrict()).find((entry) => entry.key === key) || null
        : keyOrModule;
    if (!module || !module.enabled) {
        await deactivateRuntimeModule(key);
        return recordRuntimeModule({
            key,
            kind: module?.kind || "app",
            name: module?.name || key,
            version: module?.version || "0.0.0",
            status: "skipped",
            route: module?.backendEntry || undefined,
        });
    }
    return ensureModuleLoaded(module, true);
}
export async function deactivateRuntimeModule(key) {
    const previous = deactivationBarriers.get(key);
    // The first invalidation happens synchronously, before this function can
    // yield. A register() already in progress therefore observes a stale lease
    // before it can publish its router.
    const immediatelyInvalidated = previous ? null : loadGenerations.invalidate(key);
    const operation = (async () => {
        let olderLoadsSettled = immediatelyInvalidated;
        if (previous) {
            await previous.catch(() => undefined);
            olderLoadsSettled = loadGenerations.invalidate(key);
        }
        let cleanupError;
        try {
            await dynamicRuntime.deactivate(key);
        }
        catch (error) {
            cleanupError = error;
        }
        await olderLoadsSettled;
        try {
            await dynamicRuntime.deactivate(key);
        }
        catch (error) {
            cleanupError ||= error;
        }
        lastLoadedModules = lastLoadedModules.filter((entry) => entry.key !== key);
        recordModuleDiagnostic(key, { status: "unloaded", phase: "deactivate" });
        managedRuntimeKeys.delete(key);
        if (cleanupError)
            throw cleanupError;
    })();
    deactivationBarriers.set(key, operation);
    try {
        await operation;
    }
    finally {
        if (deactivationBarriers.get(key) === operation)
            deactivationBarriers.delete(key);
    }
}
export async function registerModules(app) {
    registerUsersNetworkDataAdapter();
    attachRuntime(app);
    // A failed registry read must stop module startup with its real error. The
    // former empty-list fallback started a partial server and later exposed
    // every feature route as a misleading 404.
    const modules = (await listInstalledModulesStrict()).filter((module) => module.enabled);
    lastLoadedModules = [];
    // Providers are published before consumers; clients also resolve Hub on every call.
    modules.sort((a, b) => Number(b.key === "addon.hub") - Number(a.key === "addon.hub"));
    for (const module of modules) {
        const result = await ensureModuleLoaded(module, true);
        if (result.status === "error") {
            console.error(`[module:${module.key}] Modulstart fehlgeschlagen: ${result.error || "Unbekannter Fehler"}`);
        }
    }
    return lastLoadedModules;
}
export async function listRegisteredModules() {
    return lastLoadedModules;
}
export async function getRuntimeModuleSummary() {
    return {
        ok: true,
        modules: lastLoadedModules,
        counts: {
            total: lastLoadedModules.length,
            loaded: lastLoadedModules.filter((module) => module.status === "loaded").length,
            skipped: lastLoadedModules.filter((module) => module.status === "skipped").length,
            error: lastLoadedModules.filter((module) => module.status === "error").length,
        },
    };
}
export async function getRuntimeModuleSummaryByManifestId(key) {
    return lastLoadedModules.find((module) => module.key === key) || null;
}
