import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { derivePurposeRootKey } from "../../security/crypto/derived-keys.js";
import { storeProtectedDocument, readProtectedDocument, deleteProtectedDocument } from "../../../core/protected-documents/protected-document-storage.js";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { retentionJson, retentionHash } from "./erasure-retention-model.js";
const prefix = "erasure:vault:v1:";
const privacy = () => getServerPrismaClient("privacy");
const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const key = () => {
    const root = derivePurposeRootKey("personal-data-encryption");
    try {
        return createHash("sha256").update(root).update("\0bonni.retention.v1").digest();
    }
    finally {
        root.fill(0);
    }
};
export function sealRetention(value, aad) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.from(JSON.stringify(retentionJson(value)));
    if (bytes.length > 4 * 1024 * 1024)
        return fail("ERASURE_RETENTION_RECORD_TOO_LARGE");
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]).toString("base64url");
    return { iv: iv.toString("base64url"), data, tag: cipher.getAuthTag().toString("base64url") };
}
export function openRetention(value, aad) {
    const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(value.iv, "base64url"));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, "base64url")), cipher.final()]).toString("utf8"));
}
const storageKey = (requestId, recordKey) => `${prefix}${requestId}:${recordKey}`;
function header(record) {
    return JSON.stringify([record.schema, record.requestId, record.key, record.module, record.model, record.category, record.sourceHash,
        record.sanitizedHash, record.action, record.until, record.approvedBy, record.approvedAt, retentionJson(record.locator)]);
}
function equalHash(left, right) {
    return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
async function protectBinaryPayload(original, requestId, recordKey) {
    const binaries = [];
    async function visit(value, at) {
        if (!value || typeof value !== "object")
            return value;
        if (Object.keys(value).length === 1 && typeof value.$bytes === "string" && value.$bytes.length > 256 * 1024) {
            if (binaries.length >= 128)
                return fail("ERASURE_RETENTION_RECORD_TOO_LARGE");
            const bytes = Buffer.from(value.$bytes, "base64"), suffix = retentionHash(at).slice(0, 32), subjectId = `retention:${requestId}:${recordKey}:${suffix}`;
            const objectKey = "pd_" + createHash("sha256").update(subjectId).digest("base64url").slice(0, 32) + ".arc";
            await storeProtectedDocument({ domain: "people", subjectId, bytes, objectKey });
            const attachment = { domain: "people", subjectId, objectKey }, sha256 = createHash("sha256").update(bytes).digest("hex");
            if (createHash("sha256").update(await readProtectedDocument(attachment)).digest("hex") !== sha256)
                return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
            binaries.push({ at, attachment, sha256 });
            return { $bytes: null };
        }
        if (Array.isArray(value)) {
            const result = [];
            for (let i = 0; i < value.length; i++)
                result.push(await visit(value[i], [...at, String(i)]));
            return result;
        }
        const entries = [];
        for (const [key, entry] of Object.entries(value))
            entries.push([key, await visit(entry, [...at, key])]);
        return Object.fromEntries(entries);
    }
    return { original: await visit(retentionJson(original), []), binaries };
}
async function restoreBinaryPayload(payload) {
    const original = structuredClone(payload.original);
    for (const entry of payload.binaries || []) {
        const bytes = await readProtectedDocument(entry.attachment);
        if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
            return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
        let target = original;
        for (const key of entry.at.slice(0, -1)) {
            if (!Object.hasOwn(target, key))
                return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
            target = target[key];
        }
        if (!entry.at.length || !Object.hasOwn(target, entry.at.at(-1)))
            return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
        Object.defineProperty(target, entry.at.at(-1), { enumerable: true, configurable: true, writable: true, value: { $bytes: bytes.toString("base64") } });
    }
    return original;
}
export function createRetentionBridge(requestId, module, policy, database = privacy()) {
    const decisions = new Map((policy?.records || []).filter(r => r.module === module).map(r => [r.key, r]));
    async function stored(candidate) {
        if (candidate.module !== module || !/^[a-f0-9]{64}$/.test(candidate.key))
            return fail("ERASURE_RETENTION_SCOPE_INVALID");
        const row = await database.privacySetting.findUnique({ where: { key: storageKey(requestId, candidate.key) } });
        return row?.value;
    }
    return {
        async checkDocument(fileId) {
            const request = await database.privacyRequest.findUnique({ where: { id: requestId }, select: { subjectId: true } });
            if (!request?.subjectId)
                return false;
            const file = await getServerPrismaClient("core").archiveFile.findUnique({ where: { id: fileId }, select: { ownerPersonId: true } });
            return file?.ownerPersonId === request.subjectId;
        },
        async assess(candidate, row) {
            const existing = await stored(candidate), current = retentionHash(row);
            if (existing) {
                // The original transaction may have committed just before losing its
                // receipt. Verify the exact sanitized state instead of archiving twice.
                if (equalHash(current, existing.sanitizedHash))
                    return "archived";
                if (!equalHash(current, existing.sourceHash))
                    return "changed";
            }
            const decision = decisions.get(candidate.key);
            if (!decision)
                return "missing";
            if (decision.action === "retain" && (!decision.until || Date.parse(decision.until) <= Date.now()))
                return "changed";
            return equalHash(current, decision.fingerprint) ? "approved" : "changed";
        },
        async capture(candidate, original, sanitized, attachment) {
            if (!policy || !policy.proofId || !policy.approvedBy)
                return fail("ERASURE_RETENTION_APPROVAL_REQUIRED");
            const state = await this.assess(candidate, original);
            if (state === "archived")
                return;
            if (state !== "approved")
                return fail("ERASURE_RETENTION_SOURCE_CHANGED");
            const decision = decisions.get(candidate.key);
            const record = { schema: "bonni.retention-record/v1", requestId, key: candidate.key, module, model: candidate.model,
                locator: candidate.locator, category: candidate.category, sourceHash: retentionHash(original), sanitizedHash: retentionHash(sanitized),
                action: decision.action, until: decision.until || null, approvedBy: policy.approvedBy, approvedAt: policy.approvedAt };
            const previous = await stored(candidate);
            const previousPayload = previous?.payload ? openRetention(previous.payload, header(previous)) : null;
            const binaryPayload = await protectBinaryPayload(decision.action === "retain" ? original : null, requestId, candidate.key);
            record.payload = sealRetention({ ...binaryPayload, retiredBinaries: [...(previousPayload?.retiredBinaries || []), ...(previousPayload?.binaries || []).filter((old) => !binaryPayload.binaries.some((current) => current.attachment.objectKey === old.attachment.objectKey))], reason: decision.reason || null,
                label: candidate.label, occurredAt: candidate.occurredAt, attachment: attachment || null }, header(record));
            const entry = await database.privacySetting.upsert({ where: { key: storageKey(requestId, candidate.key) },
                create: { key: storageKey(requestId, candidate.key), value: record }, update: previous && header(previous) !== header(record) ? { value: record } : {} });
            const saved = entry.value;
            const content = openRetention(saved.payload, header(saved));
            if (saved.sourceHash !== record.sourceHash || saved.sanitizedHash !== record.sanitizedHash ||
                (decision.action === "retain" && retentionHash(await restoreBinaryPayload(content)) !== retentionHash(retentionJson(original))))
                return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
        },
        async verify(candidate, row) {
            const saved = await stored(candidate);
            if (!saved || !equalHash(retentionHash(row), saved.sanitizedHash))
                return false;
            if (saved.expiredAt)
                return true;
            const content = openRetention(saved.payload, header(saved));
            return saved.action === "delete" || equalHash(retentionHash(await restoreBinaryPayload(content)), saved.sourceHash);
        },
    };
}
export async function retainedRecordKeys(module) {
    const rows = await privacy().privacySetting.findMany({ where: { key: { startsWith: prefix } }, select: { value: true } });
    return rows.map(row => row.value).filter(row => row.module === module).map(row => ({ model: row.model, locator: row.locator }));
}
export async function listRetentionRecords(requestId) {
    const rows = await privacy().privacySetting.findMany({ where: { key: { startsWith: `${prefix}${requestId}:` } }, orderBy: { createdAt: "asc" } });
    return rows.map(row => {
        const value = row.value;
        return { key: value.key, model: value.model, module: value.module,
            category: value.category, until: value.until, expiredAt: value.expiredAt || null, action: value.action };
    });
}
export async function readRetentionRecord(requestId, recordKey) {
    const row = await privacy().privacySetting.findUnique({ where: { key: storageKey(requestId, recordKey) } });
    const value = row?.value;
    if (!value || value.action !== "retain" || value.expiredAt || Date.parse(value.until) <= Date.now())
        return fail("ERASURE_RETENTION_RECORD_UNAVAILABLE");
    const payload = openRetention(value.payload, header(value)), original = await restoreBinaryPayload(payload);
    if (!equalHash(retentionHash(original), value.sourceHash))
        return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
    return { original, reason: payload.reason, attachment: payload.attachment, label: payload.label, model: value.model, module: value.module, until: value.until };
}
export async function expireRetentionPayloads(now = new Date(), database = privacy(), expireAttachment) {
    const rows = await database.privacySetting.findMany({ where: { key: { startsWith: prefix } } });
    let expired = 0;
    for (const row of rows) {
        const value = row.value;
        if (value.expiredAt || (value.action === "retain" && Date.parse(value.until) > now.getTime()))
            continue;
        // No operational money/date/relation is removed by expiry. Those records
        // were already anonymized before the user's deletion could complete.
        const request = await database.privacyRequest.findUnique({ where: { id: value.requestId }, select: { status: true } });
        if (request?.status !== "COMPLETED")
            continue;
        const payload = openRetention(value.payload, header(value));
        for (const entry of [...(payload.binaries || []), ...(payload.retiredBinaries || [])])
            await deleteProtectedDocument(entry.attachment);
        const { expireRetentionAttachment } = await import("./erasure-retention-files.js");
        await (expireAttachment || expireRetentionAttachment)(value.requestId, value.key);
        const { payload: _payload, ...minimal } = value;
        await database.privacySetting.update({ where: { key: row.key }, data: { value: { ...minimal, expiredAt: now.toISOString() } } });
        expired++;
    }
    return { expired };
}
export async function retentionVerificationRecords(requestId, module) {
    const rows = await privacy().privacySetting.findMany({ where: { key: { startsWith: `${prefix}${requestId}:` } } });
    return rows.map(row => row.value).filter(row => row.module === module);
}
