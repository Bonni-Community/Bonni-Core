import {
  AccountType,
  AuthProviderType,
  ClubMembershipStatus,
  MemberStatus,
  type Prisma,
} from "@prisma/client";

import { getPrismaClient } from "../../../core/database/database.js";
import { hashPassword } from "../authentication/password-hash.helper.js";
import { createAccountId, createMemberId } from "../../security/crypto/id.js";
import { provisionAccountArchive } from "../../../system/routes/explorer/archive-account.service.js";
import { publishUsersNetworkRecords } from "./users-network-data-adapter.js";

type CurrentUserContext = {
  accountId?: string | null;
  id?: string | null;
  loginName?: string | null;
};

type ModuleAccessInput = {
  kind?: unknown;
  moduleKey?: unknown;
  moduleName?: unknown;
  permissions?: unknown;
};

type CreateLocalMemberInput = {
  createAccount?: unknown;
  loginName?: unknown;
  displayName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  nickname?: unknown;
  email?: unknown;
  phone?: unknown;
  birthDate?: unknown;
  joinedAt?: unknown;
  leftAt?: unknown;
  status?: unknown;
  iban?: unknown;
  bic?: unknown;
  password?: unknown;
  usage?: unknown;
  surface?: unknown;
  roles?: unknown;
  moduleAccess?: unknown;
};

type UpdateLocalMemberProfileInput = {
  loginName?: unknown;
  displayName?: unknown;
  status?: unknown;
  isActive?: unknown;
  usageLabels?: unknown;
  surfaceLabels?: unknown;
  rolesBySurface?: unknown;
  moduleAccess?: unknown;
};

type UpdateMemberByIdInput = {
  displayName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  nickname?: unknown;
  email?: unknown;
  phone?: unknown;
  birthDate?: unknown;
  joinedAt?: unknown;
  leftAt?: unknown;
  status?: unknown;
  iban?: unknown;
  bic?: unknown;
};

type NormalizedModuleAccess = {
  kind: "control-center" | "app" | "add-on" | "plug-in";
  moduleKey: string;
  moduleName: string;
  permissions: string[];
};

export class UserMutationError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "UserMutationError";
    this.code = code;
    this.status = status;
  }
}

function cleanText(value: unknown, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function slug(value: unknown, fallback = "access") {
  const normalized = cleanText(value, 120)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => cleanText(value, 120)).filter(Boolean))];
}

function normalizeKind(value: unknown): NormalizedModuleAccess["kind"] | null {
  const normalized = cleanText(value, 40).toLowerCase().replace(/_/g, "-");

  if (["control-center", "control center", "controlcenter", "control"].includes(normalized)) return "control-center";
  if (normalized === "app") return "app";
  if (["add-on", "addon"].includes(normalized)) return "add-on";
  if (["plug-in", "plugin"].includes(normalized)) return "plug-in";

  return null;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => cleanText(item, 120)));
}

function normalizeExplicitModuleAccess(value: unknown): NormalizedModuleAccess[] {
  const source = Array.isArray(value) ? value as ModuleAccessInput[] : [];

  return source.flatMap((entry) => {
    const kind = normalizeKind(entry?.kind);
    const moduleKey = cleanText(entry?.moduleKey, 120);
    const moduleName = cleanText(entry?.moduleName, 120) || moduleKey;
    const permissions = asStringArray(entry?.permissions);

    if (!kind || !moduleKey || !moduleName || !permissions.length) return [];
    return [{ kind, moduleKey, moduleName, permissions }];
  });
}

function normalizeModuleAccess(input: CreateLocalMemberInput): NormalizedModuleAccess[] {
  // Only a concrete module key may grant an app. Legacy fields such as the
  // generic surface "App" are deliberately ignored because they cannot say
  // whether StueberlApp, KontorApp, or another app was selected.
  return normalizeExplicitModuleAccess(input.moduleAccess);
}

function isValidEmail(value: string) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isTechnicalUsage(value: unknown) {
  return cleanText(value, 60).toLowerCase().includes("techn");
}

