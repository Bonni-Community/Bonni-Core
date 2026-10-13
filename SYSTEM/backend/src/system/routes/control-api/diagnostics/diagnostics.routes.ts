import { Router } from "express";

import {
  getDiagnosticsController,
  getDiagnosticsLogsController,
} from "./diagnostics.controller.js";

export const systemDiagnosticsRouter = Router();

systemDiagnosticsRouter.get("/", getDiagnosticsController);
systemDiagnosticsRouter.get("/logs", getDiagnosticsLogsController);
