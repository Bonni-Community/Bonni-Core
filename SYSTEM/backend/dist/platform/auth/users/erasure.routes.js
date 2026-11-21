import { registerErasureRetentionRoutes } from "./erasure-retention.routes.js";
import { Router } from "express";
import { z } from "zod";
import { getServerPrismaClient } from "../../../core/database/database.js";
import { createChallenge, consumeVerifiedChallenge } from "../../../core/modules/security/two-factor/service.js";
import { requirePermission } from "../../security/identity/middleware/requirePermission.js";
import { getVerifiedRequestIdentity, getVerifiedRequestSessionAssurance } from "../request-identity/request-identity-context.js";
import { isBootstrapAdminLoginName } from "../system-account-policy.js";
import { inspectErasureParticipants } from "./erasure-preflight.js";
import { ERASURE_TYPE, ERASURE_SUBJECT, ERASURE_MODULE, erasureError, erasureWorkflow } from "./erasure-workflow.js";
import { erasureExclusive } from "./erasure-write-barrier.js";
import { erasureCycleOverview, writeErasureCycleSettings, prepareApprovedErasure, precheckErasureDeactivation } from "./erasure-cycle.service.js";
import { notifyErasureMember } from "./erasure-notifications.js";
const privacy = getServerPrismaClient("privacy");
const core = getServerPrismaClient("core");
const category = { requestType: ERASURE_TYPE, subjectType: ERASURE_SUBJECT };
const select = { id: true, status: true, accountId: true, subjectId: true, requestedByAccountId: true,
    createdAt: true, updatedAt: true, resultJson: true };
