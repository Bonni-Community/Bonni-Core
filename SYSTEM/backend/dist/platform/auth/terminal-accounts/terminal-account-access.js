import { describeTerminalAccountIdentity } from "./terminal-account-declaration.js";
import { HUB_PRODUCT_OPERATION_PERMISSIONS } from "../../../core/hub/hub-products-contract.js";
import { validateHubManifest } from "../../../core/hub/hub-products-registry.js";
/** Only a canonical, assigned technical profile grants a terminal a surface.
 * Legacy roles, wildcard/admin permissions and local member profiles are never
 * inherited. Manifests and role rows must come from Core, not the client.
 */
export function resolveTerminalAccountAccess(accountRoles, manifests) {
    const grants = [];
    for (const manifest of manifests) {
        if (manifest.kind !== "app")
            continue;
        for (const profile of manifest.metadata?.accessProfiles || []) {
            if (profile.usage !== "technical" || profile.accountType !== "TERMINAL")
                continue;
            const declared = describeTerminalAccountIdentity(manifest.key, profile.key);
            if (profile.permission !== declared.permissionKey)
                continue;
            const assigned = accountRoles.find(({ role }) => (role.key === declared.roleKey
                && role.permissions.some(({ permission }) => permission.key === declared.permissionKey)));
            if (assigned) {
                // Keep explicit Hub grants from this exact technical role. App access
                // itself, other roles and wildcards never imply a product permission.
                const operations = validateHubManifest(manifest).length === 0 ? manifest.metadata?.hubProducts?.operations || [] : [];
                const requested = new Set(operations.map(operation => HUB_PRODUCT_OPERATION_PERMISSIONS[operation]));
                const productPermissions = assigned.role.permissions.map(({ permission }) => permission.key)
                    .filter(key => requested.has(key));
                grants.push({ ...declared, moduleKey: manifest.key, workspace: profile.workspace,
                    permissions: [...new Set([declared.permissionKey, ...productPermissions])] });
            }
        }
    }
    // Never combine surfaces from an old or externally changed multi-profile
    // account. An administrator must select the intended single surface in Core.
    const uniqueGrants = [...new Map(grants.map((grant) => [grant.roleKey, grant])).values()];
    const effectiveGrants = uniqueGrants.length === 1 ? uniqueGrants : [];
    return {
        roles: effectiveGrants.map((grant) => grant.roleKey),
        permissions: effectiveGrants.flatMap((grant) => grant.permissions),
        allowedApps: effectiveGrants.map((grant) => grant.moduleKey),
        allowedWorkspaces: effectiveGrants.map((grant) => grant.workspace),
    };
}
export function scopeTerminalAccount(account, manifests) {
    if (account.type !== "TERMINAL")
        return account;
    const access = resolveTerminalAccountAccess(account.roles, manifests);
    return {
        ...account,
        person: null,
        personId: null,
        accountMemberCapabilities: [],
        roles: account.roles.filter(({ role }) => access.roles.includes(role.key)).map((entry) => ({
            ...entry,
            role: {
                ...entry.role,
                permissions: entry.role.permissions.filter(({ permission }) => access.permissions.includes(permission.key)),
            },
        })),
    };
}
