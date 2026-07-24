import { prisma } from "../../../../core/database/prisma.js";
import {
  getPersonalDataMasterKeyStatus,
  listPersonalDataMasterKeyStorageLocations,
} from "../../crypto/index.js";
import { getSystemDataClassificationOverview } from "../data-classification/index.js";

type OverviewSeverity = "OK" | "INFO" | "WARNING" | "ACTION_REQUIRED" | "LOCKED" | "ERROR" | "UNAVAILABLE";

type CountResult = {
  available: boolean;
  count: number | null;
  error?: string;
};

type FindResult<T> = {
  available: boolean;
  value: T | null;
  error?: string;
};

type OverviewCard = {
  key: string;
  label: string;
  severity: OverviewSeverity;
  status: string;
  route?: string;
  details?: Record<string, unknown>;
  actions?: string[];
};

const db = prisma as any;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasDelegate(delegate: unknown): delegate is Record<string, (...args: any[]) => Promise<any>> {
  return Boolean(delegate && typeof delegate === "object");
}

async function safeCount(delegate: unknown, args?: Record<string, unknown>): Promise<CountResult> {
  if (!hasDelegate(delegate) || typeof delegate.count !== "function") {
    return { available: false, count: null };
  }

  try {
    return { available: true, count: await delegate.count(args ?? {}) };
  } catch (error) {
    return { available: true, count: null, error: getErrorMessage(error) };
  }
}

async function safeFindFirst<T>(delegate: unknown, args?: Record<string, unknown>): Promise<FindResult<T>> {
  if (!hasDelegate(delegate) || typeof delegate.findFirst !== "function") {
    return { available: false, value: null };
  }

  try {
    return { available: true, value: await delegate.findFirst(args ?? {}) };
  } catch (error) {
    return { available: true, value: null, error: getErrorMessage(error) };
  }
}

async function safeFindUnique<T>(delegate: unknown, args?: Record<string, unknown>): Promise<FindResult<T>> {
  if (!hasDelegate(delegate) || typeof delegate.findUnique !== "function") {
    return { available: false, value: null };
  }

  try {
    return { available: true, value: await delegate.findUnique(args ?? {}) };
  } catch (error) {
    return { available: true, value: null, error: getErrorMessage(error) };
  }
}

async function safeGroupBy(delegate: unknown, args?: Record<string, unknown>): Promise<FindResult<Array<Record<string, unknown>>>> {
  if (!hasDelegate(delegate) || typeof delegate.groupBy !== "function") {
    return { available: false, value: null };
  }

  try {
    return { available: true, value: await delegate.groupBy(args ?? {}) };
  } catch (error) {
    return { available: true, value: null, error: getErrorMessage(error) };
  }
}

function asCount(result: CountResult): number {
  return result.count ?? 0;
}

function isAvailable(...results: Array<CountResult | FindResult<unknown>>): boolean {
  return results.some((result) => result.available);
}

function hasErrors(...results: Array<CountResult | FindResult<unknown>>): boolean {
  return results.some((result) => Boolean(result.error));
}

function statusFromCount(count: number, emptyStatus: string, nonEmptyStatus: string) {
  return count > 0 ? nonEmptyStatus : emptyStatus;
}

function maxSeverity(cards: OverviewCard[]): OverviewSeverity {
  const order: Record<OverviewSeverity, number> = {
    OK: 0,
    INFO: 1,
    UNAVAILABLE: 2,
    WARNING: 3,
    ACTION_REQUIRED: 4,
    LOCKED: 5,
    ERROR: 6,
  };

  return cards.reduce<OverviewSeverity>((current, card) => (order[card.severity] > order[current] ? card.severity : current), "OK");
}

