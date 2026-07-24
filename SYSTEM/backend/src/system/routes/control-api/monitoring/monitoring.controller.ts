import type { Request, Response } from "express";

import { getSystemMonitoringStatus } from "./monitoring.service.js";

export async function getSystemMonitoringStatusController(_req: Request, res: Response) {
  res.json(await getSystemMonitoringStatus());
}
