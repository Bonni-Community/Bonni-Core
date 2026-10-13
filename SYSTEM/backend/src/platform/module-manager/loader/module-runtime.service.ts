import {ensureAppDatabaseRuntime} from "../distribution/app-database-runtime.js";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findModuleManifest } from "../manifests/index.js";
import { resolveBonniProjectRoot } from "../project-root.js";
import { listInstalledModulesStrict } from "../registry/index.js";
import type { InstalledModuleSummary, ModuleManifestSummary } from "../types.js";
import { coreEventBus } from "../../../core/event-bus/event-bus.js";
import { createModuleDataAdapterRuntime } from "../../../core/data-adapters/index.js";
import { createModuleMediaRuntime } from "../../../core/media/index.js";
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
import {
  getDataDomainPrismaClient,
  getPrismaClient,
} from "../../../core/database/database.js";
import { createModulePrivateDataRuntime } from "../../security/crypto/index.js";
import { createModuleNfcRuntime } from "../../security/nfc/index.js";
import { createModuleTwoFactorRuntime } from "../../security/two-factor/index.js";
import { createStagedModuleTwoFactorProviderRuntime } from "../../security/two-factor/two-factor-provider-registry.js";
import {
  createDynamicModuleRuntime,
  normalizeRuntimeModuleCleanup,
  type RuntimeModuleCleanup,
} from "./dynamic-module-runtime.js";
import {
  createModuleDatabaseRuntime,
  moduleDatabaseDomain,
} from "./module-database-runtime.js";
import { createModuleLoadGenerations } from "./module-load-generation.js";

export type RegisteredRuntimeModule = {
  key: string;
  kind: string;
  name: string;
  version: string;
  status: "loaded" | "skipped" | "error";
  route?: string;
  error?: string;
};

let lastLoadedModules: RegisteredRuntimeModule[] = [];
const moduleAttempts = new Map<string, { configuration: string; result: RegisteredRuntimeModule }>();
const loadingModules = new Map<string, Promise<RegisteredRuntimeModule>>();
const deactivationBarriers = new Map<string, Promise<void>>();
const loadGenerations = createModuleLoadGenerations();
const managedRuntimeKeys = new Set<string>();
const attachedRuntimeApps = new WeakSet<Express>();
const LOAD_CANCELLED = "MODULE_RUNTIME_LOAD_CANCELLED";

function moduleConfiguration(module: InstalledModuleSummary) {
  return [
    module.version,
    module.sourcePath || "",
    module.installPath || "",
    module.backendEntry || "",
  ].join("\u0000");
}

