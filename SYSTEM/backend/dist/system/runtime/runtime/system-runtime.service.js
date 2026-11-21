import { mergeRuntimeModuleItems } from "./runtime-module-items.js";
import { getSystemStatus } from "../../routes/control-api/system.service.js";
import { activateModulePackage, deactivateModulePackage, getModuleInstallPlan, installModulePackage, listModulePackages, } from "../../../platform/module-manager/install/index.js";
import { listRegisteredModules } from "../../../platform/module-manager/loader/index.js";
import { listInstalledModules } from "../../../platform/module-manager/registry/index.js";
async function safeCall(label, fn) {
    try {
        return { ok: true, label, value: await fn() };
    }
    catch (error) {
        return { ok: false, label, error: error instanceof Error ? error.message : String(error) };
    }
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
async function runtimeModuleSnapshot() {
    const packagesResult = await safeCall("module-manager.packages", () => listModulePackages());
    const runtimeResult = await safeCall("module-manager.runtime", () => listRegisteredModules());
    const installedResult = await safeCall("module-manager.installed", () => listInstalledModules());
    const packages = asArray(packagesResult.value);
    const runtime = asArray(runtimeResult.value);
    const installed = asArray(installedResult.value);
    const items = mergeRuntimeModuleItems(packages, installed, runtime);
    const counts = items.reduce((acc, item) => {
        acc.total += 1;
        acc.byKind[item.kind] = (acc.byKind[item.kind] || 0) + 1;
        if (item.installed)
            acc.installed += 1;
        if (item.enabled)
            acc.enabled += 1;
        return acc;
    }, { total: 0, installed: 0, enabled: 0, byKind: {} });
    return { items, counts, packagesResult, runtimeResult, installedResult };
}
export async function getSystemRuntimeStatus() {
    const [packages, runtime, installed] = await Promise.all([
        safeCall("module-manager.packages", () => listModulePackages()),
        safeCall("module-manager.runtime", () => listRegisteredModules()),
        safeCall("module-manager.installed", () => listInstalledModules()),
    ]);
    return {
        ok: true,
        system: getSystemStatus(),
        runtime: {
            canonicalApiBase: "/api/system",
            moduleApiBase: "/api/system/modules",
            aliases: ["/api/system"],
        },
        moduleManager: { packages, runtime, installed },
    };
}
export async function getSystemRuntimeModules() {
    const snapshot = await runtimeModuleSnapshot();
    return {
        ok: true,
        items: snapshot.items,
        modules: snapshot.items,
        counts: snapshot.counts,
        packages: snapshot.packagesResult,
        runtime: snapshot.runtimeResult,
        installed: snapshot.installedResult,
    };
}
export async function getSystemCompatibilityStatus() {
    return {
        ok: true,
        canonical: {
            system: "/api/system",
            modules: "/api/system/modules",
            runtimeModules: "/api/system/runtime/modules",
        },
        aliases: [],
    };
}
export async function getSystemRuntimeModuleDetails(key) {
    const snapshot = await runtimeModuleSnapshot();
    const item = snapshot.items.find((candidate) => candidate.key === key);
    if (!item)
        return { ok: false, error: "MODULE_NOT_FOUND", key };
    const [installPlan, lifecycle] = await Promise.all([
        safeCall("module-manager.install-plan", () => getModuleInstallPlan(key)),
        safeCall("module-manager.lifecycle", () => getSystemRuntimeModuleLifecycleStatus(key)),
    ]);
    return { ok: true, item, installPlan, lifecycle };
}
export async function getSystemRuntimeModuleInstallPlan(key) {
    return getModuleInstallPlan(key);
}
export async function applySystemRuntimeModuleInstallPlan(key) {
    return installModulePackage(key);
}
export async function activateSystemRuntimeModule(key) {
    return activateModulePackage(key);
}
export async function deactivateSystemRuntimeModule(key) {
    return deactivateModulePackage(key);
}
export async function getSystemRuntimeModuleLifecycleStatus(key) {
    return {
        ok: true,
        key,
        lifecycle: {
            install: "available",
            enable: "available",
            disable: "available",
            uninstall: "available",
            delete: "available",
        },
    };
}
export async function runSystemRuntimeModuleLifecycleAction(key, action, metadata) {
    if (action === "install")
        return installModulePackage(key);
    if (action === "enable" || action === "activate")
        return activateModulePackage(key);
    if (action === "disable" || action === "deactivate")
        return deactivateModulePackage(key);
    return {
        ok: false,
        key,
        action,
        metadata,
        error: "UNSUPPORTED_MODULE_ACTION",
    };
}
