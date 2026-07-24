import type { Request, Response } from "express";

import { getSystemSecurityPrivacyOverview } from "./overview.service.js";

export async function getSystemSecurityPrivacyOverviewController(_req: Request, res: Response) {
  const overview = await getSystemSecurityPrivacyOverview();
  res.json(overview);
}
