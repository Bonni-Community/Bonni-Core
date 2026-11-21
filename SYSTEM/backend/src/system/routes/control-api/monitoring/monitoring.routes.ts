import { Router } from "express";

import { getSystemMonitoringStatusController, getSystemResourcesController } from "./monitoring.controller.js";

export const systemMonitoringRouter = Router();

systemMonitoringRouter.get("/", getSystemMonitoringStatusController);
systemMonitoringRouter.get("/status", getSystemMonitoringStatusController);
systemMonitoringRouter.get("/resources", getSystemResourcesController);
