import { advanceTwoFactorAfterPasswordChange, TwoFactorPasswordChangeError, } from "./password-change.js";
const INTERACTIVE_ACCOUNT_TYPES = new Set(["MEMBER", "ADMIN"]);
const TECHNICAL_ACCOUNT_TYPES = new Set(["TERMINAL", "SERVICE"]);
const FORBIDDEN_ACCOUNT_PATCH_KEYS = new Set([
    "id",
    "type",
    "isActive",
    "passwordHash",
    "credentialRevision",
    "twoFactorProviderId",
    "twoFactorEnrolledAt",
    "privateDataTwoFactorEnrolledAt",
    "passwordRecoveryLockedAt",
    "passwordRecoveryRequestId",
]);
const TECHNICAL_SECURITY_STATE_SELECT = Object.freeze({
    type: true,
    passwordHash: true,
    twoFactorProviderId: true,
    twoFactorEnrolledAt: true,
    privateDataTwoFactorEnrolledAt: true,
    passwordRecoveryLockedAt: true,
    passwordRecoveryRequestId: true,
    twoFactorCredentials: {
        select: {
            status: true,
            secretEncrypted: true,
            secretFingerprint: true,
            enrollmentSlot: true,
            externalCredentialId: true,
        },
    },
    twoFactorRecoveryCodes: { select: { id: true } },
    twoFactorEnrollment: {
        select: {
            status: true,
            enrollmentPasswordHash: true,
        },
    },
    sessions: {
        where: { endedAt: null },
        select: { endedAt: true },
    },
    refreshTokens: {
        where: { revokedAt: null },
        select: { revokedAt: true },
    },
    passwordRecoveryRequests: {
        where: { status: { in: ["PENDING", "LOCKED", "APPROVED"] } },
        select: { status: true, browserTokenHash: true, supportCodeHash: true },
    },
});
export class AccountSecurityTransitionError extends Error {
    code = "ACCOUNT_SECURITY_TRANSITION_CONFLICT";
    statusCode = 409;
    constructor(message = "Der Sicherheitszustand des Kontos wurde gleichzeitig geändert. Bitte erneut laden.") {
        super(message);
        this.name = "AccountSecurityTransitionError";
    }
}
/**
 * Detects forbidden security residue. Terminals may keep their own password
 * and browser sessions; services may not. Neither inherits personal 2FA.
 * Callers select only the listed fields; no secret is
 * exposed outside the owning Core Security transition.
 */
