import { Router } from "express";
import { getOidcAuthProviderStatus } from "../../platform/auth/providers/oidc/index.js";
export const oidcRouter = Router();
oidcRouter.get("/status", (_req, res) => {
    const provider = getOidcAuthProviderStatus();
    res.status(provider.enabled ? 200 : 503).json({
        ok: provider.enabled,
        surface: "oidc",
        provider,
        fallback: {
            provider: "local",
            message: "Local/Sandbox/Notlauf bleibt parallel verfügbar."
        }
    });
});
export default oidcRouter;
