import { withMediaDiagnostic } from "../logger/media-diagnostics.js";
import { constants as fileConstants, promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { resolvePersistentMediaStorageRoot } from "../../../scripts/storage/persistent-storage-root.mjs";
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const HARD_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_SIDECAR_BYTES = 64 * 1024;
// `core.branding` is the only Core-owned media namespace. Feature modules still
// receive a runtime that is bound to their app/add-on/plug-in key and therefore
// cannot create or remove Core branding objects.
const MODULE_KEY = /^(?:(?:app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]|core\.branding)$/;
const OBJECT_TOKEN = /^[A-Za-z0-9_-]{32}$/;
const MEDIA_ID = /^([A-Za-z0-9_-]{4,256})\.([A-Za-z0-9_-]{32})$/;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
const SAFE_IMAGE_MIME_TYPES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
export const MODULE_MEDIA_CONTRACT_VERSION = "bonni.media/v1";
function mediaError(code, statusCode, details, cause) {
    return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
        code,
        statusCode,
        ...(details ? { details } : {}),
    });
}
function configuredMaximum(value) {
    const maximum = value === undefined || value === null || value === ""
        ? DEFAULT_MAX_UPLOAD_BYTES
        : Number(value);
    if (!Number.isSafeInteger(maximum)
        || maximum < 1
        || maximum > HARD_MAX_UPLOAD_BYTES) {
        throw mediaError("CORE_MEDIA_MAX_UPLOAD_BYTES_INVALID", 500);
    }
    return maximum;
}
export function resolveMediaPublicBasePath(value = process.env.MEDIA_PUBLIC_BASE_PATH) {
    const candidate = String(value || "/api/media/files").trim().replace(/\/+$/, "");
    if (!candidate.startsWith("/")
        || candidate.startsWith("//")
        || candidate.length > 256
        || candidate.includes("\\")
        || candidate.includes("?")
        || candidate.includes("#")
        || /(?:^|\/)\.{1,2}(?:\/|$)/.test(candidate)
        || /[\u0000-\u001f\u007f]/.test(candidate)) {
        throw mediaError("CORE_MEDIA_PUBLIC_BASE_PATH_INVALID", 500);
    }
    return candidate;
}
function resolveStorageRoot(value) {
    const candidate = String(value || "").trim();
    if (candidate.includes("\u0000")) {
        throw mediaError("CORE_MEDIA_STORAGE_ROOT_INVALID", 500);
    }
    if (candidate)
        return path.resolve(candidate);
    try {
        return resolvePersistentMediaStorageRoot();
    }
    catch (error) {
        throw mediaError(error?.code || "CORE_MEDIA_STORAGE_ROOT_INVALID", 500, undefined, error);
    }
}
function assertModuleKey(value) {
    const moduleKey = String(value || "").trim();
    if (!MODULE_KEY.test(moduleKey)) {
        throw mediaError("CORE_MEDIA_MODULE_KEY_INVALID", 500);
    }
    return moduleKey;
}
function encodeModuleKey(moduleKey) {
    return Buffer.from(moduleKey, "utf8").toString("base64url");
}
function parseMediaId(value) {
    const id = String(value || "").trim();
    const match = MEDIA_ID.exec(id);
    if (!match)
        throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
    let moduleKey;
    try {
        moduleKey = Buffer.from(match[1], "base64url").toString("utf8");
    }
    catch {
        throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
    }
    if (!MODULE_KEY.test(moduleKey)
        || encodeModuleKey(moduleKey) !== match[1]
        || !OBJECT_TOKEN.test(match[2])) {
        throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
    }
    return {
        id,
        moduleKey,
        encodedModuleKey: match[1],
        objectToken: match[2],
    };
}
function normalizeFileName(value) {
    const fileName = String(value || "").trim();
    if (!fileName
        || fileName.length > 180
        || fileName === "."
        || fileName === ".."
        || fileName.includes("/")
        || fileName.includes("\\")
        || /[\u0000-\u001f\u007f]/.test(fileName)) {
        throw mediaError("CORE_MEDIA_FILE_NAME_INVALID", 400);
    }
    return fileName;
}
function normalizeMimeType(value) {
    const candidate = String(value || "").trim().toLowerCase();
    const mimeType = candidate === "image/jpg" ? "image/jpeg" : candidate;
    if (!MIME_TYPE.test(mimeType)) {
        throw mediaError("CORE_MEDIA_MIME_TYPE_INVALID", 400);
    }
    if (mimeType === "image/svg+xml" || mimeType === "text/html") {
        throw mediaError("CORE_MEDIA_ACTIVE_CONTENT_NOT_ALLOWED", 415);
    }
    return mimeType;
}
function normalizeJsonValue(value, depth = 0) {
    if (depth > 8)
        throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        if (typeof value === "string" && value.length > 4096) {
            throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
        }
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 256)
            throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
        return value.map((entry) => normalizeJsonValue(entry, depth + 1));
    }
    if (!value || typeof value !== "object") {
        throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
    }
    const entries = Object.entries(value);
    if (entries.length > 256)
        throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
    return Object.fromEntries(entries.map(([key, entry]) => {
        if (!key
            || key.length > 128
            || ["__proto__", "constructor", "prototype"].includes(key)
            || /[\u0000-\u001f\u007f]/.test(key)) {
            throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
        }
        return [key, normalizeJsonValue(entry, depth + 1)];
    }));
}
function normalizeMetadata(value) {
    if (value === undefined)
        return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
    }
    const normalized = normalizeJsonValue(value);
    if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") {
        throw mediaError("CORE_MEDIA_METADATA_INVALID", 400);
    }
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_METADATA_BYTES) {
        throw mediaError("CORE_MEDIA_METADATA_TOO_LARGE", 413);
    }
    return normalized;
}
function decodeBase64(value, maximumBytes) {
    if (typeof value !== "string" || !value || value.length % 4 !== 0) {
        throw mediaError("CORE_MEDIA_BASE64_INVALID", 400);
    }
    const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4 + 4;
    if (value.length > maximumEncodedLength) {
        throw mediaError("CORE_MEDIA_TOO_LARGE", 413, { maxBytes: maximumBytes });
    }
    // Canonical decode/re-encode below validates alphabet, padding and unused
    // bits without a repeated RegExp group that can overflow on large photos.
    const bytes = Buffer.from(value, "base64");
    if (!bytes.length || bytes.toString("base64") !== value) {
        throw mediaError("CORE_MEDIA_BASE64_INVALID", 400);
    }
    if (bytes.length > maximumBytes) {
        throw mediaError("CORE_MEDIA_TOO_LARGE", 413, { maxBytes: maximumBytes });
    }
    return bytes;
}
function hasPrefix(bytes, expected) {
    return bytes.length >= expected.length
        && expected.every((value, index) => bytes[index] === value);
}
function assertContentMatchesMimeType(bytes, mimeType, kind) {
    if (kind === "image" && !SAFE_IMAGE_MIME_TYPES.has(mimeType)) {
        throw mediaError("CORE_MEDIA_IMAGE_TYPE_NOT_SUPPORTED", 415);
    }
    const valid = mimeType === "image/png"
        ? hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : mimeType === "image/jpeg"
            ? hasPrefix(bytes, [0xff, 0xd8, 0xff])
            : mimeType === "image/gif"
                ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
                : mimeType === "image/webp"
                    ? bytes.length >= 12
                        && bytes.subarray(0, 4).toString("ascii") === "RIFF"
                        && bytes.subarray(8, 12).toString("ascii") === "WEBP"
                    : mimeType === "application/pdf"
                        ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
                        : true;
    if (!valid)
        throw mediaError("CORE_MEDIA_CONTENT_TYPE_MISMATCH", 415);
}
function normalizeInput(input, maximumBytes) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw mediaError("CORE_MEDIA_INPUT_INVALID", 400);
    }
    const kind = String(input.kind || "").trim().toLowerCase();
    if (!KIND.test(kind))
        throw mediaError("CORE_MEDIA_KIND_INVALID", 400);
    const scope = input.scope === undefined || input.scope === null || input.scope === ""
        ? null
        : String(input.scope).trim();
    if (scope !== null && !SCOPE.test(scope)) {
        throw mediaError("CORE_MEDIA_SCOPE_INVALID", 400);
    }
    const fileName = normalizeFileName(input.fileName);
    const metadata = normalizeMetadata(input.metadata);
    const mimeType = normalizeMimeType(input.mimeType);
    const bytes = decodeBase64(input.dataBase64, maximumBytes);
    assertContentMatchesMimeType(bytes, mimeType, kind);
    return {
        kind,
        scope,
        mimeType,
        bytes,
        fileName,
        metadata,
    };
}
function extensionForMimeType(mimeType) {
    const extensions = {
        "application/json": ".json",
        "application/pdf": ".pdf",
        "image/gif": ".gif",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "text/csv": ".csv",
        "text/plain": ".txt",
    };
    return extensions[mimeType] || ".bin";
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function isMissingFile(error) {
    return error?.code === "ENOENT";
}
async function ensureRootDirectory(storageRoot) {
    await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(storageRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw mediaError("CORE_MEDIA_STORAGE_ROOT_UNSAFE", 500);
    }
    return fs.realpath(storageRoot);
}
async function ensureChildDirectory(parent, childName) {
    const target = path.join(parent, childName);
    await fs.mkdir(target, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST")
            throw error;
    });
    const stats = await fs.lstat(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
    }
    const realTarget = await fs.realpath(target);
    if (path.dirname(realTarget) !== parent) {
        throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
    }
    return realTarget;
}
async function writeDurableFile(filePath, bytes) {
    const handle = await fs.open(filePath, fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL, 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
function sidecarToCreated(sidecar, publicBasePath) {
    return {
        id: sidecar.id,
        moduleKey: sidecar.moduleKey,
        kind: sidecar.kind,
        scope: sidecar.scope,
        url: `${publicBasePath}/${encodeURIComponent(sidecar.id)}`,
        originalFileName: sidecar.originalFileName,
        mimeType: sidecar.mimeType,
        sizeBytes: sidecar.sizeBytes,
        sha256: sidecar.sha256,
        createdAt: sidecar.createdAt,
    };
}
function validateSidecar(value, parsed, publicBasePath, maximumBytes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw mediaError("CORE_MEDIA_CORRUPT", 500);
    }
    const sidecar = value;
    const expectedStoredPrefix = "content.";
    if (sidecar.schemaVersion !== MODULE_MEDIA_CONTRACT_VERSION
        || sidecar.id !== parsed.id
        || sidecar.moduleKey !== parsed.moduleKey
        || typeof sidecar.kind !== "string"
        || !KIND.test(sidecar.kind)
        || !(sidecar.scope === null || (typeof sidecar.scope === "string" && SCOPE.test(sidecar.scope)))
        || typeof sidecar.relativePath !== "string"
        || typeof sidecar.originalFileName !== "string"
        || typeof sidecar.storedFileName !== "string"
        || !sidecar.storedFileName.startsWith(expectedStoredPrefix)
        || sidecar.storedFileName.includes("/")
        || sidecar.storedFileName.includes("\\")
        || typeof sidecar.mimeType !== "string"
        || !MIME_TYPE.test(sidecar.mimeType)
        || !Number.isSafeInteger(sidecar.sizeBytes)
        || Number(sidecar.sizeBytes) < 1
        || Number(sidecar.sizeBytes) > maximumBytes
        || typeof sidecar.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(sidecar.sha256)
        || typeof sidecar.createdAt !== "string"
        || Number.isNaN(Date.parse(sidecar.createdAt))
        || !sidecar.metadata
        || typeof sidecar.metadata !== "object"
        || Array.isArray(sidecar.metadata)) {
        throw mediaError("CORE_MEDIA_CORRUPT", 500);
    }
    const expectedRelativePath = path.posix.join("modules", parsed.encodedModuleKey, "objects", parsed.objectToken, sidecar.storedFileName);
    if (sidecar.relativePath !== expectedRelativePath) {
        throw mediaError("CORE_MEDIA_CORRUPT", 500);
    }
    const normalizedMetadata = normalizeMetadata(sidecar.metadata);
    return {
        ...sidecar,
        metadata: normalizedMetadata,
    };
}
export function createModuleMediaStore(options = {}) {
    const storageRoot = resolveStorageRoot(options.storageRoot);
    const publicBasePath = resolveMediaPublicBasePath(options.publicBasePath);
    const maximumBytes = configuredMaximum(options.maxUploadBytes ?? process.env.MEDIA_MAX_UPLOAD_BYTES);
    async function moduleObjectsDirectory(encodedModuleKey, create) {
        const root = create
            ? await ensureRootDirectory(storageRoot)
            : await fs.realpath(storageRoot).catch((error) => {
                if (isMissingFile(error))
                    throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
                throw error;
            });
        const rootStats = await fs.lstat(root);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
            throw mediaError("CORE_MEDIA_STORAGE_ROOT_UNSAFE", 500);
        }
        if (create) {
            const modules = await ensureChildDirectory(root, "modules");
            const moduleDirectory = await ensureChildDirectory(modules, encodedModuleKey);
            return ensureChildDirectory(moduleDirectory, "objects");
        }
        const modules = path.join(root, "modules");
        const moduleDirectory = path.join(modules, encodedModuleKey);
        const objects = path.join(moduleDirectory, "objects");
        for (const [candidate, expectedParent] of [
            [modules, root],
            [moduleDirectory, modules],
            [objects, moduleDirectory],
        ]) {
            const stats = await fs.lstat(candidate).catch((error) => {
                if (isMissingFile(error))
                    throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
                throw error;
            });
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
                throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
            }
            if (path.dirname(await fs.realpath(candidate)) !== expectedParent) {
                throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
            }
        }
        return objects;
    }
    async function objectDirectory(parsed, create) {
        const objects = await moduleObjectsDirectory(parsed.encodedModuleKey, create);
        const directory = path.join(objects, parsed.objectToken);
        if (create) {
            await fs.mkdir(directory, { mode: 0o700 });
        }
        const stats = await fs.lstat(directory).catch((error) => {
            if (isMissingFile(error))
                throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
            throw error;
        });
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
        }
        if (path.dirname(await fs.realpath(directory)) !== objects) {
            throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
        }
        return directory;
    }
    async function create(moduleKeyValue, input) {
        const moduleKey = assertModuleKey(moduleKeyValue);
        const normalized = normalizeInput(input, maximumBytes);
        const encodedModuleKey = encodeModuleKey(moduleKey);
        const objectToken = randomBytes(24).toString("base64url");
        const id = `${encodedModuleKey}.${objectToken}`;
        const parsed = parseMediaId(id);
        const storedFileName = `content${extensionForMimeType(normalized.mimeType)}`;
        const relativePath = path.posix.join("modules", encodedModuleKey, "objects", objectToken, storedFileName);
        const createdAt = new Date().toISOString();
        const sidecar = {
            schemaVersion: MODULE_MEDIA_CONTRACT_VERSION,
            id,
            moduleKey,
            kind: normalized.kind,
            scope: normalized.scope,
            relativePath,
            originalFileName: normalized.fileName,
            storedFileName,
            mimeType: normalized.mimeType,
            sizeBytes: normalized.bytes.length,
            sha256: sha256(normalized.bytes),
            createdAt,
            metadata: normalized.metadata,
        };
        let directory = null;
        try {
            directory = await objectDirectory(parsed, true);
            await writeDurableFile(path.join(directory, storedFileName), normalized.bytes);
            await writeDurableFile(path.join(directory, "metadata.json"), `${JSON.stringify(sidecar)}\n`);
            return sidecarToCreated(sidecar, publicBasePath);
        }
        catch (error) {
            if (directory)
                await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }
    async function read(mediaId) {
        const parsed = parseMediaId(mediaId);
        const directory = await objectDirectory(parsed, false);
        const metadataPath = path.join(directory, "metadata.json");
        const metadataStats = await fs.lstat(metadataPath).catch((error) => {
            if (isMissingFile(error))
                throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
            throw error;
        });
        if (!metadataStats.isFile()
            || metadataStats.isSymbolicLink()
            || metadataStats.size < 2
            || metadataStats.size > MAX_SIDECAR_BYTES) {
            throw mediaError("CORE_MEDIA_CORRUPT", 500);
        }
        let sidecar;
        try {
            sidecar = validateSidecar(JSON.parse(await fs.readFile(metadataPath, "utf8")), parsed, publicBasePath, maximumBytes);
        }
        catch (error) {
            if (error?.code?.startsWith("CORE_MEDIA_"))
                throw error;
            throw mediaError("CORE_MEDIA_CORRUPT", 500, undefined, error);
        }
        const contentPath = path.join(directory, sidecar.storedFileName);
        const contentStats = await fs.lstat(contentPath).catch((error) => {
            if (isMissingFile(error))
                throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
            throw error;
        });
        if (!contentStats.isFile() || contentStats.isSymbolicLink()) {
            throw mediaError("CORE_MEDIA_STORAGE_PATH_UNSAFE", 500);
        }
        const noFollow = typeof fileConstants.O_NOFOLLOW === "number" ? fileConstants.O_NOFOLLOW : 0;
        const handle = await fs.open(contentPath, fileConstants.O_RDONLY | noFollow).catch((error) => {
            if (isMissingFile(error))
                throw mediaError("CORE_MEDIA_NOT_FOUND", 404);
            throw error;
        });
        let bytes;
        try {
            const stats = await handle.stat();
            if (!stats.isFile() || stats.size !== sidecar.sizeBytes) {
                throw mediaError("CORE_MEDIA_CORRUPT", 500);
            }
            bytes = await handle.readFile();
        }
        finally {
            await handle.close();
        }
        if (bytes.length !== sidecar.sizeBytes || sha256(bytes) !== sidecar.sha256) {
            throw mediaError("CORE_MEDIA_CORRUPT", 500);
        }
        return {
            ...sidecarToCreated(sidecar, publicBasePath),
            metadata: sidecar.metadata,
            bytes,
        };
    }
    async function remove(mediaId, expectedModuleKeyValue) {
        const expectedModuleKey = assertModuleKey(expectedModuleKeyValue);
        const parsed = parseMediaId(mediaId);
        if (parsed.moduleKey !== expectedModuleKey) {
            throw mediaError("CORE_MEDIA_MODULE_OWNERSHIP_MISMATCH", 403);
        }
        const directory = await objectDirectory(parsed, false);
        await fs.rm(directory, { recursive: true, force: true });
    }
    return Object.freeze({ create, read, remove });
}
let defaultStore = null;
export function getCoreMediaStore() {
    defaultStore ||= createModuleMediaStore();
    return defaultStore;
}
export function createModuleMediaRuntime(moduleKeyValue, auditClient, store = getCoreMediaStore()) {
    const moduleKey = assertModuleKey(moduleKeyValue);
    const runtime = {
        contractVersion: MODULE_MEDIA_CONTRACT_VERSION,
        moduleKey,
        async createMedia(input) {
            const media = await store.create(moduleKey, input);
            try {
                if (typeof auditClient?.auditLog?.create !== "function") {
                    throw mediaError("CORE_MEDIA_AUDIT_UNAVAILABLE", 503);
                }
                await auditClient.auditLog.create({
                    data: {
                        category: "DATA",
                        event: "MODULE_MEDIA_CREATED",
                        result: "SUCCESS",
                        targetType: "ModuleMedia",
                        targetId: media.id,
                        severity: "INFO",
                        metadataJson: {
                            moduleKey,
                            kind: media.kind,
                            scope: media.scope,
                            mimeType: media.mimeType,
                            sizeBytes: media.sizeBytes,
                            sha256: media.sha256,
                        },
                    },
                });
            }
            catch (error) {
                await store.remove(media.id, moduleKey).catch(() => undefined);
                if (error?.code === "CORE_MEDIA_AUDIT_UNAVAILABLE")
                    throw error;
                throw mediaError("CORE_MEDIA_AUDIT_FAILED", 503, undefined, error);
            }
            return media;
        },
        async readMedia(mediaId) {
            const media = await store.read(mediaId);
            if (media.moduleKey !== moduleKey) {
                throw mediaError("CORE_MEDIA_MODULE_OWNERSHIP_MISMATCH", 403);
            }
            return media;
        },
        async removeMedia(mediaId) {
            const media = await store.read(mediaId);
            if (media.moduleKey !== moduleKey) {
                throw mediaError("CORE_MEDIA_MODULE_OWNERSHIP_MISMATCH", 403);
            }
            await store.remove(mediaId, moduleKey);
            if (typeof auditClient?.auditLog?.create === "function") {
                await auditClient.auditLog.create({
                    data: {
                        category: "DATA",
                        event: "MODULE_MEDIA_REMOVED",
                        result: "SUCCESS",
                        targetType: "ModuleMedia",
                        targetId: mediaId,
                        severity: "INFO",
                        metadataJson: {
                            moduleKey,
                            kind: media.kind,
                            scope: media.scope,
                            mimeType: media.mimeType,
                            sizeBytes: media.sizeBytes,
                            sha256: media.sha256,
                        },
                    },
                });
            }
            return { ok: true, id: mediaId };
        },
    };
    return Object.freeze({
        ...runtime,
        createMedia: (input) => withMediaDiagnostic(moduleKey, 'create', () => runtime.createMedia(input)),
        readMedia: (mediaId) => withMediaDiagnostic(moduleKey, 'read', () => runtime.readMedia(mediaId)),
    });
}
