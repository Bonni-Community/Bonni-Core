import { Router } from "express";
import { scanUpdateInbox } from "./update-inbox.service.js";
import { requireAuth } from "../../security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../security/identity/middleware/requirePermission.js";

export const updateRouter = Router();

updateRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"));

updateRouter.get("/", async (_req, res, next) => {
  try { res.json(await scanUpdateInbox()); } catch (error) { next(error); }
});

updateRouter.get("/scan", async (_req, res, next) => {
  try { res.json(await scanUpdateInbox()); } catch (error) { next(error); }
});
