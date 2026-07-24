import * as fs from "node:fs/promises";
import path from "node:path";

import {
  ArchiveFolderKind,
  AuditCategory,
  AuditResult,
  type ArchiveFile,
  type ArchiveFolder,
  type Prisma,
} from "@prisma/client";

import { getPrismaClient } from "../../../core/database/database.js";
import {
  createBase64UrlToken,
  createUuid,
  decryptAes256Gcm,
  derivePurposeRootKey,
  encryptAes256Gcm,
  hmacDigest,
  sha256,
} from "../../../platform/security/crypto/index.js";
import { getRunSystemArchivRoot } from "../../boot/run-system/run-system.paths.js";
import {
  getArchiveFolderAccessContext,
  type FolderPermissions,
} from "./archive-account.service.js";

type ArchiveFileError = Error & {
  statusCode: number;
  code: string;
  details?: unknown;
};

type ArchiveFileWithFolder = ArchiveFile & { folder: ArchiveFolder };

const ARCHIVE_FILE_VERSION = 1;
const DEFAULT_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function fileError(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): ArchiveFileError {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("de-DE");
}

function validateDisplayName(value: unknown, fallback: string) {
  const displayName = String(value ?? fallback).trim().normalize("NFKC");
  if (!displayName || displayName.length > 180 || CONTROL_CHARACTERS.test(displayName)) {
    throw fileError(
      400,
      "ARCHIVE_DISPLAY_NAME_INVALID",
      "Der Anzeigename muss 1 bis 180 gültige Zeichen enthalten.",
    );
  }
  return displayName;
}

function validateOriginalName(value: unknown) {
  const rawName = String(value ?? "").trim().normalize("NFKC");
  const originalName = rawName.split(/[\\/]/u).pop() || "";
  if (!originalName || originalName.length > 255 || CONTROL_CHARACTERS.test(originalName)) {
    throw fileError(400, "ARCHIVE_FILE_NAME_INVALID", "Der ursprüngliche Dateiname ist ungültig.");
  }
  return originalName;
}

function normalizeMimeType(value: unknown) {
  const mimeType = String(value || "application/octet-stream").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function configuredUploadLimitBytes() {
  const configured = Number(process.env.ARCHIVE_UPLOAD_LIMIT_BYTES || DEFAULT_UPLOAD_LIMIT_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_UPLOAD_LIMIT_BYTES;
}

function storageSegment(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/ß/giu, "ss")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "Datei";
}

function safeExtension(originalName: string) {
  const extension = path.extname(originalName).toLocaleLowerCase("de-DE");
  return /^\.[a-z0-9]{1,12}$/u.test(extension) ? extension : "";
}

function displayDownloadName(displayName: string, originalName: string) {
  const originalExtension = safeExtension(originalName);
  if (!originalExtension || path.extname(displayName)) return displayName;
  return `${displayName}${originalExtension}`;
}

function quarterContext(now = new Date()) {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(quarter === 4 ? year + 1 : year, quarter === 4 ? 0 : quarter * 3, 1));
  return { year, quarter, start, end };
}

function buildStorageName(folderName: string, originalName: string, index: number, now = new Date()) {
  const { year, quarter } = quarterContext(now);
  return `${storageSegment(folderName)}_${year}_Q${quarter}_${String(index).padStart(4, "0")}${safeExtension(originalName)}`;
}

function objectDirectory(folderStorageKey: string) {
  const archiveRoot = path.resolve(getRunSystemArchivRoot());
  const prefix = folderStorageKey.slice(0, 2) || "00";
  return path.join(archiveRoot, "objects", prefix, folderStorageKey);
}

function objectPath(folderStorageKey: string, objectKey: string) {
  const directory = objectDirectory(folderStorageKey);
  const resolved = path.resolve(directory, objectKey);
  if (path.dirname(resolved) !== path.resolve(directory)) {
    throw fileError(500, "ARCHIVE_OBJECT_PATH_INVALID", "Der Archivspeicherpfad ist ungültig.");
  }
  return resolved;
}

