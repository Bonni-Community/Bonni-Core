import { Router } from "express";
import { z } from "zod";
import { presenceService } from "./index.js";
import { nfcService } from "../nfc/index.js";
import { NfcError } from "../nfc/service.js";
import { requirePermission } from "../../../../platform/security/identity/middleware/requirePermission.js";
const handle = (fn) => async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
        res.json(await fn(req));
    }
    catch (error) {
        res.status(error instanceof NfcError ? error.statusCode : 503).json({ code: error instanceof NfcError ? error.code : "PRESENCE_UNAVAILABLE" });
    }
};
const markSchema = z.object({
    memberId: z.string().min(1).max(100).optional(), code: z.string().min(1).max(128).optional(),
    status: z.enum(["IN", "OUT", "UNKNOWN"]), expectedVersion: z.number().int().nonnegative().optional(),
}).strict().refine(value => Boolean(value.memberId) !== Boolean(value.code));
const bridgeSchema = z.object({ label: z.string().trim().min(1).max(80), scope: z.enum(["COUNT", "MEMBERS"]) }).strict();
// Mounted after the existing user-manager authentication/authorization.
export const presenceManagementRouter = Router();
presenceManagementRouter.get("/", handle(() => presenceService.overview()));
presenceManagementRouter.post("/settings", requirePermission("SYSTEM_ADMIN"), handle(req => {
    const input = z.object({ timeoutMinutes: z.number().int().min(5).max(1440) }).strict().safeParse(req.body);
    if (!input.success)
        throw new NfcError("PRESENCE_PAYLOAD_INVALID");
    return presenceService.setTimeoutMinutes(input.data.timeoutMinutes, req.auth.accountId);
}));
presenceManagementRouter.post("/", handle(async (req) => {
    const input = markSchema.safeParse(req.body);
    if (!input.success)
        throw new NfcError("PRESENCE_PAYLOAD_INVALID");
    const memberId = input.data.memberId || (await nfcService.identify(input.data.code, req.auth)).memberId;
    return presenceService.mark(memberId, input.data.status, req.auth.accountId, input.data.expectedVersion);
}));
presenceManagementRouter.get("/bridges", requirePermission("SYSTEM_ADMIN"), handle(() => presenceService.listBridges()));
presenceManagementRouter.post("/bridges", requirePermission("SYSTEM_ADMIN"), handle(req => {
    const input = bridgeSchema.safeParse(req.body);
    if (!input.success)
        throw new NfcError("PRESENCE_PAYLOAD_INVALID");
    return presenceService.createBridge(input.data.label, input.data.scope, req.auth.accountId);
}));
presenceManagementRouter.post("/bridges/:id/revoke", requirePermission("SYSTEM_ADMIN"), handle(req => presenceService.revokeBridge(req.params.id, req.auth.accountId)));
// External bridge is intentionally GET-only and uses its own scoped token.
export function createPresenceBridgeRouter(service = presenceService) {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    router.get("/", handle(req => service.readBridge(req.headers.authorization, undefined, req.ip || "unknown")));
    router.get("/members/:memberId", handle(req => service.readBridge(req.headers.authorization, req.params.memberId, req.ip || "unknown")));
    router.use((_req, res) => { res.setHeader("Allow", "GET"); res.status(405).json({ code: "PRESENCE_BRIDGE_READ_ONLY" }); });
    return router;
}
export const presenceBridgeRouter = createPresenceBridgeRouter();
