// @ts-nocheck
import { createHash } from "node:crypto";
/** Stable representation shared with the owning app participants. */
export function retentionJson(value) {
    if (value === null || value === undefined)
        return value ?? null;
    if (value instanceof Date)
        return { $date: value.toISOString() };
    if (typeof value === "bigint")
        return { $bigint: value.toString() };
    if (Buffer.isBuffer(value) || value instanceof Uint8Array)
        return { $bytes: Buffer.from(value).toString("base64") };
    if (Array.isArray(value))
        return value.map(retentionJson);
    if (typeof value === "object") {
        if (typeof value.toJSON === "function" && Object.getPrototypeOf(value) !== Object.prototype)
            return retentionJson(value.toJSON());
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, retentionJson(value[k])]));
    }
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value)))
        throw Error("ERASURE_RETENTION_DATA_INVALID");
    return value;
}
export const retentionHash = value => createHash("sha256").update(JSON.stringify(retentionJson(value))).digest("hex");
export const retainedSubjectId = requestId => "retained_" + retentionHash(requestId).slice(0, 40);
export function retentionDescriptor(module, model, primary, row, category, required = false) {
    const locator = Object.fromEntries(primary.map(field => [field, retentionJson(row[field])]));
    if (!primary.length || Object.values(locator).some(v => v == null))
        throw Error("ERASURE_RETENTION_LOCATOR_INVALID");
    return { key: retentionHash([module, model, locator]), module, model, locator, category, required,
        fingerprint: retentionHash(row), label: String(row.invoiceNumber || row.bookingNumber || row.displayName || model), occurredAt: row.issuedAt || row.createdAt || row.updatedAt || null };
}
const safeFields = new Set(["status", "state", "type", "kind", "currency", "method", "paymentMethod", "settlementOwner", "operation", "operationType",
    "unit", "unitType", "direction", "eventType", "entryType", "source", "sourceType", "protocol", "invoiceNumber", "number", "bookingNumber", "transactionNumber"]);
/** Financial amounts, dates, enum values and row relations stay intact. Free
 * text, document snapshots and personal extensions move to the sealed vault. */
export function anonymizeRetainedRow(row, fields, subject) {
    const identifiers = new Set([...subject.accountIds, ...subject.personIds, ...subject.memberIds]);
    const replacement = retainedSubjectId(subject.requestId), data = {};
    for (const field of fields) {
        const name = field.name, value = row[name];
        if (field.primary || value == null)
            continue;
        if (field.list) {
            data[name] = /Ids$|Keys$/i.test(name) ? value.map(v => identifiers.has(v) ? replacement : v) : [];
        }
        else if (field.type === "Json" || field.type === "Bytes") {
            data[name] = field.nullable ? null : field.type === "Json" ? { archived: true } : Buffer.alloc(0);
        }
        else if (field.type === "String") {
            if (identifiers.has(value) && field.relation)
                continue;
            if (identifiers.has(value))
                data[name] = field.nullable ? null : replacement;
            else if (/Id$|Key$|Hash$|Fingerprint$/i.test(name) || /(?:Status|State|Type|Kind|Method|Currency|Version)$/.test(name) || ["accountCode", "taxCode", "vatCode", "costCenterCode"].includes(name) || safeFields.has(name) || field.enum)
                continue;
            else
                data[name] = field.nullable ? null : field.unique ? `archived_${retentionHash([subject.requestId, name, value]).slice(0, 40)}` : "Archiviert";
        }
        else if (field.type === "DateTime" && /birth|geburt/i.test(name))
            data[name] = field.nullable ? null : new Date(0);
    }
    return data;
}
export function validateRetentionDecisions(candidates, decisions, now = new Date()) {
    if (!Array.isArray(decisions) || decisions.length !== candidates.length || decisions.length > 2000)
        throw Error("ERASURE_RETENTION_PLAN_INCOMPLETE");
    const byKey = new Map(decisions.map(d => [d.key, d]));
    if (byKey.size !== decisions.length)
        throw Error("ERASURE_RETENTION_PLAN_INCOMPLETE");
    return candidates.map(candidate => {
        const d = byKey.get(candidate.key);
        if (!d || !["retain", "delete"].includes(d.action) || (candidate.required && d.action !== "retain"))
            throw Error("ERASURE_RETENTION_PLAN_INCOMPLETE");
        if (d.action === "retain" && (typeof d.reason !== "string" || d.reason.trim().length < 8 || d.reason.length > 500 ||
            typeof d.until !== "string" || !Number.isFinite(Date.parse(d.until)) || Date.parse(d.until) <= now.getTime() ||
            Date.parse(d.until) > now.getTime() + 30 * 366 * 86_400_000))
            throw Error("ERASURE_RETENTION_PERIOD_REQUIRED");
        return { ...candidate, action: d.action, ...(d.action === "retain" ? { until: new Date(d.until).toISOString(), reason: d.reason.trim() } : {}) };
    });
}
export function retentionApprovalBinding(requestId, revision, scopeHash, records, actor) {
    return "erasure-retain:" + requestId + ":" + retentionHash([revision, scopeHash, records, actor.id, actor.personId, actor.sessionId, actor.revision]);
}
