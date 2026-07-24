import { Router } from "express";

import {
  getAuthSettingsController,
  getSettingsController,
} from "./settings.controller.js";

export const systemSettingsRouter = Router();

systemSettingsRouter.get("/", getSettingsController);
systemSettingsRouter.get("/auth", getAuthSettingsController);
