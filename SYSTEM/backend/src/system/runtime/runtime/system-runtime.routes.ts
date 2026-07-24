import { Router } from "express";

import {
  getSystemCompatibilityStatusController,
  activateSystemRuntimeModuleController,
  applySystemRuntimeModuleInstallPlanController,
  deactivateSystemRuntimeModuleController,
  getSystemRuntimeModuleDetailsController,
  getSystemRuntimeModuleInstallPlanController,
  getSystemRuntimeModuleLifecycleStatusController,
  getSystemRuntimeModulesController,
  getSystemRuntimeStatusController,
  runSystemRuntimeModuleLifecycleActionController,
} from "./system-runtime.controller.js";

export const systemRuntimeRouter = Router();

systemRuntimeRouter.get("/", getSystemRuntimeStatusController);
systemRuntimeRouter.get("/status", getSystemRuntimeStatusController);
systemRuntimeRouter.get("/modules", getSystemRuntimeModulesController);

systemRuntimeRouter.get("/modules/:key", getSystemRuntimeModuleDetailsController);
systemRuntimeRouter.get("/modules/:key/install-plan", getSystemRuntimeModuleInstallPlanController);
systemRuntimeRouter.post("/modules/:key/install", applySystemRuntimeModuleInstallPlanController);
systemRuntimeRouter.post("/modules/:key/activate", activateSystemRuntimeModuleController);
systemRuntimeRouter.post("/modules/:key/deactivate", deactivateSystemRuntimeModuleController);
systemRuntimeRouter.get("/modules/:key/lifecycle", getSystemRuntimeModuleLifecycleStatusController);
systemRuntimeRouter.post("/modules/:key/lifecycle/:action", runSystemRuntimeModuleLifecycleActionController);

systemRuntimeRouter.get("/compatibility", getSystemCompatibilityStatusController);
