import type { Request, Response } from "express";

import { getSystemStatus } from "./system.service.js";

export function getSystemStatusController(_req: Request, res: Response) {
  res.json(getSystemStatus());
}

