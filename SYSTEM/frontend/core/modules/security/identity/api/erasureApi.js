import { apiRequest } from "../../../../../system/api/apiClient.js";
import { normalizeProofFields } from "../../two-factor/api/twoFactorDto.js";
import { buildExistingProof } from "../../two-factor/model/twoFactorPayload.js";

const base = "/api/system/user/erasure";
const purpose = "DSGVO_SUBJECT_DATA_DELETE";
const sensitive = {
  allowFailover: false, cache: "no-store", sensitive: true,
  headers: { Accept: "application/json", "Cache-Control": "no-store", Pragma: "no-cache" },
};
const safeId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const statuses = ["blocked", "clear", "unverified"];
const invalid = () => { throw new Error("Der Server hat keinen eindeutigen Antragsstand gemeldet. Bitte den Status erneut laden."); };
function pathId(value) { if (!safeId(value)) invalid(); return encodeURIComponent(value); }
function httpsRequired() {
  if (globalThis.window?.location?.protocol !== "https:") throw new Error("Öffne Bonni Core über HTTPS, um deinen 2FA-Nachweis geschützt zu übertragen.");
}
function response(data) {
  if (!data || !Object.hasOwn(data, "request")) invalid();
  const r = data.request;
  if (r !== null && (!safeId(r?.id) || !["REQUESTED", "APPROVED_PENDING_CHECKS", "DEACTIVATED", "WAITING_CYCLE", "BLOCKED", "ERASING"].includes(r?.state) || !validDate(r.requestedAt) || (r.approvedAt != null && !validDate(r.approvedAt)))) invalid();
  const checks = data.checks;
  if (checks != null && (!statuses.includes(checks.status) || checks.canExecute !== false || !Array.isArray(checks.modules)
    || checks.modules.some(m => !m || typeof m.key !== "string" || !statuses.includes(m.status) || !Array.isArray(m.reasons) || m.reasons.some(s => typeof s !== "string"))
    || (checks.reason != null && typeof checks.reason !== "string"))) invalid();
  const acknowledgement = data.acknowledgement;
  if (acknowledgement != null && (typeof acknowledgement.title !== "string" || typeof acknowledgement.message !== "string" || !validDate(acknowledgement.nextRunAt))) invalid();
  return { request: r && { id: r.id, state: r.state, requestedAt: r.requestedAt, approvedAt: r.approvedAt || null }, checks: checks || null,
    ...(acknowledgement ? { acknowledgement } : {}) };
}
export async function readErasure(token, targetAccountId, signal) {
  return response(await apiRequest(targetAccountId ? `${base}/review/${pathId(targetAccountId)}` : `${base}/me`, { ...sensitive, token, signal }));
}
export async function startErasureProof(token, action, requestId, signal) {
  httpsRequired();
  if (action !== "request" && action !== "approve") invalid();
  if (action === "approve" && !safeId(requestId)) invalid();
  const data = await apiRequest(`${base}/challenge`, {
    ...sensitive, token, signal, method: "POST", body: action === "approve" ? { action, requestId } : { action },
  });
  const challenge = data?.challenge;
  const fields = normalizeProofFields(challenge?.proofFields);
  if (!safeId(challenge?.id) || challenge.purpose !== purpose || challenge.status !== "PENDING" || !safeId(challenge.provider)
    || typeof challenge.providerLabel !== "string" || !fields.length || fields.some(f => f.name === "recoveryCode")) {
    throw new Error("Der 2FA-Anbieter hat keine gültige Sicherheitsabfrage geliefert.");
  }
  return { id: challenge.id, provider: challenge.provider, providerLabel: challenge.providerLabel || "2FA-Anbieter", proofFields: fields };
}
export async function verifyErasureProof(token, challengeId, proof, actorAccountId, signal) {
  httpsRequired();
  const v = await apiRequest(`/api/security/2fa/challenge/${pathId(challengeId)}/verify`, {
    ...sensitive, token, signal, method: "POST", body: buildExistingProof(proof),
  });
  if (v?.status !== "VERIFIED" || v.purpose !== purpose || v.id !== challengeId || !actorAccountId || v.accountId !== actorAccountId) {
    throw new Error("Die 2FA-Bestätigung konnte deinem Konto nicht zugeordnet werden.");
  }
}
export async function submitErasure(token, action, requestId, challengeId, signal, devicesCleared = false) {
  httpsRequired();
  if (!safeId(challengeId) || !["request", "approve"].includes(action)) invalid();
  const path = action === "request" ? `${base}/request` : `${base}/${pathId(requestId)}/approve`;
  const result = response(await apiRequest(path, { ...sensitive, token, signal, method: "POST", body: { challengeId, ...(action === "approve" ? { devicesCleared } : {}) } }));
  if (!result.request || (action === "approve" && (result.request.id !== requestId || !["APPROVED_PENDING_CHECKS", "DEACTIVATED", "WAITING_CYCLE", "BLOCKED"].includes(result.request.state)))) invalid();
  return result;
}
export async function readErasureCycle(token, signal) {
  return apiRequest(`${base}/cycle`, { ...sensitive, token, signal });
}

export async function executeErasureNow(token, requestId, signal) {
  httpsRequired();
  return apiRequest(`${base}/cycle/${pathId(requestId)}/execute`, {
    ...sensitive, token, signal, method: "POST", body: { confirm: "ENDGUELTIG_LOESCHEN" },
  });
}
export async function saveErasureCycle(token, settings, signal) {
  return apiRequest(`${base}/cycle`, { ...sensitive, token, signal, method: "PUT", body: settings });
}

export async function erasureCaseRequest(token, requestId, suffix, body, signal) {
 return apiRequest(`${base}/${pathId(requestId)}/${suffix}`, { ...sensitive, token, signal, method: "POST", body: body || {} });
}
export async function checkErasureCase(token, requestId, signal) {
 return apiRequest(`${base}/cycle/${pathId(requestId)}/check`, { ...sensitive, token, signal, method: "POST", body: {} });
}
export async function readErasureArchive(token, requestId, signal) {
 return apiRequest(`${base}/${pathId(requestId)}/archive`, { ...sensitive, token, signal });
}
export async function startRetentionProof(token, requestId, input, signal) {
 httpsRequired();
 const data = await erasureCaseRequest(token, requestId, "retention/challenge", input, signal);
 const challenge = data?.challenge || data, proofFields = normalizeProofFields(challenge?.proofFields);
 if (!safeId(challenge?.id) || challenge.purpose !== purpose || challenge.status !== "PENDING" || !proofFields.length) invalid();
 return { ...challenge, proofFields };
}
export async function archiveErasureAccess(token, requestId, key, input, signal) {
 httpsRequired();
 if (!/^[a-f0-9]{64}$/.test(key)) invalid();
 const data = await erasureCaseRequest(token, requestId, `archive/${key}/access`, input, signal);
 if (input.challengeId) return data;
 const proofFields = normalizeProofFields(data?.proofFields);
 if (!safeId(data?.id) || data.purpose !== purpose || data.status !== "PENDING" || !proofFields.length) invalid();
 return { ...data, proofFields };
}
