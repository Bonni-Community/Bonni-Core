import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { prisma } from "../../../database/prisma.js";
import { requireRuntimeSecret } from "../../../../platform/security/crypto/index.js";
import {
  hashExactLocalPassword,
  validateExactLocalPassword,
} from "../../identity/local-password-policy.js";
import {
  advanceTwoFactorAfterPasswordChange,
} from "../two-factor/password-change.js";
import {
  getRegisteredExternalTwoFactorProviderById,
  type TwoFactorProof,
} from "../two-factor/provider-registry.js";
import * as twoFactor from "../two-factor/service.js";
import type { RecoveryDecision, RecoveryProof } from "./schemas.js";

const db = prisma as any;

export const ACCOUNT_RECOVERY_CONTRACT_VERSION = "bonni.account-recovery/v1" as const;
export const ACCOUNT_RECOVERY_COOKIE = "bonni_password_recovery" as const;
export const ACCOUNT_RECOVERY_COOKIE_SECONDS = 48 * 60 * 60;
export const ACCOUNT_RECOVERY_MODULE_KEY = "core.account-recovery" as const;

const ACTIVE_STATUSES = ["PENDING", "LOCKED", "APPROVED"] as const;
const PERSONAL_TYPES = new Set(["MEMBER", "ADMIN"]);
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUPPORT_CODE_GROUPS = 4;
const SUPPORT_CODE_GROUP_LENGTH = 5;
const PUBLIC_WINDOW_MS = 15 * 60 * 1000;

type RequestMeta = { ip?: string; userAgent?: string };

function fail(code: string, statusCode = 400, details?: Record<string, unknown>): never {
  throw Object.assign(new Error(code), { code, statusCode, details });
}

function secretKey() {
  return requireRuntimeSecret({
    names: ["ACCOUNT_RECOVERY_TOKEN_SECRET", "JWT_SECRET"],
    errorCode: "ACCOUNT_RECOVERY_SECRET_MISSING_OR_WEAK",
  });
}

function hmac(domain: string, value: string) {
  return createHmac("sha256", secretKey()).update(`${domain}\0`, "utf8").update(value, "utf8").digest("base64url");
}

function hashCapability(value: string) {
  return createHash("sha256").update("bonni-account-recovery-capability:v1\0", "utf8").update(value, "utf8").digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function randomAlphabet(length: number) {
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => REFERENCE_ALPHABET[byte & 31]).join("");
}

export function generateRecoveryReference() {
  return `PR-${randomAlphabet(5)}-${randomAlphabet(5)}`;
}

export function generateSupportCode() {
  return Array.from({ length: SUPPORT_CODE_GROUPS }, () => randomAlphabet(SUPPORT_CODE_GROUP_LENGTH)).join("-");
}

type BrowserCapability = {
  token: string;
  reference: string;
  issuedAt: Date;
  expiresAt: Date;
};

export function createBrowserCapability(reference = generateRecoveryReference(), now = new Date()): BrowserCapability {
  const issuedSeconds = Math.floor(now.getTime() / 1000);
  const nonce = randomBytes(32).toString("base64url");
  const payload = `${reference}.${issuedSeconds}.${nonce}`;
  const signature = hmac("browser-token", payload);
  return {
    token: `${payload}.${signature}`,
    reference,
    issuedAt: new Date(issuedSeconds * 1000),
    expiresAt: new Date((issuedSeconds + ACCOUNT_RECOVERY_COOKIE_SECONDS) * 1000),
  };
}

export function parseBrowserCapability(value: unknown, now = new Date()): BrowserCapability | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const match = /^(PR-[A-Z2-9]{5}-[A-Z2-9]{5})\.(\d{10})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(value);
  if (!match) return null;
  const [, reference, issuedRaw, nonce, signature] = match;
  const payload = `${reference}.${issuedRaw}.${nonce}`;
  if (!safeEqual(signature, hmac("browser-token", payload))) return null;
  const issuedSeconds = Number(issuedRaw);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedSeconds) || issuedSeconds > nowSeconds + 60) return null;
  const expiresSeconds = issuedSeconds + ACCOUNT_RECOVERY_COOKIE_SECONDS;
  return {
    token: value,
    reference,
    issuedAt: new Date(issuedSeconds * 1000),
    expiresAt: new Date(expiresSeconds * 1000),
  };
}

function canonicalLoginName(value: string) {
  return value.toLowerCase();
}

function boundedEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export function getAccountRecoveryLimits() {
  return Object.freeze({
    publicRequestsPerLogin: boundedEnv("ACCOUNT_RECOVERY_REQUESTS_PER_LOGIN", 3, 1, 10),
    publicRequestsPerIp: boundedEnv("ACCOUNT_RECOVERY_REQUESTS_PER_IP", 15, 3, 100),
    activeRequestsPerAccount: 1,
    maxReviewers: 6,
    minThreshold: 3,
    supportCodeSeconds: boundedEnv("ACCOUNT_RECOVERY_SUPPORT_CODE_SECONDS", 15 * 60, 60, 60 * 60),
  });
}

export function enumerationNeutralDelayMs(elapsedMs: number, jitterByte: number) {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const jitter = Number.isInteger(jitterByte) ? Math.abs(jitterByte) % 81 : 0;
  return Math.max(0, 420 + jitter - elapsed);
}

async function consumeRateBucket(bucketKey: string, maximum: number, now: Date) {
  return db.$transaction(async (tx: any) => {
    const current = await tx.securityAccountRecoveryRateLimit.findUnique({ where: { bucketKey } });
    if (!current || current.windowStartedAt.getTime() + PUBLIC_WINDOW_MS <= now.getTime()) {
      await tx.securityAccountRecoveryRateLimit.upsert({
        where: { bucketKey },
        create: { bucketKey, attempts: 1, windowStartedAt: now },
        update: { attempts: 1, windowStartedAt: now },
      });
      return true;
    }
    if (current.attempts >= maximum) return false;
    const updated = await tx.securityAccountRecoveryRateLimit.updateMany({
      where: { bucketKey, attempts: current.attempts, windowStartedAt: current.windowStartedAt },
      data: { attempts: { increment: 1 } },
    });
    return updated.count === 1;
  }, { isolationLevel: "Serializable" });
}