function buildMasterKeyCard(): OverviewCard {
  const status = getPersonalDataMasterKeyStatus();
  let storageLocations: ReturnType<typeof listPersonalDataMasterKeyStorageLocations> = [];
  let storageError: string | null = null;

  try {
    storageLocations = listPersonalDataMasterKeyStorageLocations();
  } catch (error) {
    storageError = getErrorMessage(error);
  }

  const configuredLocations = storageLocations.filter((location) => location.configured).length;
  const writableLocations = storageLocations.filter((location) => location.writable && location.allowed).length;

  const severity: OverviewSeverity = status.loaded
    ? "OK"
    : status.bootStickRequired
      ? status.continueWithoutBootStickDecisionRequired
        ? "ACTION_REQUIRED"
        : "LOCKED"
      : "INFO";

  return {
    key: "master-key",
    label: "Server-Master-Key / Boot-Stick",
    severity,
    status: status.loaded
      ? "LOADED"
      : status.bootStickRequired
        ? status.continueWithoutBootStickDecisionRequired
          ? "BOOT_STICK_DECISION_REQUIRED"
          : "LOCKED_WITHOUT_MASTER_KEY"
        : status.state,
    route: "/api/system/security/master-key/status",
    details: {
      loaded: status.loaded,
      required: status.required,
      startupMode: status.startupMode,
      source: status.source,
      sourceHint: status.sourceHint,
      fingerprint: status.fingerprint,
      bootStickRequired: status.bootStickRequired,
      developerBootActive: status.developerBootActive,
      adminLoginAllowedWithoutMasterKey: status.adminLoginAllowedWithoutMasterKey,
      nonMemberLoginAllowedWithoutMasterKey: status.nonMemberLoginAllowedWithoutMasterKey,
      memberLoginBlocked: status.memberLoginBlocked,
      continueWithoutBootStickDecisionRequired: status.continueWithoutBootStickDecisionRequired,
      storageLocations: {
        discovered: storageLocations.length,
        configured: configuredLocations,
        writableAllowed: writableLocations,
        error: storageError,
      },
      lastError: status.lastError,
    },
    actions: status.loaded
      ? ["USB-Stick kann nach erfolgreichem Laden abgezogen werden."]
      : status.bootStickRequired
        ? ["Boot-Stick einstecken oder bewusst ohne Boot-Stick fortfahren.", "Member-Login bleibt ohne Master-Key gesperrt."]
        : [],
  };
}

