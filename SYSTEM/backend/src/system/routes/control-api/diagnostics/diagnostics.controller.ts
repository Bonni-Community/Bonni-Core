import type { NextFunction, Request, Response } from "express";

import {
  getSystemDiagnostics,
  getSystemDiagnosticsLogFile,
  getSystemDiagnosticsLogs,
} from "./diagnostics.service.js";

export function getDiagnosticsController(_req: Request, res: Response) {
  res.json(getSystemDiagnostics());
}

export async function getDiagnosticsLogsController(req: Request, res: Response, next: NextFunction) {
  try {
    const stream = String(req.query.stream || "").toLowerCase();
    if (req.query.download === "1" || req.query.download === "true") {
      const selected = stream === "error" ? "error" : "log";
      const fileName = selected === "error" ? "bonni-core-error.txt" : "bonni-core.log";
      const content = await getSystemDiagnosticsLogFile(selected);
      res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
      res.type("text/plain").send(content);
      return;
    }

    const limit = Number(req.query.limit || 500);
    res.json(await getSystemDiagnosticsLogs(limit));
  } catch (error) {
    next(error);
  }
}