async function withinPublicRateLimit(loginName: string, meta: RequestMeta, now: Date) {
  const limits = getAccountRecoveryLimits();
  const loginBucket = `login:${hmac("rate-login", loginName)}`;
  const ipBucket = `ip:${hmac("rate-ip", meta.ip || "unknown")}`;
  await db.securityAccountRecoveryRateLimit.deleteMany({
    where: { windowStartedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  }).catch(() => undefined);
  const ipAllowed = await consumeRateBucket(ipBucket, limits.publicRequestsPerIp, now);
  if (!ipAllowed) return false;
  return consumeRateBucket(loginBucket, limits.publicRequestsPerLogin, now);
}

async function assertCapabilityRateLimit(scope: "resume" | "complete", capability: string, meta: RequestMeta, now: Date) {
  const ipBucket = `${scope}:ip:${hmac(`rate-${scope}-ip`, meta.ip || "unknown")}`;
  const capabilityBucket = `${scope}:capability:${hmac(`rate-${scope}-capability`, capability)}`;
  const ipAllowed = await consumeRateBucket(ipBucket, scope === "resume" ? 20 : 12, now);
  const capabilityAllowed = ipAllowed && await consumeRateBucket(capabilityBucket, 8, now);
  if (!ipAllowed || !capabilityAllowed) fail("ACCOUNT_RECOVERY_RATE_LIMITED", 429);
}

function isEligibleTarget(account: any, allowExistingRecoveryLock = false) {
  return Boolean(
    account
    && account.isActive === true
    && PERSONAL_TYPES.has(String(account.type))
    && account.isSandbox !== true
    && typeof account.passwordHash === "string"
    && account.passwordHash.length > 0
    && account.authProvider?.type === "LOCAL"
    && account.authProvider?.active === true
    && (allowExistingRecoveryLock || !account.passwordRecoveryLockedAt),
  );
}

function parseReviewerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
    .slice(0, 6)
    .sort();
}

function parseRequestReviewerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
    .slice(0, 200)
    .sort();
}

async function readPolicy(client = db) {
  const stored = await client.securityAccountRecoveryPolicy.findUnique({ where: { id: "default" } });
  return {
    stored,
    reviewerAccountIds: parseReviewerIds(stored?.reviewerAccountIds),
    threshold: Math.max(3, Math.min(Number(stored?.threshold || 3), 6)),
    policyRevision: Number(stored?.policyRevision || 0),
  };
}

async function writeAudit(input: {
  requestId?: string;
  targetAccountId?: string;
  actorAccountId?: string;
  event: string;
  result: "SUCCESS" | "FAILURE" | "BLOCKED";
  meta?: RequestMeta;
  metadataJson?: Record<string, unknown>;
}, client = db, bestEffort = false) {
  const write = client.securityAccountRecoveryAuditLog.create({
    data: {
      requestId: input.requestId,
      targetAccountId: input.targetAccountId,
      actorAccountId: input.actorAccountId,
      event: input.event,
      result: input.result,
      ipAddress: input.meta?.ip,
      userAgent: input.meta?.userAgent,
      metadataJson: input.metadataJson,
    },
  });
  if (bestEffort) return write.catch(() => undefined);
  return write;
}

function publicStatus(status: string) {
  if (status === "APPROVED") return "APPROVED" as const;
  if (status === "EXPIRED") return "EXPIRED" as const;
  return "PENDING" as const;
}

function requestCounts(request: any) {
  const decisions = request.decisions || [];
  return {
    approvals: decisions.filter((entry: any) => entry.decision === "APPROVE").length,
    rejections: decisions.filter((entry: any) => entry.decision === "REJECT").length,
  };
}

export function deriveRecoveryDecisionOutcome(input: {
  currentStatus: "PENDING" | "LOCKED";
  approvals: number;
  rejections: number;
  threshold: number;
  decision: RecoveryDecision;
}) {
  if (!Number.isInteger(input.threshold) || input.threshold < 3) {
    fail("ACCOUNT_RECOVERY_THRESHOLD_INVALID", 500);
  }
  const approvals = input.approvals + Number(input.decision === "APPROVE");
  const rejections = input.rejections + Number(input.decision === "REJECT");
  const approved = approvals >= input.threshold;
  const rejected = !approved && rejections >= input.threshold;
  return Object.freeze({
    approvals,
    rejections,
    shouldAcquireLock: input.decision === "APPROVE" && input.currentStatus === "PENDING",
    nextStatus: approved ? "APPROVED" as const : rejected ? "CANCELLED" as const : input.currentStatus,
  });
}

async function expireUnlockedOrTerminalRequest(request: any, now = new Date()) {
  if (!request || request.expiresAt > now || !ACTIVE_STATUSES.includes(request.status)) return request;
  // Recovery locks are deliberately sticky. Expiry terminalises the request,
  // shreds capabilities and frees the active slot, but never restores login.
  return db.$transaction(async (tx: any) => {
    const expired = await tx.securityAccountRecoveryRequest.updateMany({
      where: { id: request.id, status: request.status, requestRevision: request.requestRevision, expiresAt: { lte: now } },
      data: {
        status: "EXPIRED",
        activeSlot: null,
        browserTokenHash: null,
        browserTokenExpiresAt: null,
        supportCodeHash: null,
        supportCodeExpiresAt: null,
        requestRevision: { increment: 1 },
      },
    });
    if (expired.count !== 1) {
      return tx.securityAccountRecoveryRequest.findUnique({ where: { id: request.id } });
    }
    await writeAudit({
      requestId: request.id,
      targetAccountId: request.accountId,
      event: request.lockedAt ? "ACCOUNT_RECOVERY_EXPIRED_LOCK_RETAINED" : "ACCOUNT_RECOVERY_EXPIRED",
      result: "BLOCKED",
    }, tx);
    return { ...request, status: "EXPIRED", activeSlot: null };
  }, { isolationLevel: "Serializable" });
}

export function deriveReviewerSnapshot(input: {
  candidates: Array<{
    id: string;
    type: string;
    credentialRevision: number;
    twoFactorProviderId: string | null;
    twoFactorEnrolledAt: Date | null;
  }>;
  localCredentials: Array<{
    accountId: string;
    credentialRevision: number;
    enrollmentSlot: string | null;
    secretEncrypted: string | null;
  }>;
  availableExternalProviderIds: Iterable<string>;
  configuredReviewerAccountIds: string[];
  targetAccountId: string;
}) {
  const localByAccount = new Map<string, typeof input.localCredentials>();
  for (const credential of input.localCredentials) {
    const rows = localByAccount.get(credential.accountId) || [];
    rows.push(credential);
    localByAccount.set(credential.accountId, rows);
  }
  const externalAvailable = new Set(input.availableExternalProviderIds);
  return Object.freeze(input.candidates.filter((account) => {
    if (account.id === input.targetAccountId) return false;
    if (account.type !== "ADMIN" && !input.configuredReviewerAccountIds.includes(account.id)) return false;
    const providerId = String(account.twoFactorProviderId || "").toLowerCase();
    if (providerId === "local") {
      const credentials = localByAccount.get(account.id) || [];
      return credentials.length === 1
        && credentials[0].credentialRevision === account.credentialRevision
        && credentials[0].enrollmentSlot === account.id
        && typeof credentials[0].secretEncrypted === "string"
        && credentials[0].secretEncrypted.length > 0;
    }
    return Boolean(providerId && account.twoFactorEnrolledAt && externalAvailable.has(providerId));
  }).map((account) => account.id).sort());
}

