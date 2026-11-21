import { Router } from "express";
import { getSystemSecurityPrivacyOverviewController } from "./overview.controller.js";
export const systemSecurityOverviewRouter = Router();
systemSecurityOverviewRouter.get("/", getSystemSecurityPrivacyOverviewController);
