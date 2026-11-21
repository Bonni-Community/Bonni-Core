import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { privateValue } from "../../../scripts/runtime/log-privacy.mjs";
const sessionId = randomUUID();
const startedAt = new Date().toISOString();
function readVersion(relative, field) {
    try {
        const value = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"))[field];
        return typeof value === "string" && /^[A-Za-z0-9.+_-]{1,128}$/.test(value) ? value : null;
    }
    catch {
        return null;
    }
}
const coreVersion = readVersion("../../../package.json", "version");
const modules = new Map();
const diagnosticModuleKeys = new Set();
const requests = new AsyncLocalStorage();
export function isDiagnosticModuleKey(value) {
    return typeof value === "string" && /^(?:app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(value);
}
// Only local package and runtime metadata can register a new journal identity.
export function rememberDiagnosticModule(moduleId) {
    if (isDiagnosticModuleKey(moduleId))
        diagnosticModuleKeys.add(moduleId);
}
export function isRegisteredDiagnosticModule(moduleId) {
    return diagnosticModuleKeys.has(moduleId);
}
export function recordModuleDiagnostic(moduleId, context) {
    if (!isDiagnosticModuleKey(moduleId))
        return;
    rememberDiagnosticModule(moduleId);
    const safe = privateValue({ ...modules.get(moduleId), ...context, moduleId });
    if (safe.moduleId)
        modules.set(moduleId, safe);
}
export function getDiagnosticRuntime() {
    return {
        schema: "bonni.diagnostic-context/v1", sessionId, startedAt, coreVersion,
        publishedFrontendVersion: readVersion("../../../public/system/.bonni-prebuilt-release.json", "coreVersion"),
        node: process.version, platform: process.platform, architecture: process.arch, pid: process.pid,
        slotRole: /^[a-z-]{1,32}$/.test(process.env.SYSTEM_SLOT_ROLE || "") ? process.env.SYSTEM_SLOT_ROLE : null,
        modules: [...modules.values()].map(value => ({ ...value })),
    };
}
export function withDiagnosticRequest(context, work) {
    return requests.run(context, work);
}
export function getDiagnosticRequest() { return requests.getStore(); }