async function resolveReviewerSnapshot(client: any, targetAccountId: string) {
  const policy = await readPolicy(client);
  const candidates = await client.account.findMany({
    where: {
      OR: [
        { type: "ADMIN" },
        ...(policy.reviewerAccountIds.length ? [{ id: { in: policy.reviewerAccountIds } }] : []),
      ],
      isActive: true,
      isSandbox: false,
      passwordHash: { not: null },
      passwordRecoveryLockedAt: null,
    },
    select: {
      id: true,
      type: true,
      credentialRevision: true,
      twoFactorProviderId: true,
      twoFactorEnrolledAt: true,
    },
  });
  const candidateIds = candidates.map((entry: any) => entry.id);
  const localCredentials = candidateIds.length
    ? await client.securityTwoFactorCredential.findMany({
        where: { accountId: { in: candidateIds }, method: "TOTP", status: "ACTIVE" },
        select: { accountId: true, credentialRevision: true, enrollmentSlot: true, secretEncrypted: true },
      })
    : [];
  const externalProviderIds: string[] = [...new Set<string>(candidates.map((account: any) => (
    String(account.twoFactorProviderId || "").toLowerCase()
  )).filter((providerId: string) => providerId.length > 0 && providerId !== "local"))];
  const externalAvailable = new Set<string>();
  await Promise.all(externalProviderIds.map(async (providerId) => {
    const provider = getRegisteredExternalTwoFactorProviderById(providerId);
    if (!provider) return;
    const state = await provider.getState().catch(() => null);
    if (state?.enabled === true && state.configured === true) externalAvailable.add(providerId);
  }));
  const reviewerAccountIds = [...deriveReviewerSnapshot({
    candidates,
    localCredentials,
    availableExternalProviderIds: externalAvailable,
    configuredReviewerAccountIds: policy.reviewerAccountIds,
    targetAccountId,
  })];
  if (reviewerAccountIds.length < policy.threshold) fail("ACCOUNT_RECOVERY_QUORUM_NOT_AVAILABLE", 409);
  return { policy, reviewerAccountIds };
}

async function createStoredRequest(input: {
  account: any;
  initiatedByAccountId?: string;
  browser?: BrowserCapability;
  now: Date;
  reviewerSnapshot?: Awaited<ReturnType<typeof resolveReviewerSnapshot>>;
}, client = db) {
  const snapshot = input.reviewerSnapshot || await resolveReviewerSnapshot(client, input.account.id);
  const expiresAt = new Date(input.now.getTime() + ACCOUNT_RECOVERY_COOKIE_SECONDS * 1000);
  return client.securityAccountRecoveryRequest.create({
    data: {
      reference: input.browser?.reference || generateRecoveryReference(),
      accountId: input.account.id,
      activeSlot: input.account.id,
      targetCredentialRevision: input.account.credentialRevision,
      thresholdSnapshot: snapshot.policy.threshold,
      policyRevisionSnapshot: snapshot.policy.policyRevision,
      reviewerAccountIdsSnapshot: snapshot.reviewerAccountIds,
      initiatedByAccountId: input.initiatedByAccountId,
      browserTokenHash: input.browser ? hashCapability(input.browser.token) : null,
      browserTokenExpiresAt: input.browser ? expiresAt : null,
      expiresAt,
    },
    include: { decisions: true },
  });
}

export async function requestPublicRecovery(
  loginNameValue: string,
  currentBrowserToken: string | null,
  meta: RequestMeta = {},
) {
  const startedAt = Date.now();
  const now = new Date();
  const decoy = createBrowserCapability(undefined, now);
  const neutral = (browser = decoy) => ({
    browserToken: browser.token,
    response: Object.freeze({
      contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
      status: "REQUESTED" as const,
      reference: browser.reference,
    }),
  });
  const finish = async <T>(result: T) => {
    const remaining = enumerationNeutralDelayMs(Date.now() - startedAt, randomBytes(1)[0]);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    return result;
  };

  const loginName = canonicalLoginName(loginNameValue);
  try {
    if (!await withinPublicRateLimit(loginName, meta, now)) return finish(neutral());
    const account = await db.account.findUnique({
      where: { loginName },
      include: { authProvider: true },
    });
    // The reviewer workload is intentionally executed for real and decoy
    // login names alike; no provider N+1 calls occur on the real-only branch.
    const reviewerSnapshot = await resolveReviewerSnapshot(db, account?.id || "__decoy_target__");
    if (!isEligibleTarget(account, false)) return finish(neutral());

    let existing = await db.securityAccountRecoveryRequest.findFirst({
      where: { accountId: account.id, activeSlot: account.id },
      include: { decisions: true },
    });
    if (existing?.expiresAt <= now) {
      await expireUnlockedOrTerminalRequest(existing, now);
      existing = null;
    }
    if (existing) {
      const parsedCurrent = parseBrowserCapability(currentBrowserToken, now);
      if (
        parsedCurrent
        && existing.browserTokenHash
        && safeEqual(hashCapability(parsedCurrent.token), existing.browserTokenHash)
      ) {
        return finish(neutral(parsedCurrent));
      }
      return finish(neutral());
    }

    const browser = createBrowserCapability(undefined, now);
    await db.$transaction(async (tx: any) => {
      const currentTarget = await tx.account.findUnique({
        where: { id: account.id },
        include: { authProvider: true },
      });
      const currentPolicy = await readPolicy(tx);
      if (
        !isEligibleTarget(currentTarget, false)
        || currentTarget.credentialRevision !== account.credentialRevision
        || currentPolicy.policyRevision !== reviewerSnapshot.policy.policyRevision
      ) fail("ACCOUNT_RECOVERY_TARGET_CHANGED", 409);
      const created = await createStoredRequest({
        account: currentTarget,
        browser,
        now,
        reviewerSnapshot,
      }, tx);
      await writeAudit({
        requestId: created.id,
        targetAccountId: account.id,
        event: "ACCOUNT_RECOVERY_PUBLIC_REQUESTED",
        result: "SUCCESS",
        meta,
        metadataJson: { reference: created.reference },
      }, tx);
      return created;
    }, { isolationLevel: "Serializable" });
    return finish(neutral(browser));
  } catch {
    // Public recovery remains enumeration-neutral even on a database or
    // constraint failure. The signed decoy cookie has the identical shape.
    return finish(neutral());
  }
}

