import { coreTokenService } from "../token/core-token.service.js";
import { getPrismaClient } from "../../../core/database/database.js";

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function appKeyFromAccessRole(roleKey: string) {
  const parts = String(roleKey || "").trim().toLowerCase().split(":");
  if (parts.length !== 4 || parts[0] !== "access" || parts[1] !== "app" || !parts[2] || !parts[3]) {
    return null;
  }

  const storedKey = parts[2];
  if (!/^app-[a-z0-9-]+$/.test(storedKey) || !/^[a-z0-9-]+$/.test(parts[3])) return null;

  return storedKey.startsWith("app-")
    ? `app.${storedKey.slice(4)}`
    : `app.${storedKey.replace(/-/g, "")}`;
}

export async function currentUserMiddleware(req: any, res: any, next: any) {
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return next();
  }

  try {
    const payload = coreTokenService.verifyToken(token);
    const account = await getPrismaClient().account.findUnique({
      where: { id: payload.accountId },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });

    if (!account?.isActive || account.type === "SERVICE") return next();

    const roles = unique(account.roles.map((entry) => entry.role.key));
    const permissions = unique(account.roles.flatMap((entry) => (
      entry.role.permissions.map((rolePermission) => rolePermission.permission.key)
    )));
    const allowedApps = unique(roles.map(appKeyFromAccessRole).filter((value): value is string => Boolean(value)));

    req.user = {
      accountId: payload.accountId,
      id: payload.accountId,
      loginName: payload.loginName,
      source: payload.source || "LOCAL",
      status: "ACTIVE",
      type: account.type,
      roles,
      permissions,
      allowedApps,
    };
    req.bonniIdentityVerified = true;
  } catch (error) {
    // Ungültige Tokens und nicht auflösbare Konten setzen keinen User. Damit
    // bleibt der App-Zugriff im Fehlerfall ebenfalls geschlossen.
    console.warn("Current user could not be resolved", error);
  }

  return next();
}
