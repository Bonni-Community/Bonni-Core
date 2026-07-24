import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import * as accountService from "../services/account.service.js";

export const accountRouter = Router();

accountRouter.get("/accounts", requireAuth, requirePermission("SYSTEM_ADMIN"), async (_req, res, next) => {
  try {
    res.json(await accountService.listAccounts());
  } catch (error) {
    next(error);
  }
});

accountRouter.get("/roles", requireAuth, async (_req, res, next) => {
  try {
    res.json(await accountService.listRoles());
  } catch (error) {
    next(error);
  }
});

accountRouter.get("/permissions", requireAuth, async (_req, res, next) => {
  try {
    res.json(await accountService.listPermissions());
  } catch (error) {
    next(error);
  }
});
