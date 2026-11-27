import { createMemberDevicesRuntime } from './member-devices-runtime.js';
import {
  AccountType,
  AuthProviderType,
  ClubMembershipStatus,
  MemberStatus,
} from "@prisma/client";

import { getPrismaClient } from "../../../core/database/database.js";
import type {
  ModuleAccessProfile,
  ModuleLegacyAccessMappings,
  ModuleTechnicalAccountDeclaration,
} from "../../module-manager/types.js";
import { provisionAccountArchive } from "../../../system/routes/explorer/archive-account.service.js";
import { hashPassword } from "../authentication/password-hash.helper.js";
import { validateExactLocalPassword } from "../../../core/modules/identity/local-password-policy.js";
import { advanceTwoFactorAfterPasswordChange } from "../../../core/modules/security/two-factor/password-change.js";
import { createAccountId, createMemberId } from "../../security/crypto/id.js";
import { describeTerminalAccountIdentity } from "../terminal-accounts/index.js";
import { publishUsersNetworkRecords } from "../users/users-network-data-adapter.js";
import { getVerifiedRequestIdentity } from "../request-identity/request-identity-context.js";

export const MODULE_MEMBERS_CONTRACT_VERSION = "bonni.members/v1" as const;

const PERSONAL_ACCOUNT_TYPES = new Set<string>([
  AccountType.MEMBER,
  AccountType.ADMIN,
]);
const MEMBER_STATUSES = new Set<string>(Object.values(MemberStatus));
const MEMBERSHIP_STATUSES = new Set<string>(Object.values(ClubMembershipStatus));
const CREATE_FIELDS = new Set([
  "createAccount",
  "loginName",
  "preferredLoginName",
  "memberNumber",
  "displayName",
  "firstName",
  "lastName",
  "nickname",
  "email",
  "phone",
  "birthDate",
  "joinedAt",
  "leftAt",
  "status",
  "membershipStatus",
  "notes",
]);
const UPDATE_FIELDS = new Set([
  "memberNumber",
  "displayName",
  "firstName",
  "lastName",
  "nickname",
  "email",
  "phone",
  "birthDate",
  "joinedAt",
  "leftAt",
  "notes",
]);

type PrismaLike = {
  $transaction: <T>(callback: (transaction: any) => Promise<T>) => Promise<T>;
  memberProfile: any;
  memberPresenceLog: any;
  account: any;
};

type ModuleMembersRuntimeOptions = {
  inventoryProfilePermissions?: Record<string, string[]>;
  memberDevicesEnabled?: boolean;
  prisma?: PrismaLike;
  moduleLabel?: string;
  autoAssignDefaultProfile?: boolean;
  technicalAccounts?: ModuleTechnicalAccountDeclaration[];
  hashPassword?: (password: string) => Promise<string>;
  provisionArchive?: typeof provisionAccountArchive;
  publishRecords?: (filters: {
    accountIds?: Array<string | null | undefined>;
    memberIds?: Array<string | null | undefined>;
  }) => Promise<unknown>;
};

export type ModuleMemberListOptions = {
  status?: string;
  selectableForModule?: boolean;
  presenceLimit?: number;
};

export type ModuleMemberReadOptions = {
  presenceLimit?: number;
};

export class ModuleMembersRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode = 400) {
    super(code);
    this.name = "ModuleMembersRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code: string, statusCode = 400): never {
  throw new ModuleMembersRuntimeError(code, statusCode);
}

function cleanText(value: unknown, maximum: number) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") fail("CORE_MEMBERS_TEXT_INVALID");
  return value.trim().slice(0, maximum);
}

function optionalText(value: unknown, maximum: number) {
  const normalized = cleanText(value, maximum);
  return normalized || null;
}

function assertObject(
  value: unknown,
  allowedFields: Set<string>,
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !allowedFields.has(field))) {
    fail("CORE_MEMBERS_INPUT_FIELD_NOT_ALLOWED");
  }
  return record;
}

function parseDate(value: unknown, code: string, optional = true) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    fail(code);
  }
  if (!(typeof value === "string" || value instanceof Date)) fail(code);
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(code);
  return parsed;
}

function dateIso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEmail(value: unknown) {
  const email = optionalText(value, 200)?.toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("CORE_MEMBERS_EMAIL_INVALID");
  }
  return email;
}

function normalizeLogin(value: unknown) {
  const loginName = cleanText(value, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(loginName)) {
    fail("CORE_MEMBERS_LOGIN_INVALID");
  }
  return loginName;
}

function generatedLoginName(displayName: string, accountId: string) {
  const base = displayName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 56) || "member";
  return `${base}.${accountId.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase()}`;
}

function normalizeLimit(
  value: unknown,
  fallback: number,
  maximum: number,
  code: string,
) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail(code);
  }
  return Number(value);
}

function normalizeOwnerModule(value: string) {
  const moduleKey = String(value || "").trim().toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9._-]{1,154}[a-z0-9]$/.test(moduleKey)) {
    fail("CORE_MEMBERS_MODULE_KEY_INVALID");
  }
  return moduleKey;
}

function normalizeProfiles(value: unknown): readonly ModuleAccessProfile[] {
  if (!Array.isArray(value) || value.length < 1) {
    fail("CORE_MEMBERS_ACCESS_PROFILES_REQUIRED");
  }
  const profiles = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("CORE_MEMBERS_ACCESS_PROFILE_INVALID");
    }
    const profile = entry as ModuleAccessProfile;
    if (
      !/^[a-z][a-z0-9-]{0,79}$/.test(String(profile.key || ""))
      || typeof profile.label !== "string"
      || typeof profile.permission !== "string"
      || !["local", "technical"].includes(profile.usage)
      || !["MEMBER", "ADMIN", "TERMINAL", "SERVICE"].includes(profile.accountType)
    ) {
      fail("CORE_MEMBERS_ACCESS_PROFILE_INVALID");
    }
    return Object.freeze({ ...profile });
  });
  if (new Set(profiles.map((profile) => profile.key)).size !== profiles.length) {
    fail("CORE_MEMBERS_ACCESS_PROFILE_DUPLICATE");
  }
  return Object.freeze(profiles);
}