export async function getPublicRecoveryStatus(browserToken: string | null) {
  const now = new Date();
  const parsed = parseBrowserCapability(browserToken, now);
  if (!parsed) {
    return Object.freeze({
      contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
      status: "NONE" as const,
      reference: null,
      expiresAt: null,
      supportCodeAllowed: true,
    });
  }
  if (parsed.expiresAt <= now) {
    return Object.freeze({
      contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
      status: "EXPIRED" as const,
      reference: parsed.reference,
      expiresAt: parsed.expiresAt,
      supportCodeAllowed: false,
    });
  }
  const request = await db.securityAccountRecoveryRequest.findUnique({
    where: { browserTokenHash: hashCapability(parsed.token) },
  }).catch(() => null);
  if (request?.expiresAt <= now) {
    await expireUnlockedOrTerminalRequest(request, now);
    return Object.freeze({
      contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
      status: "EXPIRED" as const,
      reference: request.reference || parsed.reference,
      expiresAt: request.expiresAt,
      supportCodeAllowed: false,
    });
  }
  const status = request ? publicStatus(request.status) : "PENDING";
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    status,
    reference: request?.reference || parsed.reference,
    expiresAt: request?.expiresAt || parsed.expiresAt,
    supportCodeAllowed: false,
  });
}

async function assertReviewer(accountId: string, targetAccountId?: string, client = db) {
  const [account, policy] = await Promise.all([
    client.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        type: true,
        isActive: true,
        isSandbox: true,
        passwordHash: true,
        passwordRecoveryLockedAt: true,
        credentialRevision: true,
        twoFactorProviderId: true,
      },
    }),
    readPolicy(client),
  ]);
  const configured = policy.reviewerAccountIds.includes(accountId);
  if (
    !account
    || account.isActive !== true
    || account.isSandbox === true
    || !PERSONAL_TYPES.has(String(account.type))
    || !account.passwordHash
    || account.passwordRecoveryLockedAt
    || (account.type !== "ADMIN" && !configured)
    || (targetAccountId && targetAccountId === accountId)
  ) fail("ACCOUNT_RECOVERY_REVIEWER_NOT_ELIGIBLE", 403);
  return { account, policy };
}

async function assertRequestReviewer(accountId: string, request: any, client = db) {
  const account = await client.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      type: true,
      isActive: true,
      isSandbox: true,
      passwordHash: true,
      passwordRecoveryLockedAt: true,
      credentialRevision: true,
      twoFactorProviderId: true,
    },
  });
  const snapshot = parseRequestReviewerIds(request.reviewerAccountIdsSnapshot);
  if (
    !account
    || account.id === request.accountId
    || account.isActive !== true
    || account.isSandbox === true
    || !PERSONAL_TYPES.has(String(account.type))
    || !account.passwordHash
    || account.passwordRecoveryLockedAt
    || !snapshot.includes(account.id)
  ) fail("ACCOUNT_RECOVERY_REVIEWER_NOT_ELIGIBLE", 403);
  return account;
}

function internalStatus(status: string) {
  if (status === "APPROVED") return "APPROVED" as const;
  if (status === "EXPIRED") return "EXPIRED" as const;
  if (status === "CANCELLED") return "REJECTED" as const;
  return "PENDING" as const;
}

function targetLabel(request: any) {
  return request.account?.person?.displayName || request.account?.loginName || request.reference;
}

function internalRequestDto(request: any, actorAccountId: string) {
  const counts = requestCounts(request);
  return Object.freeze({
    id: request.id,
    targetLabel: targetLabel(request),
    reference: request.reference,
    status: internalStatus(request.status),
    approvals: counts.approvals,
    threshold: request.thresholdSnapshot,
    expiresAt: request.expiresAt,
    canDecide: (request.status === "PENDING" || request.status === "LOCKED")
      && request.expiresAt > new Date()
      && request.accountId !== actorAccountId
      && parseRequestReviewerIds(request.reviewerAccountIdsSnapshot).includes(actorAccountId)
      && !(request.decisions || []).some((entry: any) => entry.approverAccountId === actorAccountId),
    targetIsCurrentAccount: request.accountId === actorAccountId,
  });
}

export async function getOverview(actorAccountId: string, reference?: string) {
  const [actor, policy] = await Promise.all([
    db.account.findUnique({
      where: { id: actorAccountId },
      select: {
        id: true,
        type: true,
        isActive: true,
        isSandbox: true,
        passwordHash: true,
        passwordRecoveryLockedAt: true,
      },
    }),
    readPolicy(),
  ]);
  const baseEligible = actor
    && actor.isActive === true
    && actor.isSandbox !== true
    && PERSONAL_TYPES.has(String(actor.type))
    && Boolean(actor.passwordHash)
    && !actor.passwordRecoveryLockedAt;
  if (!baseEligible) {
    return Object.freeze({
      contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
      canReview: false,
      canInitiate: false,
      policy: null,
      requests: Object.freeze([]),
    });
  }
  const currentEligible = actor.type === "ADMIN" || policy.reviewerAccountIds.includes(actorAccountId);
  const rows = await db.securityAccountRecoveryRequest.findMany({
    where: {
      status: { in: [...ACTIVE_STATUSES] },
      reviewerAccountIdsSnapshot: { array_contains: [actorAccountId] },
      ...(reference ? { reference } : {}),
    },
    include: {
      decisions: true,
      account: { include: { person: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: reference ? 1 : 50,
  });
  for (const row of rows.filter((entry: any) => entry.expiresAt <= new Date())) {
    await expireUnlockedOrTerminalRequest(row);
  }
  const live = rows.filter((entry: any) => (
    entry.expiresAt > new Date()
    && parseRequestReviewerIds(entry.reviewerAccountIdsSnapshot).includes(actorAccountId)
  ));
  const canReview = currentEligible || live.length > 0;
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    canReview,
    canInitiate: currentEligible,
    policy: currentEligible && policy.stored
      ? Object.freeze({
          reviewerAccountIds: Object.freeze(policy.reviewerAccountIds),
          threshold: policy.threshold,
        })
      : null,
    requests: Object.freeze(live.map((request: any) => internalRequestDto(request, actorAccountId))),
  });
}

export async function initiateSupportRecovery(actorAccountId: string, targetAccountId: string, meta: RequestMeta = {}) {
  await assertReviewer(actorAccountId, targetAccountId);
  const now = new Date();
  const account = await db.account.findUnique({ where: { id: targetAccountId }, include: { authProvider: true } });
  if (!isEligibleTarget(account, true)) fail("ACCOUNT_RECOVERY_TARGET_NOT_ELIGIBLE", 409);
  let existing = await db.securityAccountRecoveryRequest.findFirst({
    where: { accountId: targetAccountId, activeSlot: targetAccountId },
    include: { decisions: true, account: { include: { person: true } } },
  });
  if (existing?.expiresAt <= now) {
    await expireUnlockedOrTerminalRequest(existing, now);
    existing = null;
  }
  if (existing) {
    const maySupersedePublicPending = existing.status === "PENDING"
      && !existing.lockedAt
      && !existing.initiatedByAccountId
      && Boolean(existing.browserTokenHash)
      && existing.decisions.length === 0;
    if (!maySupersedePublicPending) {
      if (!parseRequestReviewerIds(existing.reviewerAccountIdsSnapshot).includes(actorAccountId)) {
        fail("ACCOUNT_RECOVERY_REQUEST_ALREADY_ACTIVE", 409);
      }
      return Object.freeze({
        contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
        request: internalRequestDto(existing, actorAccountId),
      });
    }
    // The exact supersede CAS is executed with replacement + both audit rows
    // in the serializable transaction below.
  }
  const created = await db.$transaction(async (tx: any) => {
    const currentTarget = await tx.account.findUnique({ where: { id: targetAccountId }, include: { authProvider: true } });
    if (!isEligibleTarget(currentTarget, true) || currentTarget.credentialRevision !== account.credentialRevision) {
      fail("ACCOUNT_RECOVERY_TARGET_CHANGED", 409);
    }
    if (existing) {
      const superseded = await tx.securityAccountRecoveryRequest.updateMany({
        where: {
          id: existing.id,
          status: "PENDING",
          requestRevision: existing.requestRevision,
          initiatedByAccountId: null,
          browserTokenHash: existing.browserTokenHash,
          lockedAt: null,
        },
        data: {
          status: "CANCELLED",
          activeSlot: null,
          browserTokenHash: null,
          browserTokenExpiresAt: null,
          supportCodeHash: null,
          cancelledAt: now,
          requestRevision: { increment: 1 },
        },
      });
      if (superseded.count !== 1) fail("ACCOUNT_RECOVERY_REQUEST_CHANGED", 409);
      await writeAudit({
        requestId: existing.id,
        targetAccountId,
        actorAccountId,
        event: "ACCOUNT_RECOVERY_PUBLIC_REQUEST_SUPERSEDED",
        result: "SUCCESS",
        meta,
      }, tx);
    }
    const replacement = await createStoredRequest(
      { account: currentTarget, initiatedByAccountId: actorAccountId, now },
      tx,
    );
    await writeAudit({
      requestId: replacement.id,
      targetAccountId,
      actorAccountId,
      event: "ACCOUNT_RECOVERY_SUPPORT_INITIATED",
      result: "SUCCESS",
      meta,
      metadataJson: { reference: replacement.reference },
    }, tx);
    return replacement;
  }, { isolationLevel: "Serializable" });
  const loaded = await db.securityAccountRecoveryRequest.findUnique({
    where: { id: created.id },
    include: { decisions: true, account: { include: { person: true } } },
  });
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    request: internalRequestDto(loaded, actorAccountId),
  });
}

