import { Router } from "express";
import { ZodError } from "zod";
import { getMatrixManagerSettings, getMatrixManagerStatus, runMatrixManagerCommand, updateMatrixManagerSettings } from "../../../../core/matrix-manager/service.js";
import { consumeVerifiedChallenge } from "../../../../platform/security/two-factor/services/two-factor.service.js";
export const systemMatrixRouter = Router();
systemMatrixRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
function failure(res, error) {
    const code = error instanceof ZodError ? "MATRIX_MANAGER_INPUT_INVALID" : String(error?.message || "");
    return res.status(error instanceof ZodError ? 400 : Number(error?.statusCode || 500)).json({
        error: code.startsWith("MATRIX_MANAGER_") || code.startsWith("ADMIN_2FA_") ? code : "MATRIX_MANAGER_OPERATION_FAILED",
    });
}
systemMatrixRouter.get("/", async (_req, res) => { try {
    res.json(await getMatrixManagerSettings());
}
catch (error) {
    failure(res, error);
} });
systemMatrixRouter.get("/status", async (_req, res) => { try {
    res.json(await getMatrixManagerStatus());
}
catch (error) {
    failure(res, error);
} });
systemMatrixRouter.post("/command", async (req, res) => {
    try {
        const accountId = String(req.auth?.accountId || "");
        if (!accountId)
            return res.status(401).json({ error: "AUTH_ACCOUNT_REQUIRED" });
        const { challengeId, ...command } = req.body || {};
        if (!["status", "configuration", "check-update"].includes(command.action)) {
            if (!challengeId)
                return res.status(428).json({ error: "ADMIN_2FA_CHALLENGE_REQUIRED" });
            await consumeVerifiedChallenge({ accountId, challengeId, purpose: "ADMIN_ELEVATION", maxAgeMinutes: 5 });
        }
        return res.json(await runMatrixManagerCommand(command, accountId));
    }
    catch (error) {
        return failure(res, error);
    }
});
systemMatrixRouter.put("/", async (req, res) => {
    try {
        const accountId = String(req.auth?.accountId || "");
        if (!accountId)
            return res.status(401).json({ error: "AUTH_ACCOUNT_REQUIRED" });
        const { challengeId, ...settings } = req.body || {};
        if (!challengeId)
            return res.status(428).json({ error: "ADMIN_2FA_CHALLENGE_REQUIRED" });
        await consumeVerifiedChallenge({ accountId, challengeId, purpose: "ADMIN_ELEVATION", maxAgeMinutes: 5 });
        return res.json(await updateMatrixManagerSettings(settings, accountId));
    }
    catch (error) {
        return failure(res, error);
    }
});
