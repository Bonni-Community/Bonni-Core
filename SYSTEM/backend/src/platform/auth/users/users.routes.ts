import { Router } from "express";
import { erasureRouter } from "./erasure.routes.js";
import { nfcManagementRouter } from "../../../core/modules/security/nfc/routes.js";
import { presenceManagementRouter } from "../../../core/modules/security/presence/routes.js";

import { currentUserMiddleware } from "../middleware/current-user.middleware.js";
import { requireAuth } from "../../security/identity/middleware/requireAuth.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../security/identity/middleware/requirePermission.js";
import {
  createLocalMemberController,
  deleteLocalMemberAccountController,
  getMemberDetailsController,
  getUsersOverviewController,
  updateLocalMemberAccessController,
  updateLocalMemberProfileController,
  updateMemberByIdController,
} from "./users.controller.js";

export const systemUsersRouter = Router();

// Die System-Routen werden im Plattform-Backend vor den allgemeinen
// Auth-Routen registriert. Der Benutzer-Router löst den Bearer-Token deshalb
// selbst auf, damit schreibende Benutzeraktionen immer einen aktuellen User haben.
systemUsersRouter.use(currentUserMiddleware);
systemUsersRouter.use(requireAuth);
systemUsersRouter.use("/erasure", erasureRouter);

const requireUserManager = requireAnyPermission(
  "SYSTEM_ADMIN",
  "auth.users.write",
);

systemUsersRouter.get("/", requireUserManager, getUsersOverviewController);
systemUsersRouter.get("/list", requireUserManager, getUsersOverviewController);
systemUsersRouter.get("/overview", requireUserManager, getUsersOverviewController);
systemUsersRouter.use("/presence", requireUserManager, presenceManagementRouter);
systemUsersRouter.get("/members/:memberId", requireUserManager, getMemberDetailsController);
systemUsersRouter.use("/members/:memberId/nfc", requireUserManager, nfcManagementRouter);
systemUsersRouter.post("/", requireUserManager, createLocalMemberController);
systemUsersRouter.patch("/members/:memberId", requireUserManager, updateMemberByIdController);
systemUsersRouter.patch("/:accountId/access", requirePermission("SYSTEM_ADMIN"), updateLocalMemberAccessController);
systemUsersRouter.patch("/:accountId", requirePermission("SYSTEM_ADMIN"), updateLocalMemberProfileController);
systemUsersRouter.delete("/:accountId", requirePermission("SYSTEM_ADMIN"), deleteLocalMemberAccountController);
