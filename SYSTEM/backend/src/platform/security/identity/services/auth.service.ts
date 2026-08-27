import { AccountType } from "@prisma/client";
import { prisma } from "../../../../core/database/database.js";
import { verifyExactLocalPassword } from "../../../../core/modules/identity/local-password-policy.js";
import { permissionsService } from "../../../permissions/permissions.service.js";
import { createRefreshToken, hashToken, signAccessToken, verifyAccessToken } from "./token.service.js";
import type { LoginInput, LoginTwoFactorInput, LogoutInput, RefreshInput } from "../schemas/auth.schemas.js";
import { assertPersonalDataLoginAllowed } from "../../crypto/index.js";
import * as twoFactorService from "../../../../core/modules/security/two-factor/service.js";

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

  const passwordOk = await verifyExactLocalPassword(input.password, account.passwordHash);

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

  if (account.passwordRecoveryLockedAt) {
    throw Object.assign(new Error("PASSWORD_RECOVERY_LOCKED"), { code: "PASSWORD_RECOVERY_LOCKED", statusCode: 423 });
  }

  if (await twoFactorService.hasActiveTwoFactor(account.id)) {
    const challenge = await twoFactorService.createChallenge(
      account.id,
      { purpose: "LOGIN" },
      { ip: meta.ipAddress, userAgent: meta.userAgent },
    );
    return {
      requiresTwoFactor: true,
      challenge,
      message: `Bitte die Zwei-Faktor-Authentifizierung (2FA) über ${challenge.providerLabel || "Bonni"} abschließen.`,
    };
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
    type: account.type,
    credentialRevision: account.credentialRevision,
  });

  const refreshToken = createRefreshToken();
  const refreshTokenHash = hashToken(refreshToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.$transaction(async (transaction) => {
    const unchanged = await transaction.account.updateMany({
      where: {
        id: account.id,
        isActive: true,
        credentialRevision: account.credentialRevision,
        passwordRecoveryLockedAt: null,
      },
      data: { lastLoginAt: new Date() },
    });
    if (unchanged.count !== 1) {
      throw Object.assign(new Error("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH"), { statusCode: 409 });
    }
    await transaction.session.create({
      data: {
        accountId: account.id,
        tokenHash: hashToken(accessToken),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        terminalId: input.terminalId,
        credentialRevision: account.credentialRevision,
      },
    });
    await transaction.refreshToken.create({
      data: {
        accountId: account.id,
        tokenHash: refreshTokenHash,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt,
        credentialRevision: account.credentialRevision,
      },
    });
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

export async function loginWithTwoFactor(input: LoginTwoFactorInput, req: RequestMeta) {
  const meta = getRequestMeta(req);
  const pending = await prisma.securityTwoFactorChallenge.findUnique({
    where: { id: input.challengeId },
    select: { accountId: true, purpose: true },
  });
  const pendingAccount = pending?.purpose === "LOGIN"
    ? await prisma.account.findUnique({ where: { id: pending.accountId }, select: { passwordRecoveryLockedAt: true } })
    : null;
  if (pendingAccount?.passwordRecoveryLockedAt) {
    throw Object.assign(new Error("PASSWORD_RECOVERY_LOCKED"), { code: "PASSWORD_RECOVERY_LOCKED", statusCode: 423 });
  }
  const verified = await twoFactorService.verifyLoginChallenge(
    input.challengeId,
    {
      code: input.code,
      recoveryCode: input.recoveryCode,
      token: input.token,
      password: input.password,
    },
    { ip: meta.ipAddress, userAgent: meta.userAgent },
  );
  const consumed = await twoFactorService.consumeVerifiedChallenge({
    accountId: verified.accountId,
    challengeId: input.challengeId,
    purpose: "LOGIN",
  });

  const account = await prisma.account.findUnique({
    where: { id: verified.accountId },
    include: {
      roles: { include: { role: true } },
      person: { include: { member: true } },
    },
  });
  if (
    !account
    || !account.isActive
    || Boolean(account.passwordRecoveryLockedAt)
    || account.type === AccountType.SERVICE
    || account.credentialRevision !== consumed.credentialRevision
  ) {
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
    type: account.type,
    credentialRevision: consumed.credentialRevision,
  });
  const refreshToken = createRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.$transaction(async (transaction) => {
    const unchanged = await transaction.account.updateMany({
      where: {
        id: account.id,
        isActive: true,
        credentialRevision: consumed.credentialRevision,
        passwordRecoveryLockedAt: null,
      },
      data: { lastLoginAt: new Date() },
    });
    if (unchanged.count !== 1) {
      throw Object.assign(new Error("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH"), { statusCode: 409 });
    }
    await transaction.session.create({
      data: {
        accountId: account.id,
        tokenHash: hashToken(accessToken),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        terminalId: input.terminalId,
        credentialRevision: consumed.credentialRevision,
      },
    });
    await transaction.refreshToken.create({
      data: {
        accountId: account.id,
        tokenHash: hashToken(refreshToken),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt,
        credentialRevision: consumed.credentialRevision,
      },
    });
  });
  await prisma.auditLog.create({
    data: {
      category: "AUTH",
      event: "LOGIN_TWO_FACTOR_SUCCESS",
      result: "SUCCESS",
      accountId: account.id,
      terminalId: input.terminalId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      severity: "INFO",
    },
  }).catch(() => undefined);

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
    },
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
    || Boolean(storedToken.account.passwordRecoveryLockedAt)
    || storedToken.account.type === AccountType.SERVICE
    || storedToken.credentialRevision < 0
    || storedToken.credentialRevision !== storedToken.account.credentialRevision
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
    type: storedToken.account.type,
    credentialRevision: storedToken.account.credentialRevision,
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
