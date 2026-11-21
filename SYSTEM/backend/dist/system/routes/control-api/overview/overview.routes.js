import { Router } from "express";
import { getOverviewController } from "./overview.controller.js";
export const systemOverviewRouter = Router();
systemOverviewRouter.get("/", getOverviewController);
