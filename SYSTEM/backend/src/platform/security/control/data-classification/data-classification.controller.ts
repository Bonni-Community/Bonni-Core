import type { Request, Response } from "express";

import { getDataClassificationOverview } from "./data-classification.service.js";

export async function getSystemDataClassificationOverviewController(_req: Request, res: Response) {
  res.json(await getDataClassificationOverview());
}
