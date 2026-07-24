import { Router } from "express";

import { currentUserMiddleware } from "../middleware/current-user.middleware.js";
import { requireAuth } from "../../security/identity/middleware/requireAuth.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../security/identity/middleware/requirePermission.js";
import {
  createKontorMeetingController,
  downloadKontorMeetingProtocolController,
  getKontorMeetingAttendanceController,
  listKontorMeetingsController,
  updateKontorMeetingDraftController,
  updateKontorMeetingAttendanceController,
  uploadKontorMeetingProtocolController,
} from "./meetings.controller.js";
import {
  createLocalMemberController,
  getMemberDetailsController,
  getUsersOverviewController,
  updateLocalMemberProfileController,
  updateMemberByIdController,
} from "./users.controller.js";

export const systemUsersRouter = Router();

// Die System-Routen werden im Plattform-Backend vor den allgemeinen
// Auth-Routen registriert. Der Benutzer-Router löst den Bearer-Token deshalb
// selbst auf, damit schreibende Benutzeraktionen immer einen aktuellen User haben.
systemUsersRouter.use(currentUserMiddleware);
systemUsersRouter.use(requireAuth);

// Kontor-Manager dürfen ausschließlich die bereits in den Services nochmals
// geprüften Vereinsfunktionen verwenden. Die eigentliche Core-Kontoverwaltung
// bleibt weiterhin dem System-Administrator vorbehalten.
const requireKontorManager = requireAnyPermission(
  "SYSTEM_ADMIN",
  "module.app-kontorapp.manager",
);

systemUsersRouter.get("/", requireKontorManager, getUsersOverviewController);
systemUsersRouter.get("/list", requireKontorManager, getUsersOverviewController);
systemUsersRouter.get("/overview", requireKontorManager, getUsersOverviewController);
systemUsersRouter.get("/meetings", requireKontorManager, listKontorMeetingsController);
systemUsersRouter.post("/meetings", requireKontorManager, createKontorMeetingController);
systemUsersRouter.patch("/meetings/:meetingId/draft", requireKontorManager, updateKontorMeetingDraftController);
systemUsersRouter.get("/meetings/:meetingId/protocol", requireKontorManager, downloadKontorMeetingProtocolController);
systemUsersRouter.put("/meetings/:meetingId/protocol", requireKontorManager, uploadKontorMeetingProtocolController);
systemUsersRouter.get("/meetings/:meetingId/attendance", requireKontorManager, getKontorMeetingAttendanceController);
systemUsersRouter.patch("/meetings/:meetingId/attendance/:memberId", requireKontorManager, updateKontorMeetingAttendanceController);
systemUsersRouter.get("/members/:memberId", requireKontorManager, getMemberDetailsController);
systemUsersRouter.post("/", requireKontorManager, createLocalMemberController);
systemUsersRouter.patch("/members/:memberId", requireKontorManager, updateMemberByIdController);
systemUsersRouter.patch("/:accountId", requirePermission("SYSTEM_ADMIN"), updateLocalMemberProfileController);
