import { Router } from "express";
import { z } from "zod";
import { logger } from "./logger.js";
const clientLogSchema = z.object({
    side: z.string().optional().default("frontend"),
    module: z.string().optional().default("frontend"),
    level: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
    label: z.string().optional().default("CLIENT_LOG"),
    data: z.unknown().optional().default(null),
});
export const clientLogRouter = Router();
clientLogRouter.post("/client-log", (req, res) => {
    const payload = clientLogSchema.parse(req.body ?? {});
    logger.log(payload.level, payload.label, {
        module: payload.module,
        side: payload.side,
        source: "client-log",
        data: payload.data,
    });
    res.status(202).json({ ok: true });
});
export default clientLogRouter;
