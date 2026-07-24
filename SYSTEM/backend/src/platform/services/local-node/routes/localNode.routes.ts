import { Router } from "express";
import { validate } from "../../../../core/core.js";
import { requireAuth } from "../../../security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../../security/identity/middleware/requirePermission.js";
import * as service from "../services/localNode.service.js";
import {
  createLocalNodeSchema,
  emergencyModeSchema,
  heartbeatSchema,
  markQueueItemSchema,
  offlineQueueItemSchema,
  updateLocalNodeSchema
} from "../schemas/localNode.schemas.js";

export const localNodeRouter = Router();

localNodeRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    res.json(await service.listLocalNodes());
  } catch (error) {
    next(error);
  }
});

localNodeRouter.post(
  "/",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(createLocalNodeSchema),
  async (req, res, next) => {
    try {
      res.json(await service.createLocalNode(req.body));
    } catch (error) {
      next(error);
    }
  }
);

localNodeRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    res.json(await service.getLocalNode(req.params.id));
  } catch (error) {
    next(error);
  }
});

localNodeRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(updateLocalNodeSchema),
  async (req, res, next) => {
    try {
      res.json(await service.updateLocalNode(req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  }
);

localNodeRouter.get("/:id/status", requireAuth, async (req, res, next) => {
  try {
    res.json(await service.getStatus(req.params.id));
  } catch (error) {
    next(error);
  }
});

localNodeRouter.post(
  "/:id/heartbeat",
  requireAuth,
  validate(heartbeatSchema),
  async (req, res, next) => {
    try {
      res.json(await service.heartbeat(req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  }
);

localNodeRouter.patch(
  "/:id/emergency-mode",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(emergencyModeSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.setEmergencyMode(
          req.params.id,
          req.body.enabled,
          req.body.reason
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

localNodeRouter.get("/:id/offline-queue", requireAuth, async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await service.listOfflineQueue(req.params.id, status));
  } catch (error) {
    next(error);
  }
});

localNodeRouter.post(
  "/:id/offline-queue",
  requireAuth,
  validate(offlineQueueItemSchema),
  async (req, res, next) => {
    try {
      res.json(await service.addOfflineQueueItem(req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  }
);

localNodeRouter.patch(
  "/offline-queue/:queueItemId",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(markQueueItemSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.markQueueItem(
          req.params.queueItemId,
          req.body.status,
          req.body.errorMessage
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

localNodeRouter.post("/:id/sync", requireAuth, async (req, res, next) => {
  try {
    res.json(await service.syncLocalNode(req.params.id));
  } catch (error) {
    next(error);
  }
});
