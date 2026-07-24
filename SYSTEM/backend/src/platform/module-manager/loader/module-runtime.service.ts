import { Router, type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findModuleManifest } from "../manifests/index.js";
import { resolveBonniProjectRoot } from "../project-root.js";
import { listInstalledModules } from "../registry/index.js";
import type { InstalledModuleSummary, ModuleManifestSummary } from "../types.js";
import { coreEventBus } from "../../../core/event-bus/event-bus.js";
import { createModuleDataAdapterRuntime } from "../../../core/data-adapters/index.js";
import { createStagedModuleNetworkRequestRuntime } from "../../../core/network-requests/index.js";
import { createModuleServiceAccountRuntime } from "../../auth/service-accounts/index.js";
import { registerUsersNetworkDataAdapter } from "../../auth/users/users-network-data-adapter.js";
import { getPrismaClient } from "../../../core/database/database.js";
import {
  createDynamicModuleRuntime,
  normalizeRuntimeModuleCleanup,
  type RuntimeModuleCleanup,
} from "./dynamic-module-runtime.js";
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

async function enabledRuntimeModuleKeys() {
  // listInstalledModules intentionally returns an empty list when the
  // database cannot be read. That empty set is the fail-closed guard state.
  const modules = (await listInstalledModules()).filter((module) => module.enabled);
  const enabledKeys = new Set(modules.map((module) => module.key));
  await Promise.all(
    [...managedRuntimeKeys]
      .filter((key) => !enabledKeys.has(key))
      .map((key) => deactivateRuntimeModule(key)),
  );
  const observed = modules.map((module) => ({ module, generation: loadGenerations.current(module.key) }));
  await Promise.all(observed.map(({ module, generation }) => ensureModuleLoaded(module, false, generation)));
  return modules.map((module) => module.key);
}

const dynamicRuntime = createDynamicModuleRuntime(enabledRuntimeModuleKeys);

function attachRuntime(app: Express) {
  if (attachedRuntimeApps.has(app)) return;
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

    const entry = await import(pathToFileURL(resolvedEntry.entryPath).href);
    const register = entry.registerModule || entry.default;

    if (typeof register !== "function") {
      throw new Error("MODULE_ENTRY_EXPORT_NOT_FOUND");
    }
    if (!isCurrent()) return cancelledModuleLoad(module);

    const networkRequestRuntime = createStagedModuleNetworkRequestRuntime(module.key);
    registrationCleanup = normalizeRuntimeModuleCleanup(() => networkRequestRuntime.dispose());
    const services = Object.freeze({
      eventBus: coreEventBus,
      dataAdapters: createModuleDataAdapterRuntime(module.key),
      networkRequests: networkRequestRuntime.runtime,
      serviceAccounts: createModuleServiceAccountRuntime(module.key),
      // Fachmodule erhalten den bereits gerouteten Core-Client als Capability.
      // Zugangsdaten und ein zweiter, unkoordinierter Prisma-Client bleiben
      // dadurch außerhalb des installierbaren Pakets.
      prisma: getPrismaClient(),
    });

    const moduleRouter = Router();
    const registrationResult = await register({
      app: moduleRouter as unknown as Express,
      module,
      services,
      prisma: services.prisma,
    });
    const moduleCleanup = normalizeRuntimeModuleCleanup(registrationResult);
    registrationCleanup = normalizeRuntimeModuleCleanup(async () => {
      // Revoke every network capability and abort in-flight work before
      // awaiting add-on cleanup. A slow disposer must not keep the module
      // remotely reachable.
      networkRequestRuntime.dispose();
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
      () => networkRequestRuntime.activate(),
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
  managedRuntimeKeys.add(module.key);

  const loading = loadingModules.get(module.key);
  if (loading) return loading;

  const configuration = moduleConfiguration(module);
  const previous = moduleAttempts.get(module.key);
  if (previous?.configuration === configuration) {
    if (previous.result.status === "loaded" && dynamicRuntime.hasRoute(module.key)) {
      dynamicRuntime.activate(module.key);
      return recordRuntimeModule(previous.result);
    }
    if (previous.result.status === "skipped" || (!retryFailed && previous.result.status === "error")) {
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
    return recordRuntimeModule(restartRequired);
  }

  const lease = loadGenerations.begin(module.key);
  const promise = loadModule(module, lease.isCurrent)
    .then(async (result) => {
      if (result.error === LOAD_CANCELLED) return result;
      moduleAttempts.set(module.key, { configuration, result });
      if (result.status === "error") {
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
    ? (await listInstalledModules()).find((entry) => entry.key === key) || null
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
  const modules = (await listInstalledModules()).filter((module) => module.enabled);
  lastLoadedModules = [];

  for (const module of modules) {
    await ensureModuleLoaded(module, true);
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
