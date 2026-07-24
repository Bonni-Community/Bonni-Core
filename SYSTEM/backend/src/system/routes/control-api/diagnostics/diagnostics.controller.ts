import type { Request, Response } from "express";

import { getSystemDiagnostics } from "./diagnostics.service.js";

export function getDiagnosticsController(_req: Request, res: Response) {
  res.json(getSystemDiagnostics());
}
