import { Router } from "express";
import { validate } from "../../../core/core.js";
import { readRouteParam } from "../../../core/http/route-param.js";
import { requireAuth } from "../../security/identity/middleware/requireAuth.js";
import * as service from "../services/timecapsule.service.js";
import {
  auditQuerySchema,
  exportAuditSchema,
  snapshotSchema
} from "../schemas/timecapsule.schemas.js";

export const timecapsuleRouter = Router();

timecapsuleRouter.get(
  "/logs",
  requireAuth,
  validate(auditQuerySchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.listLogs({
          module:
            typeof req.query.module === "string"
              ? req.query.module
              : undefined,

          level:
            typeof req.query.level === "string"
              ? req.query.level
              : undefined,

          entityType:
            typeof req.query.entityType === "string"
              ? req.query.entityType
              : undefined,

          entityId:
            typeof req.query.entityId === "string"
              ? req.query.entityId
              : undefined,

          from:
            typeof req.query.from === "string"
              ? req.query.from
              : undefined,

          to:
            typeof req.query.to === "string"
              ? req.query.to
              : undefined
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

timecapsuleRouter.get(
  "/timeline/:entityType/:entityId",
  requireAuth,
  async (req, res, next) => {
    try {
      res.json(
        await service.getTimeline(
          readRouteParam(req.params.entityType),
          readRouteParam(req.params.entityId)
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

timecapsuleRouter.post(
  "/export",
  requireAuth,
  validate(exportAuditSchema),
  async (req, res, next) => {
    try {
      res.json(await service.exportAudit(req.body));
    } catch (error) {
      next(error);
    }
  }
);

timecapsuleRouter.get(
  "/timecapsule/events",
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(await service.listTimeCapsuleEvents());
    } catch (error) {
      next(error);
    }
  }
);

timecapsuleRouter.post(
  "/timecapsule/snapshot",
  requireAuth,
  validate(snapshotSchema),
  async (req, res, next) => {
    try {
      res.json(await service.createSnapshot(req.body));
    } catch (error) {
      next(error);
    }
  }
);

timecapsuleRouter.get(
  "/timecapsule/recovery/:entityType/:entityId",
  requireAuth,
  async (req, res, next) => {
    try {
      res.json(
        await service.getRecovery(
          readRouteParam(req.params.entityType),
          readRouteParam(req.params.entityId)
        )
      );
    } catch (error) {
      next(error);
    }
  }
);