function decisionScope(request: any, decision: RecoveryDecision) {
  const revision = request.lockedCredentialRevision ?? request.targetCredentialRevision;
  return `ACCOUNT_RECOVERY:DECISION:${decision}:REQUEST:${request.id.toUpperCase()}:TARGET:${request.accountId.toUpperCase()}:CREDENTIAL:${revision}:POLICY:${request.policyRevisionSnapshot}:STATE:${request.requestRevision}`;
}

function supportCodeScope(request: any) {
  const revision = request.lockedCredentialRevision ?? request.targetCredentialRevision;
  return `ACCOUNT_RECOVERY:SUPPORT_CODE:REQUEST:${request.id.toUpperCase()}:TARGET:${request.accountId.toUpperCase()}:CREDENTIAL:${revision}:STATE:${request.requestRevision}`;
}

function policyProposal(reviewerAccountIds: string[], threshold: number) {
  const reviewers = [...reviewerAccountIds].sort();
  const hash = createHash("sha256")
    .update(JSON.stringify({ reviewerAccountIds: reviewers, threshold }), "utf8")
    .digest("hex")
    .toUpperCase();
  return { reviewers, threshold, hash };
}

function policyScope(policyRevision: number, proposalHash: string) {
  return `ACCOUNT_RECOVERY:POLICY:REVISION:${policyRevision}:PROPOSAL:${proposalHash}`;
}

async function loadLiveRequest(id: string) {
  const request = await db.securityAccountRecoveryRequest.findUnique({
    where: { id },
    include: { decisions: true, account: { include: { authProvider: true, person: true } } },
  });
  if (!request) fail("ACCOUNT_RECOVERY_REQUEST_NOT_FOUND", 404);
  if (request.expiresAt <= new Date()) {
    await expireUnlockedOrTerminalRequest(request);
    fail("ACCOUNT_RECOVERY_REQUEST_EXPIRED", 409);
  }
  if (!ACTIVE_STATUSES.includes(request.status)) fail("ACCOUNT_RECOVERY_REQUEST_NOT_ACTIVE", 409);
  return request;
}

export async function createDecisionChallenge(
  actorAccountId: string,
  requestId: string,
  decision: RecoveryDecision,
  meta: RequestMeta = {},
) {
  const request = await loadLiveRequest(requestId);
  if (request.status !== "PENDING" && request.status !== "LOCKED") {
    fail("ACCOUNT_RECOVERY_DECISION_CLOSED", 409);
  }
  await assertRequestReviewer(actorAccountId, request);
  if (request.decisions.some((entry: any) => entry.approverAccountId === actorAccountId)) {
    fail("ACCOUNT_RECOVERY_REVIEWER_ALREADY_DECIDED", 409);
  }
  const challenge = await twoFactor.createChallenge(actorAccountId, {
    purpose: "ACCOUNT_RECOVERY_APPROVAL",
    moduleKey: ACCOUNT_RECOVERY_MODULE_KEY,
    accessScope: decisionScope(request, decision),
    subjectId: request.accountId,
  }, meta);
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    requestId,
    decision,
    challenge,
  });
}

async function verifyAndConsumeBoundProof(input: {
  actorAccountId: string;
  challengeId: string;
  proof: RecoveryProof;
  purpose: "ACCOUNT_RECOVERY_APPROVAL" | "ACCOUNT_RECOVERY_SUPPORT_CODE" | "ACCOUNT_RECOVERY_POLICY";
  accessScope: string;
  subjectId: string | null;
  meta?: RequestMeta;
}) {
  await twoFactor.verifyChallenge(
    input.actorAccountId,
    input.challengeId,
    input.proof as TwoFactorProof,
    input.meta,
  );
  return twoFactor.consumeVerifiedChallenge({
    accountId: input.actorAccountId,
    challengeId: input.challengeId,
    purpose: input.purpose,
    moduleKey: ACCOUNT_RECOVERY_MODULE_KEY,
    accessScope: input.accessScope,
    subjectId: input.subjectId,
    maxAgeMinutes: 1,
  });
}

