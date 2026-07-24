import { Router } from "express";
import { requireAuth } from "../../security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../security/identity/middleware/requirePermission.js";
import { readRouteParam } from "../../../core/http/route-param.js";

import { listRegisteredModules } from "../loader/index.js";
import { listModuleManifests } from "../manifests/index.js";
import {
  activateModulePackage,
  deactivateModulePackage,
  deleteModulePackage,
  getModuleInstallPlan,
  installModulePackage,
  listModulePackages,
  uninstallModulePackage,
} from "../install/index.js";
import { listInstalledModules } from "../registry/index.js";
import { listSystemModules, syncDefaultSystemModules } from "../registry/core-module-registry.service.js";

export const systemModulesRouter = Router();

// Paket-Metadaten werden vom angemeldeten App-Host benötigt. Installations-
// und Lebenszyklus-Aktionen bleiben ausschließlich System-Administratoren
// vorbehalten.
systemModulesRouter.use(requireAuth);
const requireSystemAdmin = requirePermission("SYSTEM_ADMIN");

systemModulesRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ modules: await listSystemModules() });
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.post("/sync", requireSystemAdmin, async (_req, res, next) => {
  try {
    const result = await syncDefaultSystemModules();
    res.json({ ...result, ok: true, modules: await listSystemModules() });
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.get("/packages", async (_req, res, next) => {
  try {
    res.json({ ok: true, packages: await listModulePackages(), modules: await listModulePackages() });
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.get("/installed", async (_req, res, next) => {
  try {
    res.json({ ok: true, modules: await listInstalledModules() });
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.get("/manifests", async (_req, res, next) => {
  try {
    res.json({ ok: true, manifests: await listModuleManifests() });
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.get("/runtime", async (_req, res, next) => {
  try {
    res.json({ ok: true, modules: await listRegisteredModules() });
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.get("/packages/:key/install-plan", requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await getModuleInstallPlan(readRouteParam(req.params.key)));
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.post("/packages/:key/install", requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await installModulePackage(readRouteParam(req.params.key)));
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.post("/packages/:key/activate", requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await activateModulePackage(readRouteParam(req.params.key)));
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.post("/packages/:key/deactivate", requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await deactivateModulePackage(readRouteParam(req.params.key)));
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.post("/packages/:key/uninstall", requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await uninstallModulePackage(readRouteParam(req.params.key)));
  } catch (error) {
    next(error);
  }
});

systemModulesRouter.delete("/packages/:key", requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await deleteModulePackage(readRouteParam(req.params.key)));
  } catch (error) {
    next(error);
  }
});
