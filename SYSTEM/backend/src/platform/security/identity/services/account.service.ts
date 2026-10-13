import { AccountType, AuthProviderType } from "@prisma/client";

import { getServerPrismaClient } from "../../../../core/database/database.js";
import {
  hashExactLocalPassword,
  validateExactLocalPassword,
  verifyExactLocalPassword,
} from "../../../../core/modules/identity/local-password-policy.js";
import { advanceTwoFactorAfterPasswordChange } from "../../../../core/modules/security/two-factor/password-change.js";
import { getVerifiedRequestSessionAssurance } from "../../../auth/request-identity/request-identity-context.js";
import { publishUsersNetworkRecords } from "../../../auth/users/users-network-data-adapter.js";
import type {
  ChangeOwnPasswordInput,
  OwnChangeHistoryQuery,
  UpdateOwnProfileInput,
} from "../schemas/auth.schemas.js";

const prisma = getServerPrismaClient("core");
const PERSONAL_ACCOUNT_TYPES = new Set<AccountType>([AccountType.MEMBER, AccountType.ADMIN]);
const OWN_PASSWORD_LOCKOUT_SCOPE = "PASSWORD:SELF_SERVICE";
const OWN_PASSWORD_MAX_ATTEMPTS = 5;
const OWN_PASSWORD_BASE_LOCK_MINUTES = 3;
const OWN_PASSWORD_MAX_LOCK_MINUTES = 24 * 60;

function accountError(code: string, message: string, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function profileText(value: unknown, max: number) {
  const normalized = String(value ?? "").trim();
  return normalized ? [...normalized].slice(0, max).join("") : null;
}

function profileDate(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw accountError("OWN_PROFILE_BIRTH_DATE_INVALID", "Der Geburtstag ist ungültig.");
  }
  return date;
}

