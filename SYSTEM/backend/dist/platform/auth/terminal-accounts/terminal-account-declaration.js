export const MODULE_TERMINAL_ACCOUNT_CONTRACT_VERSION = "bonni.terminal-accounts/v2";
const PROTECTED_LEGACY_ROLE_KEYS = new Set([
    "access",
    "admin",
    "administrator",
    "administrators",
    "core",
    "member",
    "members",
    "module",
    "owner",
    "root",
    "service",
    "services",
    "super-admin",
    "superadmin",
    "system",
    "system-admin",
    "system-administrator",
    "systemadmin",
    "terminal",
    "user",
    "users",
]);
function cleanText(value, maxLength) {
    return String(value ?? "").trim().slice(0, maxLength);
}
function slug(value) {
    return cleanText(value, 160)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
export function normalizeTerminalAccountOwner(ownerModuleValue) {
    const ownerModule = cleanText(ownerModuleValue, 160).toLowerCase();
    if (!/^[a-z][a-z0-9._-]{2,159}$/.test(ownerModule)) {
        throw new Error("TERMINAL_ACCOUNT_OWNER_INVALID");
    }
    return ownerModule;
}
function moduleKind(ownerModule) {
    const kind = slug(ownerModule.split(".", 1)[0]);
    if (!["app", "addon", "plugin", "bridge"].includes(kind)) {
        throw new Error("TERMINAL_ACCOUNT_OWNER_KIND_INVALID");
    }
    return kind;
}
export function describeTerminalAccountIdentity(ownerModuleValue, profileKeyValue) {
    const ownerModule = normalizeTerminalAccountOwner(ownerModuleValue);
    const profileKey = cleanText(profileKeyValue, 80).toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(profileKey)) {
        throw new Error("TERMINAL_ACCOUNT_PROFILE_INVALID");
    }
    const ownerSlug = slug(ownerModule);
    return Object.freeze({
        ownerModule,
        profileKey,
        roleKey: `access:${moduleKind(ownerModule)}:${ownerSlug}:${profileKey}`.slice(0, 180),
        permissionKey: `module.${ownerSlug}.${profileKey}`.slice(0, 180),
    });
}
export function isProtectedLegacyTerminalRole(roleKeyValue) {
    const roleKey = cleanText(roleKeyValue, 180).toLowerCase().replace(/[._:]+/g, "-");
    return (PROTECTED_LEGACY_ROLE_KEYS.has(roleKey)
        || ["access-", "core-", "module-", "system-"].some((prefix) => roleKey.startsWith(prefix)));
}
function normalizeDefinition(ownerModule, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("TERMINAL_ACCOUNT_DECLARATION_INVALID");
    }
    const source = input;
    const allowedFields = new Set(["loginName", "profileKey", "label", "legacyRoleKeys"]);
    if (Object.keys(source).some((field) => !allowedFields.has(field))) {
        throw new Error("TERMINAL_ACCOUNT_DECLARATION_FIELD_INVALID");
    }
    const loginName = cleanText(source.loginName, 80).toLowerCase();
    const profileKey = cleanText(source.profileKey, 80).toLowerCase();
    const label = cleanText(source.label, 120);
    const identity = describeTerminalAccountIdentity(ownerModule, profileKey);
    if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(loginName)) {
        throw new Error("TERMINAL_ACCOUNT_LOGIN_INVALID");
    }
    if (source.loginName !== loginName) {
        throw new Error("TERMINAL_ACCOUNT_LOGIN_NOT_CANONICAL");
    }
    if (source.profileKey !== profileKey) {
        throw new Error("TERMINAL_ACCOUNT_PROFILE_NOT_CANONICAL");
    }
    if (typeof source.label !== "string"
        || !label
        || source.label !== label) {
        throw new Error("TERMINAL_ACCOUNT_LABEL_INVALID");
    }
    const rawLegacyRoleKeys = source.legacyRoleKeys;
    if (!Array.isArray(rawLegacyRoleKeys)
        || rawLegacyRoleKeys.length > 20) {
        throw new Error("TERMINAL_ACCOUNT_LEGACY_ROLES_INVALID");
    }
    const legacyRoleKeys = rawLegacyRoleKeys.map((value) => cleanText(value, 180));
    if (new Set(legacyRoleKeys).size !== rawLegacyRoleKeys.length
        || legacyRoleKeys.some((value, index) => (value !== rawLegacyRoleKeys[index]
            || !/^[a-z0-9][a-z0-9._:-]{0,179}$/.test(value)
            || isProtectedLegacyTerminalRole(value)))) {
        throw new Error("TERMINAL_ACCOUNT_LEGACY_ROLE_INVALID");
    }
    return Object.freeze({
        loginName,
        profileKey,
        label,
        legacyRoleKeys: Object.freeze([...legacyRoleKeys]),
        roleKey: identity.roleKey,
        permissionKey: identity.permissionKey,
    });
}
/**
 * Validates and freezes the declarations owned by a module manifest.
 *
 * A runtime module never passes these declarations into the capability call;
 * Bonni Core binds this immutable copy while the module is loaded.
 */
export function normalizeDeclaredModuleTerminalAccounts(ownerModuleValue, declarationsValue) {
    const ownerModule = normalizeTerminalAccountOwner(ownerModuleValue);
    if (!Array.isArray(declarationsValue)
        || declarationsValue.length < 1
        || declarationsValue.length > 100) {
        throw new Error("TERMINAL_ACCOUNT_DECLARATIONS_INVALID");
    }
    const declarations = declarationsValue.map((definition) => (normalizeDefinition(ownerModule, definition)));
    if (new Set(declarations.map((entry) => entry.loginName)).size !== declarations.length) {
        throw new Error("TERMINAL_ACCOUNT_DUPLICATE_LOGIN");
    }
    if (new Set(declarations.map((entry) => entry.profileKey)).size !== declarations.length) {
        throw new Error("TERMINAL_ACCOUNT_DUPLICATE_PROFILE");
    }
    return Object.freeze([...declarations]);
}