export async function decideRecovery(
  actorAccountId: string,
  requestId: string,
  decision: RecoveryDecision,
  challengeId: string,
  proof: RecoveryProof,
  meta: RequestMeta = {},
) {
  const before = await loadLiveRequest(requestId);
  if (before.status !== "PENDING" && before.status !== "LOCKED") {
    fail("ACCOUNT_RECOVERY_DECISION_CLOSED", 409);
  }
  await assertRequestReviewer(actorAccountId, before);
  const scope = decisionScope(before, decision);
  const authorization = await verifyAndConsumeBoundProof({
    actorAccountId,
    challengeId,
    proof,
    purpose: "ACCOUNT_RECOVERY_APPROVAL",
    accessScope: scope,
    subjectId: before.accountId,
    meta,
  });

  const result = await db.$transaction(async (tx: any) => {
    const now = new Date();
    const request = await tx.securityAccountRecoveryRequest.findUnique({
      where: { id: requestId },
      include: { decisions: true },
    });
    if (
      !request
      || (request.status !== "PENDING" && request.status !== "LOCKED")
      || request.expiresAt <= now
      || request.requestRevision !== before.requestRevision
      || request.accountId !== before.accountId
    ) fail("ACCOUNT_RECOVERY_REQUEST_CHANGED", 409);
    const reviewer = await assertRequestReviewer(actorAccountId, request, tx);
    if (
      reviewer.credentialRevision !== authorization.credentialRevision
      || reviewer.twoFactorProviderId !== authorization.providerId
    ) fail("ACCOUNT_RECOVERY_REVIEWER_PROOF_STALE", 409);
    if (request.decisions.some((entry: any) => entry.approverAccountId === actorAccountId)) {
      fail("ACCOUNT_RECOVERY_REVIEWER_ALREADY_DECIDED", 409);
    }

    let lockedRevision = request.lockedCredentialRevision;
    const countsBefore = requestCounts(request);
    const outcome = deriveRecoveryDecisionOutcome({
      currentStatus: request.status,
      approvals: countsBefore.approvals,
      rejections: countsBefore.rejections,
      threshold: request.thresholdSnapshot,
      decision,
    });
    if (outcome.shouldAcquireLock) {
      const account = await tx.account.findUnique({ where: { id: request.accountId }, include: { authProvider: true } });
      if (!isEligibleTarget(account, true) || account.credentialRevision !== request.targetCredentialRevision) {
        fail("ACCOUNT_RECOVERY_TARGET_CHANGED", 409);
      }
      const nextRevision = account.credentialRevision + 1;
      const locked = await tx.account.updateMany({
        where: {
          id: account.id,
          isActive: true,
          credentialRevision: account.credentialRevision,
          type: { in: ["MEMBER", "ADMIN"] },
        },
        data: {
          passwordRecoveryLockedAt: now,
          passwordRecoveryRequestId: request.id,
          credentialRevision: { increment: 1 },
        },
      });
      if (locked.count !== 1) fail("ACCOUNT_RECOVERY_TARGET_CHANGED", 409);
      await advanceTwoFactorAfterPasswordChange(tx, {
        accountId: account.id,
        previousRevision: account.credentialRevision,
        nextRevision,
        twoFactorProviderId: account.twoFactorProviderId,
        preserveAccountRecoveryRequestId: request.id,
      });
      await tx.session.updateMany({ where: { accountId: account.id, endedAt: null }, data: { endedAt: now } });
      await tx.refreshToken.updateMany({ where: { accountId: account.id, revokedAt: null }, data: { revokedAt: now } });
      lockedRevision = nextRevision;
    }

    await tx.securityAccountRecoveryDecision.create({
      data: {
        requestId,
        approverAccountId: actorAccountId,
        decision,
        approverCredentialRevision: authorization.credentialRevision,
        providerId: authorization.providerId,
        challengeId,
        decidedAt: now,
      },
    });
    const approvals = outcome.approvals;
    const rejections = outcome.rejections;
    const approved = outcome.nextStatus === "APPROVED";
    const rejected = outcome.nextStatus === "CANCELLED";
    const nextStatus = approved ? "APPROVED" : rejected ? "CANCELLED" : lockedRevision ? "LOCKED" : "PENDING";
    const updated = await tx.securityAccountRecoveryRequest.updateMany({
      where: {
        id: request.id,
        status: request.status,
        requestRevision: request.requestRevision,
        expiresAt: { gt: now },
      },
      data: {
        status: nextStatus,
        lockedCredentialRevision: lockedRevision,
        lockedAt: lockedRevision ? request.lockedAt || now : null,
        approvedAt: approved ? now : null,
        cancelledAt: rejected ? now : null,
        activeSlot: rejected ? null : request.activeSlot,
        browserTokenHash: rejected ? null : request.browserTokenHash,
        supportCodeHash: rejected ? null : request.supportCodeHash,
        requestRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) fail("ACCOUNT_RECOVERY_REQUEST_CHANGED", 409);
    await writeAudit({
      requestId,
      targetAccountId: request.accountId,
      actorAccountId,
      event: `ACCOUNT_RECOVERY_${decision}`,
      result: "SUCCESS",
      meta,
      metadataJson: { approvals, rejections, threshold: request.thresholdSnapshot, status: nextStatus },
    }, tx);
    return { status: internalStatus(nextStatus), approvals, rejections, threshold: request.thresholdSnapshot };
  }, { isolationLevel: "Serializable" });

  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    requestId,
    ...result,
  });
}

export async function createSupportCodeChallenge(actorAccountId: string, requestId: string, meta: RequestMeta = {}) {
  const request = await loadLiveRequest(requestId);
  await assertRequestReviewer(actorAccountId, request);
  if (request.status !== "APPROVED") fail("ACCOUNT_RECOVERY_NOT_APPROVED", 409);
  if (request.supportCodeUsedAt) fail("ACCOUNT_RECOVERY_SUPPORT_CODE_ALREADY_USED", 409);
  if (
    request.supportCodeIssuedAt
    && !request.supportCodeUsedAt
    && request.supportCodeExpiresAt
    && request.supportCodeExpiresAt > new Date()
  ) fail("ACCOUNT_RECOVERY_SUPPORT_CODE_ALREADY_ISSUED", 409);
  const challenge = await twoFactor.createChallenge(actorAccountId, {
    purpose: "ACCOUNT_RECOVERY_SUPPORT_CODE",
    moduleKey: ACCOUNT_RECOVERY_MODULE_KEY,
    accessScope: supportCodeScope(request),
    subjectId: request.accountId,
  }, meta);
  return Object.freeze({ contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION, requestId, challenge });
}

