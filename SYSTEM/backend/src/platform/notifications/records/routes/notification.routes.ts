import { Router } from "express";
import { validate } from "../../../../core/core.js";
import { readRouteParam } from "../../../../core/http/route-param.js";
import { requireAuth } from "../../../security/identity/middleware/requireAuth.js";
import * as service from "../services/notification.service.js";
import { createNotificationSchema } from "../schemas/notification.schemas.js";

export const notificationRouter = Router();

notificationRouter.get(
  "/",
  requireAuth,
  async (req, res, next) => {
    try {
      const accountId = typeof req.query.accountId === "string"
        ? req.query.accountId
        : req.auth?.accountId;

      res.json(await service.listNotifications(accountId));
    } catch (error) {
      next(error);
    }
  }
);

notificationRouter.post(
  "/",
  requireAuth,
  validate(createNotificationSchema),
  async (req, res, next) => {
    try {
      res.json(await service.createNotification(req.body));
    } catch (error) {
      next(error);
    }
  }
);

notificationRouter.post(
  "/:id/read",
  requireAuth,
  async (req, res, next) => {
    try {
      res.json(await service.markNotificationRead(readRouteParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  }
);

notificationRouter.post(
  "/:id/archive",
  requireAuth,
  async (req, res, next) => {
    try {
      res.json(await service.archiveNotification(readRouteParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  }
);
