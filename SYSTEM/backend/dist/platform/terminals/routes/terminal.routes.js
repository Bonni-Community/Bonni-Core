import { Router } from "express";
import { validate } from "../../../core/http/middleware/validate.js";
import { readRouteParam } from "../../../core/http/route-param.js";
import { requireAuth } from "../../security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../security/identity/middleware/requirePermission.js";
import * as terminalService from "../services/terminal.service.js";
import { getTerminalShellStatus } from "../services/terminal-pty.service.js";
import { capabilitySchema, createTerminalSchema, startSessionSchema, updateTerminalSchema } from "../schemas/terminal.schemas.js";
export const terminalRouter = Router();
terminalRouter.get("/shell/status", requireAuth, requirePermission("SYSTEM_ADMIN"), async (_req, res, next) => {
    try {
        res.json(await getTerminalShellStatus());
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.get("/", requireAuth, async (_req, res, next) => {
    try {
        res.json(await terminalService.listTerminals());
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.get("/:id", requireAuth, async (req, res, next) => {
    try {
        res.json(await terminalService.getTerminal(readRouteParam(req.params.id)));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.post("/", requireAuth, requirePermission("SYSTEM_ADMIN"), validate(createTerminalSchema), async (req, res, next) => {
    try {
        res.json(await terminalService.createTerminal(req.body));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.patch("/:id", requireAuth, requirePermission("SYSTEM_ADMIN"), validate(updateTerminalSchema), async (req, res, next) => {
    try {
        res.json(await terminalService.updateTerminal(readRouteParam(req.params.id), req.body));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.get("/:id/status", requireAuth, async (req, res, next) => {
    try {
        res.json(await terminalService.getTerminalStatus(readRouteParam(req.params.id)));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.post("/:id/session/start", requireAuth, validate(startSessionSchema), async (req, res, next) => {
    try {
        res.json(await terminalService.startTerminalSession(readRouteParam(req.params.id), String(req.auth?.accountId || "")));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.post("/session/:sessionId/end", requireAuth, async (req, res, next) => {
    try {
        res.json(await terminalService.endTerminalSession(readRouteParam(req.params.sessionId), String(req.auth?.accountId || "")));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.get("/:id/capabilities", requireAuth, async (req, res, next) => {
    try {
        res.json(await terminalService.listCapabilities(readRouteParam(req.params.id)));
    }
    catch (error) {
        next(error);
    }
});
terminalRouter.patch("/:id/capabilities", requireAuth, requirePermission("SYSTEM_ADMIN"), validate(capabilitySchema), async (req, res, next) => {
    try {
        const body = req.body;
        res.json(await terminalService.setCapability(readRouteParam(req.params.id), body.capability, body.enabled));
    }
    catch (error) {
        next(error);
    }
});
