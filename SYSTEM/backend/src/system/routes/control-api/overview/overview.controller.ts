import type { Request, Response } from "express";

import { getSystemOverview } from "./overview.service.js";

export async function getOverviewController(_req: Request, res: Response) {
  res.json(await getSystemOverview());
}
