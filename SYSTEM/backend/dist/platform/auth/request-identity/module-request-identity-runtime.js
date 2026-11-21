import { getVerifiedRequestIdentity, } from "./request-identity-context.js";
import { nfcService } from "../../../core/modules/security/nfc/index.js";
import { presenceService } from "../../../core/modules/security/presence/index.js";
export const MODULE_REQUEST_IDENTITY_CONTRACT_VERSION = "bonni.request-identity/v1";
export class ModuleRequestIdentityError extends Error {
    code;
    statusCode;
    constructor(code, statusCode) {
        super(code);
        this.name = "ModuleRequestIdentityError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
function normalizeModuleKey(value) {
    const moduleKey = String(value ?? "").trim().toLowerCase();
    if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(moduleKey)
        || moduleKey.includes("..")) {
        throw new ModuleRequestIdentityError("REQUEST_IDENTITY_MODULE_KEY_INVALID", 500);
    }
    return moduleKey;
}
function profileKey(value) {
    const key = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(key)) {
        throw new ModuleRequestIdentityError("REQUEST_IDENTITY_PROFILE_INVALID", 500);
    }
    return key;
}
function normalizeLocalProfileKeys(value) {
    if (value === undefined)
        return Object.freeze([]);
    if (!Array.isArray(value) || value.length > 100) {
        throw new ModuleRequestIdentityError("REQUEST_IDENTITY_ACCESS_PROFILES_INVALID", 500);
    }
    const localKeys = [];
    const seen = new Set();
    for (const entryValue of value) {
        if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
            throw new ModuleRequestIdentityError("REQUEST_IDENTITY_ACCESS_PROFILE_INVALID", 500);
        }
        const entry = entryValue;
        const key = profileKey(entry.key);
        const usage = String(entry.usage ?? "").trim().toLowerCase();
        if (!["local", "technical"].includes(usage) || seen.has(key)) {
            throw new ModuleRequestIdentityError("REQUEST_IDENTITY_ACCESS_PROFILE_INVALID", 500);
        }
        seen.add(key);
        if (usage === "local")
            localKeys.push(key);
    }
    return Object.freeze(localKeys);
}
function roleSlug(value) {
    return value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function accessRoleKind(moduleKey) {
    const kind = moduleKey.split(".", 1)[0];
    if (kind === "addon")
        return "add-on";
    if (kind === "plugin")
        return "plug-in";
    return kind;
}
function accessRoleKey(moduleKey, profile) {
    return `access:${accessRoleKind(moduleKey)}:${roleSlug(moduleKey)}:${profile}`.slice(0, 180);
}
function requestedProfiles(value, declaredLocalProfiles) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
        throw new ModuleRequestIdentityError("REQUEST_IDENTITY_PROFILE_QUERY_INVALID", 500);
    }
    const profiles = value.map((entry) => profileKey(entry));
    if (new Set(profiles).size !== profiles.length
        || profiles.some((profile) => !declaredLocalProfiles.has(profile))) {
        throw new ModuleRequestIdentityError("REQUEST_IDENTITY_PROFILE_NOT_DECLARED", 500);
    }
    return profiles;
}
/**
 * Creates a module-bound view of verified identity and scoped identity operations.
 * The module key and assignable local profiles come from the installed
 * manifest, never from a request or a capability call.
 */
export function createModuleRequestIdentityRuntime(moduleKeyValue, accessProfilesValue) {
    const moduleKey = normalizeModuleKey(moduleKeyValue);
    const localProfileKeys = normalizeLocalProfileKeys(accessProfilesValue);
    const declaredLocalProfiles = new Set(localProfileKeys);
    return Object.freeze({
        contractVersion: MODULE_REQUEST_IDENTITY_CONTRACT_VERSION,
        current() {
            return getVerifiedRequestIdentity();
        },
        async identifyNfc(code) {
            const identity = getVerifiedRequestIdentity();
            if (!identity)
                throw new ModuleRequestIdentityError("REQUEST_IDENTITY_UNAUTHENTICATED", 401);
            return nfcService.identify(code, identity, moduleKey);
        },
        async recordBookingSeen(input) {
            return presenceService.recordBookingSeen(input, getVerifiedRequestIdentity(), moduleKey);
        },
        requireProfiles(profileKeysValue) {
            const profiles = requestedProfiles(profileKeysValue, declaredLocalProfiles);
            const identity = getVerifiedRequestIdentity();
            if (!identity) {
                throw new ModuleRequestIdentityError("REQUEST_IDENTITY_UNAUTHENTICATED", 401);
            }
            if (!profiles.some((profile) => identity.roles.includes(accessRoleKey(moduleKey, profile)))) {
                throw new ModuleRequestIdentityError("REQUEST_IDENTITY_PROFILE_FORBIDDEN", 403);
            }
            return identity;
        },
    });
}
