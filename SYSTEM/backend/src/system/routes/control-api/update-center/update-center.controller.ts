import type { Request, Response } from "express";

import {
  checkForCoreUpdate,
  getCoreUpdateCenterStatus,
  startCoreUpdateInstallation,
  startCoreUpdatePreparation,
  updateCoreUpdateSettings,
} from "./update-center.service.js";

export async function getCoreUpdateCenterStatusController(_req: Request, res: Response) {
  res.json(await getCoreUpdateCenterStatus());
}

export async function checkForCoreUpdateController(_req: Request, res: Response) {
  res.json(await checkForCoreUpdate());
}

export async function startCoreUpdatePreparationController(_req: Request, res: Response) {
  const result = await startCoreUpdatePreparation();
  res.status(result.ok ? 202 : 409).json(result);
}

export async function startCoreUpdateInstallationController(req: Request, res: Response) {
  const targetVersion = typeof req.body?.targetVersion === "string" ? req.body.targetVersion.trim() : undefined;
  const result = await startCoreUpdateInstallation(targetVersion || undefined);
  res.status(result.ok ? 202 : 409).json(result);
}

export async function updateCoreUpdateSettingsController(req: Request, res: Response) {
  res.json(await updateCoreUpdateSettings(req.body || {}));
}
