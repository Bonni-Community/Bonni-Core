import { Router } from "express";
import { validate } from "../../../../core/core.js";
import { requireAuth } from "../../../security/identity/middleware/requireAuth.js";
import * as service from "../services/admin.service.js";
import {
  createDeviceSchema,
  createPrinterSchema,
  createRoomSchema,
  settingSchema,
  toggleFeatureSchema
} from "../schemas/admin.schemas.js";

export const adminRouter = Router();

adminRouter.get(
  "/settings",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listSettings());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/settings",
  requireAuth,
  validate(settingSchema),
  async (req, res, next) => {
    try {
      res.json(await service.upsertSetting(req.body));
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  "/features",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listFeatures());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/features/:key/toggle",
  requireAuth,
  validate(toggleFeatureSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.toggleFeature(
          req.params.key,
          req.body.enabled
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  "/devices",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listDevices());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/devices",
  requireAuth,
  validate(createDeviceSchema),
  async (req, res, next) => {
    try {
      res.json(await service.createDevice(req.body));
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  "/rooms",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listRooms());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/rooms",
  requireAuth,
  validate(createRoomSchema),
  async (req, res, next) => {
    try {
      res.json(await service.createRoom(req.body));
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  "/printers",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listPrinters());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/printers",
  requireAuth,
  validate(createPrinterSchema),
  async (req, res, next) => {
    try {
      res.json(await service.createPrinter(req.body));
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/maintenance/enable",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.enableMaintenanceMode());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/maintenance/disable",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.disableMaintenanceMode());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/backup/create",
  requireAuth,
  async (req, res, next) => {
    try {
      res.json(
        await service.createBackup(req.auth?.accountId)
      );
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  "/backup",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listBackups());
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  "/seed/demo",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.seedDemoData());
    } catch (error) {
      next(error);
    }
  }
);
