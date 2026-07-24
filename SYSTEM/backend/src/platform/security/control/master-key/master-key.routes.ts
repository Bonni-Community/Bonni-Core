import { Router } from "express";
import { requireAuth } from "../../identity/middleware/requireAuth.js";
import { requirePermission } from "../../identity/middleware/requirePermission.js";

import {
  bootWithoutKeyDecisionController,
  getMasterKeyStatusController,
  initializeMasterKeyStorageController,
  listMasterKeyStorageLocationsController,
  loadMasterKeyController,
  setDeveloperBootModeController,
} from "./master-key.controller.js";

export const systemMasterKeyRouter = Router();

systemMasterKeyRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"));

systemMasterKeyRouter.get("/", getMasterKeyStatusController);
systemMasterKeyRouter.get("/status", getMasterKeyStatusController);
systemMasterKeyRouter.get("/storage-locations", listMasterKeyStorageLocationsController);
systemMasterKeyRouter.post("/boot-without-key", bootWithoutKeyDecisionController);
systemMasterKeyRouter.post("/developer-boot", setDeveloperBootModeController);
systemMasterKeyRouter.post("/load-from-file", loadMasterKeyController);
systemMasterKeyRouter.post("/initialize-storage", initializeMasterKeyStorageController);
