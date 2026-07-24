import { Router } from "express";
import { validate } from "../../../../../core/core.js";
import { requireAuth } from "../../../../security/identity/middleware/requireAuth.js";
import * as service from "../services/task.service.js";
import {
  createTaskSchema,
  taskActionSchema,
  taskChecklistSchema,
  taskCommentSchema,
  updateTaskSchema
} from "../schemas/task.schemas.js";

export const taskRouter = Router();

taskRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    res.json(await service.listTasks());
  } catch (error) {
    next(error);
  }
});

taskRouter.post(
  "/",
  requireAuth,
  validate(createTaskSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.createTask({
          ...req.body,
          createdByAccountId: req.auth?.accountId
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.get("/board", requireAuth, async (_req, res, next) => {
  try {
    res.json(await service.getTaskBoard());
  } catch (error) {
    next(error);
  }
});

taskRouter.get("/calendar", requireAuth, async (_req, res, next) => {
  try {
    res.json(await service.getTaskCalendar());
  } catch (error) {
    next(error);
  }
});

taskRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    res.json(await service.getTask(req.params.id));
  } catch (error) {
    next(error);
  }
});

taskRouter.patch(
  "/:id",
  requireAuth,
  validate(updateTaskSchema),
  async (req, res, next) => {
    try {
      res.json(await service.updateTask(req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.post(
  "/:id/claim",
  requireAuth,
  validate(taskActionSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.claimTask(req.params.id, {
          ...req.body,
          accountId:
            req.body.accountId ?? req.auth?.accountId
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.post(
  "/:id/start",
  requireAuth,
  validate(taskActionSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.startTask(req.params.id, {
          ...req.body,
          accountId:
            req.body.accountId ?? req.auth?.accountId
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.post(
  "/:id/complete",
  requireAuth,
  validate(taskActionSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.completeTask(req.params.id, {
          ...req.body,
          accountId:
            req.body.accountId ?? req.auth?.accountId
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.post(
  "/:id/cancel",
  requireAuth,
  validate(taskActionSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.cancelTask(req.params.id, {
          ...req.body,
          accountId:
            req.body.accountId ?? req.auth?.accountId
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.post(
  "/:id/comments",
  requireAuth,
  validate(taskCommentSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.addComment(req.params.id, {
          ...req.body,
          accountId: req.auth?.accountId
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

taskRouter.post(
  "/:id/checklist",
  requireAuth,
  validate(taskChecklistSchema),
  async (req, res, next) => {
    try {
      res.json(
        await service.addChecklistItem(
          req.params.id,
          req.body
        )
      );
    } catch (error) {
      next(error);
    }
  }
);
