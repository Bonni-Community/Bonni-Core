import { randomUUID } from "node:crypto";
import { Router } from "express";
import { readLoginDiagnostics } from "../../../../platform/auth/login-diagnostics.js";
import { readCoreLiveLog } from "../../../../core/logger/coreLogStorage.js";
import { recordCoreDiagnostic } from "../../../../core/logger/diagnostic-journal.js";

import {
  getDiagnosticErrorController,
  getDiagnosticsController,
  getDiagnosticsLogsController,
} from "./diagnostics.controller.js";

export const systemDiagnosticsRouter = Router();

systemDiagnosticsRouter.get("/", getDiagnosticsController);
systemDiagnosticsRouter.get("/logs", getDiagnosticsLogsController);
systemDiagnosticsRouter.get("/errors/:errorId", getDiagnosticErrorController);
systemDiagnosticsRouter.post("/test", (_req, res) => {
  const operationId = randomUUID();
  const code = "DIAGNOSTIC_TEST_ENTRY";
  const recorded = recordCoreDiagnostic({
    moduleId: "core",
    level: "error",
    code,
    workflow: "terminal-test",
    phase: "terminal-test-error",
    operationId,
  });
  if (!recorded) {
    res.status(503).json({ ok: false, message: "Das Diagnosejournal ist gerade nicht beschreibbar." });
    return;
  }
  res.status(201).json({ ok: true, code, operationId });
});
systemDiagnosticsRouter.get("/live", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readCoreLiveLog());
  } catch (error) {
    next(error);
  }
});
systemDiagnosticsRouter.get("/logins", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readLoginDiagnostics());
  } catch (error) {
    next(error);
  }
});
