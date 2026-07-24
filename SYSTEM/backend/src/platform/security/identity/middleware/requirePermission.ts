import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../../../core/database/database.js";

function normalizePermissionVariants(permissionKey: string): Set<string> {
  const raw = String(permissionKey || "").trim();
  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();

  return new Set([
    raw,
    lower,
    upper,
    lower.replace(/_/g, "."),
    lower.replace(/\./g, "_"),
    upper.replace(/\./g, "_"),
    upper.replace(/_/g, "."),
  ]);
}

function hasRequiredPermission(availablePermissions: string[], requiredPermission: string): boolean {
  const requiredVariants = normalizePermissionVariants(requiredPermission);

  return availablePermissions.some((permission) => {
    if (permission === "*") return true;

    const availableVariants = normalizePermissionVariants(permission);

    for (const variant of availableVariants) {
      if (requiredVariants.has(variant)) return true;
    }

    return false;
  });
}

function isAdminAccount(account: any, auth: any): boolean {
  const roleKeys = [
    ...(Array.isArray(auth?.roles) ? auth.roles : []),
    ...(Array.isArray(account?.roles) ? account.roles.map((entry: any) => entry?.role?.key) : []),
  ]
    .filter(Boolean)
    .map((role) => String(role).toUpperCase());

  return roleKeys.includes("ADMIN") || roleKeys.includes("SYSTEM_ADMIN") || roleKeys.includes("SYSTEM.ADMIN");
}

export function requireAnyPermission(...permissionKeys: string[]) {
  const requiredPermissions = [...new Set(permissionKeys.map((key) => String(key || "").trim()).filter(Boolean))];

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.accountId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const account = await prisma.account.findUnique({
      where: { id: req.auth.accountId },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!account?.isActive) {
      return res.status(401).json({ error: "ACCOUNT_DISABLED" });
    }

    // Admin-Konten dürfen Systemfunktionen auch dann nutzen, wenn die Seed-Daten
    // noch die alte Schreibweise `system.admin` statt `SYSTEM_ADMIN` enthalten.
    if (isAdminAccount(account, req.auth)) {
      return next();
    }

    const rolePermissions = account.roles.flatMap((entry) =>
      entry.role.permissions.map((permissionEntry) => permissionEntry.permission.key),
    );

    const resolvedPermissions = Array.isArray(req.auth.permissions) ? req.auth.permissions : [];

    const permissions = Array.from(
      new Set([
        ...rolePermissions,
        ...resolvedPermissions,
      ]),
    );

    if (!requiredPermissions.some((permission) => hasRequiredPermission(permissions, permission))) {
      const auditedPermission = requiredPermissions.join("|").slice(0, 240);
      await prisma.auditLog
        .create({
          data: {
            category: "ACCESS",
            event: "PERMISSION_DENIED",
            result: "DENIED",
            accountId: req.auth.accountId,
            permission: auditedPermission,
            severity: "WARN",
          },
        })
        .catch(() => undefined);

      return res.status(403).json({
        error: "FORBIDDEN",
        permission: requiredPermissions[0] || null,
        permissions: requiredPermissions,
      });
    }

    next();
  };
}

export function requirePermission(permissionKey: string) {
  return requireAnyPermission(permissionKey);
}
