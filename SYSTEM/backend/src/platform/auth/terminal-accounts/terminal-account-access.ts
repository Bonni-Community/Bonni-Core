import type { ModuleManifestSummary } from "../../module-manager/types.js";
import { describeTerminalAccountIdentity } from "./terminal-account-declaration.js";

type AccountRole = {
  role: { key: string; permissions: Array<{ permission: { key: string } }> };
};

/** Only a canonical, assigned technical profile grants a terminal a surface.
 * Legacy roles, wildcard/admin permissions and local member profiles are never
 * inherited. Manifests and role rows must come from Core, not the client.
 */
export function resolveTerminalAccountAccess(
  accountRoles: readonly AccountRole[],
  manifests: readonly ModuleManifestSummary[],
) {
  const grants: Array<{ roleKey: string; permissionKey: string; moduleKey: string; workspace: string }> = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "app") continue;
    for (const profile of manifest.metadata?.accessProfiles || []) {
      if (profile.usage !== "technical" || profile.accountType !== "TERMINAL") continue;
      const declared = describeTerminalAccountIdentity(manifest.key, profile.key);
      if (profile.permission !== declared.permissionKey) continue;
      const assigned = accountRoles.some(({ role }) => (
        role.key === declared.roleKey
        && role.permissions.some(({ permission }) => permission.key === declared.permissionKey)
      ));
      if (assigned) grants.push({ ...declared, moduleKey: manifest.key, workspace: profile.workspace });
    }
  }
  // Never combine surfaces from an old or externally changed multi-profile
  // account. An administrator must select the intended single surface in Core.
  const uniqueGrants = [...new Map(grants.map((grant) => [grant.roleKey, grant])).values()];
  const effectiveGrants = uniqueGrants.length === 1 ? uniqueGrants : [];
  return {
    roles: effectiveGrants.map((grant) => grant.roleKey),
    permissions: effectiveGrants.map((grant) => grant.permissionKey),
    allowedApps: effectiveGrants.map((grant) => grant.moduleKey),
    allowedWorkspaces: effectiveGrants.map((grant) => grant.workspace),
  };
}

export function scopeTerminalAccount<T extends { type: string; roles: AccountRole[] }>(
  account: T,
  manifests: readonly ModuleManifestSummary[],
): T {
  if (account.type !== "TERMINAL") return account;
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
