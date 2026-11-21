import { Router } from "express";
import { requireAuth } from "../../identity/middleware/requireAuth.js";
import { requirePermission } from "../../identity/middleware/requirePermission.js";
import { getEmergencyControlStatus, restartEmergencyBackend, scheduleEmergencyAutoStart, startEmergencyBackend, stopEmergencyBackend, updateEmergencyControlConfig, } from "./emergency-backend-control.service.js";
export const emergencyBackendControlRouter = Router();
function actor(req) {
    return req.auth?.accountId || req.user?.loginName || null;
}
emergencyBackendControlRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"));
emergencyBackendControlRouter.get("/", async (_req, res, next) => {
    try {
        res.json(await getEmergencyControlStatus());
    }
    catch (error) {
        next(error);
    }
});
emergencyBackendControlRouter.patch("/settings", async (req, res, next) => {
    try {
        const body = req.body || {};
        res.json(await updateEmergencyControlConfig({
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            autoStart: typeof body.autoStart === "boolean" ? body.autoStart : undefined,
            autoStartDelayMs: body.autoStartDelayMs,
            port: body.port,
            bind: body.bind,
        }, actor(req)));
    }
    catch (error) {
        next(error);
    }
});
emergencyBackendControlRouter.post("/start", async (_req, res, next) => {
    try {
        res.json(await startEmergencyBackend("manual"));
    }
    catch (error) {
        next(error);
    }
});
emergencyBackendControlRouter.post("/stop", async (_req, res, next) => {
    try {
        res.json(await stopEmergencyBackend("manual"));
    }
    catch (error) {
        next(error);
    }
});
emergencyBackendControlRouter.post("/restart", async (_req, res, next) => {
    try {
        res.json(await restartEmergencyBackend("manual"));
    }
    catch (error) {
        next(error);
    }
});
emergencyBackendControlRouter.post("/schedule", async (_req, res, next) => {
    try {
        res.json(await scheduleEmergencyAutoStart("manual"));
    }
    catch (error) {
        next(error);
    }
});