function normalizeLegacyKey(value: unknown) {
  const key = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,179}$/.test(key)) {
    fail("CORE_MEMBERS_LEGACY_ACCESS_KEY_INVALID");
  }
  return key;
}

export type NormalizedLegacyAccessMappings = Readonly<{
  roles: ReadonlyMap<string, string>;
  capabilities: ReadonlyMap<string, string>;
}>;

export function normalizeModuleLegacyAccessMappings(
  mappingsValue: ModuleLegacyAccessMappings | undefined,
  profilesValue: readonly ModuleAccessProfile[],
): NormalizedLegacyAccessMappings {
  const localProfileKeys = new Set(
    profilesValue
      .filter((profile) => profile.usage === "local" && PERSONAL_ACCOUNT_TYPES.has(profile.accountType))
      .map((profile) => profile.key),
  );

  const normalizeGroup = (value: unknown) => {
    if (value === undefined) return new Map<string, string>();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("CORE_MEMBERS_LEGACY_ACCESS_MAPPINGS_INVALID");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 200) fail("CORE_MEMBERS_LEGACY_ACCESS_MAPPINGS_INVALID");
    const normalized = new Map<string, string>();
    for (const [sourceKey, targetValue] of entries) {
      const source = normalizeLegacyKey(sourceKey);
      const target = String(targetValue || "").trim().toLowerCase();
      if (!localProfileKeys.has(target) || normalized.has(source)) {
        fail("CORE_MEMBERS_LEGACY_ACCESS_MAPPING_TARGET_INVALID");
      }
      normalized.set(source, target);
    }
    return normalized;
  };

  return Object.freeze({
    roles: normalizeGroup(mappingsValue?.roles),
    capabilities: normalizeGroup(mappingsValue?.capabilities),
  });
}

function canonicalRoleKey(moduleKey: string, profileKey: string) {
  return describeTerminalAccountIdentity(moduleKey, profileKey).roleKey;
}

function canonicalPermissionKey(moduleKey: string, profileKey: string) {
  return describeTerminalAccountIdentity(moduleKey, profileKey).permissionKey;
}

function personalAccounts(member: any) {
  return (member?.person?.accounts || []).filter((account: any) => (
    PERSONAL_ACCOUNT_TYPES.has(String(account?.type || ""))
    && account?.isSandbox !== true
  ));
}

function roleKeys(account: any): string[] {
  return (account?.roles || [])
    .map((entry: any) => String(entry?.role?.key || "").trim())
    .filter(Boolean);
}

function capabilityKeys(account: any): string[] {
  return (account?.accountMemberCapabilities || [])
    .map((entry: any) => String(entry?.capability?.key || "").trim())
    .filter(Boolean);
}

