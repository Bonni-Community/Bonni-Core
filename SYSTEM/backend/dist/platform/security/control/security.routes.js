import { Router } from "express";
import { systemDataClassificationRouter } from "./data-classification/index.js";
import { systemMasterKeyRouter } from "./master-key/index.js";
import { systemSecurityOverviewRouter } from "./overview/index.js";
import { emergencyBackendControlRouter } from "./emergency-backend/index.js";
export const systemSecurityRouter = Router();
systemSecurityRouter.use("/overview", systemSecurityOverviewRouter);
systemSecurityRouter.use("/data-classification", systemDataClassificationRouter);
systemSecurityRouter.use("/master-key", systemMasterKeyRouter);
systemSecurityRouter.use("/emergency-backend", emergencyBackendControlRouter);
// Die Security-Root zeigt direkt die Control-Center-Übersicht.
systemSecurityRouter.use("/", systemSecurityOverviewRouter);
