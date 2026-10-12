import { Router } from "express";
import { brandingAdminRouter } from "../../../../core/branding/index.js";

import {
  getAuthSettingsController,
  getSettingsController,
} from "./settings.controller.js";

export const systemSettingsRouter = Router();

systemSettingsRouter.get("/", getSettingsController);
systemSettingsRouter.get("/auth", getAuthSettingsController);
systemSettingsRouter.use("/branding", brandingAdminRouter);
