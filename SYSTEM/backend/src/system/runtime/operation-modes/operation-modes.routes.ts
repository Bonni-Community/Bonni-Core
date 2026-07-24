import { Router } from "express";

import { getOperationModesStatusController } from "./operation-modes.controller.js";

export const systemOperationModesRouter = Router();

systemOperationModesRouter.get("/", getOperationModesStatusController);
systemOperationModesRouter.get("/status", getOperationModesStatusController);
