import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { BackupFolderError, resolveBackupFolder, resolveBackupWorkspaceEntry } from "../../../../../scripts/backup/backup-paths.mjs";
import { withPersistentSnapshotLock } from "../../../../core/storage/persistent-snapshot-lock.js";
import { systemBackupsRoot } from "./backup.service.js";
const MAX_TEXT_BYTES = 16_000;
async function entryInfo(absolutePath) {
    const info = await fs.lstat(absolutePath).catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    if (info && (info.isSymbolicLink() || path.relative(absolutePath, await fs.realpath(absolutePath)))) {
        throw new BackupFolderError("BACKUP_LINK_FORBIDDEN", 403, "Verknüpfungen im Backup-Bereich können nicht geöffnet werden.");
    }
    return info;
}
function sameEntry(left, right) {
    return right !== null && left.dev === right.dev && left.ino === right.ino;
}
async function openTextFile(absolutePath, writable = false, info) {
    if (info === undefined)
        info = await entryInfo(absolutePath);
    if (!info)
        return null;
    if (!info.isFile() || info.nlink !== 1) {
        throw new BackupFolderError("BACKUP_TEXT_FILE_REQUIRED", 400, "Gib eine reguläre Textdatei im Backup-Bereich an.");
    }
    const mode = writable ? constants.O_RDWR : constants.O_RDONLY;
    const handle = await fs.open(absolutePath, mode | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const current = await handle.stat();
        if (!current.isFile() || current.nlink !== 1 || !sameEntry(info, current)) {
            throw new BackupFolderError("BACKUP_TEXT_CHANGED", 409, "Die Datei wurde gleichzeitig geändert. Öffne sie erneut.");
        }
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
async function readText(handle) {
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead)
            break;
        length += bytesRead;
    }
    if (length > MAX_TEXT_BYTES)
        throw new BackupFolderError("BACKUP_TEXT_TOO_LARGE", 413, "Die Textdatei darf höchstens 16 KB groß sein.");
    const bytes = buffer.subarray(0, length);
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        throw new BackupFolderError("BACKUP_TEXT_ENCODING", 400, "Die Datei muss gültigen UTF-8-Text enthalten.");
    }
    if (text.includes("\0"))
        throw new BackupFolderError("BACKUP_TEXT_ENCODING", 400, "Die Datei muss gültigen UTF-8-Text enthalten.");
    return { text, revision: createHash("sha256").update(bytes).digest("hex") };
}
async function textState(absolutePath) {
    const handle = await openTextFile(absolutePath);
    if (!handle)
        return { text: "", revision: null };
    try {
        return await readText(handle);
    }
    finally {
        await handle.close();
    }
}
export async function createBackupWorkspaceFolder(relativePath, parents) {
    if (typeof relativePath !== "string")
        throw new BackupFolderError("INVALID_BACKUP_FOLDER", 400, "Gib einen Ordnerpfad an.");
    return withPersistentSnapshotLock("backup-terminal-mkdir", async () => {
        const root = systemBackupsRoot();
        if (parents) {
            const folder = await resolveBackupFolder(root, relativePath, { create: true });
            return { ok: true, path: folder.relativePath };
        }
        const entry = await resolveBackupWorkspaceEntry(root, relativePath, { directory: true });
        await fs.mkdir(entry.absolutePath, { mode: 0o700 }).catch((error) => {
            if (error.code !== "EEXIST")
                throw error;
            throw new BackupFolderError("BACKUP_ENTRY_EXISTS", 409, "Der Name ist in diesem Ordner bereits vergeben.");
        });
        return { ok: true, path: entry.relativePath };
    });
}
export async function removeBackupWorkspaceFolder(relativePath) {
    return withPersistentSnapshotLock("backup-terminal-rmdir", async () => {
        const entry = await resolveBackupWorkspaceEntry(systemBackupsRoot(), relativePath, { directory: true });
        const info = await entryInfo(entry.absolutePath);
        if (!info)
            throw new BackupFolderError("BACKUP_FOLDER_NOT_FOUND", 404, "Der Ordner im Backup-Bereich wurde nicht gefunden.");
        if (!info.isDirectory())
            throw new BackupFolderError("BACKUP_FOLDER_REQUIRED", 400, "Gib einen Ordner an.");
        // rmdir performs the emptiness check together with removal. A backup
        // reserved in this folder by another process cannot be removed here.
        await fs.rmdir(entry.absolutePath).catch((error) => {
            if (!["ENOTEMPTY", "EEXIST"].includes(error.code || ""))
                throw error;
            throw new BackupFolderError("BACKUP_FOLDER_NOT_EMPTY", 409, "Der Ordner ist noch gefüllt. rmdir löscht leere Ordner.");
        });
        return { ok: true, path: entry.relativePath };
    });
}
function missingEntry(error) {
    return (error instanceof BackupFolderError && error.code === "BACKUP_FOLDER_NOT_FOUND")
        || error?.code === "ENOENT";
}
async function resolveEntry(root, relativePath, force) {
    try {
        return await resolveBackupWorkspaceEntry(root, relativePath);
    }
    catch (error) {
        if (force && missingEntry(error))
            return null;
        throw error;
    }
}
async function collectWorkspaceEntries(root, entry, info, device, entries) {
    if (info.dev !== device || !(info.isDirectory() || (info.isFile() && info.nlink === 1))) {
        throw new BackupFolderError("BACKUP_ENTRY_UNSUPPORTED", 403, "Erlaubt sind reguläre Dateien und Ordner ohne Verknüpfungen im Backup-Bereich.");
    }
    entries.push({ ...entry, info });
    if (info.isDirectory()) {
        await resolveBackupWorkspaceEntry(root, entry.relativePath, { directory: true });
        for (const name of await fs.readdir(entry.absolutePath)) {
            const child = await resolveBackupWorkspaceEntry(root, `${entry.relativePath}/${name}`);
            const childInfo = await entryInfo(child.absolutePath);
            if (!childInfo)
                throw changedEntry();
            await collectWorkspaceEntries(root, child, childInfo, device, entries);
        }
    }
}
async function workspaceTree(root, entry, info) {
    const { absolutePath } = await resolveBackupFolder(root);
    const entries = [];
    await collectWorkspaceEntries(root, entry, info, (await fs.stat(absolutePath)).dev, entries);
    return entries;
}
function changedEntry() {
    return new BackupFolderError("BACKUP_ENTRY_CHANGED", 409, "Ein Eintrag wurde gleichzeitig geändert. Prüfe den Ordnerinhalt und versuche es erneut.");
}
export async function removeBackupWorkspaceTree(relativePath, force) {
    return withPersistentSnapshotLock("backup-terminal-rm-tree", async () => {
        const root = systemBackupsRoot();
        const entry = await resolveEntry(root, relativePath, force);
        const info = entry && await entryInfo(entry.absolutePath);
        if (!entry || !info) {
            if (force)
                return { ok: true, path: relativePath, removed: false };
            throw new BackupFolderError("BACKUP_ENTRY_NOT_FOUND", 404, "Der Eintrag im Backup-Bereich wurde nicht gefunden.");
        }
        const entries = await workspaceTree(root, entry, info);
        for (const item of entries.reverse()) {
            if (!sameEntry(item.info, await entryInfo(item.absolutePath)))
                throw changedEntry();
            if (item.info.isDirectory())
                await fs.rmdir(item.absolutePath);
            else
                await fs.unlink(item.absolutePath);
        }
        return { ok: true, path: entry.relativePath, removed: true };
    });
}
export async function copyBackupWorkspaceEntry(source, target, recursive) {
    return withPersistentSnapshotLock("backup-terminal-copy", async () => {
        const root = systemBackupsRoot();
        const sourceEntry = await resolveBackupWorkspaceEntry(root, source);
        const info = await entryInfo(sourceEntry.absolutePath);
        if (!info)
            throw new BackupFolderError("BACKUP_ENTRY_NOT_FOUND", 404, "Die Quelle im Backup-Bereich wurde nicht gefunden.");
        if (info.isDirectory() && !recursive) {
            throw new BackupFolderError("BACKUP_COPY_RECURSIVE_REQUIRED", 400, "Verwende cp -R, um einen Ordner mit Inhalt zu kopieren.");
        }
        const sourceName = path.basename(sourceEntry.absolutePath);
        let targetPath = target === "" ? sourceName : target;
        if (typeof target === "string" && target) {
            const entry = await resolveBackupWorkspaceEntry(root, target);
            if ((await entryInfo(entry.absolutePath))?.isDirectory())
                targetPath = `${target}/${sourceName}`;
        }
        const destination = await resolveBackupWorkspaceEntry(root, targetPath, { directory: info.isDirectory() });
        if (await entryInfo(destination.absolutePath)) {
            throw new BackupFolderError("BACKUP_ENTRY_EXISTS", 409, "Am Ziel gibt es bereits einen Eintrag mit diesem Namen.");
        }
        const withinSource = path.relative(sourceEntry.absolutePath, destination.absolutePath);
        if (info.isDirectory() && !withinSource.startsWith(`..${path.sep}`) && withinSource !== ".." && !path.isAbsolute(withinSource)) {
            throw new BackupFolderError("BACKUP_COPY_INTO_SOURCE", 400, "Wähle ein Ziel außerhalb des Quellordners.");
        }
        const entries = await workspaceTree(root, sourceEntry, info);
        const created = [];
        try {
            for (const item of entries) {
                const suffix = item.relativePath.slice(sourceEntry.relativePath.length);
                const copy = await resolveBackupWorkspaceEntry(root, destination.relativePath + suffix, { directory: item.info.isDirectory() });
                if (!sameEntry(item.info, await entryInfo(item.absolutePath)))
                    throw changedEntry();
                if (item.info.isDirectory()) {
                    await fs.mkdir(copy.absolutePath, { mode: 0o700 });
                    created.push({ absolutePath: copy.absolutePath, info: await fs.lstat(copy.absolutePath) });
                }
                else {
                    const input = await openTextFile(item.absolutePath, false, item.info);
                    if (!input)
                        throw changedEntry();
                    try {
                        const output = await fs.open(copy.absolutePath, "wx", 0o600);
                        try {
                            created.push({ absolutePath: copy.absolutePath, info: await output.stat() });
                            await pipeline(input.createReadStream(), output.createWriteStream());
                        }
                        finally {
                            await output.close();
                        }
                    }
                    finally {
                        await input.close();
                    }
                }
            }
        }
        catch (error) {
            for (const item of created.reverse()) {
                await (async () => {
                    if (!sameEntry(item.info, await entryInfo(item.absolutePath)))
                        return;
                    if (item.info.isDirectory())
                        await fs.rmdir(item.absolutePath);
                    else
                        await fs.unlink(item.absolutePath);
                })().catch(() => undefined);
            }
            if (error?.code === "EEXIST") {
                throw new BackupFolderError("BACKUP_ENTRY_EXISTS", 409, "Am Ziel gibt es bereits einen Eintrag mit diesem Namen.");
            }
            throw error;
        }
        return { ok: true, path: destination.relativePath };
    });
}
export async function readBackupWorkspaceFile(relativePath) {
    const entry = await resolveBackupWorkspaceEntry(systemBackupsRoot(), relativePath);
    return { ok: true, path: entry.relativePath, maxBytes: MAX_TEXT_BYTES, ...await textState(entry.absolutePath) };
}
export async function saveBackupWorkspaceFile(relativePath, text, expectedRevision) {
    if (typeof text !== "string" || text.includes("\0") ||
        (expectedRevision !== null && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision)))) {
        throw new BackupFolderError("INVALID_BACKUP_TEXT", 400, "Dateiinhalt oder Dateistand ist ungültig.");
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_TEXT_BYTES)
        throw new BackupFolderError("BACKUP_TEXT_TOO_LARGE", 413, "Die Textdatei darf höchstens 16 KB groß sein.");
    return withPersistentSnapshotLock("backup-terminal-save", async () => {
        const entry = await resolveBackupWorkspaceEntry(systemBackupsRoot(), relativePath);
        const current = await textState(entry.absolutePath);
        if (current.revision !== expectedRevision) {
            throw new BackupFolderError("BACKUP_TEXT_CHANGED", 409, "Die Datei wurde seit dem Öffnen geändert. Dein Entwurf bleibt im Editor.");
        }
        const temporary = path.join(path.dirname(entry.absolutePath), `.bonni-text-${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            await fs.rename(temporary, entry.absolutePath);
        }
        finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
        return { ok: true, path: entry.relativePath, revision: createHash("sha256").update(bytes).digest("hex") };
    });
}
export async function touchBackupWorkspaceFile(relativePath) {
    return withPersistentSnapshotLock("backup-terminal-touch", async () => {
        const entry = await resolveBackupWorkspaceEntry(systemBackupsRoot(), relativePath);
        const handle = await openTextFile(entry.absolutePath, true);
        if (!handle) {
            await fs.writeFile(entry.absolutePath, "", { flag: "wx", mode: 0o600 });
        }
        else {
            try {
                await readText(handle);
                const now = new Date();
                await handle.utimes(now, now);
            }
            finally {
                await handle.close();
            }
        }
        return { ok: true, path: entry.relativePath };
    });
}
export async function removeBackupWorkspaceFile(relativePath, force = false) {
    return withPersistentSnapshotLock("backup-terminal-rm", async () => {
        const entry = await resolveEntry(systemBackupsRoot(), relativePath, force);
        if (!entry || (await textState(entry.absolutePath)).revision === null) {
            if (force)
                return { ok: true, path: relativePath, removed: false };
            throw new BackupFolderError("BACKUP_TEXT_NOT_FOUND", 404, "Die Textdatei wurde nicht gefunden.");
        }
        await fs.unlink(entry.absolutePath);
        return { ok: true, path: entry.relativePath, removed: true };
    });
}