function memberReadInclude(presenceLimit: number) {
  return {
    person: {
      include: {
        accounts: {
          include: {
            roles: {
              include: {
                role: { select: { key: true } },
              },
            },
            accountMemberCapabilities: {
              include: {
                capability: { select: { key: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" as const },
        },
      },
    },
    presenceLog: presenceLimit > 0
      ? {
          orderBy: { createdAt: "desc" as const },
          take: presenceLimit,
        }
      : false,
  };
}

function normalizeTechnicalDeclarations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const source = entry as ModuleTechnicalAccountDeclaration;
    const loginName = String(source.loginName || "").trim().toLowerCase();
    const legacyRoleKeys = Array.isArray(source.legacyRoleKeys)
      ? source.legacyRoleKeys.map((roleKey) => String(roleKey).trim())
      : [];
    return loginName ? [{ loginName, legacyRoleKeys }] : [];
  });
}

function isDeclaredTechnicalAccount(
  account: any,
  technicalLogins: Set<string>,
  technicalRoleKeys: Set<string>,
  technicalLegacyRoleKeys: Set<string>,
) {
  if (["TERMINAL", "SERVICE"].includes(String(account?.type || ""))) return true;
  if (technicalLogins.has(String(account?.loginName || "").trim().toLowerCase())) return true;
  const roles = roleKeys(account);
  return roles.some((roleKey) => (
    technicalRoleKeys.has(roleKey)
    || technicalLegacyRoleKeys.has(roleKey)
  ));
}

function memberIsTechnicalOnly(
  member: any,
  technicalLogins: Set<string>,
  technicalRoleKeys: Set<string>,
  technicalLegacyRoleKeys: Set<string>,
) {
  const accounts = member?.person?.accounts || [];
  return (
    accounts.length > 0
    && accounts.every((account: any) => (
      isDeclaredTechnicalAccount(
        account,
        technicalLogins,
        technicalRoleKeys,
        technicalLegacyRoleKeys,
      )
    ))
  );
}

function safeMemberDto(
  member: any,
  moduleKey: string,
  profiles: readonly ModuleAccessProfile[],
  mappings: NormalizedLegacyAccessMappings,
  accountIsTechnical: (account: any) => boolean,
) {
  const declaredRoles = new Map(
    profiles
      .filter((profile) => (
        profile.usage === "local"
        && PERSONAL_ACCOUNT_TYPES.has(profile.accountType)
      ))
      .map((profile) => [canonicalRoleKey(moduleKey, profile.key), profile.key]),
  );
  const mappedCapabilities = new Set(mappings.capabilities.keys());
  const accounts = personalAccounts(member).filter((account: any) => (
    !accountIsTechnical(account)
  ));
  const passwordRecoveryLocked = accounts.some((account: any) => Boolean(account.passwordRecoveryLockedAt));

  return Object.freeze({
    id: member.id,
    memberId: member.id,
    personId: member.personId,
    memberNumber: member.memberNumber ?? null,
    status: member.status,
    membershipStatus: member.membershipStatus,
    joinedAt: dateIso(member.joinedAt),
    leftAt: dateIso(member.leftAt),
    notes: member.notes ?? null,
    createdAt: dateIso(member.createdAt),
    updatedAt: dateIso(member.updatedAt),
    passwordRecovery: Object.freeze({
      locked: passwordRecoveryLocked,
      state: passwordRecoveryLocked ? "PASSWORD_RECOVERY_LOCKED" : "READY",
      settlementOnly: passwordRecoveryLocked,
    }),
    person: Object.freeze({
      id: member.personId,
      displayName: member.person?.displayName ?? null,
      firstName: member.person?.firstName ?? null,
      lastName: member.person?.lastName ?? null,
      nickname: member.person?.nickname ?? null,
      email: member.person?.email ?? null,
      phone: member.person?.phone ?? null,
      birthDate: dateIso(member.person?.birthDate),
      createdAt: dateIso(member.person?.createdAt),
      updatedAt: dateIso(member.person?.updatedAt),
    }),
    accessAccounts: Object.freeze(accounts.map((account: any) => Object.freeze({
      accountId: account.id,
      loginName: account.loginName,
      type: account.type,
      isActive: Boolean(account.isActive),
      isSandbox: Boolean(account.isSandbox),
      securityState: account.passwordRecoveryLockedAt ? "PASSWORD_RECOVERY_LOCKED" : "READY",
      settlementOnly: Boolean(account.passwordRecoveryLockedAt),
      lastLoginAt: dateIso(account.lastLoginAt),
      accessProfiles: Object.freeze(roleKeys(account)
        .map((roleKey) => declaredRoles.get(roleKey))
        .filter((profileKey): profileKey is string => Boolean(profileKey))
        .sort()),
      memberCapabilities: Object.freeze(capabilityKeys(account)
        .filter((capabilityKey) => mappedCapabilities.has(capabilityKey.toUpperCase()))
        .sort()),
    }))),
    presence: Object.freeze((member.presenceLog || []).map((entry: any) => Object.freeze({
      id: entry.id,
      status: entry.status,
      source: entry.source ?? null,
      note: entry.note ?? null,
      createdAt: dateIso(entry.createdAt),
    }))),
  });
}

function normalizeLifecycleStatus(value: unknown) {
  const status = cleanText(value, 80).toUpperCase();
  if (MEMBER_STATUSES.has(status) || MEMBERSHIP_STATUSES.has(status)) return status;
  fail("CORE_MEMBERS_STATUS_INVALID");
}

function statusWhere(value: unknown) {
  const status = normalizeLifecycleStatus(value);
  return MEMBER_STATUSES.has(status)
    ? { status }
    : { membershipStatus: status };
}

function accountHasModuleAccess(
  account: any,
  moduleRoleKeys: ReadonlySet<string>,
) {
  return roleKeys(account).some((roleKey) => moduleRoleKeys.has(roleKey));
}

function assertMembershipDates(joinedAt: Date | null, leftAt: Date | null) {
  if (joinedAt && leftAt && leftAt.getTime() < joinedAt.getTime()) {
    fail("CORE_MEMBERS_DATES_INVALID");
  }
}

function defaultMemberProfile(profiles: readonly ModuleAccessProfile[]) {
  const profile = profiles.find((candidate) => (
    candidate.key === "member"
    && candidate.usage === "local"
    && candidate.accountType === "MEMBER"
  ));
  if (!profile) fail("CORE_MEMBERS_DEFAULT_PROFILE_MISSING", 409);
  return profile;
}

async function ensureProfileAccess(
  transaction: any,
  moduleKey: string,
  moduleLabel: string,
  profile: ModuleAccessProfile,
  inventoryGrants: readonly string[] = [],
) {
  const roleKey = canonicalRoleKey(moduleKey, profile.key);
  const permissionKey = canonicalPermissionKey(moduleKey, profile.key);
  const label = `${moduleLabel} · ${profile.label}`.slice(0, 180);
  const permission = await transaction.permission.upsert({
    where: { key: permissionKey },
    update: { label },
    create: { key: permissionKey, label },
  });
  const role = await transaction.role.upsert({
    where: { key: roleKey },
    update: { label },
    create: { key: roleKey, label },
  });
  await transaction.rolePermission.upsert({
    where: {
      roleId_permissionId: {
        roleId: role.id,
        permissionId: permission.id,
      },
    },
    update: {},
    create: {
      roleId: role.id,
      permissionId: permission.id,
    },
  });
  for (const key of inventoryGrants) {
    const grant = await transaction.permission.upsert({where:{key},create:{key,label:key},update:{}});
    await transaction.rolePermission.upsert({where:{roleId_permissionId:{roleId:role.id,permissionId:grant.id}},create:{roleId:role.id,permissionId:grant.id},update:{}});
  }
  return role;
}

function createData(inputValue: unknown) {
  const input = assertObject(inputValue, CREATE_FIELDS, "CORE_MEMBERS_CREATE_INPUT_INVALID");
  const requestedLoginName = input.preferredLoginName ?? input.loginName;
  if (input.createAccount !== undefined && typeof input.createAccount !== "boolean") {
    fail("CORE_MEMBERS_CREATE_ACCOUNT_INVALID");
  }
  const createAccount = input.createAccount !== false;
  const loginName = requestedLoginName === undefined || requestedLoginName === null || requestedLoginName === ""
    ? null
    : normalizeLogin(requestedLoginName);
  const firstName = optionalText(input.firstName, 100);
  const lastName = optionalText(input.lastName, 100);
  const nickname = optionalText(input.nickname, 100);
  const displayName = optionalText(input.displayName, 160)
    || [firstName, lastName].filter(Boolean).join(" ")
    || nickname
    || loginName;
  if (!displayName) fail("CORE_MEMBERS_DISPLAY_NAME_REQUIRED");
  const email = normalizeEmail(input.email);
  const joinedAt = input.joinedAt === undefined
    ? new Date()
    : parseDate(input.joinedAt, "CORE_MEMBERS_JOINED_AT_INVALID");
  const requestedStatus = input.status === undefined
    ? MemberStatus.MEMBER
    : normalizeLifecycleStatus(input.status);
  let requestedMembershipStatus = input.membershipStatus === undefined
    ? requestedStatus === MemberStatus.FORMER_MEMBER
      ? ClubMembershipStatus.RESIGNED
      : ClubMembershipStatus.ACTIVE_MEMBER
    : normalizeLifecycleStatus(input.membershipStatus);
  if (!MEMBER_STATUSES.has(requestedStatus) || !MEMBERSHIP_STATUSES.has(requestedMembershipStatus)) {
    fail("CORE_MEMBERS_STATUS_INVALID");
  }
  let normalizedStatus = requestedStatus;
  if (requestedMembershipStatus === ClubMembershipStatus.RESIGNED) {
    normalizedStatus = MemberStatus.FORMER_MEMBER;
  } else if (requestedStatus === MemberStatus.FORMER_MEMBER) {
    requestedMembershipStatus = ClubMembershipStatus.RESIGNED;
  }
  const requestedLeftAt = parseDate(input.leftAt, "CORE_MEMBERS_LEFT_AT_INVALID");
  const leftAt = normalizedStatus === MemberStatus.FORMER_MEMBER
    ? requestedLeftAt || new Date()
    : null;
  assertMembershipDates(joinedAt, leftAt);

  return {
    createAccount,
    loginName,
    person: {
      displayName,
      firstName,
      lastName,
      nickname,
      email,
      phone: optionalText(input.phone, 80),
      birthDate: parseDate(input.birthDate, "CORE_MEMBERS_BIRTH_DATE_INVALID"),
    },
    member: {
      memberNumber: optionalText(input.memberNumber, 80),
      status: normalizedStatus,
      membershipStatus: requestedMembershipStatus,
      joinedAt,
      leftAt,
      notes: optionalText(input.notes, 2_000),
    },
  };
}

function updateData(inputValue: unknown, existing: any) {
  const input = assertObject(inputValue, UPDATE_FIELDS, "CORE_MEMBERS_UPDATE_INPUT_INVALID");
  const firstName = input.firstName === undefined
    ? existing.person.firstName
    : optionalText(input.firstName, 100);
  const lastName = input.lastName === undefined
    ? existing.person.lastName
    : optionalText(input.lastName, 100);
  const nickname = input.nickname === undefined
    ? existing.person.nickname
    : optionalText(input.nickname, 100);
  const displayName = input.displayName === undefined
    ? existing.person.displayName
    : optionalText(input.displayName, 160)
      || [firstName, lastName].filter(Boolean).join(" ")
      || nickname;
  if (!displayName) fail("CORE_MEMBERS_DISPLAY_NAME_REQUIRED");
  const joinedAt = input.joinedAt === undefined
    ? existing.joinedAt
    : parseDate(input.joinedAt, "CORE_MEMBERS_JOINED_AT_INVALID");
  const leftAt = input.leftAt === undefined
    ? existing.leftAt
    : parseDate(input.leftAt, "CORE_MEMBERS_LEFT_AT_INVALID");
  assertMembershipDates(joinedAt, leftAt);

  return {
    person: {
      displayName,
      firstName,
      lastName,
      nickname,
      email: input.email === undefined ? existing.person.email : normalizeEmail(input.email),
      phone: input.phone === undefined ? existing.person.phone : optionalText(input.phone, 80),
      birthDate: input.birthDate === undefined
        ? existing.person.birthDate
        : parseDate(input.birthDate, "CORE_MEMBERS_BIRTH_DATE_INVALID"),
    },
    member: {
      memberNumber: input.memberNumber === undefined
        ? existing.memberNumber
        : optionalText(input.memberNumber, 80),
      joinedAt,
      leftAt,
      notes: input.notes === undefined ? existing.notes : optionalText(input.notes, 2_000),
    },
  };
}

function normalizeProfileKeys(
  values: unknown,
  profiles: readonly ModuleAccessProfile[],
) {
  if (!Array.isArray(values) || values.length > profiles.length) {
    fail("CORE_MEMBERS_PROFILE_KEYS_INVALID");
  }
  const normalized = values.map((value) => String(value || "").trim().toLowerCase());
  if (
    new Set(normalized).size !== normalized.length
    || normalized.some((key) => !/^[a-z][a-z0-9-]{0,79}$/.test(key))
  ) {
    fail("CORE_MEMBERS_PROFILE_KEYS_INVALID");
  }
  const allowed = new Map(
    profiles
      .filter((profile) => profile.usage === "local" && PERSONAL_ACCOUNT_TYPES.has(profile.accountType))
      .map((profile) => [profile.key, profile]),
  );
  return normalized.map((key) => {
    const profile = allowed.get(key);
    if (!profile) fail("CORE_MEMBERS_PROFILE_NOT_DECLARED", 403);
    return profile;
  });
}

function publicResult<T extends object>(result: T) {
  return Object.freeze({
    contractVersion: MODULE_MEMBERS_CONTRACT_VERSION,
    ...result,
  });
}

export function createModuleMembersRuntime(
  moduleKeyValue: string,
  profilesValue: unknown,
  legacyAccessMappingsValue?: ModuleLegacyAccessMappings,
  options: ModuleMembersRuntimeOptions = {},
) {
  const moduleKey = normalizeOwnerModule(moduleKeyValue);
  const profiles = normalizeProfiles(profilesValue);
  const mappings = normalizeModuleLegacyAccessMappings(
    legacyAccessMappingsValue,
    profiles,
  );
  const moduleLabel = cleanText(options.moduleLabel || moduleKey, 160) || moduleKey;
  const autoAssignDefaultProfile = options.autoAssignDefaultProfile !== false;
  const prisma: PrismaLike = options.prisma
    || getPrismaClient() as unknown as PrismaLike;
  const passwordHasher = options.hashPassword || hashPassword;
  const archiveProvisioner = options.provisionArchive || provisionAccountArchive;
  const publisher = options.publishRecords
    || ((filters) => {
      const identity = getVerifiedRequestIdentity();
      return publishUsersNetworkRecords(
        filters,
        identity
          ? {
              accountId: identity.accountId,
              loginName: identity.loginName,
            }
          : null,
      );
    });
  const technicalDeclarations = normalizeTechnicalDeclarations(options.technicalAccounts);
  const technicalLogins = new Set(technicalDeclarations.map((entry) => entry.loginName));
  const technicalLegacyRoleKeys = new Set(
    technicalDeclarations.flatMap((entry) => entry.legacyRoleKeys),
  );
  const technicalRoleKeys = new Set(
    profiles
      .filter((profile) => profile.usage === "technical")
      .map((profile) => canonicalRoleKey(moduleKey, profile.key)),
  );
  const moduleRoleKeys = new Set(
    profiles
      .filter((profile) => (
        profile.usage === "local"
        && PERSONAL_ACCOUNT_TYPES.has(profile.accountType)
      ))
      .map((profile) => canonicalRoleKey(moduleKey, profile.key)),
  );
  const accountIsTechnical = (account: any) => (
    isDeclaredTechnicalAccount(
      account,
      technicalLogins,
      technicalRoleKeys,
      technicalLegacyRoleKeys,
    )
  );

  async function readMember(memberIdValue: unknown, presenceLimitValue: unknown) {
    const memberId = cleanText(memberIdValue, 160);
    if (!memberId) fail("CORE_MEMBERS_MEMBER_ID_REQUIRED");
    const presenceLimit = normalizeLimit(
      presenceLimitValue,
      0,
      100,
      "CORE_MEMBERS_PRESENCE_LIMIT_INVALID",
    );
    const member = await prisma.memberProfile.findUnique({
      where: { id: memberId },
      include: memberReadInclude(presenceLimit),
    });
    if (
      !member
      || memberIsTechnicalOnly(
        member,
        technicalLogins,
        technicalRoleKeys,
        technicalLegacyRoleKeys,
      )
    ) {
      return null;
    }
    return member;
  }

  async function get(memberId: unknown, readOptions: ModuleMemberReadOptions = {}) {
    if (
      !readOptions
      || typeof readOptions !== "object"
      || Array.isArray(readOptions)
      || Object.keys(readOptions).some((field) => field !== "presenceLimit")
    ) {
      fail("CORE_MEMBERS_READ_OPTIONS_INVALID");
    }
    const member = await readMember(memberId, readOptions?.presenceLimit);
    return member
      ? safeMemberDto(member, moduleKey, profiles, mappings, accountIsTechnical)
      : null;
  }

  async function list(listOptions: ModuleMemberListOptions = {}) {
    if (!listOptions || typeof listOptions !== "object" || Array.isArray(listOptions)) {
      fail("CORE_MEMBERS_LIST_OPTIONS_INVALID");
    }
    if (
      Object.keys(listOptions).some((field) => (
        !["status", "selectableForModule", "presenceLimit"].includes(field)
      ))
      || (
        listOptions.selectableForModule !== undefined
        && typeof listOptions.selectableForModule !== "boolean"
      )
    ) {
      fail("CORE_MEMBERS_LIST_OPTIONS_INVALID");
    }
    const presenceLimit = normalizeLimit(
      listOptions.presenceLimit,
      0,
      100,
      "CORE_MEMBERS_PRESENCE_LIMIT_INVALID",
    );
    const rows = await prisma.memberProfile.findMany({
      where: listOptions.status === undefined ? undefined : statusWhere(listOptions.status),
      include: memberReadInclude(presenceLimit),
      orderBy: [
        { person: { displayName: "asc" } },
        { id: "asc" },
      ],
    });
    return Object.freeze(rows
      .filter((member: any) => !memberIsTechnicalOnly(
        member,
        technicalLogins,
        technicalRoleKeys,
        technicalLegacyRoleKeys,
      ))
      .filter((member: any) => (
        listOptions.selectableForModule !== true
        || personalAccounts(member).some((account: any) => (
          account.isActive === true
          && !accountIsTechnical(account)
          && accountHasModuleAccess(account, moduleRoleKeys)
        ))
      ))
      .map((member: any) => (
        safeMemberDto(member, moduleKey, profiles, mappings, accountIsTechnical)
      )));
  }

  async function getByAccountId(
    accountIdValue: unknown,
    readOptions: ModuleMemberReadOptions = {},
  ) {
    const accountId = cleanText(accountIdValue, 160);
    if (!accountId) fail("CORE_MEMBERS_ACCOUNT_ID_REQUIRED");
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        loginName: true,
        type: true,
        isSandbox: true,
        roles: {
          select: {
            role: { select: { key: true } },
          },
        },
        person: {
          select: {
            member: { select: { id: true } },
          },
        },
      },
    });
    if (
      !account
      || !PERSONAL_ACCOUNT_TYPES.has(String(account.type || ""))
      || account.isSandbox
      || accountIsTechnical(account)
      || !account.person?.member?.id
    ) {
      return null;
    }
    return get(account.person.member.id, readOptions);
  }

  async function create(input: unknown) {
    const normalized = createData(input);
    const defaultProfile = normalized.createAccount && autoAssignDefaultProfile
      ? defaultMemberProfile(profiles)
      : null;
    const accountId = normalized.createAccount ? createAccountId() : null;
    const loginName = normalized.createAccount
      ? normalized.loginName || generatedLoginName(normalized.person.displayName, accountId as string)
      : null;
    try {
      const created = await prisma.$transaction(async (transaction) => {
        const person = await transaction.person.create({ data: normalized.person });
        const member = await transaction.memberProfile.create({
          data: {
            id: createMemberId(),
            personId: person.id,
            ...normalized.member,
          },
        });
        if (!normalized.createAccount) {
          return { memberId: member.id, accountId: null };
        }
        const provider = await transaction.authProvider.upsert({
          where: { key: "local" },
          update: { active: true },
          create: {
            key: "local",
            type: AuthProviderType.LOCAL,
            name: "Local Login",
            active: true,
          },
        });
        if (provider.type !== AuthProviderType.LOCAL) {
          fail("CORE_MEMBERS_LOCAL_PROVIDER_INVALID", 409);
        }
        const account = await transaction.account.create({
          data: {
            id: accountId as string,
            type: AccountType.MEMBER,
            loginName: loginName as string,
            email: normalized.person.email,
            passwordHash: null,
            externalSubject: null,
            authProviderId: provider.id,
            personId: person.id,
            isActive: true,
            isSandbox: false,
          },
        });
        if (defaultProfile) {
          const role = await ensureProfileAccess(
            transaction,
            moduleKey,
            moduleLabel,
            defaultProfile,
            options.inventoryProfilePermissions?.[defaultProfile.key],
          );
          await transaction.accountRole.upsert({
            where: {
              accountId_roleId: {
                accountId: account.id,
                roleId: role.id,
              },
            },
            update: {},
            create: { accountId: account.id, roleId: role.id },
          });
        }
        await archiveProvisioner(transaction, {
          id: account.id,
          type: account.type,
          loginName: account.loginName,
          personId: person.id,
        });
        return { memberId: member.id, accountId: account.id };
      });
      await publisher({
        memberIds: [created.memberId],
        accountIds: [created.accountId],
      }).catch(() => undefined);
      return get(created.memberId);
    } catch (error: any) {
      if (error?.code === "P2002") {
        fail("CORE_MEMBERS_CONFLICT", 409);
      }
      throw error;
    }
  }

  async function update(memberIdValue: unknown, input: unknown) {
    const memberId = cleanText(memberIdValue, 160);
    if (!memberId) fail("CORE_MEMBERS_MEMBER_ID_REQUIRED");
    const existing = await prisma.memberProfile.findUnique({
      where: { id: memberId },
      include: { person: true },
    });
    if (!existing) fail("CORE_MEMBERS_MEMBER_NOT_FOUND", 404);
    const normalized = updateData(input, existing);
    await prisma.$transaction(async (transaction) => {
      await transaction.person.update({
        where: { id: existing.personId },
        data: normalized.person,
      });
      await transaction.memberProfile.update({
        where: { id: memberId },
        data: normalized.member,
      });
    });
    await publisher({ memberIds: [memberId] }).catch(() => undefined);
    return get(memberId);
  }

  async function setStatus(memberIdValue: unknown, statusValue: unknown) {
    const memberId = cleanText(memberIdValue, 160);
    if (!memberId) fail("CORE_MEMBERS_MEMBER_ID_REQUIRED");
    const status = normalizeLifecycleStatus(statusValue);
    const member = await prisma.memberProfile.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        status: true,
        membershipStatus: true,
        leftAt: true,
      },
    });
    if (!member) fail("CORE_MEMBERS_MEMBER_NOT_FOUND", 404);
    const data = status === MemberStatus.FORMER_MEMBER
      ? {
          status,
          membershipStatus: ClubMembershipStatus.RESIGNED,
          leftAt: member.leftAt || new Date(),
        }
      : status === MemberStatus.MEMBER
        ? {
            status,
            membershipStatus: member.membershipStatus === ClubMembershipStatus.RESIGNED
              ? ClubMembershipStatus.ACTIVE_MEMBER
              : member.membershipStatus,
            leftAt: null,
          }
        : MEMBER_STATUSES.has(status)
          ? { status }
      : {
          membershipStatus: status,
          status: status === ClubMembershipStatus.RESIGNED
            ? MemberStatus.FORMER_MEMBER
            : MemberStatus.MEMBER,
          leftAt: status === ClubMembershipStatus.RESIGNED
            ? member.leftAt || new Date()
            : null,
        };
    await prisma.memberProfile.update({
      where: { id: memberId },
      data,
    });
    await publisher({ memberIds: [memberId] }).catch(() => undefined);
    return get(memberId);
  }

  async function setAccessProfiles(memberIdValue: unknown, profileKeysValue: unknown) {
    const memberId = cleanText(memberIdValue, 160);
    if (!memberId) fail("CORE_MEMBERS_MEMBER_ID_REQUIRED");
    const explicitlyRequestedProfiles = normalizeProfileKeys(profileKeysValue, profiles);
    const requestedProfiles = [
      ...new Map([
        ...(autoAssignDefaultProfile ? [defaultMemberProfile(profiles)] : []),
        ...explicitlyRequestedProfiles,
      ].map((profile) => [profile.key, profile])).values(),
    ];
    const member = await prisma.memberProfile.findUnique({
      where: { id: memberId },
      include: {
        person: {
          include: {
            accounts: {
              include: {
                roles: { include: { role: true } },
              },
            },
          },
        },
      },
    });
    if (!member) fail("CORE_MEMBERS_MEMBER_NOT_FOUND", 404);
    const accounts = personalAccounts(member).filter((account: any) => (
      account.isActive === true
      && !isDeclaredTechnicalAccount(
        account,
        technicalLogins,
        technicalRoleKeys,
        technicalLegacyRoleKeys,
      )
    ));
    if (!accounts.length) fail("CORE_MEMBERS_ACTIVE_PERSONAL_ACCOUNT_REQUIRED", 409);

    await prisma.$transaction(async (transaction) => {
      const declaredRoleRows = await transaction.role.findMany({
        where: { key: { in: [...moduleRoleKeys] } },
        select: { id: true },
      });
      for (const account of accounts) {
        if (declaredRoleRows.length) {
          await transaction.accountRole.deleteMany({
            where: {
              accountId: account.id,
              roleId: { in: declaredRoleRows.map((role: any) => role.id) },
            },
          });
        }
        for (const profile of requestedProfiles) {
          const role = await ensureProfileAccess(
            transaction,
            moduleKey,
            moduleLabel,
            profile,
            options.inventoryProfilePermissions?.[profile.key],
          );
          await transaction.accountRole.upsert({
            where: {
              accountId_roleId: {
                accountId: account.id,
                roleId: role.id,
              },
            },
            update: {},
            create: { accountId: account.id, roleId: role.id },
          });
        }
      }
    });
    await publisher({
      memberIds: [memberId],
      accountIds: accounts.map((account: any) => account.id),
    }).catch(() => undefined);
    return get(memberId);
  }

  async function resetLocalPassword(memberIdValue: unknown, passwordValue: unknown) {
    const memberId = cleanText(memberIdValue, 160);
    if (!memberId) fail("CORE_MEMBERS_MEMBER_ID_REQUIRED");
    const passwordValidation = validateExactLocalPassword(passwordValue);
    if (!passwordValidation.ok || passwordValidation.characters < 12) {
      fail("CORE_MEMBERS_PASSWORD_INVALID");
    }
    const member = await prisma.memberProfile.findUnique({
      where: { id: memberId },
      include: {
        person: {
          include: {
            accounts: {
              include: {
                authProvider: true,
                roles: { include: { role: true } },
              },
            },
          },
        },
      },
    });
    if (!member) fail("CORE_MEMBERS_MEMBER_NOT_FOUND", 404);
    const accounts = personalAccounts(member).filter((account: any) => (
      account.isActive === true
      && account.authProvider?.type === AuthProviderType.LOCAL
      && account.authProvider?.active === true
      && !isDeclaredTechnicalAccount(
        account,
        technicalLogins,
        technicalRoleKeys,
        technicalLegacyRoleKeys,
      )
    ));
    if (accounts.length !== 1) {
      fail("CORE_MEMBERS_LOCAL_ACCOUNT_AMBIGUOUS", 409);
    }
    if (accounts[0].passwordRecoveryLockedAt) {
      fail("PASSWORD_RECOVERY_LOCKED", 423);
    }
    const passwordHash = await passwordHasher(passwordValidation.password);
    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.account.updateMany({
        where: {
          id: accounts[0].id,
          credentialRevision: accounts[0].credentialRevision,
          passwordRecoveryLockedAt: null,
        },
        data: {
          passwordHash,
          credentialRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) fail("CORE_MEMBERS_ACCOUNT_CHANGED", 409);
      await advanceTwoFactorAfterPasswordChange(transaction, {
        accountId: accounts[0].id,
        previousRevision: accounts[0].credentialRevision,
        nextRevision: accounts[0].credentialRevision + 1,
        twoFactorProviderId: accounts[0].twoFactorProviderId,
      });
      const now = new Date();
      await transaction.session.updateMany({
        where: { accountId: accounts[0].id, endedAt: null },
        data: { endedAt: now },
      });
      await transaction.refreshToken.updateMany({
        where: { accountId: accounts[0].id, revokedAt: null },
        data: { revokedAt: now },
      });
    });
    return Object.freeze({
      memberId,
      accountId: accounts[0].id,
      mode: "custom" as const,
      updated: true,
    });
  }

  async function history(
    memberIdValue: unknown,
    historyOptions: { limit?: number } = {},
  ) {
    if (
      !historyOptions
      || typeof historyOptions !== "object"
      || Array.isArray(historyOptions)
      || Object.keys(historyOptions).some((field) => field !== "limit")
    ) {
      fail("CORE_MEMBERS_HISTORY_OPTIONS_INVALID");
    }
    const memberId = cleanText(memberIdValue, 160);
    if (!memberId) fail("CORE_MEMBERS_MEMBER_ID_REQUIRED");
    const limit = normalizeLimit(
      historyOptions?.limit,
      50,
      200,
      "CORE_MEMBERS_HISTORY_LIMIT_INVALID",
    );
    const exists = await prisma.memberProfile.findUnique({
      where: { id: memberId },
      select: { id: true },
    });
    if (!exists) fail("CORE_MEMBERS_MEMBER_NOT_FOUND", 404);
    const logs = await prisma.memberPresenceLog.findMany({
      where: { memberId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        source: true,
        note: true,
        createdAt: true,
      },
    });
    return Object.freeze(logs.map((entry: any) => Object.freeze({
      id: entry.id,
      status: entry.status,
      source: entry.source ?? null,
      note: entry.note ?? null,
      createdAt: dateIso(entry.createdAt),
    })));
  }

  async function reconcileDeclaredAccess() {
    const defaultProfile = autoAssignDefaultProfile
      ? defaultMemberProfile(profiles)
      : null;
    const localProfiles = new Map(
      profiles
        .filter((profile) => profile.usage === "local" && PERSONAL_ACCOUNT_TYPES.has(profile.accountType))
        .map((profile) => [profile.key, profile]),
    );
    const accounts = await prisma.account.findMany({
      where: {
        type: { in: [AccountType.MEMBER, AccountType.ADMIN] },
        isSandbox: false,
        person: { member: { isNot: null } },
      },
      include: {
        person: { include: { member: true } },
        roles: { include: { role: true } },
        accountMemberCapabilities: {
          include: { capability: true },
        },
      },
    });
    const results: Array<{
      accountId: string;
      memberId: string;
      addedProfiles: string[];
    }> = [];

    await prisma.$transaction(async (transaction) => {
      if (!autoAssignDefaultProfile) {
        const retiredDefaultRole = await transaction.role.findUnique({
          where: { key: canonicalRoleKey(moduleKey, "member") },
          select: { id: true },
        });
        if (retiredDefaultRole) {
          await transaction.accountRole.deleteMany({
            where: { roleId: retiredDefaultRole.id },
          });
        }
      }
      for (const account of accounts) {
        if (
          !account.isActive
          || !account.person?.member
          || account.person.member.status !== MemberStatus.MEMBER
          || account.person.member.membershipStatus === ClubMembershipStatus.RESIGNED
          || Boolean(account.person.member.leftAt)
          || isDeclaredTechnicalAccount(
            account,
            technicalLogins,
            technicalRoleKeys,
            technicalLegacyRoleKeys,
          )
        ) {
          continue;
        }
        const wanted = new Set<string>(defaultProfile ? [defaultProfile.key] : []);
        for (const roleKey of roleKeys(account)) {
          const target = mappings.roles.get(roleKey.toUpperCase());
          if (target) wanted.add(target);
        }
        for (const capabilityKey of capabilityKeys(account)) {
          const target = mappings.capabilities.get(capabilityKey.toUpperCase());
          if (target) wanted.add(target);
        }
        const attachedRoles = new Set(roleKeys(account));
        const addedProfiles: string[] = [];
        for (const profileKey of wanted) {
          const profile = localProfiles.get(profileKey);
          if (!profile) continue;
          const canonicalKey = canonicalRoleKey(moduleKey, profile.key);
          const role = await ensureProfileAccess(
            transaction,
            moduleKey,
            moduleLabel,
            profile,
            options.inventoryProfilePermissions?.[profile.key],
          );
          await transaction.accountRole.upsert({
            where: {
              accountId_roleId: {
                accountId: account.id,
                roleId: role.id,
              },
            },
            update: {},
            create: { accountId: account.id, roleId: role.id },
          });
          if (!attachedRoles.has(canonicalKey)) addedProfiles.push(profile.key);
        }
        results.push({
          accountId: account.id,
          memberId: account.person.member.id,
          addedProfiles,
        });
      }
    });
    await publisher({
      accountIds: results.map((result) => result.accountId),
      memberIds: results.map((result) => result.memberId),
    }).catch(() => undefined);
    return Object.freeze({
      examined: accounts.length,
      reconciled: results.length,
      results: Object.freeze(results.map((result) => Object.freeze({
        ...result,
        addedProfiles: Object.freeze([...result.addedProfiles]),
      }))),
    });
  }

  async function exportLegacyFinancialProfiles() {
    const rows = await prisma.memberProfile.findMany({
      select: {
        id: true,
        allowNegativeBalance: true,
        account: {
          select: {
            id: true,
            balanceCached: true,
            lastSettledAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { id: "asc" },
    });
    return Object.freeze(rows.map((row: any) => Object.freeze({
      memberId: row.id,
      allowNegativeBalance: Boolean(row.allowNegativeBalance),
      memberAccount: row.account
        ? Object.freeze({
            id: row.account.id,
            balanceCached: String(row.account.balanceCached),
            lastSettledAt: row.account.lastSettledAt ?? null,
            createdAt: row.account.createdAt,
            updatedAt: row.account.updatedAt,
          })
        : null,
    })));
  }

  return publicResult({
    moduleKey,
    ...(options.memberDevicesEnabled ? { devices: createMemberDevicesRuntime({ prisma, moduleKey, resolveAccounts: async memberId => {
      const member: any = await get(memberId);
      return (member?.accessAccounts || []).filter((account: any) => ["MEMBER", "ADMIN"].includes(account.type) && !account.isSandbox && account.accessProfiles?.length).map((account: any) => ({ accountId: account.accountId, loginName: account.loginName }));
    } }) } : {}),
    list,
    get,
    getByAccountId,
    create,
    update,
    setStatus,
    setAccessProfiles,
    resetLocalPassword,
    history,
    reconcileDeclaredAccess,
    exportLegacyFinancialProfiles,
  });
}
