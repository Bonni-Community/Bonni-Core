import { cancelPendingRecoveryAfterCredentialChange } from "../account-recovery/credential-transition.js";
const LOCAL_PROVIDER_ID = "local";
export class TwoFactorPasswordChangeError extends Error {
    code = "TWO_FACTOR_CREDENTIAL_STATE_AMBIGUOUS";
    statusCode = 409;
    constructor() {
        super("Die Zwei-Faktor-Anmeldedaten wurden gleichzeitig geändert. Bitte erneut laden.");
        this.name = "TwoFactorPasswordChangeError";
    }
}
/**
 * Keeps an enrolled local TOTP credential usable when an account password
 * advances the shared credential revision. The caller must invoke this in the
 * same database transaction as the Account CAS update.
 *
 * Pending setup material is never carried across a password change. It is
 * shredded instead, while old challenges are explicitly cancelled.
 */
export async function advanceTwoFactorAfterPasswordChange(transaction, input) {
    if (!Number.isInteger(input.previousRevision)
        || !Number.isInteger(input.nextRevision)
        || input.previousRevision < 0
        || input.nextRevision !== input.previousRevision + 1) {
        throw new TwoFactorPasswordChangeError();
    }
    const now = new Date();
    const activeCredentials = await transaction.securityTwoFactorCredential.findMany({
        where: {
            accountId: input.accountId,
            method: "TOTP",
            status: "ACTIVE",
        },
        select: {
            id: true,
            credentialRevision: true,
            enrollmentSlot: true,
        },
        orderBy: { createdAt: "asc" },
        take: 2,
    });
    if (activeCredentials.length > 1)
        throw new TwoFactorPasswordChangeError();
    const boundProvider = String(input.twoFactorProviderId || "").trim().toLowerCase();
    const mustPreserveLocal = boundProvider === LOCAL_PROVIDER_ID;
    const mayAdoptUnboundLocal = !boundProvider && activeCredentials.length === 1;
    const preserveLocal = mustPreserveLocal || mayAdoptUnboundLocal;
    const active = activeCredentials[0] || null;
    if (mustPreserveLocal && !active)
        throw new TwoFactorPasswordChangeError();
    if (preserveLocal && active) {
        const compatibleRevision = active.credentialRevision === input.previousRevision
            || active.credentialRevision === -1;
        const compatibleSlot = active.enrollmentSlot === input.accountId
            || active.enrollmentSlot === null;
        if (!compatibleRevision || !compatibleSlot)
            throw new TwoFactorPasswordChangeError();
        const advanced = await transaction.securityTwoFactorCredential.updateMany({
            where: {
                id: active.id,
                accountId: input.accountId,
                method: "TOTP",
                status: "ACTIVE",
                credentialRevision: active.credentialRevision,
                enrollmentSlot: active.enrollmentSlot,
            },
            data: {
                credentialRevision: input.nextRevision,
                enrollmentSlot: input.accountId,
            },
        });
        if (advanced.count !== 1)
            throw new TwoFactorPasswordChangeError();
        await transaction.securityTwoFactorRecoveryCode.updateMany({
            where: {
                accountId: input.accountId,
                usedAt: null,
                credentialRevision: { in: [input.previousRevision, -1] },
            },
            data: { credentialRevision: input.nextRevision },
        });
        await transaction.securityTwoFactorRecoveryCode.updateMany({
            where: {
                accountId: input.accountId,
                usedAt: null,
                credentialRevision: { not: input.nextRevision },
            },
            data: { usedAt: now },
        });
    }
    else {
        // No local provider is bound. Any leftover local credential must not
        // become adoptable after a later provider change.
        await transaction.securityTwoFactorCredential.updateMany({
            where: {
                accountId: input.accountId,
                method: "TOTP",
                status: "ACTIVE",
            },
            data: {
                status: "REVOKED",
                secretEncrypted: null,
                secretFingerprint: null,
                enrollmentSlot: null,
                disabledAt: now,
            },
        });
        await transaction.securityTwoFactorRecoveryCode.updateMany({
            where: { accountId: input.accountId, usedAt: null },
            data: { usedAt: now },
        });
    }
    await transaction.securityTwoFactorEnrollment.updateMany({
        where: {
            accountId: input.accountId,
            status: { in: ["PENDING", "CLAIMED"] },
        },
        data: {
            status: "REVOKED",
            enrollmentPasswordHash: null,
            revokedAt: now,
        },
    });
    await transaction.securityTwoFactorCredential.updateMany({
        where: {
            accountId: input.accountId,
            method: "TOTP",
            status: "PENDING",
        },
        data: {
            status: "REVOKED",
            secretEncrypted: null,
            secretFingerprint: null,
            enrollmentSlot: null,
            disabledAt: now,
        },
    });
    await transaction.securityTwoFactorChallenge.updateMany({
        where: {
            accountId: input.accountId,
            status: { in: ["PENDING", "VERIFIED"] },
        },
        data: { status: "CANCELLED" },
    });
    await cancelPendingRecoveryAfterCredentialChange(transaction, {
        accountId: input.accountId,
        preserveRequestId: input.preserveAccountRecoveryRequestId,
        now,
    });
}