export async function issueSupportCode(
  actorAccountId: string,
  requestId: string,
  challengeId: string,
  proof: RecoveryProof,
  meta: RequestMeta = {},
) {
  const before = await loadLiveRequest(requestId);
  await assertRequestReviewer(actorAccountId, before);
  const liveExistingCode = before.supportCodeIssuedAt
    && !before.supportCodeUsedAt
    && before.supportCodeExpiresAt
    && before.supportCodeExpiresAt > new Date();
  if (before.status !== "APPROVED" || before.supportCodeUsedAt || liveExistingCode) {
    fail("ACCOUNT_RECOVERY_SUPPORT_CODE_NOT_AVAILABLE", 409);
  }
  const scope = supportCodeScope(before);
  const authorization = await verifyAndConsumeBoundProof({
    actorAccountId,
    challengeId,
    proof,
    purpose: "ACCOUNT_RECOVERY_SUPPORT_CODE",
    accessScope: scope,
    subjectId: before.accountId,
    meta,
  });
  const supportCode = generateSupportCode();
  const issuedAt = new Date();
  const expiresAt = new Date(Math.min(
    before.expiresAt.getTime(),
    issuedAt.getTime() + getAccountRecoveryLimits().supportCodeSeconds * 1000,
  ));
  const issued = await db.$transaction(async (tx: any) => {
    const reviewer = await assertRequestReviewer(actorAccountId, before, tx);
    if (
      reviewer.credentialRevision !== authorization.credentialRevision
      || reviewer.twoFactorProviderId !== authorization.providerId
    ) fail("ACCOUNT_RECOVERY_REVIEWER_PROOF_STALE", 409);
    const updated = await tx.securityAccountRecoveryRequest.updateMany({
      where: {
        id: requestId,
        status: "APPROVED",
        requestRevision: before.requestRevision,
        expiresAt: { gt: issuedAt },
        supportCodeUsedAt: null,
        OR: [
          { supportCodeIssuedAt: null },
          { supportCodeExpiresAt: { lte: issuedAt } },
        ],
      },
      data: {
        supportCodeHash: hashCapability(supportCode),
        supportCodeExpiresAt: expiresAt,
        supportCodeIssuedAt: issuedAt,
        supportCodeUsedAt: null,
        requestRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) fail("ACCOUNT_RECOVERY_REQUEST_CHANGED", 409);
    await writeAudit({
      requestId,
      targetAccountId: before.accountId,
      actorAccountId,
      event: "ACCOUNT_RECOVERY_SUPPORT_CODE_ISSUED",
      result: "SUCCESS",
      meta,
    }, tx);
    return true;
  }, { isolationLevel: "Serializable" });
  if (!issued) fail("ACCOUNT_RECOVERY_REQUEST_CHANGED", 409);
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    requestId,
    supportCode,
    supportCodeShownOnce: true,
    expiresAt,
  });
}

export async function resumeWithSupportCode(supportCode: string, meta: RequestMeta = {}) {
  await assertCapabilityRateLimit("resume", supportCode, meta, new Date());
  const result = await db.$transaction(async (tx: any) => {
    const now = new Date();
    const request = await tx.securityAccountRecoveryRequest.findUnique({
      where: { supportCodeHash: hashCapability(supportCode) },
    });
    if (
      !request
      || request.status !== "APPROVED"
      || request.expiresAt <= now
      || !request.supportCodeExpiresAt
      || request.supportCodeExpiresAt <= now
      || request.supportCodeUsedAt
    ) fail("ACCOUNT_RECOVERY_SUPPORT_CODE_INVALID", 401);
    const capability = createBrowserCapability(request.reference, now);
    const claimed = await tx.securityAccountRecoveryRequest.updateMany({
      where: {
        id: request.id,
        status: "APPROVED",
        requestRevision: request.requestRevision,
        supportCodeHash: hashCapability(supportCode),
        supportCodeUsedAt: null,
        expiresAt: { gt: now },
        supportCodeExpiresAt: { gt: now },
      },
      data: {
        supportCodeHash: null,
        supportCodeUsedAt: now,
        browserTokenHash: hashCapability(capability.token),
        browserTokenExpiresAt: request.expiresAt,
        requestRevision: { increment: 1 },
      },
    });
    if (claimed.count !== 1) fail("ACCOUNT_RECOVERY_SUPPORT_CODE_INVALID", 401);
    await writeAudit({
      requestId: request.id,
      targetAccountId: request.accountId,
      event: "ACCOUNT_RECOVERY_SUPPORT_CODE_CLAIMED",
      result: "SUCCESS",
      meta,
    }, tx);
    return { request, capability };
  }, { isolationLevel: "Serializable" });
  return {
    browserToken: result.capability.token,
    response: Object.freeze({
      contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
      status: "APPROVED" as const,
      reference: result.request.reference,
      expiresAt: result.request.expiresAt,
      supportCodeAllowed: false,
    }),
  };
}

export async function completeRecovery(
  browserToken: string | null,
  newPassword: unknown,
  newPasswordConfirmation: unknown,
  meta: RequestMeta = {},
) {
  const password = validateExactLocalPassword(newPassword);
  const confirmation = validateExactLocalPassword(newPasswordConfirmation);
  if (
    !password.ok
    || !confirmation.ok
    || password.characters < 12
    || confirmation.characters < 12
    || password.password !== confirmation.password
  ) {
    fail("ACCOUNT_RECOVERY_PASSWORD_MISMATCH", 400);
  }
  const parsed = parseBrowserCapability(browserToken);
  if (!parsed || parsed.expiresAt <= new Date()) fail("ACCOUNT_RECOVERY_CAPABILITY_INVALID", 401);
  await assertCapabilityRateLimit("complete", parsed.token, meta, new Date());
  const tokenHash = hashCapability(parsed.token);
  const request = await db.securityAccountRecoveryRequest.findUnique({ where: { browserTokenHash: tokenHash } });
  if (!request || request.status !== "APPROVED" || request.expiresAt <= new Date()) {
    fail("ACCOUNT_RECOVERY_NOT_APPROVED", 409);
  }
  const passwordHash = await hashExactLocalPassword(password.password);
  await db.$transaction(async (tx: any) => {
    const now = new Date();
    const current = await tx.securityAccountRecoveryRequest.findUnique({ where: { id: request.id } });
    const account = await tx.account.findUnique({ where: { id: request.accountId }, include: { authProvider: true } });
    if (
      !current
      || current.status !== "APPROVED"
      || current.browserTokenHash !== tokenHash
      || current.expiresAt <= now
      || !current.lockedCredentialRevision
      || !isEligibleTarget(account, true)
      || account.passwordRecoveryRequestId !== current.id
      || account.credentialRevision !== current.lockedCredentialRevision
    ) fail("ACCOUNT_RECOVERY_STATE_CHANGED", 409);
    const nextRevision = account.credentialRevision + 1;
    const updated = await tx.account.updateMany({
      where: {
        id: account.id,
        isActive: true,
        credentialRevision: account.credentialRevision,
        passwordRecoveryRequestId: current.id,
        passwordRecoveryLockedAt: { not: null },
      },
      data: {
        passwordHash,
        credentialRevision: { increment: 1 },
        passwordRecoveryLockedAt: null,
        passwordRecoveryRequestId: null,
      },
    });
    if (updated.count !== 1) fail("ACCOUNT_RECOVERY_STATE_CHANGED", 409);
    await advanceTwoFactorAfterPasswordChange(tx, {
      accountId: account.id,
      previousRevision: account.credentialRevision,
      nextRevision,
      twoFactorProviderId: account.twoFactorProviderId,
      preserveAccountRecoveryRequestId: current.id,
    });
    await tx.session.updateMany({ where: { accountId: account.id, endedAt: null }, data: { endedAt: now } });
    await tx.refreshToken.updateMany({ where: { accountId: account.id, revokedAt: null }, data: { revokedAt: now } });
    const consumed = await tx.securityAccountRecoveryRequest.updateMany({
      where: {
        id: current.id,
        status: "APPROVED",
        requestRevision: current.requestRevision,
        browserTokenHash: tokenHash,
        expiresAt: { gt: now },
      },
      data: {
        status: "CONSUMED",
        activeSlot: null,
        browserTokenHash: null,
        browserTokenExpiresAt: null,
        supportCodeHash: null,
        supportCodeExpiresAt: null,
        consumedAt: now,
        requestRevision: { increment: 1 },
      },
    });
    if (consumed.count !== 1) fail("ACCOUNT_RECOVERY_STATE_CHANGED", 409);
    await writeAudit({
      requestId: current.id,
      targetAccountId: account.id,
      event: "ACCOUNT_RECOVERY_PASSWORD_COMPLETED",
      result: "SUCCESS",
      meta,
      metadataJson: { credentialRevision: nextRevision },
    }, tx);
  }, { isolationLevel: "Serializable" });
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    status: "COMPLETED" as const,
    requiresFreshLogin: true,
  });
}

