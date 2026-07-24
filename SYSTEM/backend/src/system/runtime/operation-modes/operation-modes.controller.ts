import type { Request, Response, NextFunction } from "express";

import { getOperationModesStatus } from "./operation-modes.service.js";

export async function getOperationModesStatusController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getOperationModesStatus());
  } catch (error) {
    next(error);
  }
}
