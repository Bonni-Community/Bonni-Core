import type { Request, Response } from "express";
import { readRouteParam } from "../../../../core/http/route-param.js";

import {
  createSystemBackup,
  getSystemBackupOverview,
  listSystemBackupFolder,
  requestSystemRestore,
  validateSystemBackup,
} from "./backup.service.js";
import {
  copyBackupWorkspaceEntry,
  createBackupWorkspaceFolder,
  readBackupWorkspaceFile,
  removeBackupWorkspaceFile,
  removeBackupWorkspaceFolder,
  removeBackupWorkspaceTree,
  saveBackupWorkspaceFile,
  touchBackupWorkspaceFile,
} from "./backup-workspace.service.js";

export async function getBackupOverviewController(_req: Request, res: Response) {
  res.json(await getSystemBackupOverview());
}

export async function createBackupController(req: Request, res: Response) {
  const result = await createSystemBackup({ reason: String(req.body?.reason || "manual"), directory: req.body?.directory });
  res.status(result.ok ? 201 : 409).json(result);
}

export async function listBackupFolderController(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  res.json(await listSystemBackupFolder(req.query.path, req.query.details === "true"));
}

export async function createBackupFolderController(req: Request, res: Response) {
  res.status(201).json(await createBackupWorkspaceFolder(req.body?.path, req.body?.parents === true));
}

export async function removeBackupFolderController(req: Request, res: Response) {
  res.json(await removeBackupWorkspaceFolder(req.body?.path));
}

export async function readBackupFileController(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  res.json(await readBackupWorkspaceFile(req.query.path));
}

export async function touchBackupFileController(req: Request, res: Response) {
  res.json(await touchBackupWorkspaceFile(req.body?.path));
}

export async function saveBackupFileController(req: Request, res: Response) {
  const { path, text, revision } = req.body ?? {};
  res.json(await saveBackupWorkspaceFile(path, text, revision));
}

export async function removeBackupFileController(req: Request, res: Response) {
  const { path, recursive, force } = req.body ?? {};
  res.json(await (recursive === true
    ? removeBackupWorkspaceTree(path, force === true)
    : removeBackupWorkspaceFile(path, force === true)));
}

export async function copyBackupEntryController(req: Request, res: Response) {
  const { source, target, recursive } = req.body ?? {};
  res.status(201).json(await copyBackupWorkspaceEntry(source, target, recursive === true));
}

export async function validateBackupController(req: Request, res: Response) {
  const result = await validateSystemBackup(readRouteParam(req.params.id));
  res.status(result.ok ? 200 : 400).json(result);
}

export async function requestRestoreController(req: Request, res: Response) {
  const id = readRouteParam(req.params.id);
  const result = await requestSystemRestore(id, String(req.body?.confirmation || ""));
  res.status(result.ok ? 202 : 400).json(result);
}
