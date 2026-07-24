import type { Request, Response } from "express";
import { readRouteParam } from "../../../../core/http/route-param.js";

import {
  createSystemBackup,
  getSystemBackupOverview,
  requestSystemRestore,
  validateSystemBackup,
} from "./backup.service.js";

export async function getBackupOverviewController(_req: Request, res: Response) {
  res.json(await getSystemBackupOverview());
}

export async function createBackupController(req: Request, res: Response) {
  const result = await createSystemBackup({ reason: String(req.body?.reason || "manual") });
  res.status(result.ok ? 201 : 409).json(result);
}

export async function validateBackupController(req: Request, res: Response) {
  const result = await validateSystemBackup(readRouteParam(req.params.id));
  res.status(result.ok ? 200 : 400).json(result);
}

export async function requestRestoreController(req: Request, res: Response) {
  const id = readRouteParam(req.params.id);
  const result = await requestSystemRestore(id, String(req.body?.confirmation || ""));
  res.status(result.ok ? 202 : 400).json(result);
}
