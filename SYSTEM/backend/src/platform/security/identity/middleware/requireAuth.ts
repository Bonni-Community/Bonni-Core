import type { Request, Response, NextFunction } from "express";
import { parseAccessToken } from "../services/auth.service.js";
import { prisma } from "../../../../core/database/database.js";
import { permissionsService } from "../../../permissions/permissions.service.js";
import { assertPersonalDataLoginAllowed, getPersonalDataMasterKeyStatus } from "../../crypto/index.js";
import {
  getDatabaseRoutingStatus,
  isDatabaseConnectionFailure,
} from "../../../../core/database/database-routing.js";
import {
  cacheJsonEmergencyIdentity,
  getJsonEmergencyIdentity,
} from "../../../../core/database/json-emergency-store.js";

type CachedEmergencyIdentity = {
  auth: Record<string, unknown>;
  user: Record<string, unknown>;
  personalLogin: {
    accountId: string;
    loginName: string;
    memberId?: string;
    roles: string[];
  };
};

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const token = authHeader.slice("Bearer ".length);
  let payload: ReturnType<typeof parseAccessToken>;

  try {
    payload = parseAccessToken(token);
  } catch (error) {
    console.warn("Access token rejected", error);
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }

  try {
    const account = await prisma.account.findUnique({
      where: { id: payload.accountId },
      select: {
        id: true,
        loginName: true,
        email: true,
        type: true,
        isActive: true,
        roles: {
          include: {
            role: true,
          },
        },
        person: {
          include: {
            member: true,
          },
        },
      },
    });

    if (!account?.isActive) {
      return res.status(401).json({ error: "ACCOUNT_DISABLED" });
    }

    if (account.type === "SERVICE") {
      return res.status(403).json({ error: "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN" });
    }

    const roles = account.roles.map((entry) => entry.role.key);

    try {
      assertPersonalDataLoginAllowed({
        accountId: account.id,
        loginName: account.loginName,
        memberId: account.person?.member?.id,
        roles,
      });
    } catch (error: any) {
      return res.status(Number(error?.statusCode || error?.status || 423)).json({
        error: error?.code || error?.message || "PERSONAL_DATA_MASTER_KEY_LOCKED",
        message:
          error?.code === "PERSONAL_DATA_MEMBER_LOGIN_LOCKED"
            ? "Member-Login ist ohne geladenen Master-Key gesperrt."
            : "Personendaten sind noch verschlüsselt. Admins können sich weiter anmelden; Member-Logins bleiben gesperrt.",
        personalDataMasterKey: getPersonalDataMasterKeyStatus(),
      });
    }

    const resolvedPermissions = await permissionsService.resolveForIdentity({
      accountId: account.id,
      loginName: account.loginName,
      type: account.type,
      roles,
    });

    const user = {
      id: account.id,
      accountId: account.id,
      loginName: account.loginName,
      email: account.email,
      type: account.type,
      roles: resolvedPermissions.roles,
      permissions: resolvedPermissions.permissions,
      memberCapabilities: resolvedPermissions.memberCapabilities,
      allowedWorkspaces: resolvedPermissions.allowedWorkspaces,
      defaultWorkspace: resolvedPermissions.defaultWorkspace,
    };

    const auth = {
      ...payload,
      roles: resolvedPermissions.roles,
      permissions: resolvedPermissions.permissions,
      memberCapabilities: resolvedPermissions.memberCapabilities,
    };

    (req as any).auth = auth;

    (req as any).user = user;
    (req as any).account = user;

    await cacheJsonEmergencyIdentity(`platform:${account.id}`, {
      auth,
      user,
      personalLogin: {
        accountId: account.id,
        loginName: account.loginName,
        memberId: account.person?.member?.id,
        roles,
      },
    } satisfies CachedEmergencyIdentity).catch((error) => {
      console.warn("JSON-Notlauf-Identität konnte nicht aktualisiert werden", error);
    });

    next();
  } catch (error) {
    if (getDatabaseRoutingStatus().jsonEmergency.enabled && isDatabaseConnectionFailure(error)) {
      try {
        const cached = await getJsonEmergencyIdentity<CachedEmergencyIdentity>(
          `platform:${payload.accountId}`,
        );
        if (cached && String(cached.user?.type || "").toUpperCase() !== "SERVICE") {
          assertPersonalDataLoginAllowed(cached.personalLogin);
          (req as any).auth = cached.auth;
          (req as any).user = cached.user;
          (req as any).account = cached.user;
          res.setHeader("X-Bonni-JSON-Notlauf", "active");
          console.warn("Authentication uses encrypted JSON emergency identity", {
            accountId: payload.accountId,
          });
          return next();
        }
      } catch (fallbackError) {
        console.error("JSON emergency authentication unavailable", fallbackError);
      }
    }
    console.error("Authentication service unavailable", error);
    return res.status(503).json({
      error: "AUTH_SERVICE_UNAVAILABLE",
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Die Anmeldung kann momentan nicht geprüft werden, weil die Datenbank nicht erreichbar ist.",
    });
  }
}