function recordRuntimeModule(result: RegisteredRuntimeModule) {
  lastLoadedModules = [
    ...lastLoadedModules.filter((entry) => entry.key !== result.key),
    result,
  ];
  return result;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export type ResolvedRuntimeModuleEntry = {
  backendEntry: string;
  installPath: string;
  entryPath: string;
};

export function resolveRuntimeModuleEntry(
  module: InstalledModuleSummary,
  manifest: ModuleManifestSummary | null,
  root = resolveBonniProjectRoot(),
): ResolvedRuntimeModuleEntry | null {
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

export function runtimeModuleKeyForApiPath(requestPath: string) {
  const pathname = String(requestPath || "").split("?", 1)[0];
  const match = pathname.match(/^\/api\/apps\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\/|$)/i);
  return match ? `app.${match[1].toLowerCase()}` : null;
}

async function recoverMissingModuleRoute(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const key = runtimeModuleKeyForApiPath(request.path || request.originalUrl);
  if (!key || dynamicRuntime.hasRoute(key)) return next();

  try {
    const module = (await listInstalledModulesStrict()).find((entry) => entry.key === key) || null;
    if (!module?.enabled) return next();

    const result = await ensureModuleLoaded(module, true);
    if (result.status === "loaded" && dynamicRuntime.hasRoute(key)) return next();

    console.error(
      `[module:${key}] Fachroute konnte nicht wiederhergestellt werden: ${result.error || result.status}`,
    );
    return response.status(503).json({
      ok: false,
      error: "MODULE_RUNTIME_LOAD_FAILED",
      module: key,
      message: result.error || "Das Modul konnte nicht vollständig gestartet werden.",
    });
  } catch (error) {
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

function attachRuntime(app: Express) {
  if (attachedRuntimeApps.has(app)) return;
  // If an enabled module failed during boot, retry it on its first business
  // request. Previously the dynamic router simply fell through to the global
  // 404 handler, hiding the real startup error behind dozens of misleading
  // "Route not found" messages in the feature UI.
  app.use(recoverMissingModuleRoute);
  app.use(dynamicRuntime.middleware);
  attachedRuntimeApps.add(app);
}

function cancelledModuleLoad(module: InstalledModuleSummary): RegisteredRuntimeModule {
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

async function loadModule(
  module: InstalledModuleSummary,
  isCurrent: () => boolean,
): Promise<RegisteredRuntimeModule> {
  const manifest = await findModuleManifest(module.key);
  const backendEntry = manifest?.backend?.entry || module.backendEntry || null;
  const installPath = manifest?.sourcePath || module.sourcePath || module.installPath || null;

  if (!module.enabled || !backendEntry || !installPath) {
    return {
      key: module.key,
      kind: module.kind,
      name: module.name,
      version: module.version,
      status: "skipped",
      route: backendEntry || undefined,
    };
  }

  let registrationCleanup: RuntimeModuleCleanup | undefined;
  let published = false;
  try {
    const resolvedEntry = resolveRuntimeModuleEntry(module, manifest);
    if (!resolvedEntry) {
      throw new Error(
        `MODULE_ENTRY_NOT_FOUND:${installPath}/${backendEntry}`,
      );
    }

    await ensureAppDatabaseRuntime(path.resolve(resolveBonniProjectRoot(),installPath),module.key);
    const codeHash=createHash("sha256").update(await readFile(resolvedEntry.entryPath)).digest("hex");
    const entry = await import(pathToFileURL(resolvedEntry.entryPath).href+"?bonni="+codeHash);
    const register = entry.registerModule || entry.default;

    if (typeof register !== "function") {
      throw new Error("MODULE_ENTRY_EXPORT_NOT_FOUND");
    }
    if (!isCurrent()) return cancelledModuleLoad(module);

    const corePrisma = getPrismaClient();
    const declaredDependencies = new Set(
      (manifest?.dependsOn || []).map((dependency) => String(dependency).trim()),
    );
    const networkRequestRuntime = createStagedModuleNetworkRequestRuntime(
      module.key,
      createModuleNetworkPolicyAuthorizer(corePrisma),
    );
    const twoFactorProviderRuntime = createStagedModuleTwoFactorProviderRuntime(module.key);
    // This port resolves the owning application data domain immediately.
    // A provider plugin such as 2FA owns no application domain, therefore the
    // runtime must exist only when the manifest explicitly requests it.
    const domainMessageRuntime = declaredDependencies.has("core.domain-messages")
      ? createStagedModuleDomainMessageRuntime(module.key, corePrisma)
      : null;
    registrationCleanup = normalizeRuntimeModuleCleanup(() => {
      domainMessageRuntime?.dispose();
      networkRequestRuntime.dispose();
      twoFactorProviderRuntime.dispose();
    });
    const dataDomain = moduleDatabaseDomain(module.key, manifest);
    const modulePrisma = dataDomain ? getDataDomainPrismaClient(dataDomain) : null;
    const database = createModuleDatabaseRuntime(module.key, modulePrisma, manifest);
    const services = Object.freeze({
      eventBus: coreEventBus,
      dataAdapters: createModuleDataAdapterRuntime(module.key),
      networkRequests: networkRequestRuntime.runtime,
      ...(domainMessageRuntime
        ? { domainMessages: domainMessageRuntime.runtime }
        : {}),
      ...(declaredDependencies.has("core.protected-people")
        ? {
            protectedPeople: createModuleProtectedPeopleRuntime(
              module.key,
              corePrisma,
              getDataDomainPrismaClient("people"),
              getDataDomainPrismaClient("privacy"),
            ),
          }
        : {}),
      ...(declaredDependencies.has("core.protected-organization")
        ? {
            protectedOrganization: createModuleProtectedOrganizationRuntime(
              module.key,
              getDataDomainPrismaClient("organization"),
              getDataDomainPrismaClient("privacy"),
              createModuleInstanceIdentityRuntime(corePrisma),
            ),
          }
        : {}),
      serviceAccounts: createModuleServiceAccountRuntime(module.key),
      ...(declaredDependencies.has("core.terminal-accounts")
        ? {
            terminalAccounts: createModuleTerminalAccountRuntime(
              module.key,
              manifest?.name || module.name,
              manifest?.metadata?.technicalAccounts,
            ),
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
            requestIdentity: createModuleRequestIdentityRuntime(
              module.key,
              manifest?.metadata?.accessProfiles,
            ),
          }
        : {}),
      ...(declaredDependencies.has("core.members")
        ? {
            members: createModuleMembersRuntime(
              module.key,
              manifest?.metadata?.accessProfiles,
              manifest?.metadata?.legacyAccessMappings,
              {
                prisma: corePrisma,
                moduleLabel: manifest?.name || module.name,
                autoAssignDefaultProfile: manifest?.metadata?.autoAssignMemberAccess !== false,
                technicalAccounts: manifest?.metadata?.technicalAccounts,
              },
            ),
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
            nfc: createModuleNfcRuntime(
              module.key,
              manifest?.metadata?.nfcAccessProfiles,
            ),
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
    });

    const moduleRouter = Router();
    const logger = Object.freeze({
      info(message: string, metadata?: unknown) {
        console.info(`[module:${module.key}] ${message}`, metadata ?? "");
      },
      warn(message: string, metadata?: unknown) {
        console.warn(`[module:${module.key}] ${message}`, metadata ?? "");
      },
      error(message: string, metadata?: unknown) {
        console.error(`[module:${module.key}] ${message}`, metadata ?? "");
      },
    });
    const registrationResult = await register({
      app: moduleRouter as unknown as Express,
      module,
      services,
      prisma: services.prisma,
      logger,
    });
    const moduleCleanup = normalizeRuntimeModuleCleanup(registrationResult);
    registrationCleanup = normalizeRuntimeModuleCleanup(async () => {
      // Revoke every Core capability and abort in-flight work before awaiting
      // add-on cleanup. A slow disposer must not keep the module remotely
      // reachable or leave message subscriptions/retry timers alive.
      domainMessageRuntime?.dispose();
      networkRequestRuntime.dispose();
      twoFactorProviderRuntime.dispose();
      let cleanupError: unknown;
      try {
        await moduleCleanup?.();
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError) throw cleanupError;
    });

    published = await dynamicRuntime.publish(
      module.key,
      moduleRouter,
      registrationCleanup,
      isCurrent,
      () => {
        domainMessageRuntime?.activate();
        networkRequestRuntime.activate();
        twoFactorProviderRuntime.activate();
      },
    );
    if (!published) return cancelledModuleLoad(module);

    const result: RegisteredRuntimeModule = {
      key: module.key,
      kind: module.kind,
      name: module.name,
      version: module.version,
      status: "loaded",
      route: resolvedEntry.backendEntry,
    };
    return result;
  } catch (error) {
    if (!published && registrationCleanup) {
      await Promise.resolve(registrationCleanup()).catch(() => undefined);
    }
    const result: RegisteredRuntimeModule = {
      key: module.key,
      kind: module.kind,
      name: module.name,
      version: module.version,
      status: "error",
      route: backendEntry || undefined,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(
      `[module:${module.key}] Laufzeit konnte nicht geladen werden.`,
      error instanceof Error ? error.stack || error.message : error,
    );
    return result;
  }
}

async function ensureModuleLoaded(
  module: InstalledModuleSummary,
  retryFailed = false,
  observedGeneration = loadGenerations.current(module.key),
) {
  const deactivation = deactivationBarriers.get(module.key);
  if (deactivation) await deactivation;
  if (loadGenerations.current(module.key) !== observedGeneration) return cancelledModuleLoad(module);

  const loading = loadingModules.get(module.key);
  if (loading) return loading;

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
    const restartRequired: RegisteredRuntimeModule = {
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
      if (result.error === LOAD_CANCELLED) return result;
      moduleAttempts.set(module.key, { configuration, result });
      if (result.status === "loaded") {
        managedRuntimeKeys.add(module.key);
      } else {
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

export async function refreshRuntimeModule(
  keyOrModule: string | InstalledModuleSummary,
): Promise<RegisteredRuntimeModule> {
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

export async function deactivateRuntimeModule(key: string) {
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
    let cleanupError: unknown;
    try {
      await dynamicRuntime.deactivate(key);
    } catch (error) {
      cleanupError = error;
    }
    await olderLoadsSettled;
    try {
      await dynamicRuntime.deactivate(key);
    } catch (error) {
      cleanupError ||= error;
    }
    lastLoadedModules = lastLoadedModules.filter((entry) => entry.key !== key);
    managedRuntimeKeys.delete(key);
    if (cleanupError) throw cleanupError;
  })();
  deactivationBarriers.set(key, operation);
  try {
    await operation;
  } finally {
    if (deactivationBarriers.get(key) === operation) deactivationBarriers.delete(key);
  }
}

export async function registerModules(app: Express) {
  registerUsersNetworkDataAdapter();
  attachRuntime(app);
  // A failed registry read must stop module startup with its real error. The
  // former empty-list fallback started a partial server and later exposed
  // every feature route as a misleading 404.
  const modules = (await listInstalledModulesStrict()).filter((module) => module.enabled);
  lastLoadedModules = [];

  for (const module of modules) {
    const result = await ensureModuleLoaded(module, true);
    if (result.status === "error") {
      console.error(
        `[module:${module.key}] Modulstart fehlgeschlagen: ${result.error || "Unbekannter Fehler"}`,
      );
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

export async function getRuntimeModuleSummaryByManifestId(key: string) {
  return lastLoadedModules.find((module) => module.key === key) || null;
}
