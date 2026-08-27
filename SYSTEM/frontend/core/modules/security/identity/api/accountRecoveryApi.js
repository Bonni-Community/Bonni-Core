import { apiRequest } from "../../../../../system/api/apiClient.js";
import {
  countUnicodeCodePoints,
  hasExactUtf8RoundTrip,
  LOCAL_PASSWORD_MAX_LENGTH,
  validateExactSecret,
} from "../../two-factor/model/exactSecretPolicy.js";
import { normalizeProofFields } from "../../two-factor/api/twoFactorDto.js";

export const ACCOUNT_RECOVERY_CONTRACT_VERSION = "bonni.account-recovery/v1";
export const PASSWORD_RECOVERY_BASE = "/api/auth/password-recovery";
export const ACCOUNT_RECOVERY_BASE = "/api/security/account-recovery";

const PUBLIC_STATUS_VALUES = new Set(["NONE", "PENDING", "APPROVED", "EXPIRED"]);
const PUBLIC_REQUEST_STATUS = "REQUESTED";
const PUBLIC_COMPLETE_STATUS = "COMPLETED";
const LOGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_ID = /^[A-Za-z0-9:_-]+$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const RECOVERY_REFERENCE = /^PR-[A-Z2-9]{5}-[A-Z2-9]{5}$/u;
const SUPPORT_CODE = /^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/u;
const RECOVERY_CODE = /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u;
const TOTP_CODE = /^\d{6}(?:\d{2})?$/u;
const RECOVERY_REQUEST_STATUSES = new Set(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);
const RECOVERY_DECISIONS = new Set(["APPROVE", "REJECT"]);
const CHALLENGE_PURPOSES = new Set([
  "ACCOUNT_RECOVERY_APPROVAL",
  "ACCOUNT_RECOVERY_SUPPORT_CODE",
  "ACCOUNT_RECOVERY_POLICY",
]);
const NO_STORE_HEADERS = Object.freeze({
  Accept: "application/json",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
});
const PUBLIC_REQUEST_OPTIONS = Object.freeze({
  auth: false,
  credentials: "include",
  allowFailover: false,
  cache: "no-store",
  sensitive: true,
  headers: NO_STORE_HEADERS,
});

export class AccountRecoveryContractError extends Error {
  constructor(message, code = "ACCOUNT_RECOVERY_CONTRACT_INVALID") {
    super(message);
    this.name = "AccountRecoveryContractError";
    this.code = code;
  }
}

function invalid(message) {
  throw new AccountRecoveryContractError(message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} ist ungueltig.`);
  return value;
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${label} enthaelt unbekannte Felder.`);
}

function exactText(value, label, maxCodePoints = 200) {
  if (
    typeof value !== "string"
    || !value
    || countUnicodeCodePoints(value) > maxCodePoints
    || /[\r\n\0]/u.test(value)
    || !hasExactUtf8RoundTrip(value)
  ) invalid(`${label} ist ungueltig.`);
  return value;
}

function exactId(value, label) {
  const result = exactText(value, label, 180);
  if (!SAFE_ID.test(result)) invalid(`${label} ist ungueltig.`);
  return result;
}

function exactInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} ist ungueltig.`);
  }
  return value;
}

function exactReference(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !RECOVERY_REFERENCE.test(value)) {
    invalid("Die Vorgangsnummer ist ungueltig.");
  }
  return value;
}

function contractVersion(value) {
  if (value !== ACCOUNT_RECOVERY_CONTRACT_VERSION) invalid("Die Vertragsversion der Kontowiederherstellung ist ungueltig.");
  return value;
}

function exactDateOrNull(value, label) {
  if (value === null) return null;
  const result = exactText(value, label, 64);
  if (Number.isNaN(Date.parse(result))) invalid(`${label} ist ungueltig.`);
  return result;
}

function exactDate(value, label) {
  const result = exactDateOrNull(value, label);
  if (result === null) invalid(`${label} ist erforderlich.`);
  return result;
}

export function normalizePasswordRecoveryRequest(value) {
  const source = record(value, "Anforderungsantwort");
  exactKeys(source, new Set(["contractVersion", "status", "reference"]), "Anforderungsantwort");
  contractVersion(source.contractVersion);
  if (source.status !== PUBLIC_REQUEST_STATUS) invalid("Der Anforderungsstatus ist ungueltig.");
  return {
    contractVersion: source.contractVersion,
    status: source.status,
    reference: exactReference(source.reference),
  };
}

export function normalizePasswordRecoveryStatus(value) {
  const source = record(value, "Statusantwort");
  exactKeys(source, new Set(["contractVersion", "status", "reference", "expiresAt", "supportCodeAllowed"]), "Statusantwort");
  contractVersion(source.contractVersion);
  if (!PUBLIC_STATUS_VALUES.has(source.status)) invalid("Der Wiederherstellungsstatus ist ungueltig.");
  if (typeof source.supportCodeAllowed !== "boolean") invalid("Der Support-Code-Vertrag ist ungueltig.");
  const expiresAt = exactDateOrNull(source.expiresAt, "Ablaufzeit");
  const reference = exactReference(source.reference, { nullable: true });
  if (source.status === "NONE" && (expiresAt !== null || reference !== null || source.supportCodeAllowed !== true)) {
    invalid("Ein leerer Wiederherstellungsstatus darf keine Vorgangsdaten enthalten.");
  }
  if (source.status !== "NONE" && expiresAt === null) invalid("Der Wiederherstellungsstatus besitzt keine Ablaufzeit.");
  if (source.status !== "NONE" && reference === null) invalid("Der Wiederherstellungsstatus besitzt keine Vorgangsnummer.");
  if (source.status !== "NONE" && source.supportCodeAllowed) {
    invalid("Der Support-Code ist fuer diesen Status nicht zulaessig.");
  }
  return {
    contractVersion: source.contractVersion,
    status: source.status,
    reference,
    expiresAt,
    supportCodeAllowed: source.supportCodeAllowed,
  };
}

export function normalizePasswordRecoveryResume(value) {
  const result = normalizePasswordRecoveryStatus(value);
  if (result.status !== "APPROVED" || result.supportCodeAllowed !== false) {
    invalid("Der Support-Code wurde nicht eindeutig bestaetigt.");
  }
  return result;
}

export function normalizePasswordRecoveryCompletion(value) {
  const source = record(value, "Abschlussantwort");
  exactKeys(source, new Set(["contractVersion", "status", "requiresFreshLogin"]), "Abschlussantwort");
  contractVersion(source.contractVersion);
  if (source.status !== PUBLIC_COMPLETE_STATUS || source.requiresFreshLogin !== true) {
    invalid("Der Abschluss der Wiederherstellung ist ungueltig.");
  }
  return {
    contractVersion: source.contractVersion,
    status: source.status,
    requiresFreshLogin: true,
  };
}

function clearSecretBody(body) {
  if (!body || typeof body !== "object") return;
  if (Object.hasOwn(body, "supportCode")) body.supportCode = undefined;
  if (Object.hasOwn(body, "newPassword")) body.newPassword = undefined;
  if (Object.hasOwn(body, "newPasswordConfirmation")) body.newPasswordConfirmation = undefined;
}

async function sensitivePublicRequest(path, options, normalize) {
  return normalize(await apiRequest(path, {
    ...PUBLIC_REQUEST_OPTIONS,
    ...options,
    headers: { ...NO_STORE_HEADERS, ...(options?.headers || {}) },
  }));
}

export function requestPasswordRecovery(loginName, { signal } = {}) {
  const exactLoginName = exactText(loginName, "Benutzername", 80);
  if (!LOGIN_NAME.test(exactLoginName)) invalid("Benutzername ist ungueltig.");
  return sensitivePublicRequest(`${PASSWORD_RECOVERY_BASE}/requests`, {
    method: "POST",
    signal,
    body: { loginName: exactLoginName },
  }, normalizePasswordRecoveryRequest);
}

export function fetchPasswordRecoveryStatus({ signal } = {}) {
  return sensitivePublicRequest(`${PASSWORD_RECOVERY_BASE}/status`, { signal }, normalizePasswordRecoveryStatus);
}

export async function resumePasswordRecovery(input, { signal } = {}) {
  const supportCode = exactText(input?.supportCode, "Support-Code", 23);
  if (!SUPPORT_CODE.test(supportCode)) invalid("Support-Code ist ungueltig.");
  const body = { supportCode };
  const clear = () => {
    clearSecretBody(body);
    clearSecretBody(input);
  };
  signal?.addEventListener?.("abort", clear, { once: true });
  try {
    return await sensitivePublicRequest(`${PASSWORD_RECOVERY_BASE}/resume`, {
      method: "POST",
      signal,
      body,
    }, normalizePasswordRecoveryResume);
  } finally {
    signal?.removeEventListener?.("abort", clear);
    clear();
  }
}

export async function completePasswordRecovery(input, { signal } = {}) {
  const newPassword = input?.newPassword;
  const newPasswordConfirmation = input?.newPasswordConfirmation;
  const passwordError = validateExactSecret(newPassword, {
    label: "Das neue Passwort",
    maxLength: LOCAL_PASSWORD_MAX_LENGTH,
  });
  const confirmationError = validateExactSecret(newPasswordConfirmation, {
    label: "Die Passwort-Wiederholung",
    maxLength: LOCAL_PASSWORD_MAX_LENGTH,
  });
  const passwordTooShort = typeof newPassword === "string" && countUnicodeCodePoints(newPassword) < 12;
  if (passwordError || confirmationError || passwordTooShort || newPassword !== newPasswordConfirmation) {
    invalid(passwordError || confirmationError || (passwordTooShort
      ? "Das neue Passwort muss mindestens 12 Zeichen enthalten."
      : "Die beiden Passwoerter stimmen nicht ueberein."));
  }
  const body = { newPassword, newPasswordConfirmation };
  const clear = () => {
    clearSecretBody(body);
    clearSecretBody(input);
  };
  signal?.addEventListener?.("abort", clear, { once: true });
  try {
    return await sensitivePublicRequest(`${PASSWORD_RECOVERY_BASE}/complete`, {
      method: "POST",
      signal,
      body,
    }, normalizePasswordRecoveryCompletion);
  } finally {
    signal?.removeEventListener?.("abort", clear);
    clear();
  }
}

export const passwordRecoveryApi = Object.freeze({
  getStatus: fetchPasswordRecoveryStatus,
  request: requestPasswordRecovery,
  resume: resumePasswordRecovery,
  complete: completePasswordRecovery,
});

function normalizePolicy(value) {
  if (value === null) return null;
  const source = record(value, "Wiederherstellungsrichtlinie");
  exactKeys(source, new Set(["reviewerAccountIds", "threshold"]), "Wiederherstellungsrichtlinie");
  if (!Array.isArray(source.reviewerAccountIds) || source.reviewerAccountIds.length < 3 || source.reviewerAccountIds.length > 6) {
    invalid("Die Notfallberechtigten sind ungueltig.");
  }
  const reviewerAccountIds = source.reviewerAccountIds.map((entry) => exactId(entry, "Konto-ID"));
  if (new Set(reviewerAccountIds).size !== reviewerAccountIds.length) {
    invalid("Die Notfallberechtigten sind nicht eindeutig.");
  }
  const threshold = exactInteger(source.threshold, "Erforderliche Schwelle", 3, reviewerAccountIds.length);
  return { reviewerAccountIds, threshold };
}

export function normalizeAccountRecoveryRequest(value) {
  const source = record(value, "Wiederherstellungsantrag");
  exactKeys(source, new Set([
    "id",
    "targetLabel",
    "reference",
    "status",
    "approvals",
    "threshold",
    "expiresAt",
    "canDecide",
    "targetIsCurrentAccount",
  ]), "Wiederherstellungsantrag");
  if (!RECOVERY_REQUEST_STATUSES.has(source.status)) invalid("Der Antragsstatus ist ungueltig.");
  if (typeof source.canDecide !== "boolean" || typeof source.targetIsCurrentAccount !== "boolean") {
    invalid("Der Entscheidungsvertrag ist ungueltig.");
  }
  const threshold = exactInteger(source.threshold, "Erforderliche Schwelle", 3, 6);
  const approvals = exactInteger(source.approvals, "Bestaetigungen", 0, 6);
  if (source.targetIsCurrentAccount && source.canDecide) invalid("Das Zielkonto darf nicht selbst entscheiden.");
  if (source.status !== "PENDING" && source.canDecide) invalid("Ein abgeschlossener Antrag darf nicht entschieden werden.");
  return {
    id: exactId(source.id, "Antrags-ID"),
    targetLabel: exactText(source.targetLabel, "Zielkonto", 200),
    reference: exactReference(source.reference),
    status: source.status,
    approvals,
    threshold,
    expiresAt: exactDate(source.expiresAt, "Ablaufzeit"),
    canDecide: source.canDecide,
    targetIsCurrentAccount: source.targetIsCurrentAccount,
  };
}

export function normalizeAccountRecoveryOverview(value) {
  const source = record(value, "Wiederherstellungsuebersicht");
  exactKeys(source, new Set(["contractVersion", "canReview", "canInitiate", "policy", "requests"]), "Wiederherstellungsuebersicht");
  contractVersion(source.contractVersion);
  if (typeof source.canReview !== "boolean" || typeof source.canInitiate !== "boolean") {
    invalid("Die Wiederherstellungsberechtigung ist ungueltig.");
  }
  if (source.canInitiate && !source.canReview) invalid("Eine Initiierungsberechtigung braucht eine Pruefberechtigung.");
  if (!Array.isArray(source.requests) || source.requests.length > 50) invalid("Die Antragsliste ist ungueltig.");
  const policy = normalizePolicy(source.policy);
  const requests = source.requests.map(normalizeAccountRecoveryRequest);
  if (!source.canReview && (policy !== null || requests.length > 0)) {
    invalid("Eine unberechtigte Uebersicht darf keine internen Daten enthalten.");
  }
  return {
    contractVersion: source.contractVersion,
    canReview: source.canReview,
    canInitiate: source.canInitiate,
    policy,
    requests,
  };
}

export function normalizeInitiatedAccountRecovery(value) {
  const source = record(value, "Support-Anforderungsantwort");
  exactKeys(source, new Set(["contractVersion", "request"]), "Support-Anforderungsantwort");
  contractVersion(source.contractVersion);
  return { contractVersion: source.contractVersion, request: normalizeAccountRecoveryRequest(source.request) };
}

function normalizeChallenge(value, expectedPurpose) {
  const source = record(value, "Core-2FA-Sicherheitsabfrage");
  exactKeys(source, new Set([
    "id",
    "purpose",
    "method",
    "provider",
    "providerLabel",
    "proofFields",
    "status",
    "expiresAt",
    "maxAttempts",
    "accessScope",
  ]), "Core-2FA-Sicherheitsabfrage");
  if (!CHALLENGE_PURPOSES.has(source.purpose) || source.purpose !== expectedPurpose) {
    invalid("Der Zweck der Sicherheitsabfrage ist ungueltig.");
  }
  if (source.method !== "TOTP" && source.method !== "EXTERNAL") invalid("Die 2FA-Methode ist ungueltig.");
  if (source.status !== "PENDING") invalid("Die Sicherheitsabfrage ist nicht frisch.");
  const provider = exactText(source.provider, "2FA-Anbieter", 80);
  if (!PROVIDER_ID.test(provider)) invalid("Der 2FA-Anbieter ist ungueltig.");
  const proofFields = normalizeProofFields(source.proofFields);
  if (!proofFields.length) invalid("Die Sicherheitsabfrage besitzt keine Prueffelder.");
  return {
    id: exactId(source.id, "Sicherheitsabfrage-ID"),
    purpose: source.purpose,
    method: source.method,
    provider,
    providerLabel: exactText(source.providerLabel, "2FA-Anbietername", 100),
    proofFields,
    status: source.status,
    expiresAt: exactDate(source.expiresAt, "Ablaufzeit"),
    maxAttempts: exactInteger(source.maxAttempts, "Maximale Versuche", 1, 20),
    accessScope: exactText(source.accessScope, "Sicherheitsbereich", 400),
  };
}

function normalizeChallengeEnvelope(value, { expectedPurpose, decision = null } = {}) {
  const source = record(value, "Sicherheitsabfrage-Antwort");
  const keys = decision
    ? new Set(["contractVersion", "requestId", "decision", "challenge"])
    : new Set(["contractVersion", "requestId", "challenge"]);
  exactKeys(source, keys, "Sicherheitsabfrage-Antwort");
  contractVersion(source.contractVersion);
  if (decision && source.decision !== decision) invalid("Die Entscheidung ist nicht an die Sicherheitsabfrage gebunden.");
  return {
    contractVersion: source.contractVersion,
    requestId: exactId(source.requestId, "Antrags-ID"),
    ...(decision ? { decision: source.decision } : {}),
    challenge: normalizeChallenge(source.challenge, expectedPurpose),
  };
}

export function normalizeAccountRecoveryDecisionResult(value) {
  const source = record(value, "Entscheidungsantwort");
  exactKeys(source, new Set([
    "contractVersion", "requestId", "status", "approvals", "rejections", "threshold",
  ]), "Entscheidungsantwort");
  contractVersion(source.contractVersion);
  if (!["PENDING", "APPROVED", "REJECTED"].includes(source.status)) invalid("Der Entscheidungsstatus ist ungueltig.");
  const threshold = exactInteger(source.threshold, "Erforderliche Schwelle", 3, 6);
  return {
    contractVersion: source.contractVersion,
    requestId: exactId(source.requestId, "Antrags-ID"),
    status: source.status,
    approvals: exactInteger(source.approvals, "Bestaetigungen", 0, 6),
    rejections: exactInteger(source.rejections, "Ablehnungen", 0, 6),
    threshold,
  };
}

export function normalizeIssuedSupportCode(value) {
  const source = record(value, "Support-Code-Antwort");
  exactKeys(source, new Set([
    "contractVersion", "requestId", "supportCode", "supportCodeShownOnce", "expiresAt",
  ]), "Support-Code-Antwort");
  contractVersion(source.contractVersion);
  if (source.supportCodeShownOnce !== true || typeof source.supportCode !== "string" || !SUPPORT_CODE.test(source.supportCode)) {
    invalid("Der einmalige Support-Code ist ungueltig.");
  }
  return {
    contractVersion: source.contractVersion,
    requestId: exactId(source.requestId, "Antrags-ID"),
    supportCode: source.supportCode,
    supportCodeShownOnce: true,
    expiresAt: exactDate(source.expiresAt, "Ablaufzeit"),
  };
}

export function normalizePolicyChallenge(value) {
  const source = record(value, "Richtlinien-Sicherheitsabfrage");
  exactKeys(source, new Set([
    "contractVersion", "policyRevision", "proposalHash", "challenge",
  ]), "Richtlinien-Sicherheitsabfrage");
  contractVersion(source.contractVersion);
  if (typeof source.proposalHash !== "string" || !/^[A-F0-9]{64}$/u.test(source.proposalHash)) {
    invalid("Die Richtlinienbindung ist ungueltig.");
  }
  return {
    contractVersion: source.contractVersion,
    policyRevision: exactInteger(source.policyRevision, "Richtlinienrevision", 0, Number.MAX_SAFE_INTEGER),
    proposalHash: source.proposalHash,
    challenge: normalizeChallenge(source.challenge, "ACCOUNT_RECOVERY_POLICY"),
  };
}

export function normalizePolicyResult(value) {
  const source = record(value, "Richtlinienantwort");
  exactKeys(source, new Set([
    "contractVersion", "reviewerAccountIds", "threshold", "policyRevision",
  ]), "Richtlinienantwort");
  contractVersion(source.contractVersion);
  const policy = normalizePolicy({
    reviewerAccountIds: source.reviewerAccountIds,
    threshold: source.threshold,
  });
  return {
    contractVersion: source.contractVersion,
    ...policy,
    policyRevision: exactInteger(source.policyRevision, "Richtlinienrevision", 1, Number.MAX_SAFE_INTEGER),
  };
}

function secureAccountRecoveryRequest(path, token, options = {}) {
  return apiRequest(path, {
    ...options,
    token,
    headers: { ...NO_STORE_HEADERS, ...(options.headers || {}) },
    allowFailover: false,
    cache: "no-store",
    sensitive: true,
  });
}

function normalizeDecision(value) {
  if (!RECOVERY_DECISIONS.has(value)) invalid("Die Entscheidung ist ungueltig.");
  return value;
}

function normalizeRecoveryProof(value) {
  const source = record(value, "Core-2FA-Nachweis");
  exactKeys(source, new Set(["code", "recoveryCode", "token", "password"]), "Core-2FA-Nachweis");
  const proof = {};
  if (source.code !== undefined) {
    if (typeof source.code !== "string" || !TOTP_CODE.test(source.code)) invalid("Authenticator-Code ist ungueltig.");
    proof.code = source.code;
  }
  if (source.recoveryCode !== undefined) {
    if (typeof source.recoveryCode !== "string" || !RECOVERY_CODE.test(source.recoveryCode)) invalid("Wiederherstellungscode ist ungueltig.");
    proof.recoveryCode = source.recoveryCode;
  }
  if (source.token !== undefined) proof.token = exactText(source.token, "2FA-Token", 128);
  if (source.password !== undefined) {
    const passwordError = validateExactSecret(source.password, { label: "2FA-Passwort", maxLength: LOCAL_PASSWORD_MAX_LENGTH });
    if (passwordError || countUnicodeCodePoints(source.password) < 12) invalid(passwordError || "Das 2FA-Passwort ist zu kurz.");
    proof.password = source.password;
  }
  const names = Object.keys(proof);
  if (!names.length || (proof.recoveryCode && names.length !== 1)) invalid("Der Core-2FA-Nachweis ist unvollstaendig.");
  return proof;
}

function clearProof(value) {
  if (!value || typeof value !== "object") return;
  for (const name of ["code", "recoveryCode", "token", "password"]) {
    if (Object.hasOwn(value, name)) value[name] = undefined;
  }
}

async function requestWithProof(path, token, input, options, normalize) {
  const proof = normalizeRecoveryProof(input?.proof);
  const body = { ...input, proof };
  const clear = () => {
    clearProof(proof);
    clearProof(body.proof);
    clearProof(input?.proof);
  };
  options?.signal?.addEventListener?.("abort", clear, { once: true });
  try {
    return normalize(await secureAccountRecoveryRequest(path, token, {
      ...options,
      method: options?.method || "POST",
      body,
    }));
  } finally {
    options?.signal?.removeEventListener?.("abort", clear);
    clear();
  }
}

export async function fetchAccountRecoveryOverview(token, { signal, reference } = {}) {
  const referenceQuery = reference === undefined || reference === ""
    ? ""
    : `?reference=${encodeURIComponent(exactReference(reference))}`;
  return normalizeAccountRecoveryOverview(await secureAccountRecoveryRequest(
    `${ACCOUNT_RECOVERY_BASE}/overview${referenceQuery}`, token, { signal },
  ));
}

export async function initiateAccountRecovery(token, input, { signal } = {}) {
  const targetAccountId = exactId(input?.targetAccountId, "Zielkonto-ID");
  return normalizeInitiatedAccountRecovery(await secureAccountRecoveryRequest(
    `${ACCOUNT_RECOVERY_BASE}/requests`, token, {
      method: "POST",
      signal,
      body: { targetAccountId },
    },
  ));
}

export async function createAccountRecoveryDecisionChallenge(token, requestId, decision, { signal } = {}) {
  const id = exactId(requestId, "Antrags-ID");
  const action = normalizeDecision(decision);
  return normalizeChallengeEnvelope(await secureAccountRecoveryRequest(
    `${ACCOUNT_RECOVERY_BASE}/requests/${encodeURIComponent(id)}/challenge`, token, {
      method: "POST",
      signal,
      body: { decision: action },
    },
  ), { expectedPurpose: "ACCOUNT_RECOVERY_APPROVAL", decision: action });
}

export function submitAccountRecoveryDecision(token, requestId, input, { signal } = {}) {
  const id = exactId(requestId, "Antrags-ID");
  const decision = normalizeDecision(input?.decision);
  const challengeId = exactId(input?.challengeId, "Sicherheitsabfrage-ID");
  return requestWithProof(
    `${ACCOUNT_RECOVERY_BASE}/requests/${encodeURIComponent(id)}/decisions`,
    token,
    { decision, challengeId, proof: input?.proof },
    { signal },
    normalizeAccountRecoveryDecisionResult,
  );
}

export async function createSupportCodeChallenge(token, requestId, { signal } = {}) {
  const id = exactId(requestId, "Antrags-ID");
  return normalizeChallengeEnvelope(await secureAccountRecoveryRequest(
    `${ACCOUNT_RECOVERY_BASE}/requests/${encodeURIComponent(id)}/support-code/challenge`, token, {
      method: "POST",
      signal,
      body: {},
    },
  ), { expectedPurpose: "ACCOUNT_RECOVERY_SUPPORT_CODE" });
}

export function issueAccountRecoverySupportCode(token, requestId, input, { signal } = {}) {
  const id = exactId(requestId, "Antrags-ID");
  const challengeId = exactId(input?.challengeId, "Sicherheitsabfrage-ID");
  return requestWithProof(
    `${ACCOUNT_RECOVERY_BASE}/requests/${encodeURIComponent(id)}/support-code`,
    token,
    { challengeId, proof: input?.proof },
    { signal },
    normalizeIssuedSupportCode,
  );
}

function normalizePolicyProposal(input) {
  const policy = normalizePolicy(record(input, "Richtlinienvorschlag"));
  return { reviewerAccountIds: [...policy.reviewerAccountIds], threshold: policy.threshold };
}

export async function createAccountRecoveryPolicyChallenge(token, input, { signal } = {}) {
  const proposal = normalizePolicyProposal(input);
  return normalizePolicyChallenge(await secureAccountRecoveryRequest(
    `${ACCOUNT_RECOVERY_BASE}/policy/challenge`, token, {
      method: "POST",
      signal,
      body: proposal,
    },
  ));
}

export function updateAccountRecoveryPolicy(token, input, { signal } = {}) {
  const proposal = normalizePolicyProposal({
    reviewerAccountIds: input?.reviewerAccountIds,
    threshold: input?.threshold,
  });
  const challengeId = exactId(input?.challengeId, "Sicherheitsabfrage-ID");
  return requestWithProof(
    `${ACCOUNT_RECOVERY_BASE}/policy`,
    token,
    { ...proposal, challengeId, proof: input?.proof },
    { signal, method: "PUT" },
    normalizePolicyResult,
  );
}

export const accountRecoveryApi = Object.freeze({
  getOverview: fetchAccountRecoveryOverview,
  initiate: initiateAccountRecovery,
  createDecisionChallenge: createAccountRecoveryDecisionChallenge,
  submitDecision: submitAccountRecoveryDecision,
  createSupportCodeChallenge,
  issueSupportCode: issueAccountRecoverySupportCode,
  createPolicyChallenge: createAccountRecoveryPolicyChallenge,
  updatePolicy: updateAccountRecoveryPolicy,
});
