import { Router } from "express";

import { getSystemStatusController } from "./system.controller.js";
import { systemBackupRouter } from "./backup/index.js";
import { systemDiagnosticsRouter } from "./diagnostics/index.js";
import { systemLicensesRouter } from "../../../platform/module-manager/licensing/index.js";
import { systemModulesRouter } from "../../../platform/module-manager/routes/index.js";
import { systemMonitoringRouter } from "./monitoring/index.js";
import { systemOperationModesRouter } from "../../runtime/operation-modes/index.js";
import { systemOverviewRouter } from "./overview/index.js";
import { systemRegistryRouter } from "../../registry/controllers/index.js";
import { systemRuntimeRouter } from "../../runtime/runtime/index.js";
import { runRegistrySyncToolController } from "../../registry/controllers/registry.controller.js";
import { systemSettingsRouter } from "./settings/index.js";
import { systemSecurityRouter } from "../../../platform/security/control/index.js";
import { systemSystemConfigRouter } from "../config/index.js";
import { systemUsersRouter } from "../../../platform/auth/users/index.js";
import { systemUpdateCenterRouter } from "./update-center/index.js";
import { systemJitsiRouter, systemWebBridgeRouter } from "./integrations/index.js";
import { systemNetworkPoliciesRouter } from "./network-policies/index.js";
import { requireAuth } from "../../../platform/security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../../platform/security/identity/middleware/requirePermission.js";

export const systemRouter = Router();

// Das Control-Center enthält Benutzer-, Schlüssel-, Backup-, Registry- und
// Installationsfunktionen. Es ist deshalb als Ganzes eine Admin-Oberfläche.
systemRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"));

systemRouter.get("/", getSystemStatusController);
systemRouter.get("/status", getSystemStatusController);
systemRouter.use("/overview", systemOverviewRouter);
systemRouter.use("/monitoring", systemMonitoringRouter);
systemRouter.use("/runtime", systemRuntimeRouter);
systemRouter.use("/modules", systemModulesRouter);
systemRouter.use("/operation-modes", systemOperationModesRouter);
systemRouter.use("/registry", systemRegistryRouter);
systemRouter.use("/diagnostics", systemDiagnosticsRouter);
systemRouter.use("/settings", systemSettingsRouter);
systemRouter.use("/system", systemSystemConfigRouter);
systemRouter.use("/security", systemSecurityRouter);
systemRouter.use("/user", systemUsersRouter);
systemRouter.use("/backup", systemBackupRouter);
systemRouter.use("/update-center", systemUpdateCenterRouter);
systemRouter.use("/licenses", systemLicensesRouter);
systemRouter.use("/integrations/jitsi", systemJitsiRouter);
systemRouter.use("/integrations/web", systemWebBridgeRouter);
systemRouter.use("/network-policies", systemNetworkPoliciesRouter);
systemRouter.post("/tools/registry-sync/run", runRegistrySyncToolController);
