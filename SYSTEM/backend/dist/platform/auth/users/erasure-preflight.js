import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { moduleServicesRegistry, canReviewSystemErasure } from "../../../core/module-services/module-services-runtime.js";
import { getVerifiedRequestIdentity, getVerifiedRequestSessionAssurance } from "../request-identity/request-identity-context.js";
import { getStatus } from "../../../core/modules/security/two-factor/service.js";
import { aggregateChecks, publicCheck } from "./erasure-inspection-model.js";
/** Called only on an authorized admin review of an existing, authenticated request. */
export async function inspectErasureParticipants({ requestId, accountId }) {
    const actor = getVerifiedRequestIdentity();
    if (!actor || !canReviewSystemErasure(actor))
        throw Object.assign(new Error("ERASURE_REVIEW_DENIED"), { statusCode: 403 });
    const unknown = (reason) => ({ ...aggregateChecks([]), reason });
    try {
        // Same session-strength policy as existing Core administrative member/device operations.
        const mfa = await getStatus(actor.accountId);
        const session = getVerifiedRequestSessionAssurance();
        if (mfa.enabled !== true || mfa.available !== true || mfa.provider?.configured !== true || mfa.provider?.available === false ||
            !session?.mfaVerifiedAt || session.accountId !== actor.accountId || session.credentialRevision !== actor.credentialRevision ||
            !mfa.provider?.id || session.mfaProviderId !== String(mfa.provider.id).trim().toLowerCase())
            return unknown("Für die Vorprüfung ist eine mit 2FA bestätigte Verwaltungssitzung erforderlich.");
        const db = getServerPrismaClient("core");
        const { subject, registry } = await db.$transaction(async (tx) => ({
            subject: await tx.account.findUnique({ where: { id: accountId }, select: { id: true, type: true, personId: true, person: { select: {
                            accounts: { take: 2, select: { id: true } }, member: { select: { id: true, account: { select: { balanceCached: true } } } }
                        } } } }),
            registry: await tx.installedModule.findMany({ orderBy: { key: "asc" }, select: { key: true, name: true, status: true, installedAt: true, enabledAt: true, uninstalledAt: true, deletedAt: true } }),
        }), { isolationLevel: "RepeatableRead" });
        if (!subject || !["MEMBER", "ADMIN"].includes(subject.type))
            return unknown("Das persönliche Bonni-Konto lässt sich nicht eindeutig zuordnen.");
        if (subject.person && (subject.person.accounts.length !== 1 || subject.person.accounts[0].id !== accountId))
            return unknown("Diese Person ist mit mehreren Zugängen verknüpft. Die Zuordnung muss vor einer App-Prüfung geklärt werden.");
        const member = subject.person?.member;
        const input = { requestId, accountIds: [subject.id], personIds: subject.personId ? [subject.personId] : [], memberIds: member ? [member.id] : [] };
        const reasons = [];
        const balance = member?.account?.balanceCached;
        if (balance != null && !balance.isZero())
            reasons.push("BALANCE");
        if (!subject.personId)
            reasons.push("IDENTITY");
        reasons.push("RETENTION");
        const modules = [publicCheck("core", "Bonni Core", { status: reasons.includes("BALANCE") ? "blocked" : "unverified", reasons })];
        // Installed, disabled and former installations may retain records. Only never-installed catalogue entries are skipped.
        for (const row of registry) {
            if (row.status === "DISCOVERED" && !row.installedAt && !row.enabledAt && !row.uninstalledAt && !row.deletedAt)
                continue;
            if (row.status !== "ENABLED") {
                modules.push({ key: row.key, label: row.name, status: "unverified", reasons: ["Das Modul ist nicht aktiv. Vorhandene Daten müssen geprüft werden."] });
                continue;
            }
            let timer;
            try {
                const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ERASURE_REVIEW_TIMEOUT")), 3500); });
                modules.push(publicCheck(row.key, row.name, await Promise.race([moduleServicesRegistry.inspectAccountErasure(row.key, input), limit])));
            }
            catch {
                modules.push(publicCheck(row.key, row.name, null));
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        }
        return aggregateChecks(modules);
    }
    catch {
        return unknown("Die Datenquellen sind nicht vollständig erreichbar. Eine Ausführung ist gesperrt.");
    }
}
