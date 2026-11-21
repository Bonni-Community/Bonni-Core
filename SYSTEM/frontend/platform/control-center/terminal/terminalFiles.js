import {
  changeBackupDirectory, changeBackupTextFile, copyBackupEntry, createSystemBackup, fetchBackupDirectory, fetchBackupTextFile,
} from "../../../system/api/systemBackupApi.js";

export function resolveTerminalDirectory(directory, target = ".") {
  const parts = target.startsWith("/") ? [] : directory.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function parentDirectory(path) {
  return path.split("/").slice(0, -1).join("/");
}

function containsDirectory(path, directory) {
  return directory === path || directory.startsWith(`${path}/`);
}

async function removeEmptyDirectories(command, directory, path, { token, signal }) {
  const paths = [path];
  if (command.parents) {
    const parentLimit = command.path.startsWith("/") ? "" : directory;
    if (!path || (parentLimit && containsDirectory(path, parentLimit))) {
      throw new Error("Gib einen Unterordner oder einen absoluten Ordnerpfad im Backup-Bereich an.");
    }
    for (let parent = parentDirectory(path); parent && !containsDirectory(parent, parentLimit); parent = parentDirectory(parent)) {
      paths.push(parent);
    }
  }
  const removed = [];
  for (const target of paths) {
    try {
      const result = await changeBackupDirectory(token, target, { signal, remove: true });
      if (result?.ok !== true || result.path !== target) throw new Error("Der Core hat das Löschen des Ordners nicht bestätigt.");
      removed.push(target);
    } catch (error) {
      if (!removed.length) throw error;
      throw new Error(`/${target} · ${error.message}\nGelöscht: ${removed.map(item => `/${item}`).join(", ")}`);
    }
  }
  return removalOutput(directory, removed.at(-1), removed.map(item => `Ordner gelöscht · /${item}`).join("\n"));
}

function removalOutput(directory, path, message) {
  return containsDirectory(path, directory) ? { directory: parentDirectory(path), message } : message;
}

async function readWorkspaceText(path, { token, signal }) {
  const file = await fetchBackupTextFile(token, path, { signal });
  if (file?.ok !== true || file.path !== path || typeof file.text !== "string"
    || (file.revision !== null && (typeof file.revision !== "string" || !/^[a-f0-9]{64}$/u.test(file.revision)))
    || !Number.isInteger(file.maxBytes) || file.maxBytes < 1) {
    throw new Error("Der Core hat die Textdatei nicht bestätigt.");
  }
  return file;
}

export async function saveTerminalOutput(command, output, context) {
  const { token, signal, directory = "" } = context;
  const path = resolveTerminalDirectory(directory, command.path);
  const file = await readWorkspaceText(path, context);
  const text = (command.append ? file.text : "") + output;
  const result = await changeBackupTextFile(token, path, "PUT", { signal, text, revision: file.revision });
  if (result?.ok !== true || result.path !== path) throw new Error("Der Core hat die gespeicherte Ausgabe nicht bestätigt.");
}

export async function executeTerminalFileCommand(command, { token, signal, directory = "", openTextEditor }) {
  if (command.kind === "pwd") return `/${directory}`;
  const path = resolveTerminalDirectory(directory, command.path);
  if (command.kind === "backup-create") {
    const result = await createSystemBackup(token, "Bonni-Terminal", { signal, directory: path });
    if (result?.ok !== true || result.backup?.status !== "completed" || (result.backup.directory ?? "") !== path) {
      throw new Error(result?.message || result?.error || "Der Core hat das Backup im Zielordner nicht bestätigt.");
    }
    return `Backup abgeschlossen · /${[path, result.backup.id].filter(Boolean).join("/")}`;
  }
  if (command.kind === "mkdir") {
    const result = await changeBackupDirectory(token, path, { signal, parents: command.parents });
    if (result?.ok !== true || result.path !== path) throw new Error("Der Core hat die Änderung am Ordner nicht bestätigt.");
    return `Ordner angelegt · /${path}`;
  }
  if (command.kind === "rmdir") {
    if (!path || /(?:^|\/)\.{1,2}\/*$/u.test(command.path)) throw new Error("Gib einen Ordnernamen im Backup-Bereich an.");
    return removeEmptyDirectories(command, directory, path, { token, signal });
  }
  if (command.kind === "cp") {
    const target = resolveTerminalDirectory(directory, command.target);
    const result = await copyBackupEntry(token, path, target, { signal, recursive: command.recursive });
    if (result?.ok !== true || typeof result.path !== "string" || !result.path) {
      throw new Error("Der Core hat die Kopie nicht bestätigt.");
    }
    return `Kopiert · /${path} → /${result.path}`;
  }
  if (command.kind === "touch" || command.kind === "rm") {
    const remove = command.kind === "rm";
    if (remove && (!path || /(?:^|\/)\.{1,2}\/*$/u.test(command.path))) {
      throw new Error("Gib einen Datei- oder Ordnernamen im Backup-Bereich an.");
    }
    const result = await changeBackupTextFile(token, path, remove ? "DELETE" : "POST", {
      signal, recursive: command.recursive, force: command.force,
    });
    if (result?.ok !== true || result.path !== path) throw new Error("Der Core hat die Änderung an der Datei nicht bestätigt.");
    if (!remove) return `Datei bereit · /${path}`;
    if (result.removed === false) return `Kein Eintrag · /${path}`;
    if (command.recursive) return removalOutput(directory, path, `Gelöscht · /${path}`);
    return `Datei gelöscht · /${path}`;
  }
  if (command.kind === "nano" || command.kind === "cat") {
    const file = await readWorkspaceText(path, { token, signal });
    if (command.kind === "cat") {
      if (file.revision === null && !command.allowMissing) throw new Error("Die Textdatei wurde nicht gefunden.");
      return file.text;
    }
    const saved = await openTextEditor(path, file, signal);
    return `Datei ${saved ? "gespeichert" : "geschlossen"} · /${path}`;
  }
  const listing = await fetchBackupDirectory(token, path, { signal, details: command.long });
  if (listing?.ok !== true || listing.directory !== path || !Array.isArray(listing.entries)) {
    throw new Error("Der Core hat den Ordner nicht bestätigt.");
  }
  if (command.kind === "cd") return { directory: path, message: `/${path}` };
  return listing.entries
    .filter(entry => command.showHidden || !entry.name.startsWith("."))
    .map(entry => {
      const name = entry.name + (entry.directory ? "/" : "");
      if (!command.long) return name;
      const size = String(entry.sizeBytes ?? "–").padStart(10);
      const modified = entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–";
      return `${entry.directory ? "d" : "-"} ${size} B  ${modified}  ${name}`;
    })
    .join("\n") || "(Ordner leer)";
}
