import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { getStatus, createChallenge, consumeVerifiedChallenge } from "../../../core/modules/security/two-factor/service.js";
import { getVerifiedRequestIdentity, getVerifiedRequestSessionAssurance } from "../request-identity/request-identity-context.js";
import { moduleServicesRegistry, canReviewSystemErasure } from "../../../core/module-services/module-services-runtime.js";
import { retentionHash, validateRetentionDecisions, retentionApprovalBinding } from "./erasure-retention-model.js";
import { erasureRetentionContext, loadErasureCaseForReview, reviewErasureCase } from "./erasure-cycle.service.js";
import { attributableCoreRows } from "./erasure-core-participant.js";
import { inspectCoreRetention, supportedCoreRetention } from "./erasure-core-retention.js";
import { listRetentionRecords, readRetentionRecord } from "./erasure-retention-vault.js";
import { ERASURE_MODULE, erasureError, type Actor } from "./erasure-workflow.js";
import { erasureExclusive } from "./erasure-write-barrier.js";
import { readProtectedDocument } from "../../../core/protected-documents/protected-document-storage.js";
const privacy = () => getServerPrismaClient("privacy");
export async function assertErasureReviewMfa() {
 const identity = getVerifiedRequestIdentity(), session = getVerifiedRequestSessionAssurance();
 if (!identity || !canReviewSystemErasure(identity) || !session || session.accountId !== identity.accountId || session.credentialRevision !== identity.credentialRevision || !session.mfaVerifiedAt)
  return erasureError("ERASURE_REVIEW_MFA_REQUIRED", "Bitte melde dich mit deinem persönlichen 2FA-Verwaltungszugang an.", 403);
 const status = await getStatus(identity.accountId);
 if (!status.enabled || !status.available || !status.provider?.configured || status.provider.available === false || !status.provider.id ||
  session.mfaProviderId !== String(status.provider.id).trim().toLowerCase()) return erasureError("ERASURE_REVIEW_MFA_REQUIRED", "Die 2FA-Verwaltungssitzung konnte nicht bestätigt werden.", 403);
}
export async function retentionPlan(requestId: string, prepareIndex = false) {
 const { request, row, info } = await loadErasureCaseForReview(requestId);
 const { bridge } = await erasureRetentionContext(row, "core");
 const own = await inspectCoreRetention(row, await attributableCoreRows(row), bridge);
 const candidates = [...own.candidates], unsupported = [...own.unsupported];
 const modules = await getServerPrismaClient("core").installedModule.findMany({ select: { key: true, status: true, installedAt: true, enabledAt: true, uninstalledAt: true, deletedAt: true } });
 for (const module of modules) {
  if (module.status === "DISCOVERED" && !module.installedAt && !module.enabledAt && !module.uninstalledAt && !module.deletedAt) continue;
  try {
   const { bridge: appBridge } = await erasureRetentionContext(row, module.key);
   const report: any = await moduleServicesRegistry.cycleAccountErasure(module.key, "retentionPreview", { ...row.subject, recordReferences: row.references, devicesCleared: true, prepareRetentionIndex: prepareIndex }, row.approvedBy, appBridge);
   if (!Array.isArray(report?.candidates) || !Array.isArray(report?.unsupported)) throw Error("ERASURE_PARTICIPANT_INVALID");
   if (report.candidates.some((candidate: any) => candidate.module !== module.key || !/^[a-f0-9]{64}$/.test(candidate.key) || !/^[a-f0-9]{64}$/.test(candidate.fingerprint))) throw Error("ERASURE_PARTICIPANT_INVALID");
   candidates.push(...report.candidates); unsupported.push(...report.unsupported.map((value: any) => ({ module: module.key, ...value })));
  } catch { unsupported.push({ module: module.key, model: "Datenquelle", count: 0, reason: "DATA_UNAVAILABLE" }); }
 }
 if (candidates.length > 2000) return erasureError("ERASURE_SCOPE_TOO_LARGE", "Der Umfang muss vor einer Entscheidung aufgeteilt und geprüft werden.");
 candidates.sort((a, b) => a.key.localeCompare(b.key));
 return { requestId, state: request.status, revision: Number(info?.retentionPolicy?.revision || 0), candidates, unsupported,
  scopeHash: retentionHash(candidates), archived: await listRetentionRecords(requestId) };
}
async function decisionPlan(a: Actor, requestId: string, input: any) {
 const { request } = await loadErasureCaseForReview(requestId);
 if (request.status !== "IN_REVIEW") return erasureError("ERASURE_NOT_APPROVED", "Gib den Löschantrag zuerst zur Bearbeitung frei.");
 if (a.id === request.accountId || a.personId === request.subjectId) return erasureError("ERASURE_SELF_APPROVAL_FORBIDDEN", "Die Aufbewahrung muss eine andere berechtigte Person freigeben.", 403);
 const plan = await retentionPlan(requestId);
 if (input.scopeHash !== plan.scopeHash || input.revision !== plan.revision) return erasureError("ERASURE_RETENTION_SOURCE_CHANGED", "Der Datenumfang hat sich geändert. Lade die Prüfung erneut.");
 let records: any[];
 try { records = validateRetentionDecisions(plan.candidates, input.decisions); }
 catch { return erasureError("ERASURE_RETENTION_PERIOD_REQUIRED", "Lege für jeden aufzubewahrenden Nachweis eine Begründung und ein zukünftiges Enddatum fest."); }
 const subjectId = retentionApprovalBinding(requestId, plan.revision, plan.scopeHash, records, a);
 return { plan, records, binding: { purpose: "DSGVO_SUBJECT_DATA_DELETE" as const, moduleKey: ERASURE_MODULE, subjectId } };
}
export async function challengeRetention(a: Actor, requestId: string, input: any) {
 return erasureExclusive(async () => { const plan = await decisionPlan(a, requestId, input); return createChallenge(a.id, plan.binding); });
}
export async function approveRetention(a: Actor, requestId: string, input: any) {
 return erasureExclusive(async () => {
  const plan = await decisionPlan(a, requestId, input);
  await consumeVerifiedChallenge({ accountId: a.id, ...plan.binding, challengeId: input.challengeId, maxAgeMinutes: 1 });
  const request = await privacy().privacyRequest.findUniqueOrThrow({ where: { id: requestId } }), info = request.resultJson as any;
  const retentionPolicy = { revision: plan.plan.revision + 1, approvedAt: new Date().toISOString(), approvedBy: a.id,
   proofId: input.challengeId, binding: plan.binding.subjectId, records: plan.records };
  await privacy().privacyRequest.update({ where: { id: requestId }, data: { resultJson: { ...info, retentionPolicy } } });
  return { plan: await retentionPlan(requestId), check: await reviewErasureCase(requestId) };
 });
}
function readBinding(a: Actor, requestId: string, key: string, reason: string) {
 return { purpose: "DSGVO_SUBJECT_DATA_DELETE" as const, moduleKey: ERASURE_MODULE,
  subjectId: "erasure-archive:" + requestId + ":" + retentionHash([key, reason.trim(), a.id, a.sessionId, a.revision]) };
}
export async function accessRetentionRecord(a: Actor, requestId: string, key: string, reason: string, challengeId?: string) {
 const binding = readBinding(a, requestId, key, reason);
 if (!challengeId) { if (!(await listRetentionRecords(requestId)).some(row => row.key === key && row.action === "retain" && !row.expiredAt)) return erasureError("ERASURE_RETENTION_RECORD_UNAVAILABLE", "Dieser Nachweis ist nicht verfügbar."); return createChallenge(a.id, binding); }
 await consumeVerifiedChallenge({ accountId: a.id, ...binding, challengeId, maxAgeMinutes: 1 });
 const value = await readRetentionRecord(requestId, key);
 // Retention reads have a separate minimal audit trail, no copied content.
 await privacy().privacySetting.create({ data: { key: `erasure:vault-access:${requestId}:${challengeId}`, value: {
  requestId, recordKey: key, actorId: a.id, reason: reason.trim(), at: new Date().toISOString() } } });
 return { ...value, attachment: value.attachment ? { bytesBase64: (await readProtectedDocument(value.attachment)).toString("base64"), encoding: "base64" } : null };
}
