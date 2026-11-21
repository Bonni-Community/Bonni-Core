import { Router } from "express";
import { createHash } from "node:crypto";
import { AuthAttemptBuckets } from "../../../core/http/auth-ingress.js";
import { erasureStatusMailbox } from "./erasure-status-mailbox.js";
const buckets = new AuthAttemptBuckets();
export const erasureStatusRouter = Router();
erasureStatusRouter.post("/status", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    const retry = buckets.consume(createHash("sha256").update(req.ip || req.socket.remoteAddress || "unknown").digest("hex"), 60);
    if (retry) {
        res.set("Retry-After", String(retry));
        res.status(429).json({ code: "ERASURE_STATUS_RATE_LIMITED" });
        return;
    }
    try {
        if (!req.body || Object.keys(req.body).length !== 1) {
            res.status(404).json({ code: "ERASURE_STATUS_UNAVAILABLE" });
            return;
        }
        const value = await erasureStatusMailbox().read(req.body.token);
        if (!value) {
            res.status(404).json({ code: "ERASURE_STATUS_UNAVAILABLE" });
            return;
        }
        res.json(value);
    }
    catch {
        res.status(503).json({ code: "ERASURE_STATUS_UNAVAILABLE" });
    }
});