function fileAad(fileId: string, folderId: string, ownerPersonId: string) {
  return `bonni-core:archive-file:v${ARCHIVE_FILE_VERSION}|file:${fileId}|folder:${folderId}|owner:${ownerPersonId}`;
}

function deriveArchiveFileKey(ownerPersonId: string) {
  try {
    const rootKey = derivePurposeRootKey("personal-data-encryption");
    try {
      return hmacDigest(
        `bonni-core:archive-file-key:v${ARCHIVE_FILE_VERSION}|owner-person:${ownerPersonId}`,
        rootKey,
        "sha256",
      );
    } finally {
      rootKey.fill(0);
    }
  } catch {
    throw fileError(
      423,
      "ARCHIVE_MASTER_KEY_LOCKED",
      "Der Archivschlüssel ist nicht geladen. Dateien können derzeit nicht ver- oder entschlüsselt werden.",
    );
  }
}

function assertListPermission(permissions: FolderPermissions) {
  if (!permissions.list && !permissions.read) {
    throw fileError(403, "ARCHIVE_LIST_DENIED", "Dieser Archivordner darf nicht aufgelistet werden.");
  }
}

function assertUploadPermission(folder: ArchiveFolder, permissions: FolderPermissions) {
  if (
    folder.readOnly
    || folder.kind === ArchiveFolderKind.DOCUMENTS
    || (!permissions.write && !permissions.deposit)
  ) {
    throw fileError(
      403,
      "ARCHIVE_UPLOAD_DENIED",
      "In diesem Ordner dürfen keine Dateien hochgeladen werden.",
    );
  }
}

function canRename(folder: ArchiveFolder, permissions: FolderPermissions) {
  return !folder.readOnly
    && folder.kind !== ArchiveFolderKind.DOCUMENTS
    && (permissions.write || permissions.manage);
}

function serializeArchiveFile(
  file: ArchiveFile,
  folder: ArchiveFolder,
  permissions: FolderPermissions,
) {
  return {
    id: file.id,
    type: "file",
    folderId: file.folderId,
    displayName: file.displayName,
    originalName: file.originalName,
    storageName: file.storageName,
    downloadName: displayDownloadName(file.displayName, file.originalName),
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    encrypted: true,
    encryptionVersion: file.encryptionVersion,
    canRename: canRename(folder, permissions),
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    folder: {
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      kind: folder.kind,
      readOnly: folder.readOnly,
      permissions,
    },
  };
}

