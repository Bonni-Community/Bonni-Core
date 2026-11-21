import { AccountType, AuthProviderType } from "@prisma/client";
import { technicalAccountSecurityCleanupRequired, transitionAccountSecurity, } from "../../../core/modules/security/two-factor/account-security-transition.js";
import { MODULE_TERMINAL_ACCOUNT_CONTRACT_VERSION, normalizeDeclaredModuleTerminalAccounts, normalizeTerminalAccountOwner, } from "./terminal-account-declaration.js";
export { MODULE_TERMINAL_ACCOUNT_CONTRACT_VERSION, describeTerminalAccountIdentity, isProtectedLegacyTerminalRole, normalizeDeclaredModuleTerminalAccounts, } from "./terminal-account-declaration.js";
class TerminalAccountConflict extends Error {
    code;
    accountId;
    constructor(code, accountId) {
        super(code);
        this.name = "TerminalAccountConflict";
        this.code = code;
        this.accountId = accountId || null;
    }
}
function cleanText(value, maxLength) {
    return String(value ?? "").trim().slice(0, maxLength);
}
function moduleLabel(value, fallback) {
    return cleanText(value, 160) || fallback;
}
function permissionLabel(ownerLabel, profileLabel) {
    return `${ownerLabel} · ${profileLabel}`.slice(0, 180);
}
function roleLabel(ownerLabel, profileLabel) {
    return `${ownerLabel} · ${profileLabel} (verwaltet)`.slice(0, 180);
}
function attachedRoleKeys(account) {
    return new Set((account?.roles || []).map((entry) => cleanText(entry?.role?.key, 180)));
}
function hasForeignModuleOwnership(roleKeys, canonicalRoleKey) {
    return [...roleKeys].some((roleKey) => (/^access:(app|addon|plugin|bridge):/.test(roleKey)
        && roleKey !== canonicalRoleKey));
}
async function ensureManagedAccess(transaction, ownerLabel, definition) {
    const permission = await transaction.permission.upsert({
        where: { key: definition.permissionKey },
        update: { label: permissionLabel(ownerLabel, definition.label) },
        create: {
            key: definition.permissionKey,
            label: permissionLabel(ownerLabel, definition.label),
        },
    });
    const role = await transaction.role.upsert({
        where: { key: definition.roleKey },
        update: { label: roleLabel(ownerLabel, definition.label) },
        create: {
            key: definition.roleKey,
            label: roleLabel(ownerLabel, definition.label),
        },
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
    return role;
}
async function reconcileOneDeclaredAccount(transaction, ownerLabel, definition) {
    const account = await transaction.account.findUnique({
        where: { loginName: definition.loginName },
        include: { roles: { include: { role: true } } },
    });
    if (account) {
        const roleKeys = attachedRoleKeys(account);
        if (![AccountType.MEMBER, AccountType.TERMINAL].includes(account.type)) {
            throw new TerminalAccountConflict("TERMINAL_ACCOUNT_TYPE_CONFLICT", account.id);
        }
        if (hasForeignModuleOwnership(roleKeys, definition.roleKey)) {
            throw new TerminalAccountConflict("TERMINAL_ACCOUNT_OWNERSHIP_CONFLICT", account.id);
        }
        const hasLegacyProof = definition.legacyRoleKeys.some((roleKey) => roleKeys.has(roleKey));
        const hasCanonicalProof = roleKeys.has(definition.roleKey);
        if (!hasLegacyProof && !hasCanonicalProof) {
            throw new TerminalAccountConflict("TERMINAL_ACCOUNT_LOGIN_CONFLICT", account.id);
        }
        const role = await ensureManagedAccess(transaction, ownerLabel, definition);
        const roleAdded = !hasCanonicalProof;
        await transaction.accountRole.upsert({
            where: {
                accountId_roleId: {
                    accountId: account.id,
                    roleId: role.id,
                },
            },
            update: {},
            create: {
                accountId: account.id,
                roleId: role.id,
            },
        });
        const typeChanged = account.type !== AccountType.TERMINAL;
        const securityCleanupRequired = await technicalAccountSecurityCleanupRequired(transaction, account.id);
        if (typeChanged || securityCleanupRequired) {
            // Conversion must not inherit personal credentials. An already managed
            // terminal keeps its centrally configured password and valid sessions.
            await transitionAccountSecurity(transaction, {
                accountId: account.id,
                previousRevision: account.credentialRevision,
                previousType: account.type,
                previousIsActive: account.isActive,
                nextType: AccountType.TERMINAL,
                nextIsActive: account.isActive,
                twoFactorProviderId: account.twoFactorProviderId,
                force: !typeChanged,
            });
        }
        return {
            accountId: account.id,
            loginName: account.loginName,
            profileKey: definition.profileKey,
            roleKey: definition.roleKey,
            permissionKey: definition.permissionKey,
            status: "reconciled",
            created: false,
            typeChanged,
            roleAdded,
        };
    }
    const localProvider = await transaction.authProvider.upsert({
        where: { key: "local" },
        update: {},
        create: {
            key: "local",
            type: AuthProviderType.LOCAL,
            name: "Local Login",
            active: true,
        },
    });
    if (localProvider.type !== AuthProviderType.LOCAL) {
        throw new Error("TERMINAL_ACCOUNT_LOCAL_PROVIDER_INVALID");
    }
    const role = await ensureManagedAccess(transaction, ownerLabel, definition);
    const created = await transaction.account.create({
        data: {
            type: AccountType.TERMINAL,
            loginName: definition.loginName,
            authProviderId: localProvider.id,
            passwordHash: null,
            email: null,
            externalSubject: null,
            personId: null,
            isActive: false,
            isSandbox: false,
        },
    });
    await transaction.accountRole.upsert({
        where: {
            accountId_roleId: {
                accountId: created.id,
                roleId: role.id,
            },
        },
        update: {},
        create: {
            accountId: created.id,
            roleId: role.id,
        },
    });
    return {
        accountId: created.id,
        loginName: created.loginName,
        profileKey: definition.profileKey,
        roleKey: definition.roleKey,
        permissionKey: definition.permissionKey,
        status: "created",
        created: true,
        typeChanged: false,
        roleAdded: true,
    };
}
function conflictResult(definition, error) {
    return {
        accountId: error.accountId,
        loginName: definition.loginName,
        profileKey: definition.profileKey,
        roleKey: definition.roleKey,
        permissionKey: definition.permissionKey,
        status: "conflict",
        created: false,
        typeChanged: false,
        roleAdded: false,
        conflictCode: error.code,
    };
}
function isUniqueLoginConflict(error) {
    return (Boolean(error)
        && typeof error === "object"
        && error.code === "P2002");
}
async function auditResult(prisma, ownerModule, result) {
    if (!prisma.auditLog?.create)
        return;
    const conflict = result.status === "conflict";
    await prisma.auditLog.create({
        data: {
            category: "SYSTEM",
            event: conflict
                ? "TERMINAL_ACCOUNT_RECONCILIATION_CONFLICT"
                : result.created
                    ? "TERMINAL_ACCOUNT_CREATED"
                    : "TERMINAL_ACCOUNT_RECONCILED",
            result: conflict ? "FAILURE" : "SUCCESS",
            ...(result.accountId ? { accountId: result.accountId } : {}),
            targetType: "TERMINAL_ACCOUNT",
            targetId: result.accountId || result.loginName,
            severity: conflict ? "WARNING" : "INFO",
            metadataJson: {
                ownerModule,
                profileKey: result.profileKey,
                loginName: result.loginName,
                roleKey: result.roleKey,
                permissionKey: result.permissionKey,
                status: result.status,
                created: result.created,
                typeChanged: result.typeChanged,
                roleAdded: result.roleAdded,
                conflictCode: result.conflictCode || null,
            },
        },
    }).catch(() => undefined);
}
async function reconcileNormalizedDeclarations(prisma, ownerModule, ownerLabel, declarations) {
    if (!prisma || typeof prisma.$transaction !== "function") {
        throw new Error("TERMINAL_ACCOUNT_DATABASE_REQUIRED");
    }
    const results = [];
    for (const definition of declarations) {
        let result;
        try {
            result = await prisma.$transaction((transaction) => (reconcileOneDeclaredAccount(transaction, ownerLabel, definition)));
        }
        catch (error) {
            if (error instanceof TerminalAccountConflict) {
                result = conflictResult(definition, error);
            }
            else if (isUniqueLoginConflict(error)) {
                // A concurrent create won the unique login race. Its transaction is
                // rolled back and the module receives a per-account conflict instead
                // of failing its complete runtime registration.
                result = conflictResult(definition, new TerminalAccountConflict("TERMINAL_ACCOUNT_LOGIN_CONFLICT"));
            }
            else {
                throw error;
            }
        }
        results.push(result);
        await auditResult(prisma, ownerModule, result);
    }
    return results;
}
/**
 * Core-side helper used by tests and by the manifest-bound runtime.
 */
export async function reconcileDeclaredModuleTerminalAccounts(prisma, ownerModuleValue, ownerLabelValue, declarationsValue) {
    const ownerModule = normalizeTerminalAccountOwner(ownerModuleValue);
    const declarations = normalizeDeclaredModuleTerminalAccounts(ownerModule, declarationsValue);
    return reconcileNormalizedDeclarations(prisma, ownerModule, moduleLabel(ownerLabelValue, ownerModule), declarations);
}
/**
 * Creates a capability permanently bound to the installed manifest.
 *
 * The feature module can only request reconciliation of the declarations
 * already validated by Core; it cannot submit login names or legacy roles at
 * runtime.
 */
export function createModuleTerminalAccountRuntime(ownerModuleValue, ownerLabelValue, declarationsValue) {
    const ownerModule = normalizeTerminalAccountOwner(ownerModuleValue);
    const ownerLabel = moduleLabel(ownerLabelValue, ownerModule);
    const declarations = normalizeDeclaredModuleTerminalAccounts(ownerModule, declarationsValue);
    return Object.freeze({
        contractVersion: MODULE_TERMINAL_ACCOUNT_CONTRACT_VERSION,
        reconcileDeclared: async () => {
            const { getPrismaClient } = await import("../../../core/database/database.js");
            return reconcileNormalizedDeclarations(getPrismaClient(), ownerModule, ownerLabel, declarations);
        },
    });
}