export function accountHasTechnicalSecurityMaterial(account) {
    if (!account)
        return false;
    const terminal = account.type === "TERMINAL";
    if (!terminal && account.passwordHash !== null && account.passwordHash !== undefined
        || account.twoFactorProviderId !== null && account.twoFactorProviderId !== undefined
        || account.twoFactorEnrolledAt !== null && account.twoFactorEnrolledAt !== undefined
        || account.privateDataTwoFactorEnrolledAt !== null && account.privateDataTwoFactorEnrolledAt !== undefined
        || account.passwordRecoveryLockedAt !== null && account.passwordRecoveryLockedAt !== undefined
        || account.passwordRecoveryRequestId !== null && account.passwordRecoveryRequestId !== undefined)
        return true;
    if ((account.twoFactorCredentials || []).some((credential) => (credential.status !== "REVOKED"
        || credential.secretEncrypted !== null && credential.secretEncrypted !== undefined
        || credential.secretFingerprint !== null && credential.secretFingerprint !== undefined
        || credential.enrollmentSlot !== null && credential.enrollmentSlot !== undefined
        || credential.externalCredentialId !== null && credential.externalCredentialId !== undefined)))
        return true;
    if ((account.twoFactorRecoveryCodes || []).length > 0)
        return true;
    if (account.twoFactorEnrollment
        && (["PENDING", "CLAIMED"].includes(String(account.twoFactorEnrollment.status || ""))
            || account.twoFactorEnrollment.enrollmentPasswordHash !== null
                && account.twoFactorEnrollment.enrollmentPasswordHash !== undefined))
        return true;
    if (!terminal && (account.sessions || []).some((session) => !session.endedAt))
        return true;
    if (!terminal && (account.refreshTokens || []).some((token) => !token.revokedAt))
        return true;
    if ((account.passwordRecoveryRequests || []).length > 0)
        return true;
    return false;
}
/** Keeps ciphertext/verifier inspection inside Core Security and exposes only a decision. */
export async function technicalAccountSecurityCleanupRequired(transaction, accountId) {
    const account = await transaction.account.findUnique({
        where: { id: accountId },
        select: TECHNICAL_SECURITY_STATE_SELECT,
    });
    if (!account)
        throw new AccountSecurityTransitionError();
    return accountHasTechnicalSecurityMaterial(account);
}
function validateInput(input) {
    if (typeof input.accountId !== "string"
        || !input.accountId
        || !Number.isInteger(input.previousRevision)
        || input.previousRevision < 0
        || ![...INTERACTIVE_ACCOUNT_TYPES, ...TECHNICAL_ACCOUNT_TYPES].includes(input.previousType)
        || ![...INTERACTIVE_ACCOUNT_TYPES, ...TECHNICAL_ACCOUNT_TYPES].includes(input.nextType)
        || typeof input.previousIsActive !== "boolean"
        || typeof input.nextIsActive !== "boolean"
        || (!input.force
            && input.previousType === input.nextType
            && input.previousIsActive === input.nextIsActive))
        throw new AccountSecurityTransitionError();
    if (input.terminalPasswordHash !== undefined && (input.previousType !== "TERMINAL"
        || input.nextType !== "TERMINAL"
        || !input.force
        || typeof input.terminalPasswordHash !== "string"
        || !input.terminalPasswordHash))
        throw new AccountSecurityTransitionError();
    for (const key of Object.keys(input.accountData || {})) {
        if (FORBIDDEN_ACCOUNT_PATCH_KEYS.has(key))
            throw new AccountSecurityTransitionError();
    }
}
async function revokeSessions(transaction, accountId, now) {
    await transaction.session.updateMany({
        where: { accountId, endedAt: null },
        data: { endedAt: now },
    });
    await transaction.refreshToken.updateMany({
        where: { accountId, revokedAt: null },
        data: { revokedAt: now },
    });
}
async function cancelAccountRecovery(transaction, accountId, now) {
    await transaction.securityAccountRecoveryRequest.updateMany({
        where: { accountId, status: { in: ["PENDING", "LOCKED", "APPROVED"] } },
        data: {
            status: "CANCELLED",
            activeSlot: null,
            browserTokenHash: null,
            browserTokenExpiresAt: null,
            supportCodeHash: null,
            supportCodeExpiresAt: null,
            cancelledAt: now,
            requestRevision: { increment: 1 },
        },
    });
}
async function shredTwoFactorMaterial(transaction, accountId, now, { deleteLockouts = false } = {}) {
    await transaction.securityTwoFactorCredential.updateMany({
        where: { accountId },
        data: {
            status: "REVOKED",
            secretEncrypted: null,
            secretFingerprint: null,
            externalCredentialId: null,
            enrollmentSlot: null,
            disabledAt: now,
        },
    });
    await transaction.securityTwoFactorRecoveryCode.deleteMany({ where: { accountId } });
    await transaction.securityTwoFactorEnrollment.updateMany({
        where: {
            accountId,
            status: { in: ["PENDING", "CLAIMED"] },
        },
        data: {
            status: "REVOKED",
            enrollmentPasswordHash: null,
            revokedAt: now,
        },
    });
    // Defensive shredding for a legacy FAILED/EXPIRED row whose verifier was
    // written by a pre-Core implementation.
    await transaction.securityTwoFactorEnrollment.updateMany({
        where: { accountId, enrollmentPasswordHash: { not: null } },
        data: { enrollmentPasswordHash: null, revokedAt: now },
    });
    await transaction.securityTwoFactorChallenge.updateMany({
        where: {
            accountId,
            status: { in: ["PENDING", "VERIFIED"] },
        },
        data: { status: "CANCELLED" },
    });
    if (deleteLockouts) {
        await transaction.securityTwoFactorLockout.deleteMany({ where: { accountId } });
    }
}
/**
 * Performs an account eligibility change and all coupled credential writes in
 * the caller's database transaction. The account row is a revision/type/state
 * CAS, so a concurrent deactivate, role conversion, password rotation or TOTP
 * confirmation rolls the complete transition back instead of splitting state.
 *
 * Personal account deactivation intentionally preserves an active TOTP and
 * advances it to the new revision. An unchanged TERMINAL keeps its own password
 * (or receives an admin-rotated hash). Conversions involving technical accounts
 * never inherit passwords. All technical 2FA material is shredded.
 */
