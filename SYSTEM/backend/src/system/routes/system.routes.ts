import { Router } from "express";
import {
  listSystemModules,
  syncDefaultSystemModules,
} from "../../platform/module-manager/registry/index.js";
import { systemModulesRouter } from "../../platform/module-manager/routes/index.js";
import { getLocalAuthProviderStatus } from "../../platform/auth/providers/local/index.js";
import { getOidcAuthProviderStatus } from "../../platform/auth/providers/oidc/index.js";
import { getRuntimeLiveStatus, getRuntimeReadyStatus } from "../runtime/index.js";
import { systemRouter as controlSystemRouter } from "./control-api/index.js";
import { systemExplorerRouter } from "./explorer/index.js";
import { requireAuth } from "../../platform/security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../platform/security/identity/middleware/requirePermission.js";

export const systemRouter = Router();

systemRouter.use("/system", controlSystemRouter);
systemRouter.use("/modules", systemModulesRouter);
systemRouter.use("/explorer", systemExplorerRouter);

systemRouter.get("/status", (_req, res) => {
  res.json({
    ok: true,
    local: getLocalAuthProviderStatus(),
    oidc: getOidcAuthProviderStatus(),
    runtime: getRuntimeLiveStatus().runtime,
  });
});

systemRouter.get("/runtime", (_req, res) => {
  res.json(getRuntimeLiveStatus());
});

systemRouter.get("/runtime/ready", async (_req, res, next) => {
  try {
    const status = await getRuntimeReadyStatus();
    res.status(status.ok ? 200 : 503).json(status);
  } catch (error) {
    next(error);
  }
});

systemRouter.get("/core-modules", async (_req, res, next) => {
  try {
    res.json({ modules: await listSystemModules() });
  } catch (error) {
    next(error);
  }
});

systemRouter.post(
  "/core-modules/sync",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  async (_req, res, next) => {
  try {
    const result = await syncDefaultSystemModules();
    res.json({ ...result, ok: true, modules: await listSystemModules() });
  } catch (error) {
    next(error);
  }
  },
);
