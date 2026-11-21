import { erasureStatusMailbox } from "./erasure-status-mailbox.js";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { readErasureCycleSettings } from "./erasure-cycle.service.js";
import { withErasureWriteLock } from "./erasure-write-barrier.js";

export function erasureAcknowledgement(nextRunAt: string, approved = false) {
  const date = new Date(nextRunAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "long", timeStyle: "short" });
  return {
    title: "Dein Löschantrag wurde angenommen.", nextRunAt,
    message: approved
      ? `Dein Löschantrag wurde freigegeben. Dein Zugang wird deaktiviert. Die Löschung ist für den nächsten Löschzyklus am ${date} Uhr vorgesehen. Falls noch Daten oder Vorgänge geklärt werden müssen, wird die Löschung bis zur Klärung angehalten.`
      : `Dein Löschantrag wurde angenommen. Die Löschung ist für den nächsten Löschzyklus am ${date} Uhr vorgesehen. Dafür muss die Verwaltung deinen Antrag noch freigeben; Kontostände und offene Vorgänge müssen geklärt sein. Nach der Freigabe wird dein Zugang deaktiviert.`,
  };
}
/** Deterministic IDs make a retry after a lost HTTP response safe. The
 * durable PrivacyRequest is the delivery source; no external recipient. */
export async function notifyErasureMember(accountId: string, requestId: string, approved = false) {
  const settings = await readErasureCycleSettings();
  const statusPath = await erasureStatusMailbox().link(requestId);
  const request = await getServerPrismaClient("privacy").privacyRequest.findUnique({ where: { id: requestId }, select: { resultJson: true } });
  const state = (request?.resultJson as any)?.cycle?.state || (approved ? "APPROVED_PENDING_CHECKS" : "REQUESTED");
  await erasureStatusMailbox().publish(requestId, state, settings.enabled ? settings.nextRunAt : null);
  const acknowledgement = { ...erasureAcknowledgement(settings.nextRunAt, approved), statusPath };
  if (!settings.enabled) acknowledgement.message += " Der automatische Löschlauf ist derzeit pausiert; der Termin wird nach der Wiederaufnahme aktualisiert.";
  const db = getServerPrismaClient("core");
  const id = `erasure-${approved ? "approved" : "received"}:${requestId}`;
  await withErasureWriteLock(async () => {
  if (!await db.account.findUnique({ where: { id: accountId }, select: { id: true } })) return;
  await db.notification.upsert({ where: { id }, create: {
    id, accountId, type: approved ? "PRIVACY_ERASURE_APPROVED" : "PRIVACY_ERASURE_RECEIVED", severity: "INFO",
    message: acknowledgement.message, relatedEntityType: "PrivacyRequest", relatedEntityId: requestId,
    metadataJson: { title: acknowledgement.title, nextRunAt: acknowledgement.nextRunAt, scope: "BONNI_USER_AND_ALL_APPS", statusPath },
  }, update: {} });
  });
  return acknowledgement;
}
