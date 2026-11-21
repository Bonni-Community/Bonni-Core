import { defaultCoreModules } from "./defaults.js";
export async function listSystemModules() {
    return defaultCoreModules
        .filter((module) => module.visible !== false)
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
}
export async function syncDefaultSystemModules() {
    return {
        ok: true,
        persisted: false,
        created: 0,
        updated: 0,
        totalDefaults: defaultCoreModules.length,
        message: "Bonni-Core Module sind fest im Core enthalten. Installierbare Pakete werden in InstalledModule gespeichert.",
    };
}
export { defaultCoreModules as defaultSystemModules } from "./defaults.js";
