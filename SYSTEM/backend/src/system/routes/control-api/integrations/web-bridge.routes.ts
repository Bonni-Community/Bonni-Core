import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { getWebBridgeStatus, listWebBridgeInbox, stageWebPublication, syncWebBridge,
  testWebBridge, updateWebBridgeConfig } from "../../../../core/web-bridge/service.js";
import { providers, type WebProvider } from "../../../../core/web-bridge/protocol.js";
import { consumeVerifiedChallenge } from "../../../../platform/security/two-factor/services/two-factor.service.js";

export const systemWebBridgeRouter = Router();
systemWebBridgeRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
function provider(req: Request): WebProvider {
  const name = String(req.params.provider);
  if (!providers.includes(name as WebProvider)) throw Object.assign(new Error("WEB_BRIDGE_PROVIDER_INVALID"), { statusCode: 404 });
  return name as WebProvider;
}
function failure(res: Response, error: unknown) {
  if (error instanceof ZodError) return res.status(400).json({ error: "WEB_BRIDGE_INPUT_INVALID" });
  const value = error as { code?: string; message?: string; statusCode?: number };
  return res.status(value.statusCode || 500).json({ error: value.code?.startsWith("WEB_BRIDGE_") ? value.code
    : value.message?.startsWith("WEB_BRIDGE_") ? value.message : "WEB_BRIDGE_OPERATION_FAILED" });
}
systemWebBridgeRouter.get("/:provider", async (req, res) => {
  try { res.json(await getWebBridgeStatus(provider(req))); } catch (error) { failure(res, error); }
});
systemWebBridgeRouter.get("/:provider/inbox", async (req, res) => {
  try { res.json({ items: await listWebBridgeInbox(provider(req)) }); } catch (error) { failure(res, error); }
});
systemWebBridgeRouter.post("/:provider/test", async (req, res) => {
  try { res.json(await testWebBridge(provider(req))); } catch (error) { failure(res, error); }
});
systemWebBridgeRouter.post("/:provider/sync", async (req, res) => {
  try { res.json(await syncWebBridge(provider(req))); } catch (error) { failure(res, error); }
});
systemWebBridgeRouter.put("/:provider/publication", async (req, res) => {
  try { res.json({ publication: await stageWebPublication(provider(req), req.body) }); } catch (error) { failure(res, error); }
});
systemWebBridgeRouter.put("/:provider", async (req, res) => {
  try {
    const name = provider(req);
    const accountId = String((req as Request & { auth?: { accountId?: string } }).auth?.accountId || "");
    if (!accountId) return res.status(401).json({ error: "AUTH_ACCOUNT_REQUIRED" });
    const { challengeId, ...settings } = req.body || {};
    if (!challengeId) return res.status(428).json({ error: "ADMIN_2FA_CHALLENGE_REQUIRED" });
    await consumeVerifiedChallenge({ accountId, challengeId, purpose: "ADMIN_ELEVATION", maxAgeMinutes: 5 });
    return res.json(await updateWebBridgeConfig(name, settings, accountId));
  } catch (error) { return failure(res, error); }
});
