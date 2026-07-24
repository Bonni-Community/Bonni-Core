import type { Request, Response, NextFunction } from "express";

import {
  getAuthSettingsOverview,
  getSystemSettingsOverview,
} from "./settings.service.js";

export async function getSettingsController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getSystemSettingsOverview());
  } catch (error) {
    next(error);
  }
}

export async function getAuthSettingsController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ ok: true, area: "settings/auth", auth: await getAuthSettingsOverview() });
  } catch (error) {
    next(error);
  }
}
