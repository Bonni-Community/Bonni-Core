import { Router } from "express";

import {
  checkForCoreUpdateController,
  getCoreUpdateCenterStatusController,
  startCoreUpdateInstallationController,
  startCoreUpdatePreparationController,
  updateCoreUpdateSettingsController,
} from "./update-center.controller.js";

export const systemUpdateCenterRouter = Router();

systemUpdateCenterRouter.get("/", getCoreUpdateCenterStatusController);
systemUpdateCenterRouter.post("/check", checkForCoreUpdateController);
systemUpdateCenterRouter.post("/prepare", startCoreUpdatePreparationController);
systemUpdateCenterRouter.post("/install", startCoreUpdateInstallationController);
systemUpdateCenterRouter.put("/settings", updateCoreUpdateSettingsController);
