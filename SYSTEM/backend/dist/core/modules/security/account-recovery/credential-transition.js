export class AccountRecoveryCredentialTransitionError extends Error {
    code = "ACCOUNT_RECOVERY_CREDENTIAL_TRANSITION_CONFLICT";
    statusCode = 409;
    constructor() {
        super("Der Kontowiederherstellungsvorgang wurde gleichzeitig geändert. Bitte erneut laden.");
        this.name = "AccountRecoveryCredentialTransitionError";
    }
}
/**
 * Cancels an unlocked public/support request when any account credential
 * revision advances. Without this coupling the request's frozen target
 * revision could never be approved, while its unique active slot would still
 * block a fresh request for up to 48 hours.
 *
 * The caller must run this helper in the same database transaction as the
 * Account credentialRevision CAS. A recovery flow which itself owns the
 * revision transition may preserve its exact request id.
 */
export async function cancelPendingRecoveryAfterCredentialChange(transaction, input) {
    const now = input.now || new Date();
    const pending = await transaction.securityAccountRecoveryRequest.findMany({
        where: {
            accountId: input.accountId,
            status: "PENDING",
            lockedAt: null,
        },
        select: { id: true, requestRevision: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    let cancelled = 0;
    for (const request of pending) {
        if (request.id === input.preserveRequestId)
            continue;
        const update = await transaction.securityAccountRecoveryRequest.updateMany({
            where: {
                id: request.id,
                accountId: input.accountId,
                status: "PENDING",
                lockedAt: null,
                requestRevision: request.requestRevision,
            },
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
        if (update.count !== 1)
            throw new AccountRecoveryCredentialTransitionError();
        await transaction.securityAccountRecoveryAuditLog.create({
            data: {
                requestId: request.id,
                targetAccountId: input.accountId,
                event: "ACCOUNT_RECOVERY_CANCELLED_CREDENTIAL_CHANGED",
                result: "BLOCKED",
                metadataJson: { reason: "CREDENTIAL_REVISION_CHANGED" },
            },
        });
        cancelled += 1;
    }
    return cancelled;
}
