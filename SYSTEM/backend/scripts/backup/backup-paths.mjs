import fs from "node:fs/promises";
import path from "node:path";

const BACKUP_ID_PATTERN = /^backup-[a-z0-9._-]+$/iu;
const MAX_FOLDER_DEPTH = 8;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)/iu;

export class BackupFolderError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validSegment(name) {
  return /^[\p{L}\p{N}_ .-]{1,120}$/u.test(name)
    && !/[. ]$/u.test(name) && !WINDOWS_DEVICE.test(name);
}

function validGroup(name) {
  return validSegment(name) && !BACKUP_ID_PATTERN.test(name);
}

async function prepareRoot(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return fs.realpath(root);
}

async function openDirectory(parent, name, create) {
  const directory = path.join(parent, name);
  if (create) {
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const info = await fs.lstat(directory).catch(error => {
    if (error.code !== "ENOENT") throw error;
    throw new BackupFolderError("BACKUP_FOLDER_NOT_FOUND", 404, "Der Ordner im Backup-Bereich wurde nicht gefunden.");
  });
  if (info.isSymbolicLink()) {
    throw new BackupFolderError("BACKUP_LINK_FORBIDDEN", 403, "Verknüpfungen im Backup-Bereich können nicht geöffnet werden.");
  }
  if (!info.isDirectory()) {
    throw new BackupFolderError("BACKUP_FOLDER_REQUIRED", 400, "Dieser Pfad führt zu einer Datei. Gib einen Ordner an.");
  }
  const real = await fs.realpath(directory);
  if (path.relative(directory, real)) {
    throw new BackupFolderError("BACKUP_LINK_FORBIDDEN", 403, "Verknüpfungen im Backup-Bereich können nicht geöffnet werden.");
  }
  return real;
}

function folderSegments(relativePath, forWriting) {
  if (typeof relativePath !== "string" || relativePath.length > (forWriting ? 512 : 2048)) {
    throw new BackupFolderError("INVALID_BACKUP_FOLDER", 400, "Ungültiger Pfad im Backup-Bereich.");
  }
  const segments = relativePath ? relativePath.split("/") : [];
  if (segments.length > (forWriting ? MAX_FOLDER_DEPTH : 32)
    || segments.some(name => !(forWriting ? validGroup(name) : validSegment(name)))) {
    throw new BackupFolderError("INVALID_BACKUP_FOLDER", 400, forWriting
      ? "Wähle einen gültigen Zielordner im Backup-Bereich außerhalb einzelner Sicherungen."
      : "Ungültiger Pfad im Backup-Bereich.");
  }
  return segments;
}

export async function resolveBackupFolder(root, relativePath = "", { create = false } = {}) {
  const segments = folderSegments(relativePath, create);
  const backupRoot = await prepareRoot(root);
  let absolutePath = backupRoot;
  for (const name of segments) absolutePath = await openDirectory(absolutePath, name, create);
  return { root: backupRoot, absolutePath, relativePath };
}

export async function resolveBackupWorkspaceEntry(root, relativePath, { directory = false } = {}) {
  if (typeof relativePath !== "string" || relativePath.length > 633) {
    throw new BackupFolderError("INVALID_BACKUP_FOLDER", 400, "Ungültiger Pfad im Backup-Bereich.");
  }
  const split = relativePath.lastIndexOf("/");
  const name = relativePath.slice(split + 1);
  const parentPath = split === -1 ? "" : relativePath.slice(0, split);
  if (directory) folderSegments(relativePath, true);
  else folderSegments(parentPath, true);
  if (!validGroup(name) || relativePath.startsWith("/")) {
    throw new BackupFolderError("INVALID_BACKUP_FOLDER", 400, "Gib einen Datei- oder Ordnernamen außerhalb einzelner Sicherungen an.");
  }
  const parent = await resolveBackupFolder(root, parentPath);
  return { absolutePath: path.join(parent.absolutePath, name), relativePath };
}

export async function listBackupLocations(root) {
  const backupRoot = await prepareRoot(root);
  const locations = [];
  async function visit(directory, groups) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const isBackup = BACKUP_ID_PATTERN.test(entry.name);
      if (!isBackup && (groups.length >= MAX_FOLDER_DEPTH || !validGroup(entry.name))) continue;
      const folder = await openDirectory(directory, entry.name, false).catch(error => {
        if (error instanceof BackupFolderError || ["EACCES", "EPERM", "ENOENT"].includes(error.code)) return null;
        throw error;
      });
      if (!folder) continue;
      if (isBackup) {
        locations.push({ id: entry.name, directory: groups.join("/"), absolutePath: folder });
      } else {
        await visit(folder, [...groups, entry.name]);
      }
    }
  }
  await visit(backupRoot, []);
  return locations;
}

export async function findBackupLocation(root, id) {
  if (!BACKUP_ID_PATTERN.test(id)) {
    throw new BackupFolderError("INVALID_BACKUP_ID", 400, "Ungültige Backup-ID.");
  }
  const matches = (await listBackupLocations(root)).filter(entry => entry.id === id);
  if (matches.length > 1) {
    throw new BackupFolderError("AMBIGUOUS_BACKUP_ID", 409, "Diese Backup-ID kommt in mehreren Ordnern vor.");
  }
  const match = matches[0];
  if (match) {
    const relative = [match.directory, id].filter(Boolean).join("/");
    const { absolutePath } = await resolveBackupFolder(root, relative);
    return { ...match, absolutePath };
  }
}
