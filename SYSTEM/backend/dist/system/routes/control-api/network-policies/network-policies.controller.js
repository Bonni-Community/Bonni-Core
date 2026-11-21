import { getPrismaClient } from "../../../../core/database/database.js";
import { listModuleNetworkObservations, listModuleNetworkPolicies, updateModuleNetworkPolicy, } from "../../../../core/network-policy/index.js";
function accountId(req) {
    return String(req.auth?.accountId || "").trim();
}
export async function listNetworkPoliciesController(_req, res, next) {
    try {
        const prisma = getPrismaClient();
        const [policies, observations] = await Promise.all([
            listModuleNetworkPolicies(prisma),
            listModuleNetworkObservations(prisma, { limit: 100 }),
        ]);
        res.json({ ok: true, policies, observations });
    }
    catch (error) {
        next(error);
    }
}
export async function updateNetworkPolicyController(req, res, next) {
    try {
        const actorId = accountId(req);
        if (!actorId)
            return res.status(401).json({ error: "UNAUTHORIZED" });
        const policy = await updateModuleNetworkPolicy(getPrismaClient(), req.params.moduleKey, req.body && typeof req.body === "object" ? req.body : {}, actorId);
        return res.json({ ok: true, policy });
    }
    catch (error) {
        return next(error);
    }
}
export async function listNetworkObservationsController(req, res, next) {
    try {
        const observations = await listModuleNetworkObservations(getPrismaClient(), {
            moduleKey: req.query.moduleKey,
            decision: req.query.decision,
            limit: req.query.limit,
        });
        res.json({ ok: true, observations });
    }
    catch (error) {
        next(error);
    }
}