function hasOwn(value: object, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function sameProfileDate(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

function ownPasswordLockMinutes(level: number) {
  return Math.min(
    OWN_PASSWORD_BASE_LOCK_MINUTES * (2 ** Math.max(level, 0)),
    OWN_PASSWORD_MAX_LOCK_MINUTES,
  );
}

function ownPasswordLockedError(lockedUntil: Date) {
  return Object.assign(
    accountError(
      "OWN_PASSWORD_TEMPORARILY_LOCKED",
      "Der Passwortwechsel ist nach mehreren Fehlversuchen vorübergehend gesperrt.",
      423,
    ),
    { details: { lockedUntil, maxAttempts: OWN_PASSWORD_MAX_ATTEMPTS } },
  );
}

async function assertOwnPasswordAttemptAllowed(accountId: string) {
  const lockout = await prisma.securityTwoFactorLockout.findUnique({
    where: {
      accountId_scopeKey: {
        accountId,
        scopeKey: OWN_PASSWORD_LOCKOUT_SCOPE,
      },
    },
    select: { lockedUntil: true },
  });
  if (lockout?.lockedUntil && lockout.lockedUntil > new Date()) {
    throw ownPasswordLockedError(lockout.lockedUntil);
  }
}

async function registerOwnPasswordFailure(accountId: string) {
  return prisma.$transaction(async (transaction) => {
    const now = new Date();
    // Reuse Core's persistent account/scope lockout store. The atomic upsert
    // prevents concurrent requests from losing failed-attempt increments.
    const row = await transaction.securityTwoFactorLockout.upsert({
      where: {
        accountId_scopeKey: {
          accountId,
          scopeKey: OWN_PASSWORD_LOCKOUT_SCOPE,
        },
      },
      create: {
        accountId,
        scopeKey: OWN_PASSWORD_LOCKOUT_SCOPE,
        failedAttempts: 1,
        lastFailureAt: now,
      },
      update: {
        failedAttempts: { increment: 1 },
        lastFailureAt: now,
      },
    });

    let lockedUntil = row.lockedUntil && row.lockedUntil > now
      ? row.lockedUntil
      : null;
    if (!lockedUntil && row.failedAttempts >= OWN_PASSWORD_MAX_ATTEMPTS) {
      const nextLockedUntil = new Date(
        now.getTime() + ownPasswordLockMinutes(row.lockLevel) * 60 * 1000,
      );
      const locked = await transaction.securityTwoFactorLockout.updateMany({
        where: {
          id: row.id,
          failedAttempts: { gte: OWN_PASSWORD_MAX_ATTEMPTS },
          lockLevel: row.lockLevel,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: {
          failedAttempts: 0,
          lockLevel: { increment: 1 },
          lockedUntil: nextLockedUntil,
          lastFailureAt: now,
        },
      });
      if (locked.count === 1) lockedUntil = nextLockedUntil;
    }

    await transaction.auditLog.create({
      data: {
        category: "SECURITY",
        event: lockedUntil
          ? "USER_PASSWORD_CHANGE_BLOCKED"
          : "USER_PASSWORD_CHANGE_FAILED",
        result: lockedUntil ? "DENIED" : "FAILED",
        accountId,
        targetType: "Account",
        targetId: accountId,
        metadataJson: {
          maxAttempts: OWN_PASSWORD_MAX_ATTEMPTS,
          ...(lockedUntil ? { lockedUntil: lockedUntil.toISOString() } : {}),
        },
      },
    });
    return { lockedUntil };
  });
}

export async function getMe(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      person: true,
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
    throw Object.assign(new Error("ACCOUNT_NOT_FOUND"), { statusCode: 404 });
  }

  const roles = account.roles.map((entry) => entry.role.key);
  const permissions = [
    ...new Set(
      account.roles.flatMap((entry) =>
        entry.role.permissions.map((permissionEntry) => permissionEntry.permission.key)
      )
    )
  ];

  return {
    id: account.id,
    loginName: account.loginName,
    email: account.email,
    type: account.type,
    person: account.person,
    roles,
    permissions
  };
}

export async function updateMeProfile(accountId: string, input: UpdateOwnProfileInput) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      loginName: true,
      email: true,
      personId: true,
      isActive: true,
      credentialRevision: true,
      updatedAt: true,
      person: {
        select: {
          firstName: true,
          secondFirstName: true,
          lastName: true,
          nickname: true,
          displayName: true,
          email: true,
          birthDate: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!account?.isActive) {
    throw accountError("ACCOUNT_NOT_FOUND", "Das Benutzerkonto wurde nicht gefunden.", 404);
  }
  if (!account.personId || !account.person) {
    throw accountError("OWN_PROFILE_PERSON_REQUIRED", "Dem Benutzerkonto ist keine Person zugeordnet.", 409);
  }
  const personId = account.personId;
  const currentPerson = account.person;

  const provided = {
    firstName: hasOwn(input, "firstName"),
    secondFirstName: hasOwn(input, "secondFirstName"),
    lastName: hasOwn(input, "lastName"),
    nickname: hasOwn(input, "nickname"),
    displayName: hasOwn(input, "displayName"),
    email: hasOwn(input, "email"),
    birthDate: hasOwn(input, "birthDate"),
  };
  if (!Object.values(provided).some(Boolean)) {
    throw accountError("OWN_PROFILE_UPDATE_EMPTY", "Es wurde kein Profilfeld zum Ändern übergeben.");
  }

  const normalized = {
    firstName: provided.firstName ? profileText(input.firstName, 100) : currentPerson.firstName,
    secondFirstName: provided.secondFirstName
      ? profileText(input.secondFirstName, 100)
      : currentPerson.secondFirstName,
    lastName: provided.lastName ? profileText(input.lastName, 100) : currentPerson.lastName,
    nickname: provided.nickname ? profileText(input.nickname, 100) : currentPerson.nickname,
    displayName: provided.displayName ? profileText(input.displayName, 160) : currentPerson.displayName,
    email: provided.email
      ? profileText(input.email, 200)?.toLowerCase() || null
      : currentPerson.email,
    birthDate: provided.birthDate ? profileDate(input.birthDate) : currentPerson.birthDate,
  };
  if (!normalized.displayName) {
    throw accountError("OWN_PROFILE_DISPLAY_NAME_REQUIRED", "Der Anzeigename darf nicht leer sein.");
  }

  const changedFields = [
    provided.firstName && normalized.firstName !== currentPerson.firstName ? "firstName" : null,
    provided.secondFirstName && normalized.secondFirstName !== currentPerson.secondFirstName
      ? "secondFirstName"
      : null,
    provided.lastName && normalized.lastName !== currentPerson.lastName ? "lastName" : null,
    provided.nickname && normalized.nickname !== currentPerson.nickname ? "nickname" : null,
    provided.displayName && normalized.displayName !== currentPerson.displayName ? "displayName" : null,
    provided.birthDate && !sameProfileDate(normalized.birthDate, currentPerson.birthDate) ? "birthDate" : null,
    provided.email && (normalized.email !== currentPerson.email || normalized.email !== account.email)
      ? "email"
      : null,
  ].filter((field): field is string => Boolean(field));
  if (!changedFields.length) return getMe(accountId);

  const personData: {
    firstName?: string | null;
    secondFirstName?: string | null;
    lastName?: string | null;
    nickname?: string | null;
    displayName?: string;
    email?: string | null;
    birthDate?: Date | null;
  } = {};
  if (provided.firstName) personData.firstName = normalized.firstName;
  if (provided.secondFirstName) personData.secondFirstName = normalized.secondFirstName;
  if (provided.lastName) personData.lastName = normalized.lastName;
  if (provided.nickname) personData.nickname = normalized.nickname;
  if (provided.displayName) personData.displayName = normalized.displayName;
  if (provided.email) personData.email = normalized.email;
  if (provided.birthDate) personData.birthDate = normalized.birthDate;

  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    const unchangedAccount = await transaction.account.updateMany({
      where: {
        id: account.id,
        personId,
        isActive: true,
        credentialRevision: account.credentialRevision,
        updatedAt: account.updatedAt,
      },
      data: {
        updatedAt: now,
        ...(provided.email ? { email: normalized.email } : {}),
      },
    });
    if (unchangedAccount.count !== 1) {
      throw accountError(
        "OWN_PROFILE_CHANGED_CONCURRENTLY",
        "Das Profil wurde gleichzeitig geändert. Bitte erneut laden.",
        409,
      );
    }
    const changedPerson = await transaction.person.updateMany({
      where: {
        id: personId,
        updatedAt: currentPerson.updatedAt,
      },
      data: personData,
    });
    if (changedPerson.count !== 1) {
      throw accountError(
        "OWN_PROFILE_CHANGED_CONCURRENTLY",
        "Das Profil wurde gleichzeitig geändert. Bitte erneut laden.",
        409,
      );
    }
    await transaction.auditLog.create({
      data: {
        category: "DATA",
        event: "USER_PROFILE_UPDATED",
        result: "SUCCESS",
        accountId: account.id,
        targetType: "Person",
        targetId: personId,
        metadataJson: {
          changedFields,
        },
      },
    });
  });

  await publishUsersNetworkRecords(
    { accountIds: [account.id] },
    { accountId: account.id, loginName: account.loginName },
    { serverAuthoritative: true },
  ).catch((error) => {
    console.warn("[core.identity] Network data adapter could not publish the self-profile update", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return getMe(accountId);
}

export async function changeMePassword(accountId: string, input: ChangeOwnPasswordInput) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { authProvider: true },
  });
  if (!account?.isActive || !account.passwordHash) {
    throw accountError("ACCOUNT_NOT_FOUND", "Das Benutzerkonto wurde nicht gefunden.", 404);
  }
  if (!PERSONAL_ACCOUNT_TYPES.has(account.type)) {
    throw accountError(
      "TECHNICAL_ACCOUNT_PASSWORD_FORBIDDEN",
      account.type === AccountType.TERMINAL
        ? "Terminal-Passwörter werden durch die Benutzerverwaltung in Bonni Core gesetzt."
        : "Reine Dienstkonten dürfen kein interaktives Passwort besitzen.",
      409,
    );
  }
  if (account.passwordRecoveryLockedAt) {
    throw accountError(
      "PASSWORD_RECOVERY_LOCKED",
      "Das Passwort darf nur über den laufenden Wiederherstellungsvorgang gesetzt werden.",
      423,
    );
  }
  if (
    account.authProvider.type !== AuthProviderType.LOCAL
    || account.authProvider.active !== true
  ) {
    throw accountError(
      "OWN_PASSWORD_PROVIDER_INVALID",
      "Das Passwort wird vom externen Anmeldeanbieter verwaltet.",
      409,
    );
  }
  if (account.twoFactorProviderId) {
    const assurance = getVerifiedRequestSessionAssurance();
    if (
      !assurance
      || assurance.accountId !== account.id
      || assurance.credentialRevision !== account.credentialRevision
      || assurance.mfaProviderId !== account.twoFactorProviderId
      || !assurance.mfaVerifiedAt
    ) {
      throw accountError(
        "TWO_FACTOR_SESSION_ASSURANCE_REQUIRED",
        "Der Passwortwechsel benötigt eine mit 2FA bestätigte aktuelle Sitzung.",
        403,
      );
    }
  }
  await assertOwnPasswordAttemptAllowed(account.id);
  if (!(await verifyExactLocalPassword(input.currentPassword, account.passwordHash))) {
    const failure = await registerOwnPasswordFailure(account.id);
    if (failure.lockedUntil) throw ownPasswordLockedError(failure.lockedUntil);
    throw accountError("OWN_PASSWORD_CURRENT_INVALID", "Das aktuelle Passwort ist falsch.", 401);
  }
  const validation = validateExactLocalPassword(input.newPassword);
  if (!validation.ok || validation.characters < 6) {
    throw accountError("OWN_PASSWORD_TOO_SHORT", "Das neue Passwort muss mindestens 6 Zeichen haben.");
  }
  const passwordHash = await hashExactLocalPassword(validation.password, 12);
  const nextRevision = account.credentialRevision + 1;
  const now = new Date();

  await prisma.$transaction(async (transaction) => {
    const changed = await transaction.account.updateMany({
      where: {
        id: account.id,
        type: account.type,
        isActive: true,
        authProviderId: account.authProviderId,
        passwordHash: account.passwordHash,
        twoFactorProviderId: account.twoFactorProviderId,
        authProvider: {
          is: {
            type: AuthProviderType.LOCAL,
            active: true,
          },
        },
        credentialRevision: account.credentialRevision,
        passwordRecoveryLockedAt: null,
      },
      data: {
        passwordHash,
        credentialRevision: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw accountError(
        "OWN_PASSWORD_CHANGED_CONCURRENTLY",
        "Das Passwort wurde gleichzeitig geändert. Bitte erneut anmelden.",
        409,
      );
    }
    await advanceTwoFactorAfterPasswordChange(transaction, {
      accountId: account.id,
      previousRevision: account.credentialRevision,
      nextRevision,
      twoFactorProviderId: account.twoFactorProviderId,
    });
    await transaction.session.updateMany({
      where: { accountId: account.id, endedAt: null },
      data: { endedAt: now },
    });
    await transaction.refreshToken.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await transaction.securityTwoFactorLockout.upsert({
      where: {
        accountId_scopeKey: {
          accountId: account.id,
          scopeKey: OWN_PASSWORD_LOCKOUT_SCOPE,
        },
      },
      create: {
        accountId: account.id,
        scopeKey: OWN_PASSWORD_LOCKOUT_SCOPE,
        failedAttempts: 0,
        lockLevel: 0,
        lastSuccessAt: now,
      },
      update: {
        failedAttempts: 0,
        lockLevel: 0,
        lockedUntil: null,
        lastSuccessAt: now,
      },
    });
    await transaction.auditLog.create({
      data: {
        category: "SECURITY",
        event: "USER_PASSWORD_CHANGED",
        result: "SUCCESS",
        accountId: account.id,
        targetType: "Account",
        targetId: account.id,
      },
    });
  });

  return { ok: true, sessionRevoked: true };
}

export async function getMyChangeHistory(
  accountId: string,
  scope?: OwnChangeHistoryQuery["scope"],
) {
  if (scope === "security") {
    const [passwordRows, twoFactorRows] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          accountId,
          event: {
            in: [
              "USER_PASSWORD_CHANGED",
              "USER_PASSWORD_CHANGE_FAILED",
              "USER_PASSWORD_CHANGE_BLOCKED",
            ],
          },
        },
        select: {
          id: true,
          event: true,
          result: true,
          metadataJson: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 4,
      }),
      prisma.securityTwoFactorAuditLog.findMany({
        where: { accountId },
        select: {
          id: true,
          event: true,
          result: true,
          purpose: true,
          method: true,
          metadataJson: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 4,
      }),
    ]);
    const entries = [
      ...passwordRows.map((entry) => ({ ...entry, source: "ACCOUNT" as const })),
      ...twoFactorRows.map((entry) => ({ ...entry, source: "TWO_FACTOR" as const })),
    ].sort((left, right) => (
      right.createdAt.getTime() - left.createdAt.getTime()
      || right.id.localeCompare(left.id)
    )).slice(0, 4);
    return { entries };
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      accountId,
      event: {
        in: [
          "USER_PROFILE_UPDATED",
          "USER_PASSWORD_CHANGED",
          "SYSTEM_BRANDING_UPDATED",
          "SYSTEM_BRANDING_LOGO_UPDATED",
          "SYSTEM_BRANDING_LOGO_RESET",
        ],
      },
    },
    select: {
      id: true,
      event: true,
      result: true,
      metadataJson: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 4,
  });
  return { entries: rows };
}

export async function listAccounts() {
  return prisma.account.findMany({
    select: {
      id: true,
      loginName: true,
      email: true,
      type: true,
      isActive: true,
      isSandbox: true,
      lastLoginAt: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function listRoles() {
  return prisma.role.findMany({
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    },
    orderBy: { key: "asc" }
  });
}

export async function listPermissions() {
  return prisma.permission.findMany({
    orderBy: { key: "asc" }
  });
}
