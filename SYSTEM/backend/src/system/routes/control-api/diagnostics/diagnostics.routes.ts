import { Router } from "express";

import { getDiagnosticsController } from "./diagnostics.controller.js";

export const systemDiagnosticsRouter = Router();

systemDiagnosticsRouter.get("/", getDiagnosticsController);
