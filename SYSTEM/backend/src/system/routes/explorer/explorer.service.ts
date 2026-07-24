import path from "node:path";
import * as fs from "node:fs/promises";

import { getRunSystemArchivRoot } from "../../boot/run-system/run-system.paths.js";

type ArchiveEntryType = "directory" | "file" | "link" | "other";

type ArchiveEntry = {
  name: string;
  path: string;
  type: ArchiveEntryType;
  owner: string;
  permissions: string;
  size: number | null;
  modifiedAt: string;
  navigable: boolean;
};

type ArchiveListing = {
  ok: true;
  rootName: "Archiv";
  path: string;
  parentPath: string | null;
  entries: ArchiveEntry[];
  stats: {
    total: number;
    apps: number;
    addons: number;
    plugins: number;
    sources: number;
    directories: number;
    files: number;
    bytes: number;
  };
};

type ExplorerHttpError = Error & {
  statusCode: number;
  code: string;
  details?: unknown;
};

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;

function explorerError(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): ExplorerHttpError {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function normalizeRelativePath(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";

  if (raw.startsWith("/") || /^[a-z]:/i.test(raw)) {
    throw explorerError(400, "INVALID_ARCHIVE_PATH", "Der Archivpfad muss relativ sein.");
  }

  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
    throw explorerError(400, "INVALID_ARCHIVE_PATH", "Der Archivpfad ist ungültig.");
  }

  return segments.join("/");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureArchiveRoot(): Promise<string> {
  const configuredRoot = path.resolve(getRunSystemArchivRoot());
  await fs.mkdir(configuredRoot, { recursive: true, mode: 0o750 });
  return fs.realpath(configuredRoot);
}

async function resolveArchiveDirectory(relativePath: unknown) {
  const normalized = normalizeRelativePath(relativePath);
  const root = await ensureArchiveRoot();
  const candidate = path.resolve(root, ...normalized.split("/").filter(Boolean));

  if (!isInsideRoot(root, candidate)) {
    throw explorerError(403, "ARCHIVE_PATH_FORBIDDEN", "Der Pfad liegt außerhalb des Archivs.");
  }

  let candidateInfo;
  try {
    candidateInfo = await fs.lstat(candidate);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw explorerError(404, "ARCHIVE_DIRECTORY_NOT_FOUND", "Der Archivordner wurde nicht gefunden.");
    }
    throw error;
  }

  if (candidateInfo.isSymbolicLink()) {
    throw explorerError(403, "ARCHIVE_LINK_FORBIDDEN", "Symbolische Verknüpfungen können nicht geöffnet werden.");
  }

  const realCandidate = await fs.realpath(candidate);
  if (!isInsideRoot(root, realCandidate)) {
    throw explorerError(403, "ARCHIVE_PATH_FORBIDDEN", "Der Pfad liegt außerhalb des Archivs.");
  }

  const info = await fs.stat(realCandidate);
  if (!info.isDirectory()) {
    throw explorerError(400, "ARCHIVE_PATH_NOT_DIRECTORY", "Der Archivpfad ist kein Ordner.");
  }

  return { root, absolutePath: realCandidate, relativePath: normalized };
}