function accountTypeFor(input: CreateLocalMemberInput, access: NormalizedModuleAccess[]) {
  const hasControlCenterAdmin = access.some((assignment) => (
    assignment.kind === "control-center"
    && assignment.permissions.some((permission) => slug(permission) === "administrator")
  ));

  if (hasControlCenterAdmin) return AccountType.ADMIN;

  const technical = isTechnicalUsage(input.usage)
    || access.some((assignment) => assignment.kind === "add-on" || assignment.kind === "plug-in");

  if (!technical) return AccountType.MEMBER;
  return access.some((assignment) => assignment.kind === "app")
    ? AccountType.TERMINAL
    : AccountType.SERVICE;
}

function accessRoleKey(assignment: NormalizedModuleAccess, permission: string) {
  return [
    "access",
    slug(assignment.kind),
    slug(assignment.moduleKey),
    slug(permission),
  ].join(":").slice(0, 180);
}

function accessPermissionKey(assignment: NormalizedModuleAccess, permission: string) {
  return [
    "module",
    slug(assignment.moduleKey),
    slug(permission),
  ].join(".").slice(0, 180);
}

function moduleKindLabel(kind: NormalizedModuleAccess["kind"]) {
  if (kind === "control-center") return "Control Center";
  if (kind === "add-on") return "Add-on";
  if (kind === "plug-in") return "Plug-in";
  return "App";
}

function capabilityKey(permission: string) {
  const normalized = slug(permission).replace(/-/g, "_").toUpperCase();
  if (["MANAGER", "STOREMAN", "TREASURER", "HELPER"].includes(normalized)) return normalized;
  return null;
}

