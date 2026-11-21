import type { Request, Response } from "express";

import { getSystemMonitoringStatus } from "./monitoring.service.js";
import { getSystemResources } from "./resource.service.js";

export async function getSystemMonitoringStatusController(_req: Request, res: Response) {
  res.json(await getSystemMonitoringStatus());
}

export async function getSystemResourcesController(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.json(await getSystemResources());
}