async function buildTwoFactorCard(): Promise<OverviewCard> {
  const now = new Date();
  const [activeCredentials, pendingCredentials, lockedScopes, pendingChallenges, recentFailures] = await Promise.all([
    safeCount(db.securityTwoFactorCredential, { where: { status: "ACTIVE" } }),
    safeCount(db.securityTwoFactorCredential, { where: { status: "PENDING" } }),
    safeCount(db.securityTwoFactorLockout, { where: { lockedUntil: { gt: now } } }),
    safeCount(db.securityTwoFactorChallenge, { where: { status: "PENDING", expiresAt: { gt: now } } }),
    safeCount(db.securityTwoFactorAuditLog, {
      where: {
        result: { in: ["FAILURE", "BLOCKED"] },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  if (!isAvailable(activeCredentials, pendingCredentials, lockedScopes, pendingChallenges, recentFailures)) {
    return {
      key: "two-factor",
      label: "2-Faktor-Authentifizierung",
      severity: "UNAVAILABLE",
      status: "NOT_INSTALLED_OR_NOT_MIGRATED",
      route: "/api/security/2fa/status",
      details: { available: false },
    };
  }

  const active = asCount(activeCredentials);
  const locked = asCount(lockedScopes);
  const failures = asCount(recentFailures);
  const severity: OverviewSeverity = hasErrors(activeCredentials, pendingCredentials, lockedScopes, pendingChallenges, recentFailures)
    ? "WARNING"
    : locked > 0
      ? "ACTION_REQUIRED"
      : failures > 0
        ? "WARNING"
        : active > 0
          ? "OK"
          : "INFO";

  return {
    key: "two-factor",
    label: "2-Faktor-Authentifizierung",
    severity,
    status: locked > 0 ? "LOCKOUTS_ACTIVE" : active > 0 ? "ACTIVE" : "NO_ACTIVE_CREDENTIALS_FOUND",
    route: "/api/security/2fa/status",
    details: {
      activeCredentialCount: activeCredentials.count,
      pendingCredentialCount: pendingCredentials.count,
      activeLockoutCount: lockedScopes.count,
      pendingChallengeCount: pendingChallenges.count,
      recentFailureOrBlockedCount24h: recentFailures.count,
      errors: [activeCredentials, pendingCredentials, lockedScopes, pendingChallenges, recentFailures]
        .map((result) => result.error)
        .filter(Boolean),
    },
    actions: locked > 0
      ? ["Aktive 2FA-Sperren prüfen."]
      : active === 0
        ? ["Admin- und Datenschutzbeauftragten-Accounts sollten 2FA aktivieren."]
        : [],
  };
}

async function buildDsgvoSchemaCard(): Promise<OverviewCard> {
  type SchemaGuard = {
    id: string;
    schemaFingerprint: string | null;
    reviewedSchemaFingerprint: string | null;
    discoveredColumnCount: number;
    hasUnreviewedChanges: boolean;
    lastDiscoveredAt: Date | null;
    reviewedAt: Date | null;
  };

  const [guard, reviewRequired, approved, ignored] = await Promise.all([
    safeFindUnique<SchemaGuard>(db.dsgvoDataScanSchemaGuard, { where: { id: "default" } }),
    safeCount(db.dsgvoDataScanKnownColumn, { where: { status: "REVIEW_REQUIRED" } }),
    safeCount(db.dsgvoDataScanKnownColumn, { where: { status: "APPROVED" } }),
    safeCount(db.dsgvoDataScanKnownColumn, { where: { status: "IGNORED" } }),
  ]);

  if (!isAvailable(guard, reviewRequired, approved, ignored)) {
    return {
      key: "dsgvo-schema",
      label: "DSGVO Schema-Check",
      severity: "UNAVAILABLE",
      status: "NOT_INSTALLED_OR_NOT_MIGRATED",
      route: "/api/dsgvo/subject-data-scan/coverage",
      details: {
        policy: {
          observedColumns: ["memberId", "member_id", "accountId", "account_id"],
          notObserved: ["userId", "user_id", "personId", "person_id", "name", "email", "phone", "note", "metadataJson"],
        },
      },
    };
  }

  const hasUnreviewed = Boolean(guard.value?.hasUnreviewedChanges) || asCount(reviewRequired) > 0;
  const severity: OverviewSeverity = hasErrors(guard, reviewRequired, approved, ignored)
    ? "WARNING"
    : hasUnreviewed
      ? "ACTION_REQUIRED"
      : "OK";

  return {
    key: "dsgvo-schema",
    label: "DSGVO Schema-Check",
    severity,
    status: hasUnreviewed ? "SCHEMA_REVIEW_REQUIRED" : guard.value ? "REVIEWED" : "NOT_DISCOVERED_YET",
    route: "/api/dsgvo/subject-data-scan/coverage",
    details: {
      policy: {
        observedColumns: ["memberId", "member_id", "accountId", "account_id"],
        notObserved: ["userId", "user_id", "personId", "person_id", "name", "email", "phone", "note", "metadataJson"],
      },
      guard: guard.value,
      reviewRequiredColumnCount: reviewRequired.count,
      approvedColumnCount: approved.count,
      ignoredColumnCount: ignored.count,
      errors: [guard, reviewRequired, approved, ignored].map((result) => result.error).filter(Boolean),
    },
    actions: hasUnreviewed ? ["Neue oder geänderte memberId/accountId-Spalten prüfen und bestätigen."] : [],
  };
}

async function buildRetentionCard(): Promise<OverviewCard> {
  const [pending, inReview, approved, postponed, blocked, activeRules] = await Promise.all([
    safeCount(db.dsgvoRetentionCandidate, { where: { status: "PENDING" } }),
    safeCount(db.dsgvoRetentionCandidate, { where: { status: "IN_REVIEW" } }),
    safeCount(db.dsgvoRetentionCandidate, { where: { status: "APPROVED" } }),
    safeCount(db.dsgvoRetentionCandidate, { where: { status: "POSTPONED" } }),
    safeCount(db.dsgvoRetentionCandidate, { where: { status: "BLOCKED" } }),
    safeCount(db.dsgvoRetentionRule, { where: { status: "ACTIVE" } }),
  ]);

  if (!isAvailable(pending, inReview, approved, postponed, blocked, activeRules)) {
    return {
      key: "retention",
      label: "Retention-Regeln",
      severity: "UNAVAILABLE",
      status: "NOT_INSTALLED_OR_NOT_MIGRATED",
      route: "/api/dsgvo/retention/candidates",
      details: { available: false },
    };
  }

  const openReview = asCount(pending) + asCount(inReview);
  const approvedCount = asCount(approved);
  const severity: OverviewSeverity = hasErrors(pending, inReview, approved, postponed, blocked, activeRules)
    ? "WARNING"
    : openReview > 0
      ? "ACTION_REQUIRED"
      : approvedCount > 0
        ? "WARNING"
        : "OK";

  return {
    key: "retention",
    label: "Retention-Regeln",
    severity,
    status: openReview > 0
      ? "CANDIDATES_NEED_REVIEW"
      : approvedCount > 0
        ? "APPROVED_CANDIDATES_WAITING_FOR_DELETION_PROCESS"
        : statusFromCount(asCount(activeRules), "NO_ACTIVE_RULES", "OK"),
    route: "/api/dsgvo/retention/candidates",
    details: {
      activeRuleCount: activeRules.count,
      pendingCandidateCount: pending.count,
      inReviewCandidateCount: inReview.count,
      approvedCandidateCount: approved.count,
      postponedCandidateCount: postponed.count,
      blockedCandidateCount: blocked.count,
      errors: [pending, inReview, approved, postponed, blocked, activeRules].map((result) => result.error).filter(Boolean),
    },
    actions: openReview > 0
      ? ["Retention-Kandidaten prüfen: freigeben, behalten, aufschieben oder blockieren."]
      : approvedCount > 0
        ? ["Freigegebene Kandidaten in den geschützten DSGVO-Löschprozess übernehmen."]
        : [],
  };
}

async function buildDpoApprovalCard(): Promise<OverviewCard> {
  const now = new Date();
  const [requested, approved, rejected, expired] = await Promise.all([
    safeCount(db.dsgvoDpoApproval, { where: { status: "REQUESTED" } }),
    safeCount(db.dsgvoDpoApproval, { where: { status: "APPROVED" } }),
    safeCount(db.dsgvoDpoApproval, { where: { status: "REJECTED" } }),
    safeCount(db.dsgvoDpoApproval, {
      where: {
        status: { in: ["REQUESTED", "APPROVED"] },
        expiresAt: { not: null, lt: now },
      },
    }),
  ]);

  if (!isAvailable(requested, approved, rejected, expired)) {
    return {
      key: "dpo-approvals",
      label: "DPO-Freigaben",
      severity: "UNAVAILABLE",
      status: "NOT_INSTALLED_OR_NOT_MIGRATED",
      route: "/api/dsgvo/subject-data-export-approvals",
      details: { available: false },
    };
  }

  const requestedCount = asCount(requested);
  const expiredCount = asCount(expired);
  const severity: OverviewSeverity = hasErrors(requested, approved, rejected, expired)
    ? "WARNING"
    : expiredCount > 0
      ? "WARNING"
      : requestedCount > 0
        ? "ACTION_REQUIRED"
        : "OK";

  return {
    key: "dpo-approvals",
    label: "Datenschutzbeauftragten-Freigaben",
    severity,
    status: requestedCount > 0 ? "APPROVALS_REQUESTED" : expiredCount > 0 ? "EXPIRED_APPROVALS_FOUND" : "OK",
    route: "/api/dsgvo/subject-data-export-approvals",
    details: {
      requestedCount: requested.count,
      approvedOpenCount: approved.count,
      rejectedCount: rejected.count,
      expiredOpenCount: expired.count,
      errors: [requested, approved, rejected, expired].map((result) => result.error).filter(Boolean),
    },
    actions: requestedCount > 0 ? ["Offene Export-Freigaben durch Datenschutzbeauftragten prüfen."] : [],
  };
}

async function buildAuditCard(): Promise<OverviewCard> {
  type AuditRow = {
    id: string;
    action: string;
    result: string;
    dataArea: string;
    createdAt: Date;
    hash: string;
    previousHash: string | null;
  };

  const [last24h, deniedOrFailed, latest, byResult] = await Promise.all([
    safeCount(db.dsgvoAccessAuditLog, { where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    safeCount(db.dsgvoAccessAuditLog, {
      where: {
        result: { in: ["FAILED", "DENIED", "BLOCKED"] },
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
    safeFindFirst<AuditRow>(db.dsgvoAccessAuditLog, { orderBy: { createdAt: "desc" } }),
    safeGroupBy(db.dsgvoAccessAuditLog, {
      by: ["result"],
      _count: { _all: true },
      where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    }),
  ]);

  if (!isAvailable(last24h, deniedOrFailed, latest, byResult)) {
    return {
      key: "dsgvo-audit",
      label: "DSGVO-Zugriffsprotokoll",
      severity: "UNAVAILABLE",
      status: "NOT_INSTALLED_OR_NOT_MIGRATED",
      route: "/api/dsgvo/access-audit",
      details: { available: false },
    };
  }

  const badEvents = asCount(deniedOrFailed);
  const severity: OverviewSeverity = hasErrors(last24h, deniedOrFailed, latest, byResult)
    ? "WARNING"
    : badEvents > 0
      ? "WARNING"
      : latest.value
        ? "OK"
        : "INFO";

  return {
    key: "dsgvo-audit",
    label: "DSGVO-Zugriffsprotokoll",
    severity,
    status: latest.value ? "ACTIVE" : "NO_EVENTS_YET",
    route: "/api/dsgvo/access-audit",
    details: {
      eventsLast24h: last24h.count,
      deniedFailedOrBlockedLast7d: deniedOrFailed.count,
      latestEvent: latest.value
        ? {
          id: latest.value.id,
          action: latest.value.action,
          result: latest.value.result,
          dataArea: latest.value.dataArea,
          createdAt: latest.value.createdAt,
          hasHash: Boolean(latest.value.hash),
          hasPreviousHash: Boolean(latest.value.previousHash),
        }
        : null,
      resultGroupsLast7d: byResult.value ?? [],
      errors: [last24h, deniedOrFailed, latest, byResult].map((result) => result.error).filter(Boolean),
    },
    actions: badEvents > 0 ? ["Blockierte/fehlgeschlagene DSGVO-Zugriffe prüfen."] : [],
  };
}

async function buildDeletionCard(): Promise<OverviewCard> {
  const [rulesReview, rulesApproved, jobsReview, jobsRunning, resultsFailed] = await Promise.all([
    safeCount(db.dsgvoSubjectDeletionRule, { where: { status: "REVIEW_REQUIRED" } }),
    safeCount(db.dsgvoSubjectDeletionRule, { where: { status: "APPROVED" } }),
    safeCount(db.dsgvoSubjectDeletionJob, { where: { status: "REVIEW_REQUIRED" } }),
    safeCount(db.dsgvoSubjectDeletionJob, { where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    safeCount(db.dsgvoSubjectDeletionResult, { where: { status: "FAILED" } }),
  ]);

  if (!isAvailable(rulesReview, rulesApproved, jobsReview, jobsRunning, resultsFailed)) {
    return {
      key: "dsgvo-delete",
      label: "DSGVO Löschen / Anonymisieren",
      severity: "UNAVAILABLE",
      status: "NOT_INSTALLED_OR_NOT_MIGRATED",
      route: "/api/dsgvo/subject-data-deletion/rules",
      details: { available: false },
    };
  }

  const reviewItems = asCount(rulesReview) + asCount(jobsReview);
  const failed = asCount(resultsFailed);
  const severity: OverviewSeverity = hasErrors(rulesReview, rulesApproved, jobsReview, jobsRunning, resultsFailed)
    ? "WARNING"
    : failed > 0
      ? "WARNING"
      : reviewItems > 0
        ? "ACTION_REQUIRED"
        : "OK";

  return {
    key: "dsgvo-delete",
    label: "DSGVO Löschen / Anonymisieren",
    severity,
    status: reviewItems > 0 ? "REVIEW_REQUIRED" : failed > 0 ? "FAILED_RESULTS_FOUND" : "OK",
    route: "/api/dsgvo/subject-data-deletion/rules",
    details: {
      deletionRulesReviewRequired: rulesReview.count,
      deletionRulesApproved: rulesApproved.count,
      deletionJobsReviewRequired: jobsReview.count,
      deletionJobsRunningOrQueued: jobsRunning.count,
      failedDeletionResults: resultsFailed.count,
      errors: [rulesReview, rulesApproved, jobsReview, jobsRunning, resultsFailed].map((result) => result.error).filter(Boolean),
    },
    actions: reviewItems > 0 ? ["Löschregeln oder Löschpläne prüfen, bevor echte Aktionen laufen."] : [],
  };
}

function buildDataClassificationCard(): OverviewCard {
  const overview = getSystemDataClassificationOverview();
  const criticalOpen = overview.summary.criticalUnclassifiedCount;
  const unclassified = overview.summary.unclassifiedCount;

  const severity: OverviewSeverity = criticalOpen > 0
    ? "ACTION_REQUIRED"
    : unclassified > 0
      ? "INFO"
      : "OK";

  return {
    key: "data-classification",
    label: "Datenklassifizierung pro Modul",
    severity,
    status: criticalOpen > 0
      ? "CRITICAL_MODULES_UNCLASSIFIED"
      : unclassified > 0
        ? "UNCLASSIFIED_MODULES_PRESENT"
        : "OK",
    route: "/api/system/security/data-classification",
    details: {
      policy: overview.policy,
      summary: overview.summary,
      criticalModules: overview.modules
        .filter((module) => module.criticalOpen)
        .map((module) => ({
          moduleId: module.moduleId,
          label: module.label,
          inferred: module.inferred,
          capabilities: module.capabilities,
        })),
    },
    actions: criticalOpen > 0
      ? ["Kritische Module mit memberId/accountId bewusst klassifizieren."]
      : unclassified > 0
        ? ["Übrige Module bei Gelegenheit klassifizieren."]
        : [],
  };
}

export async function getSystemSecurityPrivacyOverview() {
  const cards = await Promise.all([
    Promise.resolve(buildMasterKeyCard()),
    Promise.resolve(buildDataClassificationCard()),
    buildTwoFactorCard(),
    buildDsgvoSchemaCard(),
    buildRetentionCard(),
    buildDpoApprovalCard(),
    buildDeletionCard(),
    buildAuditCard(),
  ]);

  const severity = maxSeverity(cards);

  return {
    ok: severity !== "ERROR",
    area: "system/security/overview",
    generatedAt: new Date().toISOString(),
    title: "Sicherheit & Datenschutz",
    severity,
    summary: {
      okCount: cards.filter((card) => card.severity === "OK").length,
      actionRequiredCount: cards.filter((card) => card.severity === "ACTION_REQUIRED").length,
      warningCount: cards.filter((card) => card.severity === "WARNING").length,
      lockedCount: cards.filter((card) => card.severity === "LOCKED").length,
      unavailableCount: cards.filter((card) => card.severity === "UNAVAILABLE").length,
    },
    cards,
    routes: {
      masterKey: "/api/system/security/master-key/status",
      masterKeyStorageLocations: "/api/system/security/master-key/storage-locations",
      twoFactor: "/api/security/2fa/status",
      dataClassification: "/api/system/security/data-classification",
      dsgvoSchemaCoverage: "/api/dsgvo/subject-data-scan/coverage",
      retentionCandidates: "/api/dsgvo/retention/candidates",
      dpoApprovals: "/api/dsgvo/subject-data-export-approvals",
      deletionRules: "/api/dsgvo/subject-data-deletion/rules",
      accessAudit: "/api/dsgvo/access-audit",
    },
  };
}
