import { Router } from "express";
import { requireAuth } from "../../../platform/security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../../platform/security/identity/middleware/requirePermission.js";
import { getRegistryController, runRegistrySyncToolController, syncRegistryController, } from "./registry.controller.js";
export const systemRegistryRouter = Router();
systemRegistryRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"));
systemRegistryRouter.get("/", getRegistryController);
systemRegistryRouter.post("/sync", syncRegistryController);
systemRegistryRouter.post("/tools/registry-sync/run", runRegistrySyncToolController);
