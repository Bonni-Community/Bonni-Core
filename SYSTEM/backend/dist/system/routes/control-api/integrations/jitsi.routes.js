import { Router } from "express";
import { getJitsiPublicSettings, testJitsiConnection, updateJitsiSettings, } from "../../../../core/video-conferencing/index.js";
import { consumeVerifiedChallenge } from "../../../../platform/security/two-factor/services/two-factor.service.js";
export const systemJitsiRouter = Router();
function accountId(req) {
    const value = String(req.auth?.accountId || "").trim();
    if (!value)
        throw Object.assign(new Error("AUTH_ACCOUNT_REQUIRED"), { statusCode: 401 });
    return value;
}
function errorResponse(res, error) {
    const resolved = error;
    return res.status(Number(resolved?.statusCode || resolved?.status || 500)).json({
        error: resolved?.code || resolved?.message || "JITSI_SETTINGS_ERROR",
    });
}
systemJitsiRouter.get("/", async (_req, res) => {
    try {
        res.json({ settings: await getJitsiPublicSettings() });
    }
    catch (error) {
        errorResponse(res, error);
    }
});
systemJitsiRouter.post("/test", async (req, res) => {
    try {
        res.json(await testJitsiConnection(req.body?.serverUrl));
    }
    catch (error) {
        errorResponse(res, error);
    }
});
systemJitsiRouter.put("/", async (req, res) => {
    try {
        const actorId = accountId(req);
        const challengeId = String(req.body?.challengeId || "").trim();
        if (!challengeId)
            return res.status(428).json({ error: "ADMIN_2FA_CHALLENGE_REQUIRED" });
        await consumeVerifiedChallenge({
            accountId: actorId,
            challengeId,
            purpose: "ADMIN_ELEVATION",
            maxAgeMinutes: 5,
        });
        const settings = await updateJitsiSettings({
            enabled: req.body?.enabled,
            serverUrl: req.body?.serverUrl,
            appId: req.body?.appId,
            ...(Object.prototype.hasOwnProperty.call(req.body || {}, "secret") ? { secret: req.body.secret } : {}),
        }, actorId);
        return res.json({ settings });
    }
    catch (error) {
        return errorResponse(res, error);
    }
});