export async function assertCanManageUsers(
  prisma: ReturnType<typeof getPrismaClient>,
  currentUser: CurrentUserContext | null | undefined,
  { allowKontorManager = false } = {},
) {
  const accountId = cleanText(currentUser?.accountId || currentUser?.id, 160);
  const loginName = cleanText(currentUser?.loginName, 160).toLowerCase();

  if (!accountId && !loginName) {
    throw new UserMutationError("UNAUTHENTICATED", "Nicht angemeldet.", 401);
  }

  const account = await prisma.account.findFirst({
    where: {
      OR: [
        ...(accountId ? [{ id: accountId }] : []),
        ...(loginName ? [{ loginName }] : []),
      ],
    },
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

  const roleKeys = account?.roles.map((entry) => entry.role.key) || [];
  const permissionKeys = account?.roles.flatMap((entry) => (
    entry.role.permissions.map((rolePermission) => rolePermission.permission.key)
  )) || [];
  const allowed = Boolean(account?.isActive) && (
    roleKeys.includes("admin")
    || permissionKeys.some((permission) => ["*", "system.admin", "auth.users.write"].includes(permission))
    || (allowKontorManager && permissionKeys.includes("module.app-kontorapp.manager"))
  );

  if (!allowed) {
    throw new UserMutationError(
      "USER_MANAGEMENT_FORBIDDEN",
      "Für die Benutzerverwaltung fehlt die Berechtigung.",
      403,
    );
  }
}

function shouldCreateAccount(value: unknown) {
  if (value === false || value === 0) return false;
  if (typeof value === "string" && ["false", "0", "nein", "no"].includes(value.trim().toLowerCase())) {
    return false;
  }
  return true;
}

function parseOptionalDate(value: unknown, fieldLabel: string) {
  const raw = cleanText(value, 40);
  if (!raw) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(date.getTime())) {
    throw new UserMutationError("LOCAL_MEMBER_DATE_INVALID", `${fieldLabel} ist kein gültiges Datum.`);
  }
  return date;
}

function assertMembershipDates(joinedAt: Date | null, leftAt: Date | null) {
  if (joinedAt && leftAt && leftAt.getTime() < joinedAt.getTime()) {
    throw new UserMutationError(
      "MEMBER_DATES_INVALID",
      "Das Austrittsdatum darf nicht vor dem Eintrittsdatum liegen.",
    );
  }
}

const CLUB_MEMBERSHIP_STATUS_ALIASES: Record<string, ClubMembershipStatus> = {
  active_member: ClubMembershipStatus.ACTIVE_MEMBER,
  active: ClubMembershipStatus.ACTIVE_MEMBER,
  aktiv: ClubMembershipStatus.ACTIVE_MEMBER,
  aktivesmitglied: ClubMembershipStatus.ACTIVE_MEMBER,
  "aktives mitglied": ClubMembershipStatus.ACTIVE_MEMBER,
  member: ClubMembershipStatus.ACTIVE_MEMBER,
  passive_member: ClubMembershipStatus.PASSIVE_MEMBER,
  passive: ClubMembershipStatus.PASSIVE_MEMBER,
  passiv: ClubMembershipStatus.PASSIVE_MEMBER,
  passivmitglied: ClubMembershipStatus.PASSIVE_MEMBER,
  supporting_member: ClubMembershipStatus.SUPPORTING_MEMBER,
  supporting: ClubMembershipStatus.SUPPORTING_MEMBER,
  foerdermitglied: ClubMembershipStatus.SUPPORTING_MEMBER,
  "fördermitglied": ClubMembershipStatus.SUPPORTING_MEMBER,
  honorary_member: ClubMembershipStatus.HONORARY_MEMBER,
  honorary: ClubMembershipStatus.HONORARY_MEMBER,
  ehrenmitglied: ClubMembershipStatus.HONORARY_MEMBER,
  sponsor: ClubMembershipStatus.SPONSOR,
  resigned: ClubMembershipStatus.RESIGNED,
  former_member: ClubMembershipStatus.RESIGNED,
  former: ClubMembershipStatus.RESIGNED,
  ehemalig: ClubMembershipStatus.RESIGNED,
  ausgetreten: ClubMembershipStatus.RESIGNED,
};

function clubMembershipStatus(
  value: unknown,
  fallback: ClubMembershipStatus = ClubMembershipStatus.ACTIVE_MEMBER,
) {
  const raw = cleanText(value, 60);
  if (!raw) return fallback;
  return CLUB_MEMBERSHIP_STATUS_ALIASES[raw.toLowerCase()] || fallback;
}

function memberLifecycleStatus(value: ClubMembershipStatus) {
  return value === ClubMembershipStatus.RESIGNED
    ? MemberStatus.FORMER_MEMBER
    : MemberStatus.MEMBER;
}

function accountActiveStatus(value: unknown, fallback: boolean) {
  const normalized = cleanText(value, 40).toLowerCase();

  if (["aktiv", "active", "aktiviert", "enabled"].includes(normalized)) return true;
  if (["inaktiv", "inactive", "deaktiviert", "disabled"].includes(normalized)) return false;

  // Fachliche Statuswerte anderer Apps dürfen den Kontostatus nicht verändern.
  return fallback;
}

function normalizeIban(value: unknown) {
  const iban = cleanText(value, 80).replace(/\s+/g, "").toUpperCase();
  if (!iban) return null;

  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    throw new UserMutationError("MEMBER_IBAN_INVALID", "Bitte eine gültige IBAN eingeben.");
  }

  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }

  if (remainder !== 1) {
    throw new UserMutationError("MEMBER_IBAN_INVALID", "Die Prüfsumme der IBAN ist ungültig.");
  }

  return iban;
}

function normalizeBic(value: unknown) {
  const bic = cleanText(value, 20).replace(/\s+/g, "").toUpperCase();
  if (!bic) return null;
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    throw new UserMutationError("MEMBER_BIC_INVALID", "Bitte eine gültige BIC mit 8 oder 11 Zeichen eingeben.");
  }
  return bic;
}

