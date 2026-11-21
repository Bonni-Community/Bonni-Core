import { assertAccountNotErasing } from "./erasure-write-barrier.js";
import { AccountType, AuthProviderType, ClubMembershipStatus, MemberStatus, Prisma, } from "@prisma/client";
import { getPrismaClient } from "../../../core/database/database.js";
import { hashPassword } from "../authentication/password-hash.helper.js";
import { validateExactLocalPassword } from "../../../core/modules/identity/local-password-policy.js";
import { advanceTwoFactorAfterPasswordChange } from "../../../core/modules/security/two-factor/password-change.js";
import { AccountSecurityTransitionError, technicalAccountSecurityCleanupRequired, transitionAccountSecurity, } from "../../../core/modules/security/two-factor/account-security-transition.js";
import { BOOTSTRAP_ADMIN_LOGIN_NAME, isBootstrapAdminLoginName, isForbiddenInteractiveLoginName, } from "../system-account-policy.js";
import { createAccountId, createMemberId } from "../../security/crypto/id.js";
import { provisionAccountArchive } from "../../../system/routes/explorer/archive-account.service.js";
import { publishUserAccountDeletion, publishUsersNetworkRecords, } from "./users-network-data-adapter.js";
import { listModuleManifests } from "../../module-manager/manifests/index.js";
const PERSONAL_ACCOUNT_TYPES = new Set([AccountType.MEMBER, AccountType.ADMIN]);
const TECHNICAL_ACCOUNT_TYPES = new Set([AccountType.TERMINAL, AccountType.SERVICE]);
export class UserMutationError extends Error {
    code;
    status;
    constructor(code, message, status = 400) {
        super(message);
        this.name = "UserMutationError";
        this.code = code;
        this.status = status;
    }
}
function cleanText(value, maxLength = 160) {
    return String(value || "").trim().slice(0, maxLength);
}
function slug(value, fallback = "access") {
    const normalized = cleanText(value, 120)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || fallback;
}
function unique(values) {
    return [...new Set(values.map((value) => cleanText(value, 120)).filter(Boolean))];
}
function normalizeKind(value) {
    const normalized = cleanText(value, 40).toLowerCase().replace(/_/g, "-");
    if (["control-center", "control center", "controlcenter", "control"].includes(normalized))
        return "control-center";
    if (normalized === "app")
        return "app";
    if (["add-on", "addon"].includes(normalized))
        return "add-on";
    if (["plug-in", "plugin"].includes(normalized))
        return "plug-in";
    return null;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return unique(value.map((item) => cleanText(item, 120)));
}
function normalizeExplicitModuleAccess(value) {
    const source = Array.isArray(value) ? value : [];
    return source.flatMap((entry) => {
        const kind = normalizeKind(entry?.kind);
        const moduleKey = cleanText(entry?.moduleKey, 120);
        const moduleName = cleanText(entry?.moduleName, 120) || moduleKey;
        const permissions = asStringArray(entry?.permissions);
        if (!kind || !moduleKey || !moduleName || !permissions.length)
            return [];
        return [{ kind, moduleKey, moduleName, permissions }];
    });
}
function normalizeModuleAccess(input) {
    // Only a concrete module key may grant an app. Legacy fields such as the
    // generic surface "App" are deliberately ignored because they cannot name
    // the selected installable module.
    return normalizeExplicitModuleAccess(input.moduleAccess);
}
function manifestKindForAccess(manifest) {
    if (manifest.kind === "addon")
        return "add-on";
    if (manifest.kind === "plugin")
        return "plug-in";
    return manifest.kind;
}
function profileMatchesPermission(profile, value) {
    const candidate = slug(value, "");
    const permissionParts = profile.permission.split(".");
    return Boolean(candidate) && [
        profile.key,
        profile.label,
        profile.permission,
        permissionParts[permissionParts.length - 1],
    ].some((entry) => slug(entry, "") === candidate);
}
async function resolveModuleAccessProfiles(access) {
    if (!access.some((assignment) => assignment.kind !== "control-center")) {
        return access;
    }
    const manifests = await listModuleManifests({ strict: true });
    return access.map((assignment) => {
        if (assignment.kind === "control-center")
            return assignment;
        const requestedKey = slug(assignment.moduleKey, "");
        const requestedName = slug(assignment.moduleName, "");
        const manifest = manifests.find((candidate) => (manifestKindForAccess(candidate) === assignment.kind
            && (slug(candidate.key, "") === requestedKey
                || slug(candidate.name, "") === requestedName)));
        if (!manifest) {
            throw new UserMutationError("MODULE_ACCESS_MANIFEST_NOT_FOUND", `Das Modul „${assignment.moduleName}“ ist nicht installiert.`, 409);
        }
        const declaredProfiles = manifest.metadata?.accessProfiles;
        if (!Array.isArray(declaredProfiles) || !declaredProfiles.length) {
            throw new UserMutationError("MODULE_ACCESS_PROFILES_MISSING", `Das Modul „${manifest.name}“ deklariert keine Zugriffsprofile.`, 409);
        }
        const profiles = assignment.permissions.map((permission) => {
            const profile = declaredProfiles.find((entry) => profileMatchesPermission(entry, permission));
            if (!profile) {
                throw new UserMutationError("MODULE_ACCESS_PROFILE_INVALID", `Die Funktion „${permission}“ ist für „${manifest.name}“ nicht deklariert.`);
            }
            return profile;
        });
        const uniqueProfiles = [...new Map(profiles.map((profile) => [profile.key, profile])).values()];
        return {
            ...assignment,
            moduleKey: manifest.key,
            moduleName: manifest.name,
            permissions: uniqueProfiles.map((profile) => profile.key),
            profiles: uniqueProfiles,
        };
    });
}
function isValidEmail(value) {
    return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function isTechnicalUsage(value) {
    return cleanText(value, 60).toLowerCase().includes("techn");
}
function accountTypeFor(input, access) {
    const hasControlCenterAdmin = access.some((assignment) => (assignment.kind === "control-center"
        && assignment.permissions.some((permission) => slug(permission) === "administrator")));
    const profiles = access.flatMap((assignment) => assignment.profiles || []);
    const profileUsages = new Set(profiles.map((profile) => profile.usage));
    const profileAccountTypes = new Set(profiles.map((profile) => profile.accountType));
    if (profileUsages.size > 1
        || profileAccountTypes.size > 1
        || (hasControlCenterAdmin && profileUsages.has("technical"))) {
        throw new UserMutationError("MODULE_ACCESS_PROFILE_CONFLICT", "Lokale Mitglieds- und technische Zugriffsprofile brauchen getrennte Benutzerzugänge.");
    }
    if (hasControlCenterAdmin)
        return AccountType.ADMIN;
    const declaredAccountType = profiles[0]?.accountType;
    if (declaredAccountType) {
        return AccountType[declaredAccountType];
    }
    const technical = isTechnicalUsage(input.usage)
        || access.some((assignment) => assignment.kind === "add-on" || assignment.kind === "plug-in");
    if (!technical)
        return AccountType.MEMBER;
    return access.some((assignment) => assignment.kind === "app")
        ? AccountType.TERMINAL
        : AccountType.SERVICE;
}
function accessRoleKey(assignment, permission) {
    return [
        "access",
        slug(assignment.kind),
        slug(assignment.moduleKey),
        slug(permission),
    ].join(":").slice(0, 180);
}
function accessPermissionKey(assignment, permission) {
    return [
        "module",
        slug(assignment.moduleKey),
        slug(permission),
    ].join(".").slice(0, 180);
}
function moduleKindLabel(kind) {
    if (kind === "control-center")
        return "Control Center";
    if (kind === "add-on")
        return "Add-on";
    if (kind === "plug-in")
        return "Plug-in";
    return "App";
}
export async function assertCanManageUsers(prisma, currentUser) {
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
    const permissionKeys = account?.roles.flatMap((entry) => (entry.role.permissions.map((rolePermission) => rolePermission.permission.key))) || [];
    const allowed = Boolean(account?.isActive) && Boolean(account && PERSONAL_ACCOUNT_TYPES.has(account.type)) && (roleKeys.includes("admin")
        || permissionKeys.some((permission) => ["*", "system.admin", "auth.users.write"].includes(permission)));
    if (!allowed) {
        throw new UserMutationError("USER_MANAGEMENT_FORBIDDEN", "Für die Benutzerverwaltung fehlt die Berechtigung.", 403);
    }
}
function shouldCreateAccount(value) {
    if (value === false || value === 0)
        return false;
    if (typeof value === "string" && ["false", "0", "nein", "no"].includes(value.trim().toLowerCase())) {
        return false;
    }
    return true;
}
function parseOptionalDate(value, fieldLabel) {
    const raw = cleanText(value, 40);
    if (!raw)
        return null;
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
    if (Number.isNaN(date.getTime())) {
        throw new UserMutationError("LOCAL_MEMBER_DATE_INVALID", `${fieldLabel} ist kein gültiges Datum.`);
    }
    return date;
}
function assertMembershipDates(joinedAt, leftAt) {
    if (joinedAt && leftAt && leftAt.getTime() < joinedAt.getTime()) {
        throw new UserMutationError("MEMBER_DATES_INVALID", "Das Austrittsdatum darf nicht vor dem Eintrittsdatum liegen.");
    }
}
const CLUB_MEMBERSHIP_STATUS_ALIASES = {
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
function clubMembershipStatus(value, fallback = ClubMembershipStatus.ACTIVE_MEMBER) {
    const raw = cleanText(value, 60);
    if (!raw)
        return fallback;
    return CLUB_MEMBERSHIP_STATUS_ALIASES[raw.toLowerCase()] || fallback;
}
function memberLifecycleStatus(value) {
    return value === ClubMembershipStatus.RESIGNED
        ? MemberStatus.FORMER_MEMBER
        : MemberStatus.MEMBER;
}
function accountActiveStatus(value, fallback) {
    const normalized = cleanText(value, 40).toLowerCase();
    if (["aktiv", "active", "aktiviert", "enabled"].includes(normalized))
        return true;
    if (["inaktiv", "inactive", "deaktiviert", "disabled"].includes(normalized))
        return false;
    // Fachliche Statuswerte anderer Apps dürfen den Kontostatus nicht verändern.
    return fallback;
}
async function assignModuleAccess(transaction, accountId, access) {
    for (const assignment of access) {
        for (const permissionValue of assignment.permissions) {
            const profile = assignment.profiles?.find((entry) => entry.key === permissionValue);
            const permissionKeyPart = profile?.key || permissionValue;
            const permissionLabel = profile?.label || permissionValue;
            const isAdministrator = assignment.kind === "control-center" && slug(permissionKeyPart) === "administrator";
            const roleKey = isAdministrator ? "admin" : accessRoleKey(assignment, permissionKeyPart);
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
                const permissionKey = profile?.permission || accessPermissionKey(assignment, permissionKeyPart);
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
        }
    }
}
export async function createLocalMember(input, currentUser) {
    const prisma = getPrismaClient();
    await assertCanManageUsers(prisma, currentUser);
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
    const passwordValidation = createAccount ? validateExactLocalPassword(input.password) : null;
    const password = passwordValidation?.ok ? passwordValidation.password : "";
    const moduleAccess = createAccount
        ? await resolveModuleAccessProfiles(normalizeModuleAccess(input))
        : [];
    const accountType = createAccount ? accountTypeFor(input, moduleAccess) : AccountType.MEMBER;
    if (createAccount && !loginName) {
        throw new UserMutationError("LOCAL_MEMBER_LOGIN_REQUIRED", "Bitte einen Loginnamen eingeben.");
    }
    if (createAccount && !/^[a-z0-9][a-z0-9._-]*$/.test(loginName)) {
        throw new UserMutationError("LOCAL_MEMBER_LOGIN_INVALID", "Der Loginname darf nur Kleinbuchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.");
    }
    if (createAccount && isForbiddenInteractiveLoginName(loginName)) {
        throw new UserMutationError("LOCAL_MEMBER_LOGIN_FORBIDDEN", "Der Benutzername root ist für Systemzwecke gesperrt.", 409);
    }
    if (!displayName) {
        throw new UserMutationError("LOCAL_MEMBER_DISPLAY_NAME_REQUIRED", "Bitte einen Anzeigenamen eingeben.");
    }
    if (!isValidEmail(email || "")) {
        throw new UserMutationError("LOCAL_MEMBER_EMAIL_INVALID", "Bitte eine gültige E-Mail-Adresse eingeben.");
    }
    if (createAccount && (!passwordValidation?.ok || passwordValidation.characters < 6)) {
        throw new UserMutationError("LOCAL_MEMBER_PASSWORD_TOO_SHORT", "Das Passwort muss mindestens 6 Zeichen haben.");
    }
    if (createAccount && !PERSONAL_ACCOUNT_TYPES.has(accountType)) {
        throw new UserMutationError("TECHNICAL_ACCESS_REQUIRES_MANAGED_ACCOUNT", "Technische Terminal- und Dienstkonten werden ausschließlich durch das zuständige Modul angelegt.", 409);
    }
    const existing = createAccount
        ? await prisma.account.findUnique({ where: { loginName } })
        : null;
    if (existing) {
        throw new UserMutationError("LOCAL_MEMBER_ALREADY_EXISTS", "Dieser Loginname existiert bereits.", 409);
    }
    const passwordHash = createAccount ? await hashPassword(password) : null;
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
    }
    catch (error) {
        if (error?.code === "P2002") {
            throw new UserMutationError("LOCAL_MEMBER_ALREADY_EXISTS", "Dieser Loginname existiert bereits.", 409);
        }
        throw error;
    }
}
export async function updateMemberById(memberIdValue, input, currentUser) {
    const prisma = getPrismaClient();
    await assertCanManageUsers(prisma, currentUser);
    const memberId = cleanText(memberIdValue, 160);
    await assertAccountNotErasing(memberId);
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
export async function getMemberDetailsById(memberIdValue, currentUser) {
    const prisma = getPrismaClient();
    await assertCanManageUsers(prisma, currentUser);
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
export async function updateLocalMemberProfile(accountIdValue, input, currentUser) {
    const prisma = getPrismaClient();
    await assertCanManageUsers(prisma, currentUser);
    const accountId = cleanText(accountIdValue, 160);
    await assertAccountNotErasing(accountId);
    if (!accountId) {
        throw new UserMutationError("LOCAL_MEMBER_ACCOUNT_REQUIRED", "Der Benutzerzugang fehlt.");
    }
    const existing = await prisma.account.findUnique({
        where: { id: accountId },
        include: {
            person: {
                include: { member: true },
            },
        },
    });
    if (!existing) {
        throw new UserMutationError("LOCAL_MEMBER_NOT_FOUND", "Der Benutzer wurde nicht gefunden.", 404);
    }
    const requestedLoginName = cleanText(input.loginName, 80).toLowerCase();
    const bootstrapAdmin = isBootstrapAdminLoginName(existing.loginName);
    if (bootstrapAdmin && requestedLoginName && requestedLoginName !== BOOTSTRAP_ADMIN_LOGIN_NAME) {
        throw new UserMutationError("BOOTSTRAP_ADMIN_LOGIN_IMMUTABLE", "Der feste Systembenutzer admin kann nicht umbenannt werden.", 409);
    }
    if (!bootstrapAdmin && isForbiddenInteractiveLoginName(requestedLoginName)) {
        throw new UserMutationError("LOCAL_MEMBER_LOGIN_FORBIDDEN", "Der Benutzername root ist für Systemzwecke gesperrt.", 409);
    }
    const loginName = bootstrapAdmin
        ? BOOTSTRAP_ADMIN_LOGIN_NAME
        : requestedLoginName || existing.loginName;
    const displayName = cleanText(input.displayName, 160) || existing.person?.displayName || loginName;
    const updatesModuleAccess = !bootstrapAdmin && Array.isArray(input.moduleAccess);
    const moduleAccess = updatesModuleAccess
        ? await resolveModuleAccessProfiles(normalizeExplicitModuleAccess(input.moduleAccess))
        : [];
    const status = cleanText(input.status, 40).toLowerCase();
    const requestedIsActive = typeof input.isActive === "boolean"
        ? input.isActive
        : accountActiveStatus(status, existing.isActive);
    if (bootstrapAdmin && !requestedIsActive) {
        throw new UserMutationError("BOOTSTRAP_ADMIN_DEACTIVATION_FORBIDDEN", "Der feste Systembenutzer admin muss aktiv bleiben.", 409);
    }
    const isActive = bootstrapAdmin ? true : requestedIsActive;
    const usageLabels = asStringArray(input.usageLabels);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(loginName)) {
        throw new UserMutationError("LOCAL_MEMBER_LOGIN_INVALID", "Der Loginname darf nur Kleinbuchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.");
    }
    const accountType = bootstrapAdmin
        ? AccountType.ADMIN
        : updatesModuleAccess
            ? accountTypeFor({ usage: usageLabels.join(" ") }, moduleAccess)
            : existing.type;
    if (updatesModuleAccess
        && PERSONAL_ACCOUNT_TYPES.has(existing.type) !== PERSONAL_ACCOUNT_TYPES.has(accountType)) {
        throw new UserMutationError("ACCOUNT_USAGE_IMMUTABLE", "Die Kontoart ist seit der Anlage festgelegt. Persönliche und technische Zugänge können nicht ineinander umgewandelt werden. Bitte einen getrennten Zugang verwenden.", 409);
    }
    if (updatesModuleAccess && accountType === AccountType.TERMINAL) {
        const terminalProfiles = new Set(moduleAccess.flatMap((assignment) => ((assignment.profiles || []).map((profile) => `${assignment.moduleKey}:${profile.key}`))));
        if (terminalProfiles.size !== 1) {
            throw new UserMutationError("TERMINAL_ACCOUNT_SINGLE_PROFILE_REQUIRED", "Ein Terminal-Zugang darf genau eine technische App-Oberfläche haben. Bitte nur eine Funktion auswählen.", 409);
        }
    }
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
            const eligibilityChanged = existing.isActive !== isActive || existing.type !== accountType;
            const technicalCleanupRequired = TECHNICAL_ACCOUNT_TYPES.has(accountType)
                && await technicalAccountSecurityCleanupRequired(transaction, accountId);
            const securityTransitionRequired = eligibilityChanged || technicalCleanupRequired
                || (updatesModuleAccess && existing.type === AccountType.TERMINAL);
            if (securityTransitionRequired) {
                await transitionAccountSecurity(transaction, {
                    accountId,
                    previousRevision: existing.credentialRevision,
                    previousType: existing.type,
                    previousIsActive: existing.isActive,
                    nextType: accountType,
                    nextIsActive: isActive,
                    twoFactorProviderId: existing.twoFactorProviderId,
                    force: !eligibilityChanged,
                    accountData: { loginName },
                });
            }
            const account = securityTransitionRequired
                ? await transaction.account.findUnique({ where: { id: accountId } })
                : await transaction.account.update({
                    where: { id: accountId },
                    data: { loginName },
                });
            if (!account) {
                throw new UserMutationError("LOCAL_MEMBER_NOT_FOUND", "Der Benutzer wurde nicht gefunden.", 404);
            }
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
    }
    catch (error) {
        if (error?.code === "P2002") {
            throw new UserMutationError("LOCAL_MEMBER_ALREADY_EXISTS", "Dieser Loginname existiert bereits.", 409);
        }
        if (error instanceof AccountSecurityTransitionError
            || error?.code === "TWO_FACTOR_CREDENTIAL_STATE_AMBIGUOUS") {
            throw new UserMutationError("LOCAL_MEMBER_SECURITY_STATE_CHANGED", "Der Sicherheitszustand des Zugangs wurde gleichzeitig geändert. Bitte erneut laden.", 409);
        }
        throw error;
    }
}
export async function updateLocalMemberAccess(accountIdValue, input, currentUser) {
    const prisma = getPrismaClient();
    await assertCanManageUsers(prisma, currentUser);
    const accountId = cleanText(accountIdValue, 160);
    await assertAccountNotErasing(accountId);
    if (!accountId) {
        throw new UserMutationError("LOCAL_MEMBER_ACCOUNT_REQUIRED", "Der Benutzerzugang fehlt.");
    }
    const existing = await prisma.account.findUnique({
        where: { id: accountId },
        include: { authProvider: true },
    });
    if (!existing) {
        throw new UserMutationError("LOCAL_MEMBER_NOT_FOUND", "Der Benutzer wurde nicht gefunden.", 404);
    }
    const updatesEmail = Object.prototype.hasOwnProperty.call(input, "email");
    const updatesPassword = Object.prototype.hasOwnProperty.call(input, "password");
    if (!updatesEmail && !updatesPassword) {
        throw new UserMutationError("LOCAL_MEMBER_ACCESS_UPDATE_EMPTY", "Es wurden keine Zugangsdaten zum Ändern übergeben.");
    }
    const email = updatesEmail ? cleanText(input.email, 200).toLowerCase() || null : existing.email;
    if (email && !isValidEmail(email)) {
        throw new UserMutationError("LOCAL_MEMBER_EMAIL_INVALID", "Bitte eine gültige E-Mail-Adresse eingeben.");
    }
    let passwordHash;
    if (updatesPassword) {
        if (existing.passwordRecoveryLockedAt) {
            throw new UserMutationError("PASSWORD_RECOVERY_LOCKED", "Das Passwort darf nur über den laufenden Wiederherstellungsvorgang gesetzt werden.", 423);
        }
        if (!PERSONAL_ACCOUNT_TYPES.has(existing.type) && existing.type !== AccountType.TERMINAL) {
            throw new UserMutationError("TECHNICAL_ACCOUNT_PASSWORD_FORBIDDEN", "Reine Dienstkonten dürfen kein interaktives Passwort besitzen.", 409);
        }
        if (existing.authProvider.type !== AuthProviderType.LOCAL) {
            throw new UserMutationError("LOCAL_MEMBER_PASSWORD_PROVIDER_INVALID", "Das Passwort dieses Zugangs wird vom externen Anmeldeanbieter verwaltet.", 409);
        }
        const passwordValidation = validateExactLocalPassword(input.password);
        if (!passwordValidation.ok || passwordValidation.characters < 6) {
            throw new UserMutationError("LOCAL_MEMBER_PASSWORD_TOO_SHORT", "Das Passwort muss mindestens 6 Zeichen haben.");
        }
        passwordHash = await hashPassword(passwordValidation.password);
    }
    const account = await prisma.$transaction(async (transaction) => {
        if (passwordHash && existing.type === AccountType.TERMINAL) {
            await transitionAccountSecurity(transaction, {
                accountId,
                previousRevision: existing.credentialRevision,
                previousType: existing.type,
                previousIsActive: existing.isActive,
                nextType: existing.type,
                nextIsActive: existing.isActive,
                force: true,
                terminalPasswordHash: passwordHash,
                accountData: updatesEmail ? { email } : {},
            });
        }
        else {
            const updated = await transaction.account.updateMany({
                where: {
                    id: accountId,
                    type: existing.type,
                    credentialRevision: existing.credentialRevision,
                    ...(passwordHash ? { passwordRecoveryLockedAt: null } : {}),
                },
                data: {
                    ...(updatesEmail ? { email } : {}),
                    ...(passwordHash ? {
                        passwordHash,
                        credentialRevision: { increment: 1 },
                    } : {}),
                },
            });
            if (updated.count !== 1) {
                throw new UserMutationError("LOCAL_MEMBER_ACCESS_CHANGED", "Die Zugangsdaten wurden gleichzeitig geändert. Bitte erneut laden.", 409);
            }
            if (passwordHash) {
                await advanceTwoFactorAfterPasswordChange(transaction, {
                    accountId,
                    previousRevision: existing.credentialRevision,
                    nextRevision: existing.credentialRevision + 1,
                    twoFactorProviderId: existing.twoFactorProviderId,
                });
                const now = new Date();
                await transaction.session.updateMany({
                    where: { accountId, endedAt: null },
                    data: { endedAt: now },
                });
                await transaction.refreshToken.updateMany({
                    where: { accountId, revokedAt: null },
                    data: { revokedAt: now },
                });
            }
        }
        return transaction.account.findUnique({
            where: { id: accountId },
            select: {
                id: true,
                loginName: true,
                email: true,
                type: true,
                isActive: true,
                personId: true,
            },
        });
    });
    if (!account)
        throw new UserMutationError("LOCAL_MEMBER_NOT_FOUND", "Der Benutzer wurde nicht gefunden.", 404);
    await publishUsersNetworkRecords({ accountIds: [account.id] }, {
        accountId: currentUser?.accountId || currentUser?.id || null,
        loginName: currentUser?.loginName || null,
    }).catch((error) => {
        console.warn("[core.auth.users] Network data adapter could not publish the access update", {
            error: error instanceof Error ? error.message : String(error),
        });
    });
    return {
        ok: true,
        updated: true,
        account: {
            ...account,
            accountId: account.id,
        },
    };
}
export async function deleteLocalMemberAccount(accountIdValue, currentUser) {
    const prisma = getPrismaClient();
    await assertCanManageUsers(prisma, currentUser);
    const accountId = cleanText(accountIdValue, 160);
    if (!accountId) {
        throw new UserMutationError("LOCAL_MEMBER_ACCOUNT_REQUIRED", "Der Benutzerzugang fehlt.");
    }
    const actorAccount = await prisma.account.findFirst({
        where: {
            OR: [
                ...(cleanText(currentUser?.accountId || currentUser?.id, 160)
                    ? [{ id: cleanText(currentUser?.accountId || currentUser?.id, 160) }]
                    : []),
                ...(cleanText(currentUser?.loginName, 160)
                    ? [{ loginName: cleanText(currentUser?.loginName, 160).toLowerCase() }]
                    : []),
            ],
        },
        select: { id: true },
    });
    if (actorAccount?.id === accountId) {
        throw new UserMutationError("LOCAL_MEMBER_SELF_DELETE_FORBIDDEN", "Der aktuell verwendete Benutzerzugang kann nicht selbst gelöscht werden.", 409);
    }
    const deleted = await prisma.$transaction(async (transaction) => {
        const existing = await transaction.account.findUnique({
            where: { id: accountId },
            include: {
                roles: {
                    include: { role: true },
                },
            },
        });
        if (!existing) {
            throw new UserMutationError("LOCAL_MEMBER_NOT_FOUND", "Der Benutzer wurde nicht gefunden.", 404);
        }
        if (isBootstrapAdminLoginName(existing.loginName)) {
            throw new UserMutationError("BOOTSTRAP_ADMIN_DELETE_FORBIDDEN", "Der feste Systembenutzer admin kann nicht gelöscht werden.", 409);
        }
        const isAdministrator = existing.roles.some(({ role }) => role.key === "admin");
        if (isAdministrator) {
            const remainingAdministrators = await transaction.account.count({
                where: {
                    id: { not: accountId },
                    isActive: true,
                    roles: { some: { role: { key: "admin" } } },
                },
            });
            if (remainingAdministrators < 1) {
                throw new UserMutationError("LOCAL_MEMBER_LAST_ADMIN_DELETE_FORBIDDEN", "Der letzte aktive Administrator kann nicht gelöscht werden.", 409);
            }
        }
        const protectedGrants = await transaction.archiveFolderGrant.count({
            where: { grantedByAccountId: accountId },
        });
        if (protectedGrants > 0) {
            throw new UserMutationError("LOCAL_MEMBER_DELETE_BLOCKED_BY_ARCHIVE_GRANTS", "Der Benutzer hat noch nachvollziehbare Archivfreigaben erteilt. Diese müssen zuerst übertragen oder widerrufen werden.", 409);
        }
        // All aliases of the legacy admin endpoint must respect the request workflow.
        // Preserve its previous bootstrap/last-admin/archive guards and technical-account handling.
        if (PERSONAL_ACCOUNT_TYPES.has(existing.type)) {
            throw new UserMutationError("PERSONAL_ACCOUNT_ERASURE_REQUEST_REQUIRED", "Für persönliche Benutzerkonten ist der systemweite Löschantrag mit gesonderter Freigabe erforderlich.", 409);
        }
        await transaction.accountRole.deleteMany({ where: { accountId } });
        await transaction.accountMemberCapability.deleteMany({ where: { accountId } });
        await transaction.session.deleteMany({ where: { accountId } });
        await transaction.refreshToken.deleteMany({ where: { accountId } });
        await transaction.externalIdentity.deleteMany({ where: { accountId } });
        await transaction.account.delete({ where: { id: accountId } });
        return {
            accountId: existing.id,
            loginName: existing.loginName,
            personId: existing.personId,
        };
    }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    await publishUserAccountDeletion(deleted.accountId, {
        accountId: actorAccount?.id || currentUser?.accountId || currentUser?.id || null,
        loginName: currentUser?.loginName || null,
    }).catch((error) => {
        console.warn("[core.auth.users] Network data adapter could not publish the account deletion", {
            error: error instanceof Error ? error.message : String(error),
        });
    });
    return {
        ok: true,
        deleted: true,
        ...deleted,
    };
}
