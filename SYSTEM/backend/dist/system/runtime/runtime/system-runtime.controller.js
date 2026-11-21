import { readRouteParam } from "../../../core/http/route-param.js";
import { getSystemCompatibilityStatus, activateSystemRuntimeModule, applySystemRuntimeModuleInstallPlan, deactivateSystemRuntimeModule, getSystemRuntimeModuleDetails, getSystemRuntimeModuleInstallPlan, getSystemRuntimeModuleLifecycleStatus, getSystemRuntimeModules, getSystemRuntimeStatus, runSystemRuntimeModuleLifecycleAction, } from "./system-runtime.service.js";
export async function getSystemRuntimeStatusController(_req, res) {
    res.json(await getSystemRuntimeStatus());
}
export async function getSystemRuntimeModulesController(_req, res) {
    res.json(await getSystemRuntimeModules());
}
export async function getSystemCompatibilityStatusController(_req, res) {
    res.json(await getSystemCompatibilityStatus());
}
export async function getSystemRuntimeModuleDetailsController(req, res) {
    const result = await getSystemRuntimeModuleDetails(readRouteParam(req.params.key));
    if (!result.ok) {
        res.status(404).json(result);
        return;
    }
    res.json(result);
}
export async function getSystemRuntimeModuleInstallPlanController(req, res) {
    const result = await getSystemRuntimeModuleInstallPlan(readRouteParam(req.params.key));
    if (!result.ok) {
        res.status(400).json(result);
        return;
    }
    res.json(result);
}
export async function applySystemRuntimeModuleInstallPlanController(req, res) {
    const result = await applySystemRuntimeModuleInstallPlan(readRouteParam(req.params.key));
    if (!result.ok) {
        res.status(400).json(result);
        return;
    }
    res.json(result);
}
export async function activateSystemRuntimeModuleController(req, res) {
    const result = await activateSystemRuntimeModule(readRouteParam(req.params.key));
    if (!result.ok) {
        res.status(400).json(result);
        return;
    }
    res.json(result);
}
export async function deactivateSystemRuntimeModuleController(req, res) {
    const result = await deactivateSystemRuntimeModule(readRouteParam(req.params.key));
    if (!result.ok) {
        res.status(400).json(result);
        return;
    }
    res.json(result);
}
export async function getSystemRuntimeModuleLifecycleStatusController(req, res) {
    const result = await getSystemRuntimeModuleLifecycleStatus(readRouteParam(req.params.key));
    if (!result.ok) {
        res.status(404).json(result);
        return;
    }
    res.json(result);
}
export async function runSystemRuntimeModuleLifecycleActionController(req, res) {
    const result = await runSystemRuntimeModuleLifecycleAction(readRouteParam(req.params.key), readRouteParam(req.params.action), req.body || {});
    if (!result.ok) {
        res.status(400).json(result);
        return;
    }
    res.json(result);
}