async function assignModuleAccess(
  transaction: Prisma.TransactionClient,
  accountId: string,
  access: NormalizedModuleAccess[],
) {
  for (const assignment of access) {
    for (const permissionLabel of assignment.permissions) {
      const isAdministrator = assignment.kind === "control-center" && slug(permissionLabel) === "administrator";
      const roleKey = isAdministrator ? "admin" : accessRoleKey(assignment, permissionLabel);
      const roleLabel = isAdministrator
        ? "Administrator"
        : `${moduleKindLabel(assignment.kind)}: ${assignment.moduleName} · ${permissionLabel}`;
      const role = await transaction.role.upsert({
        where: { key: roleKey },
        update: { label: roleLabel },
        create: { key: roleKey, label: roleLabel },
      });

      await transaction.accountRole.upsert({
        where: { accountId_roleId: { accountId, roleId: role.id } },
        update: {},
        create: { accountId, roleId: role.id },
      });

      if (!isAdministrator) {
        const permissionKey = accessPermissionKey(assignment, permissionLabel);
        const permission = await transaction.permission.upsert({
          where: { key: permissionKey },
          update: { label: roleLabel },
          create: { key: permissionKey, label: roleLabel },
        });

        await transaction.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: role.id, permissionId: permission.id },
        });
      }

      const memberCapabilityKey = capabilityKey(permissionLabel);
      if (memberCapabilityKey) {
        const capability = await transaction.memberCapability.upsert({
          where: { key: memberCapabilityKey as any },
          update: { label: permissionLabel },
          create: { key: memberCapabilityKey as any, label: permissionLabel },
        });

        await transaction.accountMemberCapability.upsert({
          where: {
            accountId_capabilityId: {
              accountId,
              capabilityId: capability.id,
            },
          },
          update: {},
          create: { accountId, capabilityId: capability.id },
        });
      }
    }
  }
}

