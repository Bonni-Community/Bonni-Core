import type { Response, NextFunction } from "express";
import { prisma } from "../../database/prisma.js";
import { verifyAccessToken } from "../../../platform/auth/token/token.service.js";
import type { AuthenticatedRequest } from "../../../platform/auth/session/authContext.js";
import {
  isDatabaseAuthorizationFailure,
} from "../../database/database-routing.js";
import {
  getVerifiedRequestIdentity,
  getVerifiedRequestSessionAssurance,
} from "../../../platform/auth/request-identity/request-identity-context.js";

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

  const verifiedIdentity = getVerifiedRequestIdentity();
  const verifiedSession = getVerifiedRequestSessionAssurance();
  if (
    !verifiedIdentity
    || !verifiedSession
    || verifiedIdentity.accountId !== payload.accountId
    || verifiedSession.accountId !== payload.accountId
    || verifiedSession.credentialRevision !== payload.credentialRevision
  ) {
    return res.status(401).json({ error: "INVALID_OR_ENDED_SESSION" });
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

    if (
      !account
      || !account.isActive
      || account.passwordRecoveryLockedAt
      || account.credentialRevision !== payload.credentialRevision
    ) {
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
      credentialRevision: account.credentialRevision,
      roles,
      permissions: Array.from(new Set(permissions))
    };

    next();
  } catch (error) {
    // Interactive authentication is deliberately fail-closed during database
    // outages. A cached credential revision can become stale immediately after
    // password or 2FA rotation and must never authorize an old JWT.
    console.error("Authentication service unavailable", error);
    if (isDatabaseAuthorizationFailure(error)) {
      return res.status(500).json({
        error: "DATABASE_SCHEMA_PERMISSION_DENIED",
        code: "DATABASE_SCHEMA_PERMISSION_DENIED",
        message: "Die Datenbank ist erreichbar, aber dem Backend fehlen Rechte auf das zugewiesene Schema. Bitte das Backend-Setup erneut ausführen und anschließend neu starten.",
      });
    }
    return res.status(503).json({
      error: "AUTH_SERVICE_UNAVAILABLE",
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Die Anmeldung kann momentan nicht geprüft werden, weil die Datenbank nicht erreichbar ist.",
    });
  }
}
