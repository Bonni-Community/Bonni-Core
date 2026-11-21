import { Router } from "express";
import { getSystemDataClassificationOverviewController } from "./data-classification.controller.js";
export const systemDataClassificationRouter = Router();
systemDataClassificationRouter.get("/", getSystemDataClassificationOverviewController);