async function writeEncryptedObject(
  folderStorageKey: string,
  objectKey: string,
  encryptedValue: string,
) {
  const directory = objectDirectory(folderStorageKey);
  const finalPath = objectPath(folderStorageKey, objectKey);
  const temporaryPath = `${finalPath}.${createBase64UrlToken(8)}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, encryptedValue, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return finalPath;
}

async function auditFileEvent(input: {
  event: string;
  accountId: string;
  fileId: string;
  metadata?: Prisma.InputJsonValue;
}) {
  const prisma = getPrismaClient();
  await prisma.auditLog.create({
    data: {
      category: AuditCategory.DATA,
      event: input.event,
      result: AuditResult.SUCCESS,
      accountId: input.accountId,
      targetType: "ArchiveFile",
      targetId: input.fileId,
      metadataJson: input.metadata,
    },
  });
}

export async function listArchiveFiles(accountId: string, folderId: string) {
  const context = await getArchiveFolderAccessContext(accountId, folderId);
  assertListPermission(context.permissions);
  const files = await context.prisma.archiveFile.findMany({
    where: { folderId, deletedAt: null },
    orderBy: [{ displayName: "asc" }, { createdAt: "desc" }],
  });
  return files.map((file) => serializeArchiveFile(file, context.folder, context.permissions));
}

export async function uploadArchiveFile(
  accountId: string,
  folderId: string,
  input: {
    bytes: Buffer;
    originalName: unknown;
    displayName?: unknown;
    mimeType?: unknown;
  },
) {
  const context = await getArchiveFolderAccessContext(accountId, folderId);
  assertUploadPermission(context.folder, context.permissions);
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1) {
    throw fileError(400, "ARCHIVE_FILE_EMPTY", "Die ausgewählte Datei ist leer.");
  }
  const uploadLimit = configuredUploadLimitBytes();
  if (input.bytes.length > uploadLimit) {
    throw fileError(413, "ARCHIVE_FILE_TOO_LARGE", `Die Datei darf höchstens ${Math.floor(uploadLimit / 1024 / 1024)} MB groß sein.`);
  }

  const originalName = validateOriginalName(input.originalName);
  const defaultDisplayName = path.basename(originalName, path.extname(originalName));
  const displayName = validateDisplayName(input.displayName, defaultDisplayName || originalName);
  const mimeType = normalizeMimeType(input.mimeType);
  const now = new Date();
  const period = quarterContext(now);
  let nextIndex = await context.prisma.archiveFile.count({
    where: {
      folderId,
      createdAt: { gte: period.start, lt: period.end },
    },
  }) + 1;

  const fileId = createUuid();
  const objectKey = `af_${createBase64UrlToken(24)}.arc`;
  const key = deriveArchiveFileKey(context.folder.ownerPersonId);
  let encryptedValue: string;
  try {
    encryptedValue = encryptAes256Gcm(
      input.bytes,
      key,
      fileAad(fileId, folderId, context.folder.ownerPersonId),
    );
  } finally {
    key.fill(0);
  }

  const finalPath = await writeEncryptedObject(context.folder.storageKey, objectKey, encryptedValue)
    .catch((error) => {
      throw fileError(
        507,
        "ARCHIVE_STORAGE_WRITE_FAILED",
        "Die verschlüsselte Datei konnte nicht im Archiv gespeichert werden.",
        error instanceof Error ? error.message : String(error),
      );
    });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const storageName = buildStorageName(context.folder.name, originalName, nextIndex, now);
      try {
        const file = await context.prisma.$transaction(async (transaction) => {
          const created = await transaction.archiveFile.create({
            data: {
              id: fileId,
              folderId,
              ownerPersonId: context.folder.ownerPersonId,
              createdByAccountId: accountId,
              displayName,
              normalizedDisplayName: normalizeSearchValue(displayName),
              originalName,
              normalizedOriginalName: normalizeSearchValue(originalName),
              storageName,
              normalizedStorageName: normalizeSearchValue(storageName),
              objectKey,
              mimeType,
              sizeBytes: input.bytes.length,
              sha256: sha256(input.bytes),
              encryptionVersion: ARCHIVE_FILE_VERSION,
            },
          });
          await transaction.auditLog.create({
            data: {
              category: AuditCategory.DATA,
              event: "ARCHIVE_FILE_UPLOADED",
              result: AuditResult.SUCCESS,
              accountId,
              targetType: "ArchiveFile",
              targetId: created.id,
              metadataJson: {
                folderId,
                displayName,
                storageName,
                mimeType,
                sizeBytes: input.bytes.length,
              },
            },
          });
          return created;
        });
        return {
          ok: true,
          file: serializeArchiveFile(file, context.folder, context.permissions),
        };
      } catch (error: any) {
        if (error?.code === "P2002") {
          nextIndex += 1;
          continue;
        }
        throw error;
      }
    }
    throw fileError(409, "ARCHIVE_STORAGE_NAME_CONFLICT", "Es konnte kein eindeutiger Speichername erzeugt werden.");
  } catch (error) {
    await fs.unlink(finalPath).catch(() => undefined);
    throw error;
  }
}

export async function renameArchiveFileDisplayName(
  accountId: string,
  fileId: string,
  displayNameValue: unknown,
) {
  const prisma = getPrismaClient();
  const existing = await prisma.archiveFile.findFirst({
    where: { id: fileId, deletedAt: null },
    include: { folder: true },
  });
  if (!existing) throw fileError(404, "ARCHIVE_FILE_NOT_FOUND", "Die Archivdatei wurde nicht gefunden.");
  const context = await getArchiveFolderAccessContext(accountId, existing.folderId);
  if (!canRename(context.folder, context.permissions)) {
    throw fileError(403, "ARCHIVE_RENAME_DENIED", "Der Anzeigename dieser Datei darf nicht geändert werden.");
  }
  const displayName = validateDisplayName(displayNameValue, existing.displayName);
  const updated = await prisma.archiveFile.update({
    where: { id: existing.id },
    data: {
      displayName,
      normalizedDisplayName: normalizeSearchValue(displayName),
    },
  });
  await auditFileEvent({
    event: "ARCHIVE_FILE_DISPLAY_NAME_CHANGED",
    accountId,
    fileId: updated.id,
    metadata: { previousDisplayName: existing.displayName, displayName },
  });
  return { ok: true, file: serializeArchiveFile(updated, context.folder, context.permissions) };
}

export async function downloadArchiveFile(accountId: string, fileId: string) {
  const prisma = getPrismaClient();
  const file = await prisma.archiveFile.findFirst({
    where: { id: fileId, deletedAt: null },
    include: { folder: true },
  });
  if (!file) throw fileError(404, "ARCHIVE_FILE_NOT_FOUND", "Die Archivdatei wurde nicht gefunden.");
  const context = await getArchiveFolderAccessContext(accountId, file.folderId);
  if (!context.permissions.read && !context.permissions.copy) {
    throw fileError(403, "ARCHIVE_DOWNLOAD_DENIED", "Diese Archivdatei darf nicht heruntergeladen werden.");
  }

  let encryptedValue: string;
  try {
    encryptedValue = await fs.readFile(
      objectPath(file.folder.storageKey, file.objectKey),
      "utf8",
    );
  } catch {
    throw fileError(409, "ARCHIVE_OBJECT_MISSING", "Das verschlüsselte Dateiobjekt fehlt im Archivspeicher.");
  }

  const key = deriveArchiveFileKey(file.ownerPersonId);
  let bytes: Buffer;
  try {
    bytes = decryptAes256Gcm(
      encryptedValue,
      key,
      fileAad(file.id, file.folderId, file.ownerPersonId),
    );
  } catch {
    throw fileError(409, "ARCHIVE_FILE_CORRUPT", "Die Archivdatei konnte nicht sicher entschlüsselt werden.");
  } finally {
    key.fill(0);
  }
  if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) {
    bytes.fill(0);
    throw fileError(409, "ARCHIVE_FILE_INTEGRITY_FAILED", "Die Integritätsprüfung der Archivdatei ist fehlgeschlagen.");
  }

  await auditFileEvent({
    event: "ARCHIVE_FILE_DOWNLOADED",
    accountId,
    fileId: file.id,
    metadata: { folderId: file.folderId, sizeBytes: file.sizeBytes },
  });
  return {
    bytes,
    mimeType: file.mimeType,
    downloadName: displayDownloadName(file.displayName, file.originalName),
  };
}

export async function searchArchiveFiles(accountId: string, query: unknown) {
  const prisma = getPrismaClient();
  const normalizedQuery = normalizeSearchValue(query);
  if (normalizedQuery.length < 2) return [];
  const candidates = await prisma.archiveFile.findMany({
    where: {
      deletedAt: null,
      OR: [
        { normalizedDisplayName: { contains: normalizedQuery } },
        { normalizedOriginalName: { contains: normalizedQuery } },
        { normalizedStorageName: { contains: normalizedQuery } },
        { folder: { normalizedName: { contains: normalizedQuery }, deletedAt: null } },
      ],
    },
    include: { folder: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  const visible = [];
  for (const file of candidates as ArchiveFileWithFolder[]) {
    try {
      const context = await getArchiveFolderAccessContext(accountId, file.folderId);
      if (context.permissions.read || context.permissions.list) {
        visible.push(serializeArchiveFile(file, file.folder, context.permissions));
      }
    } catch (error: any) {
      if (error?.code !== "ARCHIVE_ACCESS_DENIED") throw error;
    }
  }
  return visible;
}
