import { Prisma } from "@prisma/client";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import type { ErasureCase } from "./erasure-cycle.js";
import type { RetentionBridge, RetentionPolicy } from "./erasure-retention-vault.js";
import { retentionDescriptor, retainedSubjectId } from "./erasure-retention-model.js";
import { prepareRetentionAttachment, cleanupRetentionAttachments, verifyRetentionAttachments } from "./erasure-retention-files.js";
export const supportedCoreRetention = new Set(["AuditLog", "TimeCapsuleEvent", "ArchiveFile", "PeopleDocument", "PeopleSepaMandate"]);
export function coreRetentionCandidate(model: string, record: any) {
 return retentionDescriptor("core", model, ["id"], record, model === "AuditLog" || model === "TimeCapsuleEvent" ? "AUDIT" : "DOCUMENTS", model === "PeopleSepaMandate");
}
export function isActorOnlyCoreRecord(model: string, record: any, row: ErasureCase) {
 const own = new Set([...row.subject.accountIds, ...row.subject.personIds, ...row.subject.memberIds]);
 return model === "TimeCapsuleEvent" && row.subject.accountIds.includes(record.actorAccountId) && !own.has(record.entityId);
}
export async function inspectCoreRetention(row: ErasureCase, entries: any[], bridge?: RetentionBridge) {
 const candidates: any[] = [], unsupported: any[] = [];
 for (const entry of entries) {
  if (!supportedCoreRetention.has(entry.name)) continue;
  for (const record of entry.rows) {
   if (isActorOnlyCoreRecord(entry.name, record, row)) continue;
   if ((entry.name === "PeopleDocument" || entry.name === "PeopleSepaMandate") && !row.subject.personIds.includes(record.personId)) {
    unsupported.push({ module: "core", model: entry.name, count: 1, reason: "SHARED_SUBJECT" }); continue;
   }
   if (entry.name === "ArchiveFile") {
    const folder = await getServerPrismaClient("core").archiveFolder.findUnique({ where: { id: record.folderId }, include: { grants: true } });
    if (!folder || !row.subject.personIds.includes(record.ownerPersonId) || !row.subject.personIds.includes(folder.ownerPersonId) ||
     folder.grants.some(g => !g.revokedAt && (!g.expiresAt || g.expiresAt > new Date()) && !row.subject.personIds.includes(g.granteePersonId))) {
      unsupported.push({ module: "core", model: entry.name, count: 1, reason: "SHARED_SUBJECT" }); continue;
    }
   }
   if (entry.name === "PeopleSepaMandate" && record.documentObjectKeyEncrypted) {
    unsupported.push({ module: "core", model: entry.name, count: 1, reason: "MANDATE_DOCUMENT_REVIEW" }); continue;
   }
   const candidate = coreRetentionCandidate(entry.name, record), state = await bridge?.assess(candidate, record);
   if (state !== "archived") candidates.push({ ...candidate, ...(state === "changed" ? { changed: true } : {}) });
  }
 }
 return { candidates, unsupported };
}
export async function archiveCoreRetention(row: ErasureCase, entries: any[], bridge: RetentionBridge, policy: RetentionPolicy) {
 for (const entry of entries) {
  if (!supportedCoreRetention.has(entry.name)) continue;
  for (const record of entry.rows) {
   const database: any = getServerPrismaClient(entry.domain), delegate = database[entry.delegate];
   if (isActorOnlyCoreRecord(entry.name, record, row)) { await delegate.update({ where: { id: record.id }, data: { actorAccountId: null } }); continue; }
   const candidate = coreRetentionCandidate(entry.name, record);
   if (await bridge.assess(candidate, record) === "archived") continue;
   let sanitized: any = null, attachment: any = null;
   if (entry.name === "TimeCapsuleEvent") sanitized = { ...record, actorAccountId: null, entityType: "PrivacyErasure", entityId: retainedSubjectId(row.id), eventType: "ERASURE_TOMBSTONE",
     action: "ERASED", beforeJson: null, afterJson: null, metadataJson: { erasureReceipt: candidate.key }, terminalId: null, localNodeId: null, sourceId: null };
   if (entry.name === "ArchiveFile" || entry.name === "PeopleDocument")
    attachment = await prepareRetentionAttachment(row.id, candidate.key, entry.name, record, policy.records.find(r => r.key === candidate.key)?.action === "retain");
   await bridge.capture(candidate, record, sanitized, attachment);
   if (sanitized) {
    const { id: _id, ...data } = sanitized;
    await delegate.update({ where: { id: record.id }, data: { ...data, beforeJson: Prisma.DbNull, afterJson: Prisma.DbNull } });
   } else await delegate.deleteMany({ where: { id: record.id } });
  }
 }
 await cleanupRetentionAttachments(row.id);
 if (!await verifyRetentionAttachments(row.id)) throw Object.assign(Error("ERASURE_DOCUMENT_CLEANUP_PENDING"), { code: "ERASURE_DOCUMENT_CLEANUP_PENDING" });
}
