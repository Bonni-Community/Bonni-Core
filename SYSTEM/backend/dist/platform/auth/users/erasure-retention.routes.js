import { z } from "zod";
import { assertErasureReviewMfa, retentionPlan, challengeRetention, approveRetention, accessRetentionRecord } from "./erasure-retention.service.js";
import { listRetentionRecords } from "./erasure-retention-vault.js";
import { reviewErasureCase, runImmediateErasure } from "./erasure-cycle.service.js";
import { erasureExclusive } from "./erasure-write-barrier.js";
const id = z.string().regex(/^era_[a-f0-9]{64}$/), key = z.string().regex(/^[a-f0-9]{64}$/);
const decision = z.object({ key, action: z.enum(["retain", "delete"]), until: z.string().max(40).optional(), reason: z.string().max(500).optional() }).strict();
const planInput = z.object({ revision: z.number().int().min(0), scopeHash: key, decisions: z.array(decision).max(2000) }).strict();
const readInput = z.object({ reason: z.string().trim().min(8).max(500), challengeId: z.string().min(1).max(180).optional() }).strict();
export function registerErasureRetentionRoutes(router, { admin, handle, actor }) {
    router.post("/cycle/:requestId/execute", admin, handle(async (req, res) => {
        const requestId = id.parse(req.params.requestId), reviewer = actor();
        z.object({ confirm: z.literal("ENDGUELTIG_LOESCHEN") }).strict().parse(req.body);
        await assertErasureReviewMfa();
        res.json(await runImmediateErasure(requestId, reviewer));
    }));
    router.post("/cycle/:requestId/check", admin, handle(async (req, res) => {
        actor();
        await assertErasureReviewMfa();
        res.json(await erasureExclusive(async () => { await retentionPlan(id.parse(req.params.requestId), true); return reviewErasureCase(req.params.requestId); }));
    }));
    router.post("/:requestId/retention/preview", admin, handle(async (req, res) => {
        actor();
        await assertErasureReviewMfa();
        res.json(await erasureExclusive(() => retentionPlan(id.parse(req.params.requestId), true)));
    }));
    router.post("/:requestId/retention/challenge", admin, handle(async (req, res) => {
        const a = actor();
        await assertErasureReviewMfa();
        res.status(201).json(await challengeRetention(a, id.parse(req.params.requestId), planInput.parse(req.body)));
    }));
    router.post("/:requestId/retention/approve", admin, handle(async (req, res) => {
        const a = actor();
        await assertErasureReviewMfa();
        res.json(await approveRetention(a, id.parse(req.params.requestId), planInput.extend({ challengeId: z.string().min(1).max(180) }).parse(req.body)));
    }));
    router.get("/:requestId/archive", admin, handle(async (req, res) => {
        actor();
        await assertErasureReviewMfa();
        res.json({ records: await listRetentionRecords(id.parse(req.params.requestId)) });
    }));
    router.post("/:requestId/archive/:key/access", admin, handle(async (req, res) => {
        const a = actor();
        await assertErasureReviewMfa();
        const input = readInput.parse(req.body);
        res.json(await accessRetentionRecord(a, id.parse(req.params.requestId), key.parse(req.params.key), input.reason, input.challengeId));
    }));
}
