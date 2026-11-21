import { getPrismaClient } from "../database/database.js";
import { getVerifiedRequestIdentity } from "../../platform/auth/request-identity/request-identity-context.js";
import { createLogicalArchiveFolder, getArchiveWorkspace, listLogicalArchiveFolder, } from "../../system/routes/explorer/archive-account.service.js";
import { listArchiveFiles } from "../../system/routes/explorer/archive-file.service.js";
export const MODULE_ARCHIVE_CONTRACT_VERSION = "bonni.archive/v1";
export class ModuleArchiveRuntimeError extends Error {
    code;
    statusCode;
    constructor(code, statusCode) {
        super(code);
        this.name = "ModuleArchiveRuntimeError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
function fail(code, statusCode) {
    throw new ModuleArchiveRuntimeError(code, statusCode);
}
function normalizeModuleKey(value) {
    const moduleKey = String(value || "").trim().toLowerCase();
    if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(moduleKey)
        || moduleKey.includes("..")) {
        fail("CORE_ARCHIVE_MODULE_KEY_INVALID", 500);
    }
    return moduleKey;
}
function normalizeFileId(value) {
    const fileId = String(value || "").trim();
    if (!fileId || fileId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
        fail("CORE_ARCHIVE_FILE_ID_INVALID", 400);
    }
    return fileId;
}
function normalizeMimeTypes(value) {
    if (value === undefined)
        return Object.freeze([]);
    if (!Array.isArray(value)
        || value.length < 1
        || value.length > 50) {
        fail("CORE_ARCHIVE_MIME_TYPES_INVALID", 400);
    }
    const values = value.map((entry) => String(entry || "").trim().toLowerCase());
    if (new Set(values).size !== values.length
        || values.some((entry) => (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/.test(entry)))) {
        fail("CORE_ARCHIVE_MIME_TYPES_INVALID", 400);
    }
    return Object.freeze(values);
}
function acceptedMimeType(mimeTypeValue, accepted) {
    if (!accepted.length)
        return true;
    const mimeType = String(mimeTypeValue || "").trim().toLowerCase();
    return accepted.some((candidate) => (candidate === mimeType
        || (candidate.endsWith("/*")
            && mimeType.startsWith(candidate.slice(0, -1)))));
}
function currentPersonId() {
    const identity = getVerifiedRequestIdentity();
    if (!identity?.personId
        || !["MEMBER", "ADMIN"].includes(identity.type)) {
        fail("CORE_ARCHIVE_UNAUTHENTICATED", 401);
    }
    return identity.personId;
}
function currentAccountId() {
    const identity = getVerifiedRequestIdentity();
    if (!identity?.accountId
        || !["MEMBER", "ADMIN"].includes(identity.type)) {
        fail("CORE_ARCHIVE_UNAUTHENTICATED", 401);
    }
    return identity.accountId;
}
function normalizeFolderId(value) {
    const folderId = String(value || "").trim();
    if (!folderId || folderId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(folderId)) {
        fail("CORE_ARCHIVE_FOLDER_ID_INVALID", 400);
    }
    return folderId;
}
function normalizeFolderInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("CORE_ARCHIVE_FOLDER_INPUT_INVALID", 400);
    }
    const input = value;
    if (Object.keys(input).some((field) => !["parentId", "name"].includes(field))) {
        fail("CORE_ARCHIVE_FOLDER_INPUT_INVALID", 400);
    }
    const name = String(input.name || "").trim();
    const parentId = input.parentId == null || input.parentId === ""
        ? null
        : normalizeFolderId(input.parentId);
    if (!name || name.length > 128)
        fail("CORE_ARCHIVE_FOLDER_NAME_INVALID", 400);
    return { parentId, name };
}
const SAFE_FILE_SELECT = Object.freeze({
    id: true,
    displayName: true,
    originalName: true,
    mimeType: true,
    sizeBytes: true,
    createdAt: true,
});
function activeGrantWhere(personId, allowCopy) {
    return {
        granteePersonId: personId,
        revokedAt: null,
        OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } },
        ],
        ...(allowCopy
            ? { AND: [{ OR: [{ canRead: true }, { canCopy: true }] }] }
            : { canRead: true }),
    };
}
function authorizedFileWhere(fileId, personId, requireOwner, allowCopy) {
    return {
        ...(fileId ? { id: fileId } : {}),
        deletedAt: null,
        folder: { deletedAt: null },
        ...(requireOwner
            ? { ownerPersonId: personId }
            : {
                OR: [
                    { ownerPersonId: personId },
                    {
                        folder: {
                            grants: {
                                some: activeGrantWhere(personId, allowCopy),
                            },
                        },
                    },
                ],
            }),
    };
}
function safeFile(file) {
    return Object.freeze({
        id: file.id,
        displayName: file.displayName,
        originalName: file.originalName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        createdAt: file.createdAt,
    });
}
export function createModuleArchiveRuntime(moduleKeyValue, prismaValue = getPrismaClient()) {
    const moduleKey = normalizeModuleKey(moduleKeyValue);
    const prisma = prismaValue;
    return Object.freeze({
        contractVersion: MODULE_ARCHIVE_CONTRACT_VERSION,
        moduleKey,
        async authorizeFile(fileIdValue, options = {}) {
            if (!options || typeof options !== "object" || Array.isArray(options)) {
                fail("CORE_ARCHIVE_OPTIONS_INVALID", 400);
            }
            if (Object.keys(options).some((field) => (!["acceptMimeTypes", "requireOwner"].includes(field)))
                || (options.requireOwner !== undefined
                    && typeof options.requireOwner !== "boolean")) {
                fail("CORE_ARCHIVE_OPTIONS_INVALID", 400);
            }
            const fileId = normalizeFileId(fileIdValue);
            const personId = currentPersonId();
            const acceptedMimeTypes = normalizeMimeTypes(options.acceptMimeTypes);
            const file = await prisma.archiveFile.findFirst({
                where: authorizedFileWhere(fileId, personId, options.requireOwner === true, false),
                select: SAFE_FILE_SELECT,
            });
            if (!file)
                fail("CORE_ARCHIVE_FILE_NOT_FOUND", 404);
            if (!acceptedMimeType(file.mimeType, acceptedMimeTypes)) {
                fail("CORE_ARCHIVE_MIME_TYPE_NOT_ACCEPTED", 415);
            }
            return safeFile(file);
        },
        async filterReadable(fileIdsValue) {
            if (!Array.isArray(fileIdsValue)
                || fileIdsValue.length > 500) {
                fail("CORE_ARCHIVE_FILE_IDS_INVALID", 400);
            }
            const fileIds = fileIdsValue.map(normalizeFileId);
            if (new Set(fileIds).size !== fileIds.length) {
                fail("CORE_ARCHIVE_FILE_IDS_INVALID", 400);
            }
            if (!fileIds.length)
                return Object.freeze([]);
            const personId = currentPersonId();
            const files = await prisma.archiveFile.findMany({
                where: {
                    ...authorizedFileWhere(undefined, personId, false, true),
                    id: { in: fileIds },
                },
                select: SAFE_FILE_SELECT,
            });
            const byId = new Map(files.map((file) => [file.id, file]));
            return Object.freeze(fileIds.flatMap((fileId) => {
                const file = byId.get(fileId);
                return file ? [safeFile(file)] : [];
            }));
        },
        async getWorkspace() {
            return getArchiveWorkspace(currentAccountId());
        },
        async getFolder(folderIdValue) {
            const accountId = currentAccountId();
            const folderId = normalizeFolderId(folderIdValue);
            const [listing, files] = await Promise.all([
                listLogicalArchiveFolder(accountId, folderId),
                listArchiveFiles(accountId, folderId),
            ]);
            return { ...listing, files };
        },
        async createFolder(inputValue) {
            return createLogicalArchiveFolder(currentAccountId(), normalizeFolderInput(inputValue));
        },
    });
}
