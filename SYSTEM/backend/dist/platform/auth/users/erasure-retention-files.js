import { createHash } from "node:crypto";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { storeProtectedDocument, readProtectedDocument, deleteProtectedDocument } from "../../../core/protected-documents/protected-document-storage.js";
import { readArchiveFileForRetention, deleteArchiveObjectForRetention } from "../../../system/routes/explorer/archive-file.service.js";
import { sealRetention, openRetention } from "./erasure-retention-vault.js";
const db = () => getServerPrismaClient("privacy");
const prefix = "erasure:retention-file:v1:";
const storageKey = (requestId, key) => `${prefix}${requestId}:${key}`;
const aad = (requestId, key) => `bonni.erasure-retention-file/v1:${requestId}:${key}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function prepareRetentionAttachment(requestId, key, model, row, retain) {
    const existing = await db().privacySetting.findUnique({ where: { key: storageKey(requestId, key) } });
    if (existing) {
        const value = openRetention(existing.value, aad(requestId, key));
        if (value.attachment) {
            const bytes = await readProtectedDocument(value.attachment);
            if (sha(bytes) !== value.sha256)
                throw Error("ERASURE_DOCUMENT_HASH_INVALID");
        }
        return value.attachment || null;
    }
    let bytes, source;
    if (model === "ArchiveFile") {
        const folder = await getServerPrismaClient("core").archiveFolder.findUniqueOrThrow({ where: { id: row.folderId } });
        bytes = await readArchiveFileForRetention(row, folder.storageKey);
        source = { model, folderStorageKey: folder.storageKey, objectKey: row.objectKey, sourceId: row.id };
    }
    else {
        source = { model, domain: "people", subjectId: row.personId, objectKey: row.objectKey, sourceId: row.id };
        bytes = await readProtectedDocument(source);
        if (bytes.length !== row.sizeInBytes || sha(bytes) !== row.checksum)
            throw Error("ERASURE_DOCUMENT_HASH_INVALID");
    }
    let attachment = null;
    if (retain) {
        const subjectId = `retention:${requestId}:${key}`;
        const objectKey = "pd_" + createHash("sha256").update(subjectId).digest("base64url").slice(0, 32) + ".arc";
        await storeProtectedDocument({ domain: "people", subjectId, bytes, objectKey });
        attachment = { domain: "people", subjectId, objectKey };
        if (sha(await readProtectedDocument(attachment)) !== sha(bytes))
            throw Error("ERASURE_DOCUMENT_HASH_INVALID");
    }
    const value = { source, attachment, sha256: sha(bytes), cleaned: false };
    await db().privacySetting.upsert({ where: { key: storageKey(requestId, key) },
        create: { key: storageKey(requestId, key), value: sealRetention(value, aad(requestId, key)) }, update: {} });
    return attachment;
}
export async function cleanupRetentionAttachments(requestId) {
    const rows = await db().privacySetting.findMany({ where: { key: { startsWith: `${prefix}${requestId}:` } } });
    for (const row of rows) {
        const key = row.key.slice(`${prefix}${requestId}:`.length), value = openRetention(row.value, aad(requestId, key));
        if (value.cleaned)
            continue;
        const source = value.source;
        const delegate = source.model === "ArchiveFile" ? getServerPrismaClient("core").archiveFile : getServerPrismaClient("people").peopleDocument;
        // Never remove a live object's content if its database transaction rolled back.
        if (await delegate.findUnique({ where: { id: source.sourceId }, select: { id: true } }))
            continue;
        if (source.model === "ArchiveFile")
            await deleteArchiveObjectForRetention(source.folderStorageKey, source.objectKey);
        else
            await deleteProtectedDocument(source);
        await db().privacySetting.update({ where: { key: row.key }, data: { value: sealRetention({ ...value, source: null, cleaned: true }, aad(requestId, key)) } });
    }
}
export async function verifyRetentionAttachments(requestId) {
    const rows = await db().privacySetting.findMany({ where: { key: { startsWith: `${prefix}${requestId}:` } } });
    for (const row of rows) {
        const key = row.key.slice(`${prefix}${requestId}:`.length), value = openRetention(row.value, aad(requestId, key));
        if (!value.cleaned)
            return false;
        if (value.attachment && sha(await readProtectedDocument(value.attachment)) !== value.sha256)
            return false;
    }
    return true;
}
export async function expireRetentionAttachment(requestId, key) {
    const row = await db().privacySetting.findUnique({ where: { key: storageKey(requestId, key) } });
    if (!row)
        return;
    const value = openRetention(row.value, aad(requestId, key));
    if (!value.cleaned)
        throw Error("ERASURE_RETENTION_CLEANUP_PENDING");
    if (value.attachment)
        await deleteProtectedDocument(value.attachment);
    await db().privacySetting.deleteMany({ where: { key: row.key } });
}
