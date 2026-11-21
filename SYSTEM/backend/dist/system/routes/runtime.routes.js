import { Router } from "express";
import { getRuntimeJsonFallbackStatus, getRuntimeLiveStatus, getRuntimeReadyStatus, getSystemRuntimeConfig, } from "../runtime/index.js";
export const runtimeRouter = Router();
runtimeRouter.get("/", (_req, res) => {
    res.json(getRuntimeLiveStatus());
});
runtimeRouter.get("/slot", (_req, res) => {
    res.json({ ok: true, runtime: getSystemRuntimeConfig() });
});
runtimeRouter.get("/ready", async (_req, res, next) => {
    try {
        const status = await getRuntimeReadyStatus();
        res.status(status.ok ? 200 : 503).json(status);
    }
    catch (error) {
        next(error);
    }
});
runtimeRouter.get("/notlauf", async (_req, res, next) => {
    try {
        const status = await getRuntimeJsonFallbackStatus();
        res.status(status.ok ? 200 : 503).json(status);
    }
    catch (error) {
        next(error);
    }
});