function entryType(info: Awaited<ReturnType<typeof fs.lstat>>): ArchiveEntryType {
  if (info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function permissionString(info: Awaited<ReturnType<typeof fs.lstat>>, type: ArchiveEntryType): string {
  const prefix = type === "directory" ? "d" : type === "link" ? "l" : "-";
  const mode = Number(info.mode || 0);
  const masks = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const symbols = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return prefix + masks.map((mask, index) => (mode & mask ? symbols[index] : "-")).join("");
}

function parentPath(relativePath: string): string | null {
  if (!relativePath) return null;
  const parent = path.posix.dirname(relativePath);
  return parent === "." ? "" : parent;
}

function categoryCounts(entries: ArchiveEntry[]) {
  const normalizedNames = entries.map((entry) => entry.name.toLowerCase().replace(/[^a-z0-9äöüß]/g, ""));
  const count = (patterns: RegExp[]) => normalizedNames.filter((name) => patterns.some((pattern) => pattern.test(name))).length;

  return {
    apps: count([/^apps?$/, /app$/]),
    addons: count([/^addons?$/, /addon$/]),
    plugins: count([/^plugins?$/, /plugin$/]),
    sources: count([/^sources?$/, /^quellen?$/, /source$/, /quelle$/]),
  };
}

async function readEntry(
  directory: string,
  relativeDirectory: string,
  name: string,
): Promise<ArchiveEntry> {
  const absolutePath = path.join(directory, name);
  const info = await fs.lstat(absolutePath);
  const type = entryType(info);
  const uid = Number.isFinite(Number(info.uid)) ? Number(info.uid) : null;
  const gid = Number.isFinite(Number(info.gid)) ? Number(info.gid) : null;

  return {
    name,
    path: [relativeDirectory, name].filter(Boolean).join("/"),
    type,
    owner: uid == null || gid == null ? "System" : `${uid}:${gid}`,
    permissions: permissionString(info, type),
    size: type === "directory" ? null : Number(info.size || 0),
    modifiedAt: info.mtime.toISOString(),
    navigable: type === "directory",
  };
}

export async function listArchiveDirectory(relativePath: unknown = ""): Promise<ArchiveListing> {
  const resolved = await resolveArchiveDirectory(relativePath);
  const directoryEntries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
  const entries = await Promise.all(
    directoryEntries
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .map((entry) => readEntry(resolved.absolutePath, resolved.relativePath, entry.name)),
  );

  entries.sort((left, right) => {
    if (left.type === "directory" && right.type !== "directory") return -1;
    if (left.type !== "directory" && right.type === "directory") return 1;
    return left.name.localeCompare(right.name, "de", { numeric: true, sensitivity: "base" });
  });

  const categories = categoryCounts(entries);
  const files = entries.filter((entry) => entry.type === "file");

  return {
    ok: true,
    rootName: "Archiv",
    path: resolved.relativePath,
    parentPath: parentPath(resolved.relativePath),
    entries,
    stats: {
      total: entries.length,
      ...categories,
      directories: entries.filter((entry) => entry.type === "directory").length,
      files: files.length,
      bytes: files.reduce((sum, entry) => sum + Number(entry.size || 0), 0),
    },
  };
}

function validateFolderName(value: unknown): string {
  const name = String(value ?? "").trim();

  if (!name || name.length > 128) {
    throw explorerError(400, "INVALID_FOLDER_NAME", "Der Ordnername muss 1 bis 128 Zeichen lang sein.");
  }

  if (
    name === "."
    || name === ".."
    || FORBIDDEN_NAME_CHARACTERS.test(name)
    || WINDOWS_RESERVED_NAMES.test(name)
    || /[. ]$/.test(name)
  ) {
    throw explorerError(400, "INVALID_FOLDER_NAME", "Der Ordnername enthält unzulässige Zeichen.");
  }

  return name;
}

export async function createArchiveDirectory(input: { path?: unknown; name?: unknown }) {
  const parent = await resolveArchiveDirectory(input.path ?? "");
  const name = validateFolderName(input.name);
  const target = path.resolve(parent.absolutePath, name);

  if (!isInsideRoot(parent.root, target) || path.dirname(target) !== parent.absolutePath) {
    throw explorerError(403, "ARCHIVE_PATH_FORBIDDEN", "Der Zielpfad liegt außerhalb des Archivs.");
  }

  try {
    await fs.mkdir(target, { recursive: false, mode: 0o750 });
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw explorerError(409, "ARCHIVE_FOLDER_EXISTS", "Ein Ordner mit diesem Namen existiert bereits.");
    }
    if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
      throw explorerError(403, "ARCHIVE_NOT_WRITABLE", "Das Archiv ist an dieser Stelle nicht beschreibbar.");
    }
    throw error;
  }

  return {
    ...await listArchiveDirectory(parent.relativePath),
    created: {
      name,
      path: [parent.relativePath, name].filter(Boolean).join("/"),
    },
  };
}
