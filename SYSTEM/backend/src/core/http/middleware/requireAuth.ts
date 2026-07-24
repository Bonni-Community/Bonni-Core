import type { Response, NextFunction } from "express";
import { prisma } from "../../database/prisma.js";
import { verifyAccessToken } from "../../../platform/auth/token/token.service.js";
import type { AuthenticatedRequest } from "../../../platform/auth/session/authContext.js";
import {
  getDatabaseRoutingStatus,
  isDatabaseConnectionFailure,
} from "../../database/database-routing.js";
import {
  cacheJsonEmergencyIdentity,
  getJsonEmergencyIdentity,
} from "../../database/json-emergency-store.js";

function getBearerToken(header?: string): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = getBearerToken(req.header("authorization"));

  if (!token) {
    return res.status(401).json({ error: "MISSING_TOKEN" });
  }

  let payload: ReturnType<typeof verifyAccessToken>;

  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    try {
      await (prisma as any).tokenProblemLog?.create?.({
        data: {
          reason: error instanceof Error ? error.message : "TOKEN_VERIFY_FAILED",
          ipAddress: req.ip,
          userAgent: req.header("user-agent")
        }
      });
    } catch (logError) {
      console.warn("Token problem could not be logged", logError);
    }

    return res.status(401).json({ error: "INVALID_TOKEN" });
  }

  try {
    const account = await prisma.account.findUnique({
      where: { id: payload.accountId },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!account || !account.isActive) {
      return res.status(401).json({ error: "ACCOUNT_INACTIVE_OR_MISSING" });
    }

    const roles = account.roles.map((accountRole: any) => accountRole.role.key);
    const permissions = account.roles.flatMap((accountRole: any) =>
      accountRole.role.permissions.map((rolePermission: any) => rolePermission.permission.key)
    );

    req.auth = {
      accountId: account.id,
      loginName: account.loginName,
      accountType: account.type,
      type: payload.type,
      roles,
      permissions: Array.from(new Set(permissions))
    };

    await cacheJsonEmergencyIdentity(`core:${account.id}`, { auth: req.auth }).catch((error) => {
      console.warn("JSON-Notlauf-Identität konnte nicht aktualisiert werden", error);
    });

    next();
  } catch (error) {
    if (getDatabaseRoutingStatus().jsonEmergency.enabled && isDatabaseConnectionFailure(error)) {
      try {
        const cached = await getJsonEmergencyIdentity<{ auth: NonNullable<AuthenticatedRequest["auth"]> }>(
          `core:${payload.accountId}`,
        );
        if (cached?.auth) {
          req.auth = cached.auth;
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