const idSchema = z.string().min(1).max(180).regex(/^[a-zA-Z0-9.:_-]+$/u);
const challengeSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("request") }).strict(),
    z.object({ action: z.literal("approve"), requestId: idSchema }).strict(),
]);
const commitSchema = z.object({ challengeId: idSchema, devicesCleared: z.boolean().optional() }).strict();
function actor() {
    const identity = getVerifiedRequestIdentity(), session = getVerifiedRequestSessionAssurance();
    if (!identity || !session || !session.sessionId || identity.accountId !== session.accountId
        || identity.credentialRevision !== session.credentialRevision) {
        return erasureError("ERASURE_SESSION_REQUIRED", "Bitte melde dich erneut an.", 401);
    }
    if (identity.type !== "MEMBER" && identity.type !== "ADMIN") {
        return erasureError("ERASURE_PERSONAL_ACCOUNT_REQUIRED", "Ein persönlicher Benutzerzugang ist erforderlich.", 403);
    }
    return { id: identity.accountId, personId: identity.personId, sessionId: session.sessionId, revision: identity.credentialRevision };
}
const workflow = erasureWorkflow({
    async target(id) {
        const a = await core.account.findUnique({ where: { id }, select: {
                id: true, loginName: true, personId: true, person: { select: { member: { select: { id: true } } } },
                type: true, isActive: true, credentialRevision: true, passwordRecoveryLockedAt: true,
            } });
        if (!a || (a.type !== "MEMBER" && a.type !== "ADMIN"))
            return null;
        return { id: a.id, personId: a.personId, memberId: a.person?.member?.id ?? null, revision: a.credentialRevision,
            active: a.isActive && !a.passwordRecoveryLockedAt, protectedSystemAccount: isBootstrapAdminLoginName(a.loginName) };
    },
    latest: accountId => privacy.privacyRequest.findFirst({ where: { ...category, accountId }, select,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    find: id => privacy.privacyRequest.findFirst({ where: { ...category, id }, select }),
    async proofConfirmed(accountId, proofId, binding) {
        return Boolean(await core.securityTwoFactorChallenge.findFirst({ where: {
                id: proofId, accountId, status: "CONSUMED", verifiedAt: { not: null }, consumedAt: { not: null },
                moduleKey: ERASURE_MODULE, purpose: "DSGVO_SUBJECT_DATA_DELETE", accessScope: "CORE.DSGVO_SUBJECT_DATA_DELETE",
                subjectId: binding,
            }, select: { id: true } }));
    },
    challenge: (a, binding) => createChallenge(a.id, binding),
    consume: (a, binding, challengeId) => consumeVerifiedChallenge({
        accountId: a.id, ...binding, challengeId, maxAgeMinutes: 1,
    }),
    create: (a, plan, proofId) => privacy.$transaction(async (tx) => {
        // The genuine request ID is also the uniqueness key for concurrent submissions.
        return tx.privacyRequest.create({ data: { ...category, id: plan.id, status: "OPEN",
                subjectId: plan.target.personId, accountId: plan.target.id, requestedByAccountId: a.id,
                resultJson: { scope: "BONNI_USER_AND_ALL_APPS", requestProofId: proofId, requestBinding: plan.binding.subjectId } }, select });
    }, { isolationLevel: "Serializable" }),
    approve: (a, plan, proofId) => privacy.$transaction(async (tx) => {
        const row = plan.entry;
        const details = row.resultJson && typeof row.resultJson === "object" ? row.resultJson : {};
        const changed = await tx.privacyRequest.updateMany({ where: { ...category, id: plan.id, status: "OPEN",
                accountId: plan.target.id, requestedByAccountId: plan.target.id, subjectId: plan.target.personId, updatedAt: row.updatedAt },
            data: { status: "IN_REVIEW", resultJson: { scope: "BONNI_USER_AND_ALL_APPS",
                    ...("requestProofId" in details && typeof details.requestProofId === "string" ? { requestProofId: details.requestProofId } : {}),
                    ...("requestBinding" in details && typeof details.requestBinding === "string" ? { requestBinding: details.requestBinding } : {}),
                    approvedByAccountId: a.id, approvedAt: new Date().toISOString(), approvalProofId: proofId, approvalBinding: plan.binding.subjectId,
                    devicesClearedAt: new Date().toISOString(), devicesClearedByAccountId: a.id,
                } } });
        if (changed.count !== 1)
            return erasureError("ERASURE_PLAN_CHANGED", "Der Antrag hat sich während der Freigabe geändert.");
        return tx.privacyRequest.findUniqueOrThrow({ where: { id: plan.id }, select });
    }, { isolationLevel: "Serializable" }),
});
const handle = (work) => async (req, res) => {
    try {
        await work(req, res);
    }
    catch (failure) {
        const e = failure;
        if (failure instanceof z.ZodError) {
            res.status(400).json({ code: "ERASURE_INVALID_INPUT", message: "Die Anfrage ist ungültig." });
            return;
        }
        if (e.code?.startsWith("ERASURE_") || e.code?.startsWith("TWO_FACTOR_")) {
            res.status(e.statusCode || 409).json({ code: e.code, message: e.code.startsWith("ERASURE_")
                    ? e.message : "Die aktuelle Zwei-Faktor-Bestätigung ist erforderlich oder nicht mehr verwendbar." });
            return;
        }
        if (e.code === "P2002" || e.code === "P2034") {
            res.status(409).json({ code: "ERASURE_CONCURRENT_CHANGE", message: "Der Vorgang hat sich geändert. Bitte den Stand erneut laden." });
            return;
        }
        res.status(503).json({ code: "ERASURE_UNAVAILABLE", message: "Der Bearbeitungsstand konnte nicht bestätigt werden. Bitte erneut laden." });
    }
};
export const erasureRouter = Router();
erasureRouter.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Authorization");
    next();
});
const admin = requirePermission("SYSTEM_ADMIN");
erasureRouter.get("/cycle", admin, handle(async (_req, res) => { actor(); res.json(await erasureCycleOverview()); }));
erasureRouter.put("/cycle", admin, handle(async (req, res) => {
    actor();
    res.json({ settings: await erasureExclusive(() => writeErasureCycleSettings(req.body)) });
}));
erasureRouter.get("/me", handle(async (_req, res) => {
    const accountId = actor().id, result = await workflow.read(accountId);
    res.json({ ...result, ...(result.request ? { acknowledgement: await notifyErasureMember(accountId, result.request.id) } : {}) });
}));
erasureRouter.get("/review/:accountId", admin, handle(async (req, res) => {
    actor();
    const accountId = idSchema.parse(req.params.accountId);
    const dto = await workflow.read(accountId);
    if (!dto.request) {
        res.json(dto);
        return;
    }
    const checks = await inspectErasureParticipants({ requestId: dto.request.id, accountId }).catch(() => ({
        status: "unverified", canExecute: false, modules: [], reason: "Die Teilnehmerprüfung ist nicht verfügbar.",
    }));
    res.json({ ...dto, checks });
}));
erasureRouter.post("/challenge", (req, res, next) => req.body?.action === "approve" ? admin(req, res, next) : next(), handle(async (req, res) => {
    const input = challengeSchema.parse(req.body);
    res.status(201).json(await workflow.challenge(actor(), input.action, input.action === "approve" ? input.requestId : undefined));
}));
erasureRouter.post("/request", handle(async (req, res) => {
    const { challengeId } = commitSchema.parse(req.body);
    const accountId = actor().id, result = await workflow.submit(actor(), "request", challengeId);
    if (!result.request)
        return erasureError("ERASURE_REQUEST_CHANGED", "Der Antragsstand konnte nicht bestätigt werden.");
    res.status(201).json({ ...result, acknowledgement: await notifyErasureMember(accountId, result.request.id) });
}));
erasureRouter.post("/:requestId/approve", admin, handle(async (req, res) => {
    const requestId = idSchema.parse(req.params.requestId);
    const { challengeId, devicesCleared } = commitSchema.parse(req.body);
    if (devicesCleared !== true)
        return erasureError("ERASURE_DEVICE_CLEARANCE_REQUIRED", "Bestätige zuerst, dass die betroffenen Geräte synchronisiert oder ihre lokalen Warteschlangen bereinigt sind.");
    const reviewer = actor();
    res.json(await erasureExclusive(async () => {
        const row = await privacy.privacyRequest.findFirst({ where: { ...category, id: requestId, status: "OPEN" }, select: { accountId: true } });
        if (!row?.accountId)
            return erasureError("ERASURE_NOT_PENDING", "Dieser Antrag steht nicht zur Freigabe an.");
        await precheckErasureDeactivation(row.accountId, requestId);
        await workflow.submit(reviewer, "approve", challengeId, requestId);
        await prepareApprovedErasure(requestId);
        // The durable request is also the retry source for notification delivery.
        // A failed inbox write must not leave an approved account active.
        await notifyErasureMember(row.accountId, requestId, true).catch(() => undefined);
        return workflow.read(row.accountId);
    }));
}));
registerErasureRetentionRoutes(erasureRouter, { admin, handle, actor });
