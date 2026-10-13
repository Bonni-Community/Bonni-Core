import { Router } from "express";
import { z } from "zod";
import { nfcService } from "./index.js";
import { NfcError } from "./service.js";

// Mounted inside systemUsersRouter, after authentication + user-manager checks.
export const nfcManagementRouter = Router({ mergeParams: true });
const registration = z.object({
  code: z.string().min(1).max(128), label: z.string().trim().min(1).max(80),
  kind: z.enum(["NFC", "BARCODE"]).optional(),
  loginAccountId: z.string().min(1).max(100).nullable().optional(),
}).strict();
const handle = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await fn(req)); }
  catch (error) {
    const known = error instanceof NfcError;
    const code = known ? error.code : "NFC_SERVICE_UNAVAILABLE";
    res.status(known ? error.statusCode : 503).json({ code, message: code });
  }
};
nfcManagementRouter.get("/", handle(req => nfcService.list(req.params.memberId)));
nfcManagementRouter.post("/", handle(req => {
  const parsed = registration.safeParse(req.body);
  if (!parsed.success) throw new NfcError("NFC_PAYLOAD_INVALID");
  return nfcService.register(req.params.memberId, parsed.data, req.auth.accountId);
}));
nfcManagementRouter.post("/:tagId/revoke", handle(req => nfcService.revoke(req.params.memberId, req.params.tagId, req.auth.accountId)));
