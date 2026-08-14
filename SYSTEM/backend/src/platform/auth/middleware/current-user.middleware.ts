import { coreTokenService } from "../token/core-token.service.js";
import { getServerPrismaClient } from "../../../core/database/database.js";
import {
  isDatabaseAuthorizationFailure,
  isDatabaseConnectionFailure,
} from "../../../core/database/database-routing.js";
import {
  runWithVerifiedRequestIdentity,
  type RequestIdentity,
  type RequestIdentityAccountType,
} from "../request-identity/request-identity-context.js";

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

type ResolvedCurrentUserAccount = {
  id: string;
  loginName: string;
  type: string;
  isActive: boolean;
  personId: string | null;
  person: { member: { id: string } | null } | null;
  roles: Array<{
    role: {
      key: string;
      permissions: Array<{ permission: { key: string } }>;
    };
  }>;
};

type CurrentUserMiddlewareDependencies = {
  verifyToken: (token: string) => {
    accountId: string;
    source?: string;
  };
  findAccount: (accountId: string) => Promise<ResolvedCurrentUserAccount | null>;
  warn: (message: string, error: unknown) => void;
};

function requestIdentity(account: ResolvedCurrentUserAccount): RequestIdentity {
  const roles = unique(account.roles.map((entry) => entry.role.key));
  const permissions = unique(account.roles.flatMap((entry) => (
    entry.role.permissions.map((rolePermission) => rolePermission.permission.key)
  )));
  const allowedApps = unique(
    roles.map(appKeyFromAccessRole).filter((value): value is string => Boolean(value)),
  );

  return {
    accountId: account.id,
    loginName: account.loginName,
    type: account.type as RequestIdentityAccountType,
    roles,
    permissions,
    allowedApps,
    personId: account.personId || null,
    memberId: account.person?.member?.id || null,
  };
}

export function createCurrentUserMiddleware(dependencies: CurrentUserMiddlewareDependencies) {
  return async function resolveCurrentUser(req: any, res: any, next: any) {
    const header = req.headers?.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    let identity: RequestIdentity | null = null;
    let tokenSource = "LOCAL";

    delete req.user;
    req.bonniIdentityVerified = false;

    if (token) {
      let payload: ReturnType<CurrentUserMiddlewareDependencies["verifyToken"]>;
      try {
        payload = dependencies.verifyToken(token);
      } catch (error) {
        // Nur ein tatsächlich ungültiger Token wird wie eine anonyme Anfrage
        // behandelt. Ein Datenbankfehler nach erfolgreicher Tokenprüfung darf
        // die Sitzung nicht als vermeintlich ungültig löschen.
        dependencies.warn("Current user could not be resolved", error);
        return runWithVerifiedRequestIdentity(null, next);
      }

      tokenSource = payload.source || "LOCAL";

      try {
        const account = await dependencies.findAccount(payload.accountId);

        if (account && account.type === "SERVICE") {
          identity = null;
        } else if (account?.isActive) {
          identity = requestIdentity(account);
        }
      } catch (error) {
        dependencies.warn("Current user database lookup failed", error);

        if (isDatabaseAuthorizationFailure(error)) {
          return res.status(500).json({
            code: "DATABASE_SCHEMA_PERMISSION_DENIED",
            message: "Die Datenbank ist erreichbar, aber dem Backend fehlen Rechte auf das Core-Schema.",
          });
        }

        return res.status(isDatabaseConnectionFailure(error) ? 503 : 500).json({
          code: "AUTH_SERVICE_UNAVAILABLE",
          message: "Die Anmeldung wurde erkannt, konnte aber momentan nicht gegen die Datenbank geprüft werden.",
        });
      }
    }

    if (identity) {
      req.user = {
        ...identity,
        id: identity.accountId,
        source: tokenSource,
        status: "ACTIVE",
      };
      req.bonniIdentityVerified = true;
    }

    return runWithVerifiedRequestIdentity(identity, next);
  };
}

export const currentUserMiddleware = createCurrentUserMiddleware({
  verifyToken: (token) => coreTokenService.verifyToken(token),
  findAccount: (accountId) => getServerPrismaClient("core").account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      loginName: true,
      type: true,
      isActive: true,
      personId: true,
      person: {
        select: {
          member: {
            select: { id: true },
          },
        },
      },
      roles: {
        select: {
          role: {
            select: {
              key: true,
              permissions: {
                select: {
                  permission: {
                    select: { key: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  }),
  warn: (message, error) => console.warn(message, error),
});
