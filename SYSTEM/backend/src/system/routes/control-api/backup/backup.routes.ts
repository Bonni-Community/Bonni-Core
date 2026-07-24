import { Router } from "express";

import {
  createBackupController,
  getBackupOverviewController,
  requestRestoreController,
  validateBackupController,
} from "./backup.controller.js";

export const systemBackupRouter = Router();

systemBackupRouter.get("/", getBackupOverviewController);
systemBackupRouter.post("/", createBackupController);
systemBackupRouter.post("/:id/validate", validateBackupController);
systemBackupRouter.post("/:id/restore", requestRestoreController);
