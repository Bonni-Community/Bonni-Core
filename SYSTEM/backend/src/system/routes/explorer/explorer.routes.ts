import express, { Router } from "express";

import { requireAuth } from "../../../platform/security/identity/middleware/requireAuth.js";
import { requirePermission } from "../../../platform/security/identity/middleware/requirePermission.js";
import {
  createArchiveDirectoryController,
  createLogicalArchiveFolderController,
  approveAccountLinkController,
  getAccountLinksController,
  getArchiveWorkspaceController,
  grantArchiveFolderAccessController,
  downloadArchiveFileController,
  listArchiveFolderGrantsController,
  listArchiveDirectoryController,
  listLogicalArchiveFolderController,
  rejectAccountLinkController,
  requestAccountLinkController,
  renameArchiveFileDisplayNameController,
  revokeArchiveFolderGrantController,
  searchArchiveWorkspaceController,
  uploadArchiveFileController,
} from "./explorer.controller.js";

export const systemExplorerRouter = Router();

systemExplorerRouter.use(requireAuth);

systemExplorerRouter.get("/", requirePermission("SYSTEM_ADMIN"), listArchiveDirectoryController);
systemExplorerRouter.post("/folders", requirePermission("SYSTEM_ADMIN"), createArchiveDirectoryController);

systemExplorerRouter.get("/workspace", getArchiveWorkspaceController);
systemExplorerRouter.get("/workspace/account-links", getAccountLinksController);
systemExplorerRouter.post("/workspace/account-links", requestAccountLinkController);
systemExplorerRouter.post("/workspace/account-links/:requestId/approve", approveAccountLinkController);
systemExplorerRouter.delete("/workspace/account-links/:requestId", rejectAccountLinkController);
systemExplorerRouter.get("/workspace/search", searchArchiveWorkspaceController);
systemExplorerRouter.post("/workspace/folders", createLogicalArchiveFolderController);
systemExplorerRouter.post(
  "/workspace/folders/:folderId/files",
  express.raw({
    type: "application/octet-stream",
    limit: Number(process.env.ARCHIVE_UPLOAD_LIMIT_BYTES || 25 * 1024 * 1024),
  }),
  uploadArchiveFileController,
);
systemExplorerRouter.get("/workspace/folders/:folderId", listLogicalArchiveFolderController);
systemExplorerRouter.patch("/workspace/files/:fileId", renameArchiveFileDisplayNameController);
systemExplorerRouter.get("/workspace/files/:fileId/download", downloadArchiveFileController);
systemExplorerRouter.get("/workspace/folders/:folderId/grants", listArchiveFolderGrantsController);
systemExplorerRouter.post("/workspace/folders/:folderId/grants", grantArchiveFolderAccessController);
systemExplorerRouter.delete(
  "/workspace/folders/:folderId/grants/:grantId",
  revokeArchiveFolderGrantController,
);
