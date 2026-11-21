import { readRouteParam } from "../../../../core/http/route-param.js";
import { createSystemBackup, getSystemBackupOverview, listSystemBackupFolder, requestSystemRestore, validateSystemBackup, } from "./backup.service.js";
import { copyBackupWorkspaceEntry, createBackupWorkspaceFolder, readBackupWorkspaceFile, removeBackupWorkspaceFile, removeBackupWorkspaceFolder, removeBackupWorkspaceTree, saveBackupWorkspaceFile, touchBackupWorkspaceFile, } from "./backup-workspace.service.js";
export async function getBackupOverviewController(_req, res) {
    res.json(await getSystemBackupOverview());
}
export async function createBackupController(req, res) {
    const result = await createSystemBackup({ reason: String(req.body?.reason || "manual"), directory: req.body?.directory });
    res.status(result.ok ? 201 : 409).json(result);
}
export async function listBackupFolderController(req, res) {
    res.set("Cache-Control", "no-store");
    res.json(await listSystemBackupFolder(req.query.path, req.query.details === "true"));
}
export async function createBackupFolderController(req, res) {
    res.status(201).json(await createBackupWorkspaceFolder(req.body?.path, req.body?.parents === true));
}
export async function removeBackupFolderController(req, res) {
    res.json(await removeBackupWorkspaceFolder(req.body?.path));
}
export async function readBackupFileController(req, res) {
    res.set("Cache-Control", "no-store");
    res.json(await readBackupWorkspaceFile(req.query.path));
}
export async function touchBackupFileController(req, res) {
    res.json(await touchBackupWorkspaceFile(req.body?.path));
}
export async function saveBackupFileController(req, res) {
    const { path, text, revision } = req.body ?? {};
    res.json(await saveBackupWorkspaceFile(path, text, revision));
}
export async function removeBackupFileController(req, res) {
    const { path, recursive, force } = req.body ?? {};
    res.json(await (recursive === true
        ? removeBackupWorkspaceTree(path, force === true)
        : removeBackupWorkspaceFile(path, force === true)));
}
export async function copyBackupEntryController(req, res) {
    const { source, target, recursive } = req.body ?? {};
    res.status(201).json(await copyBackupWorkspaceEntry(source, target, recursive === true));
}
export async function validateBackupController(req, res) {
    const result = await validateSystemBackup(readRouteParam(req.params.id));
    res.status(result.ok ? 200 : 400).json(result);
}
export async function requestRestoreController(req, res) {
    const id = readRouteParam(req.params.id);
    const result = await requestSystemRestore(id, String(req.body?.confirmation || ""));
    res.status(result.ok ? 202 : 400).json(result);
}