export async function transitionAccountSecurity(transaction, input) {
    validateInput(input);
    const nextRevision = input.previousRevision + 1;
    const technicalTarget = TECHNICAL_ACCOUNT_TYPES.has(input.nextType);
    const technicalSource = TECHNICAL_ACCOUNT_TYPES.has(input.previousType);
    const resetTechnicalCredentials = technicalTarget || technicalSource;
    const sameTerminal = input.previousType === "TERMINAL" && input.nextType === "TERMINAL";
    const accountUpdate = await transaction.account.updateMany({
        where: {
            id: input.accountId,
            credentialRevision: input.previousRevision,
            type: input.previousType,
            isActive: input.previousIsActive,
        },
        data: {
            ...(input.accountData || {}),
            type: input.nextType,
            isActive: input.nextIsActive,
            credentialRevision: { increment: 1 },
            passwordRecoveryRequestId: null,
            ...(resetTechnicalCredentials ? {
                ...(!sameTerminal ? { passwordHash: null } : input.terminalPasswordHash !== undefined
                    ? { passwordHash: input.terminalPasswordHash } : {}),
                passwordRecoveryLockedAt: null,
                twoFactorProviderId: null,
                twoFactorEnrolledAt: null,
                privateDataTwoFactorEnrolledAt: null,
            } : {}),
        },
    });
    if (accountUpdate.count !== 1)
        throw new AccountSecurityTransitionError();
    const now = new Date();
    await cancelAccountRecovery(transaction, input.accountId, now);
    if (resetTechnicalCredentials) {
        await shredTwoFactorMaterial(transaction, input.accountId, now, { deleteLockouts: true });
    }
    else {
        try {
            await advanceTwoFactorAfterPasswordChange(transaction, {
                accountId: input.accountId,
                previousRevision: input.previousRevision,
                nextRevision,
                twoFactorProviderId: input.twoFactorProviderId,
            });
        }
        catch (error) {
            // An administrator must always be able to deactivate a compromised or
            // already-corrupt account. In that one direction, ambiguity causes a
            // complete 2FA revoke (with the private-data sticky marker retained),
            // never a rollback which would leave the account active.
            if (!(error instanceof TwoFactorPasswordChangeError) || input.nextIsActive)
                throw error;
            await shredTwoFactorMaterial(transaction, input.accountId, now);
            const bindingCleared = await transaction.account.updateMany({
                where: {
                    id: input.accountId,
                    credentialRevision: nextRevision,
                    type: input.nextType,
                    isActive: false,
                },
                data: {
                    twoFactorProviderId: null,
                    twoFactorEnrolledAt: null,
                },
            });
            if (bindingCleared.count !== 1)
                throw new AccountSecurityTransitionError();
        }
    }
    await revokeSessions(transaction, input.accountId, now);
    return Object.freeze({
        accountId: input.accountId,
        previousRevision: input.previousRevision,
        credentialRevision: nextRevision,
        technicalTarget,
        sessionsRevoked: true,
    });
}
