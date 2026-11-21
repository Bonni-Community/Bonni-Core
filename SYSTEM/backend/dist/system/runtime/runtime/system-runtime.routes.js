import { moduleServicesRegistry } from '../../../core/module-services/module-services-runtime.js';
import { Router } from "express";
import { getSystemCompatibilityStatusController, activateSystemRuntimeModuleController, applySystemRuntimeModuleInstallPlanController, deactivateSystemRuntimeModuleController, getSystemRuntimeModuleDetailsController, getSystemRuntimeModuleInstallPlanController, getSystemRuntimeModuleLifecycleStatusController, getSystemRuntimeModulesController, getSystemRuntimeStatusController, runSystemRuntimeModuleLifecycleActionController, } from "./system-runtime.controller.js";
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
// Authentication and SYSTEM_ADMIN are enforced by the parent system router and again by the registry.
systemRuntimeRouter.get('/modules/:key/maintenance', async (req, res, next) => {
    try {
        res.json(await moduleServicesRegistry.invokeControl(String(req.params.key), 'status', {}));
    }
    catch (error) {
        next(error);
    }
});
systemRuntimeRouter.post('/modules/:key/maintenance/:operation', async (req, res, next) => {
    try {
        res.json(await moduleServicesRegistry.invokeControl(String(req.params.key), String(req.params.operation), req.body ?? {}));
    }
    catch (error) {
        next(error);
    }
});