async function assertPolicyCandidates(reviewerAccountIds: string[]) {
  const accounts = await db.account.findMany({
    where: { id: { in: reviewerAccountIds } },
    include: { authProvider: true },
  });
  if (
    accounts.length !== reviewerAccountIds.length
    || accounts.some((account: any) => !isEligibleTarget(account, false))
  ) fail("ACCOUNT_RECOVERY_POLICY_REVIEWER_INVALID", 409);
  // A merely durable enrollment marker is not enough for a newly configured
  // quorum: every trustee must be able to produce a fresh proof right now.
  // getStatus deliberately keeps adapter outages fail-closed here.
  const twoFactorReady = await Promise.all(accounts.map(async (account: any) => {
    const status = await twoFactor.getStatus(account.id).catch(() => null);
    return status?.enabled === true && status.configured === true && status.available === true;
  }));
  if (twoFactorReady.some((ready) => !ready)) {
    fail("ACCOUNT_RECOVERY_POLICY_REVIEWER_TWO_FACTOR_REQUIRED", 409);
  }
}

export async function createPolicyChallenge(
  actorAccountId: string,
  reviewerAccountIds: string[],
  threshold: number,
  meta: RequestMeta = {},
) {
  const reviewer = await assertReviewer(actorAccountId);
  if (reviewer.account.type !== "ADMIN") fail("ACCOUNT_RECOVERY_POLICY_ADMIN_REQUIRED", 403);
  const proposal = policyProposal(reviewerAccountIds, threshold);
  await assertPolicyCandidates(proposal.reviewers);
  const challenge = await twoFactor.createChallenge(actorAccountId, {
    purpose: "ACCOUNT_RECOVERY_POLICY",
    moduleKey: ACCOUNT_RECOVERY_MODULE_KEY,
    accessScope: policyScope(reviewer.policy.policyRevision, proposal.hash),
    subjectId: null,
  }, meta);
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    policyRevision: reviewer.policy.policyRevision,
    proposalHash: proposal.hash,
    challenge,
  });
}

export async function updatePolicy(
  actorAccountId: string,
  reviewerAccountIds: string[],
  threshold: number,
  challengeId: string,
  proof: RecoveryProof,
  meta: RequestMeta = {},
) {
  const actor = await assertReviewer(actorAccountId);
  if (actor.account.type !== "ADMIN") fail("ACCOUNT_RECOVERY_POLICY_ADMIN_REQUIRED", 403);
  const proposal = policyProposal(reviewerAccountIds, threshold);
  await assertPolicyCandidates(proposal.reviewers);
  const scope = policyScope(actor.policy.policyRevision, proposal.hash);
  const authorization = await verifyAndConsumeBoundProof({
    actorAccountId,
    challengeId,
    proof,
    purpose: "ACCOUNT_RECOVERY_POLICY",
    accessScope: scope,
    subjectId: null,
    meta,
  });
  const nextRevision = actor.policy.policyRevision + 1;
  await db.$transaction(async (tx: any) => {
    const currentActor = await tx.account.findUnique({
      where: { id: actorAccountId },
      select: { id: true, type: true, isActive: true, credentialRevision: true, twoFactorProviderId: true, passwordRecoveryLockedAt: true },
    });
    if (
      !currentActor
      || currentActor.type !== "ADMIN"
      || currentActor.isActive !== true
      || currentActor.passwordRecoveryLockedAt
      || currentActor.credentialRevision !== authorization.credentialRevision
      || currentActor.twoFactorProviderId !== authorization.providerId
    ) fail("ACCOUNT_RECOVERY_POLICY_PROOF_STALE", 409);
    const current = await readPolicy(tx);
    if (current.policyRevision !== actor.policy.policyRevision) fail("ACCOUNT_RECOVERY_POLICY_CHANGED", 409);
    if (current.stored) {
      const updated = await tx.securityAccountRecoveryPolicy.updateMany({
        where: { id: "default", policyRevision: current.policyRevision },
        data: {
          reviewerAccountIds: proposal.reviewers,
          threshold: proposal.threshold,
          policyRevision: { increment: 1 },
          updatedByAccountId: actorAccountId,
        },
      });
      if (updated.count !== 1) fail("ACCOUNT_RECOVERY_POLICY_CHANGED", 409);
    } else {
      await tx.securityAccountRecoveryPolicy.create({
        data: {
          id: "default",
          reviewerAccountIds: proposal.reviewers,
          threshold: proposal.threshold,
          policyRevision: nextRevision,
          updatedByAccountId: actorAccountId,
        },
      });
    }
    await writeAudit({
      actorAccountId,
      event: "ACCOUNT_RECOVERY_POLICY_UPDATED",
      result: "SUCCESS",
      meta,
      metadataJson: { policyRevision: nextRevision, threshold: proposal.threshold, reviewerCount: proposal.reviewers.length },
    }, tx);
  }, { isolationLevel: "Serializable" });
  return Object.freeze({
    contractVersion: ACCOUNT_RECOVERY_CONTRACT_VERSION,
    reviewerAccountIds: Object.freeze(proposal.reviewers),
    threshold: proposal.threshold,
    policyRevision: nextRevision,
  });
}
