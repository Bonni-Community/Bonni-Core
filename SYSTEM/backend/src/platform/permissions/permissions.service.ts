import { prisma } from "../../core/database/database.js";
import { listModuleManifests } from "../module-manager/manifests/index.js";
import { resolveTerminalAccountAccess } from "../auth/terminal-accounts/terminal-account-access.js";

type PlatformIdentity = {
  accountId?: string;
  loginName?: string;
  type?: string;
  roles?: string[];
};

function normalizeRole(role: unknown) {
  return String(role || "MEMBER").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function defaultWorkspaceForRoles(roles: string[]) {
  const normalized = roles.map((role) => role.toUpperCase());

  if (normalized.includes("ADMIN") || normalized.includes("SYSTEM_ADMIN")) return "admin";
  return "member";
}

export class PlatformPermissionsService {
  async resolveForIdentity(identity: PlatformIdentity) {
    if (identity.type === "TERMINAL") {
      // Never expand a terminal's inherited generic role (including admin) to
      // broad Core permissions in the alternate identity/API path.
      const roleRows = await prisma.role.findMany({
        where: { key: { in: identity.roles || [] } },
        include: { permissions: { include: { permission: true } } },
      });
      const access = resolveTerminalAccountAccess(
        roleRows.map((role) => ({ role })), await listModuleManifests(),
      );
      return { ...access, memberCapabilities: [], defaultWorkspace: access.allowedWorkspaces[0] || "member" };
    }
    const roles = unique(
      (identity.roles?.length ? identity.roles : ["MEMBER"]).map(normalizeRole)
    );

    const permissions = new Set<string>();
    const roleKeys = unique([
      ...roles,
      ...roles.map((role) => role.toLowerCase()),
      ...roles.map((role) => role.toUpperCase()),
    ]);

    try {
      const roleRows = await prisma.role.findMany({
        where: { key: { in: roleKeys } },
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      });

      for (const role of roleRows) {
        for (const entry of role.permissions || []) {
          if (entry.permission?.key) permissions.add(entry.permission.key);
        }
      }
    } catch {
      // The platform must be able to start even when the optional permission tables
      // are not available yet. Installation/seed can create the detailed model later.
    }

    if (roles.some((role) => ["ADMIN", "SYSTEM_ADMIN"].includes(role.toUpperCase()))) {
      permissions.add("*");
    }

    const defaultWorkspace = defaultWorkspaceForRoles(roles);
    const allowedWorkspaces = permissions.has("*")
      ? ["admin", "member"]
      : unique([defaultWorkspace, "member"]);

    return {
      roles,
      permissions: Array.from(permissions),
      memberCapabilities: [],
      allowedWorkspaces,
      defaultWorkspace,
    };
  }
}

export const permissionsService = new PlatformPermissionsService();