export async function createLocalMember(
  input: CreateLocalMemberInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = getPrismaClient();
  await assertCanManageUsers(prisma, currentUser, { allowKontorManager: true });

  const createAccount = shouldCreateAccount(input.createAccount);
  const loginName = cleanText(input.loginName, 80).toLowerCase();
  const firstName = cleanText(input.firstName, 100) || null;
  const lastName = cleanText(input.lastName, 100) || null;
  const nickname = cleanText(input.nickname, 100) || null;
  const displayName = cleanText(input.displayName, 160)
    || [firstName, lastName].filter(Boolean).join(" ")
    || nickname
    || loginName;
  const email = cleanText(input.email, 200).toLowerCase() || null;
  const phone = cleanText(input.phone, 80) || null;
  const birthDate = parseOptionalDate(input.birthDate, "Der Geburtstag");
  const joinedAt = parseOptionalDate(input.joinedAt, "Das Eintrittsdatum") || new Date();
  const normalizedClubStatus = clubMembershipStatus(input.status);
  const normalizedMemberStatus = memberLifecycleStatus(normalizedClubStatus);
  const requestedLeftAt = parseOptionalDate(input.leftAt, "Das Austrittsdatum");
  const leftAt = normalizedClubStatus === ClubMembershipStatus.RESIGNED
    ? requestedLeftAt || new Date()
    : null;
  assertMembershipDates(joinedAt, leftAt);
  const iban = normalizeIban(input.iban);
  const bic = normalizeBic(input.bic);
  const password = String(input.password || "");
  const moduleAccess = createAccount ? normalizeModuleAccess(input) : [];

  if (createAccount && !loginName) {
    throw new UserMutationError("LOCAL_MEMBER_LOGIN_REQUIRED", "Bitte einen Loginnamen eingeben.");
  }
  if (createAccount && !/^[a-z0-9][a-z0-9._-]*$/.test(loginName)) {
    throw new UserMutationError(
      "LOCAL_MEMBER_LOGIN_INVALID",
      "Der Loginname darf nur Kleinbuchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.",
    );
  }
  if (!displayName) {
    throw new UserMutationError("LOCAL_MEMBER_DISPLAY_NAME_REQUIRED", "Bitte einen Anzeigenamen eingeben.");
  }
  if (!isValidEmail(email || "")) {
    throw new UserMutationError("LOCAL_MEMBER_EMAIL_INVALID", "Bitte eine gültige E-Mail-Adresse eingeben.");
  }
  if (createAccount && password.length < 6) {
    throw new UserMutationError("LOCAL_MEMBER_PASSWORD_TOO_SHORT", "Das Passwort muss mindestens 6 Zeichen haben.");
  }
  const existing = createAccount
    ? await prisma.account.findUnique({ where: { loginName } })
    : null;
  if (existing) {
    throw new UserMutationError("LOCAL_MEMBER_ALREADY_EXISTS", "Dieser Loginname existiert bereits.", 409);
  }

  const passwordHash = createAccount ? await hashPassword(password) : null;
  const accountType = createAccount ? accountTypeFor(input, moduleAccess) : AccountType.MEMBER;

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const localProvider = createAccount
        ? await transaction.authProvider.upsert({
            where: { key: "local" },
            update: { active: true },
            create: {
              key: "local",
              type: AuthProviderType.LOCAL,
              name: "Local Login",
              active: true,
            },
          })
        : null;
      const person = await transaction.person.create({
        data: {
          displayName,
          firstName,
          lastName,
          nickname,
          email,
          phone,
          birthDate,
        },
      });
      const member = accountType === AccountType.MEMBER
        ? await transaction.memberProfile.create({
            data: {
              id: createMemberId(),
              personId: person.id,
              status: normalizedMemberStatus,
              membershipStatus: normalizedClubStatus,
              joinedAt,
              leftAt,
              iban,
              bic,
            },
          })
        : null;
      const account = createAccount && localProvider
        ? await transaction.account.create({
            data: {
              id: createAccountId(),
              type: accountType,
              loginName,
              email,
              passwordHash,
              authProviderId: localProvider.id,
              personId: person.id,
              isActive: true,
              isSandbox: false,
            },
          })
        : null;

      if (account) {
        await assignModuleAccess(transaction, account.id, moduleAccess);
        await provisionAccountArchive(transaction, {
          id: account.id,
          type: account.type,
          loginName: account.loginName,
          personId: person.id,
        });
      }

      return {
        account: account ? {
          id: account.id,
          accountId: account.id,
          loginName: account.loginName,
          email: account.email,
          type: account.type,
          isActive: account.isActive,
          personId: person.id,
        } : null,
        personId: person.id,
        memberId: member?.id || null,
      };
    });

    const response = {
      ok: true,
      created: true,
      ...result,
      moduleAccess,
    };
    await publishUsersNetworkRecords({
      accountIds: [result.account?.id],
      memberIds: [result.memberId],
    }, {
      accountId: currentUser?.accountId || currentUser?.id || null,
      loginName: currentUser?.loginName || null,
    }).catch((error) => {
      console.warn("[core.auth.users] Network data adapter could not publish the new user", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return response;
  } catch (error: any) {
    if (error?.code === "P2002") {
      throw new UserMutationError("LOCAL_MEMBER_ALREADY_EXISTS", "Dieser Loginname existiert bereits.", 409);
    }
    throw error;
  }
}

export async function updateMemberById(
  memberIdValue: unknown,
  input: UpdateMemberByIdInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = getPrismaClient();
  await assertCanManageUsers(prisma, currentUser, { allowKontorManager: true });

  const memberId = cleanText(memberIdValue, 160);
  if (!memberId) {
    throw new UserMutationError("MEMBER_ID_REQUIRED", "Die Mitglieds-ID fehlt.");
  }

  const existing = await prisma.memberProfile.findUnique({
    where: { id: memberId },
    include: { person: true },
  });
  if (!existing) {
    throw new UserMutationError("MEMBER_NOT_FOUND", "Das Mitglied wurde nicht gefunden.", 404);
  }

  const firstName = cleanText(input.firstName, 100) || null;
  const lastName = cleanText(input.lastName, 100) || null;
  const nickname = cleanText(input.nickname, 100) || null;
  const email = cleanText(input.email, 200).toLowerCase() || null;
  const phone = cleanText(input.phone, 80) || null;
  const displayName = cleanText(input.displayName, 160)
    || [firstName, lastName].filter(Boolean).join(" ")
    || nickname;
  const normalizedClubStatus = clubMembershipStatus(input.status, existing.membershipStatus);
  const normalizedMemberStatus = memberLifecycleStatus(normalizedClubStatus);
  const birthDate = input.birthDate === undefined
    ? existing.person.birthDate
    : parseOptionalDate(input.birthDate, "Der Geburtstag");
  const joinedAt = input.joinedAt === undefined
    ? existing.joinedAt
    : parseOptionalDate(input.joinedAt, "Das Eintrittsdatum");
  const requestedLeftAt = input.leftAt === undefined
    ? existing.leftAt
    : parseOptionalDate(input.leftAt, "Das Austrittsdatum");
  const leftAt = normalizedClubStatus === ClubMembershipStatus.RESIGNED
    ? requestedLeftAt || new Date()
    : null;
  assertMembershipDates(joinedAt, leftAt);
  const iban = input.iban === undefined ? existing.iban : normalizeIban(input.iban);
  const bic = input.bic === undefined ? existing.bic : normalizeBic(input.bic);

  if (!displayName) {
    throw new UserMutationError("MEMBER_DISPLAY_NAME_REQUIRED", "Bitte Vorname oder Nachname eingeben.");
  }
  if (!isValidEmail(email || "")) {
    throw new UserMutationError("MEMBER_EMAIL_INVALID", "Bitte eine gültige E-Mail-Adresse eingeben.");
  }

  const result = await prisma.$transaction(async (transaction) => {
    const person = await transaction.person.update({
      where: { id: existing.personId },
      data: {
        displayName,
        firstName,
        lastName,
        nickname,
        email,
        phone,
        birthDate,
      },
    });
    const member = await transaction.memberProfile.update({
      where: { id: memberId },
      data: {
        status: normalizedMemberStatus,
        membershipStatus: normalizedClubStatus,
        joinedAt,
        leftAt,
        iban,
        bic,
      },
    });

    return {
      memberId: member.id,
      personId: person.id,
      displayName: person.displayName,
    };
  });

  const response = {
    ok: true,
    updated: true,
    ...result,
  };
  await publishUsersNetworkRecords({ memberIds: [result.memberId] }, {
    accountId: currentUser?.accountId || currentUser?.id || null,
    loginName: currentUser?.loginName || null,
  }).catch((error) => {
    console.warn("[core.auth.users] Network data adapter could not publish the member update", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return response;
}

export async function getMemberDetailsById(
  memberIdValue: unknown,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = getPrismaClient();
  await assertCanManageUsers(prisma, currentUser, { allowKontorManager: true });

  const memberId = cleanText(memberIdValue, 160);
  if (!memberId) {
    throw new UserMutationError("MEMBER_ID_REQUIRED", "Die Mitglieds-ID fehlt.");
  }

  const member = await prisma.memberProfile.findUnique({
    where: { id: memberId },
    include: {
      person: {
        include: {
          accounts: {
            select: {
              id: true,
              loginName: true,
              email: true,
              isActive: true,
              type: true,
              createdAt: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  if (!member) {
    throw new UserMutationError("MEMBER_NOT_FOUND", "Das Mitglied wurde nicht gefunden.", 404);
  }

  return {
    ok: true,
    member: {
      id: member.id,
      memberId: member.id,
      memberNumber: member.memberNumber,
      personId: member.personId,
      displayName: member.person.displayName,
      firstName: member.person.firstName,
      lastName: member.person.lastName,
      nickname: member.person.nickname,
      email: member.person.email,
      phone: member.person.phone,
      birthDate: member.person.birthDate?.toISOString() || null,
      membershipStatus: member.leftAt || member.status === MemberStatus.FORMER_MEMBER
        ? ClubMembershipStatus.RESIGNED
        : member.membershipStatus,
      joinedAt: member.joinedAt?.toISOString() || null,
      leftAt: member.leftAt?.toISOString() || null,
      iban: member.iban,
      bic: member.bic,
      accounts: member.person.accounts.map((account) => ({
        accountId: account.id,
        id: account.id,
        loginName: account.loginName,
        email: account.email,
        isActive: account.isActive,
        type: account.type,
        createdAt: account.createdAt.toISOString(),
      })),
    },
  };
}

export async function updateLocalMemberProfile(
  accountIdValue: unknown,
  input: UpdateLocalMemberProfileInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = getPrismaClient();
  await assertCanManageUsers(prisma, currentUser);

  const accountId = cleanText(accountIdValue, 160);
  if (!accountId) {
    throw new UserMutationError("LOCAL_MEMBER_ACCOUNT_REQUIRED", "Der Benutzerzugang fehlt.");
  }

  const existing = await prisma.account.findUnique({
    where: { id: accountId },
    include: { person: true },
  });
  if (!existing) {
    throw new UserMutationError("LOCAL_MEMBER_NOT_FOUND", "Der Benutzer wurde nicht gefunden.", 404);
  }

  const loginName = cleanText(input.loginName, 80).toLowerCase() || existing.loginName;
  const displayName = cleanText(input.displayName, 160) || existing.person?.displayName || loginName;
  const updatesModuleAccess = Array.isArray(input.moduleAccess);
  const moduleAccess = updatesModuleAccess
    ? normalizeExplicitModuleAccess(input.moduleAccess)
    : [];
  const status = cleanText(input.status, 40).toLowerCase();
  const isActive = typeof input.isActive === "boolean"
    ? input.isActive
    : accountActiveStatus(status, existing.isActive);
  const usageLabels = asStringArray(input.usageLabels);

  if (!/^[a-z0-9][a-z0-9._-]*$/.test(loginName)) {
    throw new UserMutationError(
      "LOCAL_MEMBER_LOGIN_INVALID",
      "Der Loginname darf nur Kleinbuchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.",
    );
  }
  const accountType = updatesModuleAccess
    ? accountTypeFor({ usage: usageLabels.join(" ") }, moduleAccess)
    : existing.type;

  try {
    const result = await prisma.$transaction(async (transaction) => {
      if (updatesModuleAccess) {
        const managedRoles = await transaction.role.findMany({
          where: {
            OR: [
              { key: "admin" },
              { key: { startsWith: "access:" } },
            ],
          },
          select: { id: true },
        });

        await transaction.accountRole.deleteMany({
          where: {
            accountId,
            roleId: { in: managedRoles.map((role) => role.id) },
          },
        });
        await transaction.accountMemberCapability.deleteMany({ where: { accountId } });
      }

      const account = await transaction.account.update({
        where: { id: accountId },
        data: {
          loginName,
          isActive,
          type: accountType,
        },
      });

      if (existing.personId) {
        await transaction.person.update({
          where: { id: existing.personId },
          data: { displayName },
        });

        if (accountType === AccountType.MEMBER) {
          await transaction.memberProfile.upsert({
            where: { personId: existing.personId },
            update: {},
            create: {
              id: createMemberId(),
              personId: existing.personId,
              status: "MEMBER",
              joinedAt: new Date(),
            },
          });
        }
      }

      if (updatesModuleAccess) {
        await assignModuleAccess(transaction, accountId, moduleAccess);
      }
      if (existing.personId) {
        await provisionAccountArchive(transaction, {
          id: account.id,
          type: account.type,
          loginName: account.loginName,
          personId: existing.personId,
        });
      }

      return {
        accountId: account.id,
        loginName: account.loginName,
        displayName,
        isActive: account.isActive,
        type: account.type,
      };
    });

    const response = {
      ok: true,
      updated: true,
      account: result,
      moduleAccessChanged: updatesModuleAccess,
      moduleAccess,
    };
    await publishUsersNetworkRecords({ accountIds: [result.accountId] }, {
      accountId: currentUser?.accountId || currentUser?.id || null,
      loginName: currentUser?.loginName || null,
    }).catch((error) => {
      console.warn("[core.auth.users] Network data adapter could not publish the account update", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return response;
  } catch (error: any) {
    if (error?.code === "P2002") {
      throw new UserMutationError("LOCAL_MEMBER_ALREADY_EXISTS", "Dieser Loginname existiert bereits.", 409);
    }
    throw error;
  }
}
