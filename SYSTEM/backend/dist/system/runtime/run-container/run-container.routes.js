import { Router } from "express";
import { buildRunContainerCandidate, getRunContainerDiagnostics, getRunContainerStatus, promoteCandidateToActive, } from "./run-container.service.js";
import { requireAuth } from "../../../platform/security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../../platform/security/identity/middleware/requirePermission.js";
export const runContainerRouter = Router();
// Runtime identities and promotion operations are administrative internals.
// In particular, an unauthenticated caller must never be able to create or
// promote a candidate through /api/run-container.
runContainerRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"));
runContainerRouter.get("/status", async (_req, res) => {
    res.json(await getRunContainerStatus());
});
runContainerRouter.get("/diagnostics", async (_req, res) => {
    res.json(await getRunContainerDiagnostics());
});
runContainerRouter.post("/candidate", async (req, res) => {
    const candidate = await buildRunContainerCandidate({
        reason: typeof req.body?.reason === "string" ? req.body.reason : "system",
        requestedBy: req.auth?.accountId,
    });
    res.json({ ok: true, candidate });
});
runContainerRouter.post("/promote", async (_req, res) => {
    const active = await promoteCandidateToActive();
    res.json({ ok: true, active });
});
