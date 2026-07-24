import bcrypt from "bcryptjs";
import { AccountType } from "@prisma/client";
import { prisma } from "../../../../core/database/database.js";
import { permissionsService } from "../../../permissions/permissions.service.js";
import { createRefreshToken, hashToken, signAccessToken, verifyAccessToken } from "./token.service.js";
import type { LoginInput, LogoutInput, RefreshInput } from "../schemas/auth.schemas.js";
import { assertPersonalDataLoginAllowed } from "../../crypto/index.js";

type RequestMeta = {
  ip?: string;
  headers: Record<string, unknown>;
  accountId?: string;
};

function getRequestMeta(req: RequestMeta) {
  return {
    ipAddress: req.ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined
  };
}

export async function login(input: LoginInput, req: RequestMeta) {
  const meta = getRequestMeta(req);

  const account = await prisma.account.findUnique({
    where: { loginName: input.login },
    include: {
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
    }
  });

  if (account?.type === AccountType.SERVICE) {
    await prisma.authFailureLog.create({
      data: {
        accountId: account.id,
        loginName: input.login,
        reason: "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        terminalId: input.terminalId,
      },
    }).catch(() => undefined);
    throw Object.assign(new Error("SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN"), { statusCode: 403 });
  }

  if (!account || !account.passwordHash || !account.isActive) {
    await prisma.authFailureLog.create({
      data: {
        loginName: input.login,
        reason: "INVALID_ACCOUNT",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        terminalId: input.terminalId
      }
    }).catch(() => undefined);

    throw Object.assign(new Error("INVALID_CREDENTIALS"), { statusCode: 401 });
  }

  const passwordOk = await bcrypt.compare(input.password, account.passwordHash);

  if (!passwordOk) {
    await prisma.authFailureLog.create({
      data: {
        accountId: account.id,
        loginName: input.login,
        reason: "INVALID_PASSWORD",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        terminalId: input.terminalId
      }
    }).catch(() => undefined);

    throw Object.assign(new Error("INVALID_CREDENTIALS"), { statusCode: 401 });
  }

  const roles = account.roles.map((entry) => entry.role.key);

  assertPersonalDataLoginAllowed({
    accountId: account.id,
    loginName: account.loginName,
    memberId: account.person?.member?.id,
    roles,
    isSandbox: (account as any).isSandbox,
  });

  const resolvedPermissions = await permissionsService.resolveForIdentity({
    accountId: account.id,
    loginName: account.loginName,
    type: account.type,
    roles,
  });

  const accessToken = signAccessToken({
    accountId: account.id,
    loginName: account.loginName,
    type: account.type
  });

  const refreshToken = createRefreshToken();
  const refreshTokenHash = hashToken(refreshToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.session.create({
    data: {
      accountId: account.id,
      tokenHash: hashToken(accessToken),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      terminalId: input.terminalId
    }
  });

  await prisma.refreshToken.create({
    data: {
      accountId: account.id,
      tokenHash: refreshTokenHash,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      expiresAt
    }
  });

  await prisma.auditLog.create({
    data: {
      category: "AUTH",
      event: "LOGIN_SUCCESS",
      result: "SUCCESS",
      accountId: account.id,
      terminalId: input.terminalId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      severity: "INFO"
    }
  }).catch(() => undefined);

  await prisma.account.update({
    where: { id: account.id },
    data: { lastLoginAt: new Date() }
  });

  return {
    accessToken,
    refreshToken,
    account: {
      id: account.id,
      loginName: account.loginName,
      email: account.email,
      type: account.type,
      roles: resolvedPermissions.roles,
      permissions: resolvedPermissions.permissions,
      memberCapabilities: resolvedPermissions.memberCapabilities,
      allowedWorkspaces: resolvedPermissions.allowedWorkspaces,
      defaultWorkspace: resolvedPermissions.defaultWorkspace,
    }
  };
}

export async function refresh(input: RefreshInput, req: RequestMeta) {
  const meta = getRequestMeta(req);
  const refreshTokenHash = hashToken(input.refreshToken);

  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash: refreshTokenHash },
    include: {
      account: {
        include: {
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
      },
    }
  });

  if (
    !storedToken
    || storedToken.revokedAt
    || storedToken.expiresAt < new Date()
    || !storedToken.account.isActive
    || storedToken.account.type === AccountType.SERVICE
  ) {
    await prisma.tokenProblemLog.create({
      data: {
        tokenType: "REFRESH",
        reason: "INVALID_OR_EXPIRED_REFRESH_TOKEN",
        accountId: storedToken?.accountId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent
      }
    }).catch(() => undefined);

    throw Object.assign(new Error("INVALID_REFRESH_TOKEN"), { statusCode: 401 });
  }

  const roles = storedToken.account.roles.map((entry) => entry.role.key);

  assertPersonalDataLoginAllowed({
    accountId: storedToken.account.id,
    loginName: storedToken.account.loginName,
    memberId: storedToken.account.person?.member?.id,
    roles,
    isSandbox: (storedToken.account as any).isSandbox,
  });

  const accessToken = signAccessToken({
    accountId: storedToken.account.id,
    loginName: storedToken.account.loginName,
    type: storedToken.account.type
  });

  return { accessToken };
}

export async function logout(input: LogoutInput, req: RequestMeta) {
  const meta = getRequestMeta(req);

  if (input.refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(input.refreshToken), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }

  if (req.accountId) {
    await prisma.auditLog.create({
      data: {
        category: "AUTH",
        event: "LOGOUT",
        result: "SUCCESS",
        accountId: req.accountId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        severity: "INFO"
      }
    }).catch(() => undefined);
  }

  return { ok: true };
}

export function parseAccessToken(token: string) {
  return verifyAccessToken(token);
}
