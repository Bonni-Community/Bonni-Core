const BUSY_STATES = new Set([
  "queued",
  "checking",
  "validating",
  "backing-up",
  "maintenance",
  "handoff",
  "stopping",
  "applying",
  "setting-up",
  "restarting",
  "health-check",
  "health",
  "confirmation",
  "awaiting-confirmation",
  "armed",
  "commit-pending",
  "awaiting-retry",
  "retry-started",
  "rollback-required",
  "return",
  "committing",
  "in-progress",
  "installing",
  "running",
  "rolling-back",
]);

const ERROR_STATES = new Set([
  "failed",
  "invalid",
  "id-collision",
  "multiple-packages",
  "recovery-required",
  "rolled-back",
  "confirmation-failed",
  "failed-old-active",
]);

export const UPDATE_ACTION_ERROR_STORAGE_KEY = "bonni.core-update.last-action-error";
export const ACCEPTED_UPDATE_STATUS_TIMEOUT_MS = 60_000;
export const ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS = 5 * 60_000;
export const UPDATE_CONFIRMATION_WINDOW_MS = 60_000;

export function formatBonniCoreVersion(value) {
  const version = String(value || "").trim();
  if (!version) return "—";
  return version.replace(/^(\d+\.\d+\.\d+)\+([A-Za-z])$/u, "$1$2");
}

const CANDIDATE_STEP_LABELS = Object.freeze({
  "candidate-copy": "SYSTEM vollständig nach RUN_INSTALL kopieren",
  "candidate-build": "Candidate aus dem geprüften Paket aufbauen",
  "candidate-start": "Isolierten Candidate starten",
  "candidate-health": "Backend und Frontend des Candidate vollständig prüfen",
  "candidate-cutover": "Kontrolliert auf den geprüften Candidate wechseln",
  "candidate-confirmation": "Neue aktive Version ausdrücklich bestätigen",
  "candidate-rollback": "Gesicherten Vorgängerstand kontrolliert wiederherstellen",
});

const LOCAL_SOURCE_STEP_LABELS = Object.freeze({
  ...CANDIDATE_STEP_LABELS,
  validate: "Neue Pakete werden geprüft",
  build: "UPDATE in RUN_INSTALL anwenden und versiegeln",
  start: "Candidate getrennt in RUN_SYSTEM starten",
  handoff: "Installationsdienst übernimmt",
  stop: "Wechsel wird vorbereitet",
  install: "Aktualisierung wird durchgeführt",
  restart: "Bonni Core wird neu gestartet",
  health: "Funktionstest – Backend und Frontend werden geprüft",
  cutover: "Anfragen kontrolliert auf den Candidate umschalten",
  confirmation: "Neue aktive Version innerhalb von 60 Sekunden bestätigen",
  "awaiting-confirmation": "Neue aktive Version innerhalb von 60 Sekunden bestätigen",
  complete: "SYSTEM übernehmen und Vorgänger direkt in BACKUP sichern",
  return: "Aktualisierung wird abgeschlossen",
  rollback: "Fehler erkannt – bisheriger Stand wird wiederhergestellt",
  "rolling-back": "Fehler erkannt – bisheriger Stand wird wiederhergestellt",
});

const SIGNED_RELEASE_STEP_LABELS = Object.freeze({
  ...CANDIDATE_STEP_LABELS,
  candidate: "Isolierten Candidate mit Testkopie vorbereiten",
  "candidate-prepare": "Isolierten Candidate mit Testkopie vorbereiten",
  health: "Isolierten Candidate vollständig prüfen",
  switch: "Kontrollierter Wechsel auf den geprüften Stand",
  cutover: "Kontrollierter Wechsel auf den geprüften Stand",
  "controlled-switch": "Kontrollierter Wechsel auf den geprüften Stand",
  confirmation: "Neue aktive Version ausdrücklich bestätigen",
  "awaiting-confirmation": "Neue aktive Version ausdrücklich bestätigen",
  observation: "14-Tage-Beobachtung des neuen aktiven Stands",
  hold: "14-Tage-Beobachtung des neuen aktiven Stands",
  "rollback-window": "14-Tage-Beobachtung des neuen aktiven Stands",
  finalize: "Gesicherten Rückfallstand abschließen",
  commit: "Gesicherten Rückfallstand abschließen",
  rollback: "Fehler vor Abschluss – gesicherten Rückfallstand kontrolliert aktivieren",
  "rolling-back": "Fehler vor Abschluss – gesicherten Rückfallstand kontrolliert aktivieren",
});

function updateStepLabel(step, index, kind) {
  const key = String(step?.key || "").trim();
  const labels = kind === "local-source" ? LOCAL_SOURCE_STEP_LABELS : SIGNED_RELEASE_STEP_LABELS;
  return labels[key]
    || step?.label
    || step?.name
    || key
    || `Schritt ${index + 1}`;
}

function updateStepKind(progress, requestedKind) {
  if (requestedKind === "local-source" || requestedKind === "release") return requestedKind;
  const entries = Array.isArray(progress?.steps)
    ? progress.steps
    : progress?.steps && typeof progress.steps === "object"
      ? Object.keys(progress.steps).map((key) => ({ key }))
      : [];
  return entries.some((step) => ["handoff", "stop", "install", "restart", "return"].includes(String(step?.key || "")))
    ? "local-source"
    : "release";
}

export function normalizeUpdateActionError(error, fallback, updateId = "current") {
  const data = error?.data || {};
  const nested = data?.error && typeof data.error === "object" ? data.error : {};
  return {
    message: error?.message || data?.message || nested?.message || fallback,
    code: error?.code || data?.code || nested?.code || null,
    errorCode: data?.errorCode || nested?.errorCode || data?.details?.errorCode || null,
    supervisorErrorCode: data?.supervisorErrorCode
      || nested?.supervisorErrorCode
      || data?.details?.supervisorErrorCode
      || null,
    causeCode: data?.causeCode || nested?.causeCode || data?.details?.causeCode || null,
    technicalMessage: data?.technicalMessage
      || nested?.technicalMessage
      || data?.details?.technicalMessage
      || error?.cause?.message
      || "",
    detail: data?.detail
      || nested?.detail
      || data?.errorDetail
      || data?.details?.detail
      || "",
    errorDetail: data?.errorDetail || nested?.errorDetail || data?.details?.errorDetail || "",
    phase: data?.phase || nested?.phase || data?.details?.phase || "",
    failedPhase: data?.failedPhase || nested?.failedPhase || data?.details?.failedPhase || "",
    stage: data?.stage || nested?.stage || data?.details?.stage || "",
    failedStage: data?.failedStage || nested?.failedStage || data?.details?.failedStage || "",
    diagnostic: data?.diagnostic || nested?.diagnostic || data?.details?.diagnostic || "",
    diagnosticLog: data?.diagnosticLog || nested?.diagnosticLog || data?.details?.diagnosticLog || "",
    stderr: data?.stderr || nested?.stderr || data?.details?.stderr || "",
    stdout: data?.stdout || nested?.stdout || data?.details?.stdout || "",
    exitCode: data?.exitCode ?? nested?.exitCode ?? data?.details?.exitCode ?? null,
    signal: data?.signal || nested?.signal || data?.details?.signal || "",
    details: data?.details || nested?.details || null,
    cause: nested?.cause || data?.cause || error?.cause || null,
    error: Object.keys(nested).length
      ? nested
      : typeof data?.error === "string"
        ? data.error
        : null,
    updateId: String(updateId || "current"),
    createdAt: new Date().toISOString(),
  };
}

export function normalizeUpdateState(value, fallback = "none") {
  return String(value || fallback).trim().toLowerCase();
}

const CONFIRMATION_ACTIVE_STATES = new Set([
  "armed",
  "confirmation",
  "awaiting-confirmation",
]);
const CONFIRMATION_ROLLBACK_STATES = new Set([
  "rollback-required",
  "rolled-back",
]);
const CONFIRMATION_FAILED_STATES = new Set([
  "confirmation-failed",
  "failed-old-active",
]);

function confirmationState(value) {
  return normalizeUpdateState(value).replaceAll("_", "-");
}

/**
 * Normalizes the supervisor-owned, 60-second post-cutover acceptance gate.
 * The UI deliberately derives no slot or proxy proof; those stay server-side.
 */
export function normalizeUpdateConfirmation(progress, now = Date.now()) {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const nestedSource = [progress.acceptanceGate, progress.confirmation, progress.gate]
    .find((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  const nested = nestedSource || {};
  const phase = confirmationState(progress.phase || progress.stage);
  const explicitState = progress.confirmationState || progress.acceptanceState;
  const reportedState = confirmationState(
    nested.state
      || explicitState
      || progress.status,
  );
  let state = reportedState;
  const reportedGateState = CONFIRMATION_ACTIVE_STATES.has(state)
    || CONFIRMATION_ROLLBACK_STATES.has(state)
    || CONFIRMATION_FAILED_STATES.has(state)
    || state === "confirmed";
  if (CONFIRMATION_ACTIVE_STATES.has(phase) && !reportedGateState) state = "armed";
  if (state === "awaiting-confirmation" || state === "confirmation") state = "armed";
  if (state === "confirmation-failed") state = "failed-old-active";
  const hasGateEvidence = Boolean(
    nestedSource
    || explicitState
    || CONFIRMATION_ACTIVE_STATES.has(phase)
    || CONFIRMATION_ACTIVE_STATES.has(reportedState)
    || progress.rollbackRequired === true
    || progress.confirmationDeadline
    || progress.confirmationAttempt,
  );
  if (!hasGateEvidence && (CONFIRMATION_ROLLBACK_STATES.has(state) || CONFIRMATION_FAILED_STATES.has(state))) {
    return null;
  }
  if (
    !CONFIRMATION_ACTIVE_STATES.has(state)
    && !CONFIRMATION_ROLLBACK_STATES.has(state)
    && !CONFIRMATION_FAILED_STATES.has(state)
    && state !== "confirmed"
  ) return null;

  const deadlineValue = nested.deadlineAt
    || progress.confirmationDeadline
    || progress.deadlineAt
    || nested.expiresAt
    || progress.confirmBy;
  let deadlineMs = Date.parse(String(deadlineValue || ""));
  const reportedTtlMs = Number(nested.ttlMs ?? progress.confirmationTtlMs ?? progress.ttlMs);
  const ttlMs = Number.isFinite(reportedTtlMs) && reportedTtlMs > 0
    ? Math.min(UPDATE_CONFIRMATION_WINDOW_MS, reportedTtlMs)
    : UPDATE_CONFIRMATION_WINDOW_MS;
  if (!Number.isFinite(deadlineMs)) {
    const armedAtMs = Date.parse(String(nested.armedAt || progress.confirmationStartedAt || progress.updatedAt || ""));
    deadlineMs = Number.isFinite(armedAtMs) ? armedAtMs + ttlMs : Number.NaN;
  }
  const currentTime = Number(now);
  const remainingMs = Number.isFinite(deadlineMs) && Number.isFinite(currentTime)
    ? Math.max(0, Math.min(ttlMs, deadlineMs - currentTime))
    : null;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingPercent = remainingMs === null ? 0 : Math.max(0, Math.min(100, (remainingMs / ttlMs) * 100));
  const attemptValue = Number(nested.attempt ?? progress.confirmationAttempt ?? progress.attempt);
  const maxAttemptsValue = Number(nested.maxAttempts ?? progress.confirmationMaxAttempts ?? progress.maxAttempts);
  const attempt = Number.isSafeInteger(attemptValue) && [1, 2].includes(attemptValue) ? attemptValue : null;
  const maxAttempts = Number.isSafeInteger(maxAttemptsValue) && maxAttemptsValue === 2
    ? maxAttemptsValue
    : null;
  const active = state === "armed";
  const rollbackRequired = CONFIRMATION_ROLLBACK_STATES.has(state)
    || nested.rollbackRequired === true
    || progress.rollbackRequired === true;
  const terminalFailed = state === "failed-old-active";
  return {
    state,
    active,
    confirmed: state === "confirmed",
    rollbackRequired,
    terminalFailed,
    oldBackendActive: rollbackRequired || terminalFailed,
    attempt,
    maxAttempts,
    deadlineAt: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
    remainingMs,
    remainingSeconds,
    remainingPercent,
    canConfirm: active && remainingMs !== 0,
    canRetry: state === "rollback-required" && attempt === 1 && maxAttempts === 2,
  };
}

const DEPLOYMENT_PHASES = Object.freeze({
  idle: "idle",
  none: "idle",
  preparing: "candidate",
  validating: "candidate",
  candidate: "candidate",
  "candidate-preparing": "candidate",
  "candidate-testing": "candidate",
  "candidate-preflight": "candidate",
  "candidate-ready": "candidate",
  switching: "cutover",
  cutover: "cutover",
  "controlled-switch": "cutover",
  "cutover-pending": "cutover",
  "cutover-running": "cutover",
  observing: "observation",
  observation: "observation",
  hold: "observation",
  holding: "observation",
  "hold-active": "observation",
  "rollback-hold": "observation",
  "rollback-window": "observation",
  "awaiting-finalization": "observation",
  "ready-to-finalize": "observation",
  finalizing: "finalize",
  committing: "finalize",
  "hold-expired": "finalize",
  "auto-finalize-due": "finalize",
  committed: "completed",
  finalized: "completed",
  completed: "completed",
  "rolling-back": "rollback",
  rollback: "rollback",
  "rolled-back": "rolled-back",
  failed: "failed",
  blocked: "blocked",
});

function boundedLifecycleText(value, maximum = 240) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function lifecycleSlot(value) {
  const slot = boundedLifecycleText(value, 80);
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/u.test(slot) ? slot : "";
}

const DEPLOYMENT_LIFECYCLE_HOLD_DAYS = 14;
const DEPLOYMENT_LIFECYCLE_HOLD_MS = DEPLOYMENT_LIFECYCLE_HOLD_DAYS * 24 * 60 * 60_000;
const ACTIVE_HOLD_PHASES = new Set(["observation", "finalize"]);
const BLOCKING_LIFECYCLE_PHASES = new Set(["observation", "finalize", "rollback", "blocked"]);

export function normalizeDeploymentLifecycle(value, now = Date.now(), context = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = normalizeUpdateState(value.status || value.state, "idle").replaceAll("_", "-");
  const phase = DEPLOYMENT_PHASES[status] || "unknown";
  const generation = Number(value.generation ?? value.revision);
  const activatedAtMs = Date.parse(String(value.activatedAt || ""));
  const holdUntilMs = Date.parse(String(value.holdUntil || value.hold?.until || ""));
  const currentTime = Number(now);
  const remainingMs = Number.isFinite(holdUntilMs) && Number.isFinite(currentTime)
    ? holdUntilMs - currentTime
    : null;
  const reportedHoldId = boundedLifecycleText(value.holdId || value.hold?.id || value.rollbackHoldId, 160);
  const holdId = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(reportedHoldId) ? reportedHoldId : "";
  const previousSlot = lifecycleSlot(value.previousSlot || value.rollbackSlot);
  const standbySlot = lifecycleSlot(value.standbySlot || value.candidateSlot);
  const targetVersion = boundedLifecycleText(value.candidateVersion || value.targetVersion, 80);
  const reportedActiveVersion = boundedLifecycleText(
    value.activeVersion || value.currentVersion || context.currentVersion,
    80,
  );
  const currentVersion = ["observation", "finalize", "completed"].includes(phase) && targetVersion
    ? targetVersion
    : reportedActiveVersion;
  const reportedHoldDays = Number(value.holdDays);
  const holdDays = Number.isSafeInteger(reportedHoldDays)
    && reportedHoldDays === DEPLOYMENT_LIFECYCLE_HOLD_DAYS
    ? DEPLOYMENT_LIFECYCLE_HOLD_DAYS
    : null;
  const activeHold = ACTIVE_HOLD_PHASES.has(phase);
  let holdContractIssue = "";
  if (activeHold && holdDays !== DEPLOYMENT_LIFECYCLE_HOLD_DAYS) {
    holdContractIssue = "Der Serververtrag ist unvollständig: Die Rückfallfrist muss exakt 14 Tage betragen. Hold und Folgeupdate-Sperre bleiben vorsorglich aktiv.";
  } else if (activeHold && (!Number.isFinite(activatedAtMs) || !Number.isFinite(holdUntilMs))) {
    holdContractIssue = "Der Serververtrag ist unvollständig: Beginn und Ende der 14-Tage-Frist wurden nicht vollständig bestätigt. Hold und Folgeupdate-Sperre bleiben vorsorglich aktiv.";
  } else if (activeHold && holdUntilMs - activatedAtMs !== DEPLOYMENT_LIFECYCLE_HOLD_MS) {
    holdContractIssue = "Die serverseitige Rückfallfrist weicht vom verbindlichen Zeitraum von exakt 14 Tagen ab. Hold und Folgeupdate-Sperre bleiben vorsorglich aktiv.";
  }
  const serverBlockReason = boundedLifecycleText(value.blockReason || value.reason, 480);
  const followUpdatesBlocked = Boolean(
    value.followUpdatesBlocked
    || value.updatesBlocked
    || value.blocksUpdates
    || BLOCKING_LIFECYCLE_PHASES.has(phase)
    || holdContractIssue,
  );
  return {
    protocol: boundedLifecycleText(value.protocol, 80),
    mode: boundedLifecycleText(value.mode, 80),
    status,
    phase,
    activeSlot: lifecycleSlot(value.activeSlot),
    standbySlot,
    previousSlot,
    currentVersion,
    targetVersion,
    previousVersion: boundedLifecycleText(value.previousVersion || value.rollbackVersion, 80),
    generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : null,
    holdId,
    holdDays,
    holdContractValid: !holdContractIssue,
    holdContractIssue,
    activatedAt: Number.isFinite(activatedAtMs) ? new Date(activatedAtMs).toISOString() : null,
    holdUntil: Number.isFinite(holdUntilMs) ? new Date(holdUntilMs).toISOString() : null,
    remainingMs,
    holdExpired: remainingMs !== null && remainingMs <= 0,
    canFinalize: value.canFinalize === true && !holdContractIssue,
    canRollback: value.canRollback === true && !holdContractIssue,
    followUpdatesBlocked,
    blockReason: holdContractIssue || serverBlockReason,
    serverBlockReason,
    finalizeReason: boundedLifecycleText(value.finalizeReason, 240),
    finalizedAt: Number.isFinite(Date.parse(String(value.finalizedAt || "")))
      ? new Date(Date.parse(value.finalizedAt)).toISOString()
      : null,
  };
}

export function deploymentLifecycleInstallationBlock({
  lifecycle,
  localRelevant,
  updateAvailable,
  installation,
}) {
  const serverBlocked = Boolean(updateAvailable && installation?.allowed === false);
  const lifecycleBlocked = Boolean(updateAvailable && lifecycle?.followUpdatesBlocked);
  const blocked = serverBlocked || lifecycleBlocked;
  return {
    blocked,
    serverBlocked,
    lifecycleBlocked,
    localLifecycleBlocked: Boolean(localRelevant && lifecycleBlocked),
    reason: blocked
      ? installation?.reason
        || lifecycle?.blockReason
        || "Ein gesicherter Rückfallstand muss vor dem nächsten Update abgeschlossen werden."
      : "",
  };
}

export function deploymentLifecycleStatusLabel(lifecycle) {
  const phase = lifecycle?.phase || "unknown";
  if (lifecycle?.holdContractIssue) return "14-Tage-Vertrag nicht bestätigt";
  if (phase === "idle" && lifecycle?.followUpdatesBlocked) return "Lifecycle sicher gesperrt";
  if (phase === "candidate") return "Isolierter Candidate-Test";
  if (phase === "cutover") return "Kontrollierter Wechsel";
  if (phase === "observation") return "14-Tage-Beobachtung";
  if (phase === "finalize") return "Rückfallstand wird abgeschlossen";
  if (phase === "completed") return "Rückfallstand abgeschlossen";
  if (phase === "rollback") return "Kontrollierter Rückfall läuft";
  if (phase === "rolled-back") return "Rückfall kontrolliert abgeschlossen";
  if (phase === "blocked") return "Lifecycle sicher gesperrt";
  if (phase === "failed") return "Lifecycle sicher angehalten";
  return "Bereit";
}

export function formatDeploymentLifecycleDate(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function formatDeploymentLifecycleRemaining(remainingMs) {
  if (!Number.isFinite(remainingMs)) return "Frist wird vom Server bestätigt";
  if (remainingMs <= 0) return "Frist erreicht – Serverstatus wird geprüft";
  const totalHours = Math.ceil(remainingMs / (60 * 60_000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days && hours) return `Noch ${days} ${days === 1 ? "Tag" : "Tage"} und ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
  if (days) return `Noch ${days} ${days === 1 ? "Tag" : "Tage"}`;
  return `Noch ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
}

export function deploymentLifecycleStages(lifecycle) {
  const phase = lifecycle?.phase || "unknown";
  const activeIndex = {
    candidate: 0,
    cutover: 1,
    observation: 2,
    finalize: 3,
    completed: 4,
  }[phase];
  const definitions = [
    {
      key: "isolated-candidate",
      label: "Candidate isoliert vorbereiten und prüfen",
      detail: "Der produktive aktive Stand bleibt erreichbar; der Candidate arbeitet ausschließlich mit einer isolierten Testkopie.",
    },
    {
      key: "single-active-cutover",
      label: "Kontrolliert auf den geprüften Stand wechseln",
      detail: "Der Cutover wird atomar ausgeführt. Auf die gemeinsame Produktionsdatenbank schreibt immer nur der aktive Stand.",
    },
    {
      key: "observation-hold",
      label: "Neuen aktiven Stand 14 Tage beobachten",
      detail: "Der bisherige Programmstand bleibt serverseitig als gesicherter Rückfallstand erhalten; Folgeupdates bleiben gesperrt.",
    },
    {
      key: "finalize-hold",
      label: "Gesicherten Rückfallstand abschließen",
      detail: "Erst die serverseitig bestätigte Finalisierung gibt den nächsten Update-Lauf frei.",
    },
  ];
  const steps = definitions.map((definition, index) => ({
    ...definition,
    status: Number.isInteger(activeIndex)
      ? activeIndex >= definitions.length || index < activeIndex
        ? "completed"
        : index === activeIndex
          ? "running"
          : "pending"
      : "pending",
  }));
  if (["rollback", "rolled-back"].includes(phase)) {
    steps.push({
      key: "controlled-rollback",
      label: "Gesicherten Rückfallstand kontrolliert aktivieren",
      detail: "Dieser Weg ist nur vor der endgültigen Finalisierung verfügbar und wird ausschließlich serverseitig koordiniert.",
      status: phase === "rolled-back" ? "completed" : "running",
    });
  }
  return steps;
}

export function normalizeUpdateStepStatus(value) {
  const status = normalizeUpdateState(value);
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["running", "active", "in-progress", "installing", "committing"].includes(status)) return "running";
  if (["failed", "error", "invalid"].includes(status)) return "failed";
  if (["waiting", "queued", "blocked"].includes(status)) return "waiting";
  return "pending";
}

export function normalizeUpdateSteps(progress, options = {}) {
  const kind = updateStepKind(progress, options.kind);
  if (Array.isArray(progress?.steps)) {
    return progress.steps.map((step, index) => ({
      key: step?.key || `step-${index}`,
      label: updateStepLabel(step, index, kind),
      detail: step?.detail || step?.message || "",
      status: normalizeUpdateStepStatus(step?.status),
    }));
  }
  if (progress?.steps && typeof progress.steps === "object") {
    return Object.entries(progress.steps).map(([key, value]) => ({
      key,
      label: updateStepLabel(typeof value === "object" ? { ...value, key } : { key }, 0, kind),
      detail: typeof value === "object" ? value?.detail || value?.message || "" : "",
      status: normalizeUpdateStepStatus(typeof value === "object" ? value?.status : value),
    }));
  }
  return [];
}

const FIVE_STEP_UPDATE_PHASES = Object.freeze([
  Object.freeze({ key: "verify", label: "Prüfen" }),
  Object.freeze({ key: "prepare", label: "Sichern/Vorbereiten" }),
  Object.freeze({ key: "apply", label: "Aktualisieren" }),
  Object.freeze({ key: "start-health", label: "Starten/Prüfen" }),
  Object.freeze({ key: "finish", label: "Abschließen" }),
]);

const FIVE_STEP_KEYS = Object.freeze({
  verify: new Set([
    "accepted-install",
    "check",
    "checking",
    "download",
    "manifest",
    "package-check",
    "preflight",
    "signature",
    "store",
    "validate",
    "verification",
    "verify",
  ]),
  prepare: new Set([
    "candidate-copy",
    "handoff",
    "maintenance",
    "prepare",
    "stop",
    "stopping",
  ]),
  apply: new Set([
    "applying",
    "build",
    "candidate",
    "candidate-build",
    "candidate-prepare",
    "install",
    "installing",
    "setting-up",
    "setup",
  ]),
  "start-health": new Set([
    "candidate-health",
    "candidate-start",
    "health",
    "health-check",
    "migration",
    "restart",
    "restarting",
    "start",
  ]),
  finish: new Set([
    "armed",
    "awaiting-confirmation",
    "candidate-confirmation",
    "candidate-cutover",
    "commit",
    "commit-pending",
    "committing",
    "complete",
    "confirmation",
    "controlled-switch",
    "cutover",
    "finalize",
    "hold",
    "observation",
    "return",
    "rollback-window",
    "switch",
  ]),
});

const ROLLBACK_STEP_KEYS = new Set([
  "candidate-rollback",
  "controlled-rollback",
  "rollback",
  "rolling-back",
]);

const ROLLBACK_UPDATE_STATES = new Set([
  "confirmation-failed",
  "failed-old-active",
  "rollback",
  "rollback-required",
  "rolled-back",
  "rolling-back",
]);

const COMPLETED_UPDATE_STATES = new Set([
  "already-installed",
  "complete",
  "completed",
  "done",
  "success",
  "succeeded",
]);

function normalizedFiveStepKey(value) {
  return normalizeUpdateState(value).replaceAll("_", "-");
}

function fiveStepPhaseIndex(value) {
  const key = normalizedFiveStepKey(value);
  if (!key || ROLLBACK_STEP_KEYS.has(key)) return -1;
  if (key === "backup" || key.startsWith("backup-")) return 1;
  return FIVE_STEP_UPDATE_PHASES.findIndex((phase) => FIVE_STEP_KEYS[phase.key].has(key));
}

function aggregateFiveStepStatus(entries) {
  const statuses = entries.map((entry) => entry.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.length && statuses.every((status) => status === "completed")) return "completed";
  if (statuses.includes("completed")) return "running";
  return "pending";
}

function correlatedBackupStep(backup, updateId, manifestSha256) {
  const id = String(updateId || "").trim();
  const sha256 = String(manifestSha256 || "").trim().toLowerCase();
  if (!id || !/^[a-f0-9]{64}$/u.test(sha256)) return null;
  const latest = backup?.latest;
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return null;
  const expectedReason = `before-local-source-update:${id}:${sha256}`;
  if (String(latest.reason || "") !== expectedReason) return null;

  const status = normalizeUpdateStepStatus(latest.status);
  if (status === "running" && normalizeUpdateState(backup?.status) !== "running") return null;
  const components = Array.isArray(latest.components) ? latest.components : [];
  const activeComponent = components.find((component) => normalizeUpdateStepStatus(component?.status) === "running")
    || components.find((component) => normalizeUpdateStepStatus(component?.status) === "failed");
  const completedComponents = components.filter(
    (component) => normalizeUpdateStepStatus(component?.status) === "completed",
  ).length;
  const componentProgress = components.length ? completedComponents / components.length : null;
  const detail = activeComponent?.label
    ? `${activeComponent.label} wird ${status === "failed" ? "als fehlgeschlagen gemeldet" : "gesichert"}.`
    : status === "completed"
      ? "Die zu diesem Update gehörende Sicherung wurde vollständig erstellt."
      : latest.error || latest.message || "Die zu diesem Update gehörende Sicherung wird erstellt.";
  return {
    key: "backup",
    label: "Sicherung vor der Aktualisierung erstellen",
    detail,
    status,
    componentProgress,
    source: "backup",
  };
}

function fiveStepPhaseFraction(phase, progress) {
  if (phase.status === "completed") return 1;
  if (phase.status !== "running") return 0;
  if (!phase.entries.length) return 0;

  const completed = phase.entries.filter((entry) => entry.status === "completed").length;
  let runningContribution = 0;
  const running = phase.entries.find((entry) => entry.status === "running");
  if (running?.source === "backup" && Number.isFinite(running.componentProgress)) {
    runningContribution = Math.max(0, Math.min(1, running.componentProgress));
  } else if (
    phase.key === "apply"
    && ["build", "candidate-build", "install", "setup"].includes(normalizedFiveStepKey(running?.key))
  ) {
    const stageIndex = Number(progress?.setup?.stageIndex);
    const stageCount = Number(progress?.setup?.stageCount);
    if (
      Number.isInteger(stageIndex)
      && Number.isInteger(stageCount)
      && stageCount > 0
      && stageIndex >= 0
      && stageIndex <= stageCount
    ) runningContribution = stageIndex / stageCount;
  } else if (phase.key === "verify" && normalizedFiveStepKey(running?.key) === "download") {
    const explicit = Number(progress?.progressPercent ?? progress?.percent);
    if (Number.isFinite(explicit)) runningContribution = Math.max(0, Math.min(1, explicit / 100));
  }
  return Math.max(0, Math.min(1, (completed + runningContribution) / phase.entries.length));
}

/**
 * Verdichtet ausschließlich gemeldete Update-, Monitor- und exakt zum Paket
 * gehörende Backupzustände zu den fünf stabilen Schritten der Oberfläche.
 * Die ursprünglichen Einzelschritte bleiben unverändert für Details, Fehler
 * und Historie erhalten. Ein Rollback wird am fehlgeschlagenen Schritt
 * erläutert und niemals als sechster Fortschrittsschritt ergänzt.
 */
export function normalizeFiveStepProgress(progress, options = {}) {
  const rawSteps = Array.isArray(options.rawSteps)
    ? options.rawSteps
    : normalizeUpdateSteps(progress, { kind: options.kind });
  const phases = FIVE_STEP_UPDATE_PHASES.map((definition, index) => ({
    ...definition,
    number: index + 1,
    status: "pending",
    detail: "",
    rollbackDetail: "",
    entries: [],
  }));
  const rollbackEntries = [];

  for (const step of rawSteps) {
    const normalizedKey = normalizedFiveStepKey(step?.key);
    if (ROLLBACK_STEP_KEYS.has(normalizedKey)) {
      rollbackEntries.push(step);
      continue;
    }
    const phaseIndex = fiveStepPhaseIndex(normalizedKey);
    if (phaseIndex >= 0) phases[phaseIndex].entries.push(step);
  }

  const backupStep = correlatedBackupStep(options.backup, options.updateId, options.manifestSha256);
  if (backupStep) phases[1].entries.push(backupStep);

  for (const phase of phases) {
    phase.status = aggregateFiveStepStatus(phase.entries);
    const detailSource = phase.entries.find((entry) => ["failed", "running", "waiting"].includes(entry.status))
      || phase.entries.findLast((entry) => entry.status === "completed");
    phase.detail = detailSource?.detail || "";
  }

  const progressState = normalizedFiveStepKey(progress?.status || progress?.phase);
  const reportedStates = [progress?.status, progress?.phase, progress?.stage]
    .map(normalizedFiveStepKey)
    .filter(Boolean);
  const reportedPhaseIndex = [
    progress?.failedStage,
    progress?.failedPhase,
    progress?.stage,
    progress?.phase,
    progress?.status,
  ].map(fiveStepPhaseIndex).find((index) => index >= 0) ?? -1;
  const terminalCompleted = reportedStates.some((state) => COMPLETED_UPDATE_STATES.has(state));
  if (terminalCompleted) {
    for (const phase of phases) phase.status = "completed";
  } else if (reportedPhaseIndex >= 0 && phases[reportedPhaseIndex].status === "pending") {
    phases[reportedPhaseIndex].status = isUpdateFailed(progressState) ? "failed" : "running";
    phases[reportedPhaseIndex].detail = progress?.detail || progress?.message || phases[reportedPhaseIndex].detail;
  }

  const furthestEvidenceIndex = phases.reduce(
    (furthest, phase, index) => phase.status === "pending" ? furthest : index,
    -1,
  );
  for (let index = 0; index < furthestEvidenceIndex; index += 1) {
    if (phases[index].status === "pending") phases[index].status = "completed";
  }

  const rollbackState = reportedStates.some((state) => ROLLBACK_UPDATE_STATES.has(state))
    || rollbackEntries.some((entry) => ["running", "completed", "failed"].includes(entry.status));
  if (rollbackState) {
    const explicitlyFailedIndex = phases.findIndex((phase) => phase.status === "failed");
    const lastStartedIndex = phases.reduce(
      (last, phase, index) => phase.status === "pending" ? last : index,
      -1,
    );
    const rollbackPhaseIndex = explicitlyFailedIndex >= 0
      ? explicitlyFailedIndex
      : reportedPhaseIndex >= 0
        ? reportedPhaseIndex
        : Math.max(0, lastStartedIndex);
    const rollbackEntry = rollbackEntries.find((entry) => entry.status === "running")
      || rollbackEntries.find((entry) => entry.status === "failed")
      || rollbackEntries.at(-1);
    phases[rollbackPhaseIndex].status = "failed";
    phases[rollbackPhaseIndex].rollbackDetail = rollbackEntry?.detail
      || (reportedStates.includes("rolling-back") || rollbackEntry?.status === "running"
        ? "Sichere Rückkehr zur bisherigen Version läuft."
        : "Sichere Rückkehr zur bisherigen Version wurde abgeschlossen.");
  }

  const completed = phases.filter((phase) => phase.status === "completed").length;
  const runningPhase = phases.find((phase) => phase.status === "running");
  const runningContribution = runningPhase ? fiveStepPhaseFraction(runningPhase, progress) : 0;
  const percent = terminalCompleted && !rollbackState
    ? 100
    : Math.max(0, Math.min(99, ((completed + runningContribution) / phases.length) * 100));

  return {
    steps: phases.map(({ entries, ...phase }) => phase),
    percent,
    hasEvidence: Boolean(rawSteps.length || backupStep || reportedPhaseIndex >= 0 || terminalCompleted),
    backupActive: backupStep?.status === "running",
    rollbackActive: rollbackState,
  };
}

export function updateProgressPercent(progress, steps = normalizeUpdateSteps(progress)) {
  const explicit = Number(progress?.progressPercent ?? progress?.percent);
  const state = normalizeUpdateState(progress?.status || progress?.phase);
  if (state === "completed") return 100;
  if (!steps.length) {
    return Number.isFinite(explicit) ? Math.max(0, Math.min(99, explicit)) : 0;
  }
  const completed = steps.filter((step) => step.status === "completed").length;
  const setupStageIndex = Number(progress?.setup?.stageIndex);
  const setupStageCount = Number(progress?.setup?.stageCount);
  const setupContribution = Number.isInteger(setupStageIndex)
    && Number.isInteger(setupStageCount)
    && setupStageCount > 0
    && setupStageIndex >= 0
    && setupStageIndex <= setupStageCount
    && steps.some((step) => step.key === "install" && step.status === "running")
    ? setupStageIndex / setupStageCount
    : null;
  // Bei regulären Releases beschreibt progressPercent ausschließlich den
  // Download des gerade laufenden Schritts. Er darf daher nicht als
  // Gesamtfortschritt der anschließenden Sicherung/Installation erscheinen.
  const runningContribution = setupContribution ?? (
    Number.isFinite(explicit) && steps.some((step) => step.status === "running")
      ? Math.max(0, Math.min(1, explicit / 100))
      : 0
  );
  return Math.max(0, Math.min(99, ((completed + runningContribution) / steps.length) * 100));
}

export function isUpdateBusy(...states) {
  return states.some((state) => BUSY_STATES.has(normalizeUpdateState(state)));
}

export function isUpdateFailed(...states) {
  return states.some((state) => ERROR_STATES.has(normalizeUpdateState(state)));
}

export function updateExecutionObservation(status, kind = "local-source") {
  const local = kind === "local-source";
  const source = local ? status?.localSourceUpdate || {} : status?.workflow || {};
  const progress = local ? source?.progress || {} : source;
  const sourceState = normalizeUpdateState(source?.state || source?.status);
  const progressState = normalizeUpdateState(progress?.status || progress?.phase, "idle");
  const state = !["none", "idle"].includes(progressState) ? progressState : sourceState;
  const executionState = isUpdateBusy(sourceState, progressState)
    || isUpdateFailed(sourceState, progressState)
    || ["completed", "already-installed"].includes(sourceState)
    || ["completed", "already-installed"].includes(progressState);
  const updateId = local
    ? source?.updateId || ""
    : source?.id || status?.manifest?.id || status?.targetVersion || "";
  const targetVersion = local
    ? source?.to?.coreVersion || ""
    : source?.targetVersion || status?.targetVersion || status?.manifest?.version || "";

  return {
    updateId: String(updateId || ""),
    targetVersion: String(targetVersion || ""),
    state,
    executionState,
    signature: JSON.stringify([
      String(updateId || ""),
      String(targetVersion || ""),
      sourceState,
      progressState,
      progress?.updatedAt || source?.updatedAt || "",
      progress?.message || source?.message || "",
      progress?.errorCode || source?.errorCode || "",
      typeof progress?.error === "string" ? progress.error : progress?.error?.message || "",
    ]),
  };
}

export function hasObservedAcceptedUpdate(status, optimisticStart) {
  if (!optimisticStart) return false;
  const current = updateExecutionObservation(status, optimisticStart.kind);
  if (optimisticStart.kind === "local-source") {
    if (
      optimisticStart.updateId
      && current.updateId !== optimisticStart.updateId
    ) {
      return false;
    }
  } else if (
    optimisticStart.targetVersion
    && current.targetVersion !== optimisticStart.targetVersion
  ) {
    return false;
  }
  return current.executionState && current.signature !== optimisticStart.baselineSignature;
}

export function hasAcceptedUpdateStatusTimedOut(
  optimisticStart,
  now = Date.now(),
  timeoutMs = ACCEPTED_UPDATE_STATUS_TIMEOUT_MS,
) {
  if (!optimisticStart || optimisticStart.expired) return false;
  const startedAt = Date.parse(String(optimisticStart.startedAt || ""));
  if (!Number.isFinite(startedAt)) return true;
  return Number(now) - startedAt >= timeoutMs;
}

export function normalizeAcceptedUpdateTransition(
  value,
  now = Date.now(),
  maximumAgeMs = ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS,
) {
  if (!value || typeof value !== "object") return null;
  const kind = value.kind === "local-source" || value.kind === "release" ? value.kind : null;
  const updateId = typeof value.updateId === "string" ? value.updateId.trim() : "";
  const targetVersion = typeof value.targetVersion === "string" ? value.targetVersion.trim() : "";
  const baselineSignature = typeof value.baselineSignature === "string" ? value.baselineSignature : "";
  const startedAtMs = Date.parse(String(value.startedAt || ""));
  const currentTime = Number(now);
  const ageMs = currentTime - startedAtMs;
  let parsedBaseline = null;
  try {
    parsedBaseline = JSON.parse(baselineSignature);
  } catch {
    parsedBaseline = null;
  }
  if (
    !kind
    || !baselineSignature
    || baselineSignature.length > 5_000
    || !Array.isArray(parsedBaseline)
    || parsedBaseline.length < 4
    || !Number.isFinite(currentTime)
    || !Number.isFinite(startedAtMs)
    || ageMs < -60_000
    || ageMs > maximumAgeMs
    || (kind === "local-source" && !updateId)
    || (kind === "release" && !targetVersion)
  ) return null;
  return {
    kind,
    updateId: updateId.slice(0, 200),
    targetVersion: targetVersion.slice(0, 200),
    baselineSignature,
    startedAt: new Date(startedAtMs).toISOString(),
    expired: Boolean(value.expired) || ageMs >= ACCEPTED_UPDATE_STATUS_TIMEOUT_MS,
  };
}

export function localUpdateStateLabel(state) {
  const normalized = normalizeUpdateState(state);
  if (["available", "ready"].includes(normalized)) return "Bereit zur Aktualisierung";
  if (["confirmation", "awaiting-confirmation", "armed"].includes(normalized)) {
    return "Bestätigung der neuen Version ausstehend";
  }
  if (["rollback-required", "rolled-back"].includes(normalized)) return "Alte Version wieder aktiv";
  if (["confirmation-failed", "failed-old-active"].includes(normalized)) {
    return "Bestätigung fehlgeschlagen – alte Version aktiv";
  }
  if (normalized === "rolling-back") return "Sichere Rückkehr läuft";
  if (BUSY_STATES.has(normalized)) return "Aktualisierung läuft";
  if (["already-installed", "completed"].includes(normalized)) return "Erfolgreich installiert";
  if (normalized === "multiple-packages") return "Mehrere Pakete gefunden";
  if (normalized === "recovery-required") return "Fortsetzung erforderlich";
  if (normalized === "id-collision") return "Paket-ID bereits verwendet";
  if (normalized === "invalid") return "Paket fehlerhaft";
  if (normalized === "failed") return "Aktualisierung fehlgeschlagen";
  return "Keine Aktualisierung verfügbar";
}

function normalizeReleaseChanges(value) {
  const entries = Array.isArray(value) ? value : [];
  return entries.flatMap((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ type: "Änderung", title: entry.trim(), detail: "", key: `change-${index}` }];
    }
    if (!entry || typeof entry !== "object") return [];
    const title = String(entry.title || entry.label || "").trim();
    const detail = String(entry.detail || entry.description || "").trim();
    if (!title && !detail) return [];
    return [{
      type: String(entry.type || "Änderung").trim(),
      title: title || "Technische Änderung",
      detail,
      key: entry.key || `change-${index}`,
    }];
  });
}

function localCoreReleaseText(value, { kontorUnchanged, packageVersion, technicalPackageVersion }) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (kontorUnchanged) {
    text = text
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => !/(?:Kontor\s*-?\s*App|KontorApp|Kontor-Bereich)/iu.test(sentence))
      .join(" ")
      .trim();
  }
  if (technicalPackageVersion && packageVersion) {
    text = text.split(technicalPackageVersion).join(packageVersion);
  }
  const build = String(technicalPackageVersion || "").match(/^(\d+\.\d+\.\d+)[+-]([A-Za-z][0-9A-Za-z.-]*)$/u);
  if (build) text = text.split(`${build[1]}.${build[2]}`).join(packageVersion);
  return text;
}

export function localUpdateReleaseNotes(localUpdate) {
  const notes = localUpdate?.releaseNotes || localUpdate?.changeSummary || null;
  const technicalPackageVersion = String(localUpdate?.to?.coreVersion || "").trim();
  const packageVersion = technicalPackageVersion
    ? formatBonniCoreVersion(technicalPackageVersion)
    : "";
  const kontorUnchanged = Boolean(
    localUpdate?.from?.kontorAppVersion
    && localUpdate?.to?.kontorAppVersion
    && localUpdate.from.kontorAppVersion === localUpdate.to.kontorAppVersion,
  );
  const releaseTextOptions = { kontorUnchanged, packageVersion, technicalPackageVersion };
  const suppliedChanges = normalizeReleaseChanges(notes?.changes || notes?.highlights)
    .filter((entry) => !kontorUnchanged || !/(?:Kontor\s*-?\s*App|KontorApp|Kontor-Bereich)/iu.test(`${entry.title} ${entry.detail}`))
    .map((entry) => ({
      ...entry,
      title: localCoreReleaseText(entry.title, releaseTextOptions),
      detail: localCoreReleaseText(entry.detail, releaseTextOptions),
    }));
  if (notes && (notes.title || notes.summary || suppliedChanges.length)) {
    return {
      title: packageVersion || notes.title || "Was ändert sich?",
      summary: localCoreReleaseText(notes.summary || notes.description, releaseTextOptions)
        || "Dieses Update enthält die folgenden Änderungen.",
      changes: suppliedChanges,
      supplied: true,
    };
  }

  const counts = localUpdate?.counts || {};
  const fileCount = Number(counts.files ?? counts.fileCount ?? 0) || 0;
  const inventoryCount = Number(counts.inventory ?? counts.inventoryCount ?? 0) || 0;
  const deleteCount = Number(counts.delete ?? counts.deletions ?? counts.deleteCount ?? 0) || 0;
  const components = Array.isArray(localUpdate?.components) ? localUpdate.components : [];
  const changes = components.length ? [{
    type: "Bereich",
    title: "Bonni Core",
    detail: "Die geprüften Programmdateien von Bonni Core werden als ein gemeinsames System aktualisiert.",
    key: "bonni-core",
  }] : [];
  changes.unshift({
    type: "Dateien",
    title: `${fileCount} ${fileCount === 1 ? "Datei wird" : "Dateien werden"} aktualisiert`,
    detail: inventoryCount
      ? `Bonni ersetzt nur geänderte Dateien. Der Index prüft dabei ${inventoryCount} verwaltete Dateien.`
      : "Bonni ersetzt nur die tatsächlich geänderten Programmdateien.",
    key: "files",
  });
  if (deleteCount) {
    changes.push({
      type: "Bereinigung",
      title: `${deleteCount} ${deleteCount === 1 ? "nicht mehr benötigte Datei wird" : "nicht mehr benötigte Dateien werden"} entfernt`,
      detail: "Entfernt werden ausschließlich die im geprüften Update-Index aufgeführten Dateien.",
      key: "deletions",
    });
  }
  return {
    title: packageVersion || "Was ändert sich?",
    summary: "Diese ältere Testaktualisierung enthält noch keine fachliche Versionsbeschreibung. Die betroffenen technischen Bereiche sind vollständig aufgeführt.",
    changes,
    supplied: false,
  };
}

const UPDATE_ERROR_CODE_PATTERN = /\b(?:SUPERVISOR|SOURCE_UPDATE|LOCAL_SOURCE|POSTGRESQL|BOOTSTRAP|CORE_UPDATE|START_REPAIR|INSTALLATION_MONITOR|UPDATE)_[A-Z0-9_]+\b/gu;
const UPDATE_ERROR_CODE_FIELDS = new Map([
  ["supervisorErrorCode", -2],
  ["errorCode", 0],
  ["code", 0],
  ["causeCode", 2],
  ["rootCauseCode", 3],
]);
const UPDATE_ERROR_BRANCH_FIELDS = new Set([
  "error",
  "errors",
  "cause",
  "details",
  "diagnostic",
  "failure",
  "result",
]);

function cleanErrorText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorPathDepth(path) {
  return path.reduce((depth, key) => depth + (UPDATE_ERROR_BRANCH_FIELDS.has(key) ? 2 : 1), 0);
}

function isTechnicalErrorPath(path) {
  const field = path.at(-1) || "message";
  if (path.some((key) => UPDATE_ERROR_BRANCH_FIELDS.has(key))) return true;
  if ([
    "technicalMessage",
    "technicalDetail",
    "technicalDetails",
    "errorDetail",
    "diagnosticLog",
    "stderr",
    "stdout",
    "reason",
    "error",
  ].includes(field)) return true;
  return ["message", "detail"].includes(field) && path.length <= 2;
}

function updateErrorEvidence(localUpdate, actionError) {
  const codeEvidence = [];
  const technicalEvidence = [];
  const phaseEvidence = [];
  const stageEvidence = [];
  const visited = new Set();
  let visitCount = 0;

  function addCode(code, path, semanticDepth, order) {
    const normalized = cleanErrorText(code).toUpperCase();
    if (!normalized || !/^[A-Z][A-Z0-9_]+$/u.test(normalized)) return;
    codeEvidence.push({ code: normalized, path: path.join("."), semanticDepth, order });
  }

  function addTechnical(value, path, order) {
    const text = cleanErrorText(value);
    if (!text) return;
    technicalEvidence.push({ text, path: path.join("."), order });
    for (const match of text.matchAll(UPDATE_ERROR_CODE_PATTERN)) {
      addCode(match[0], path, errorPathDepth(path) + 1, order + (match.index || 0) / 10_000);
    }
  }

  function visit(value, path = [], depth = 0, sourceOrder = 0) {
    if (depth > 8 || visitCount >= 400 || value == null) return;
    visitCount += 1;
    if (typeof value === "string") {
      if (isTechnicalErrorPath(path)) {
        addTechnical(value, path, sourceOrder + visitCount / 10_000);
      }
      return;
    }
    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [rawKey, child] of entries) {
      const key = String(rawKey);
      const childPath = [...path, key];
      const semanticDepth = errorPathDepth(path) + (UPDATE_ERROR_CODE_FIELDS.get(key) ?? 0);
      const order = sourceOrder + visitCount / 10_000;
      if (UPDATE_ERROR_CODE_FIELDS.has(key) && typeof child === "string") {
        addCode(child, childPath, semanticDepth, order);
      }
      if (["phase", "failedPhase"].includes(key) && typeof child === "string" && child.trim()) {
        phaseEvidence.push({
          value: child.trim(),
          semanticDepth: semanticDepth + (key === "failedPhase" ? 2 : 0),
          order,
        });
      }
      if (["stage", "failedStage", "step", "currentStage"].includes(key) && typeof child === "string" && child.trim()) {
        stageEvidence.push({
          value: child.trim(),
          semanticDepth: semanticDepth + (key === "failedStage" ? 2 : 0),
          order,
        });
      }
      if (
        ["exitCode", "statusCode", "signal"].includes(key)
        && ["string", "number", "boolean"].includes(typeof child)
      ) {
        addTechnical(String(child), childPath, order);
      }
      if (
        ["string", "number", "boolean"].includes(typeof child)
        && childPath.some((entry) => UPDATE_ERROR_BRANCH_FIELDS.has(entry))
        && typeof child !== "string"
      ) {
        addTechnical(String(child), childPath, order);
      }
      visit(child, childPath, depth + 1, sourceOrder);
    }
  }

  if (localUpdate && typeof localUpdate === "object") visit(localUpdate, [], 0, 0);
  else if (typeof localUpdate === "string") addTechnical(localUpdate, ["message"], 0);
  if (actionError && typeof actionError === "object") visit(actionError, ["action"], 0, 10_000);
  else if (typeof actionError === "string") addTechnical(actionError, ["action", "message"], 10_000);

  const codesByName = new Map();
  for (const evidence of codeEvidence) {
    const existing = codesByName.get(evidence.code);
    if (!existing || evidence.semanticDepth > existing.semanticDepth) codesByName.set(evidence.code, evidence);
  }
  const orderedCodes = [...codesByName.values()].sort((left, right) => (
    left.semanticDepth - right.semanticDepth || left.order - right.order
  ));
  const deepestCode = orderedCodes.at(-1)?.code || null;
  const outerCode = orderedCodes.find((entry) => entry.code !== deepestCode)?.code || null;

  const technicalByText = new Map();
  for (const evidence of technicalEvidence.sort((left, right) => left.order - right.order)) {
    if (!technicalByText.has(evidence.text)) technicalByText.set(evidence.text, evidence);
  }
  const distinctTechnical = [...technicalByText.values()];
  const technical = distinctTechnical.length <= 1
    ? distinctTechnical[0]?.text || ""
    : distinctTechnical.map((entry) => `${entry.path || "detail"}: ${entry.text}`).join("\n");
  const deepestPhase = phaseEvidence.sort((left, right) => (
    left.semanticDepth - right.semanticDepth || left.order - right.order
  )).at(-1)?.value || "";
  const deepestStage = stageEvidence.sort((left, right) => (
    left.semanticDepth - right.semanticDepth || left.order - right.order
  )).at(-1)?.value || "";

  return {
    code: deepestCode,
    outerCode,
    codeChain: orderedCodes.map((entry) => entry.code),
    phase: deepestPhase,
    stage: deepestStage,
    technical,
  };
}

function errorPresentation(base, presentation = {}) {
  const codeChain = Array.isArray(base.codeChain) ? base.codeChain : [];
  const signature = JSON.stringify([
    base.code || "NO_CODE",
    codeChain,
    base.phase || "",
    base.stage || "",
    base.technical || "",
  ]);
  return {
    ...base,
    signature,
    title: presentation.title || base.title || "Aktualisierung konnte nicht abgeschlossen werden",
    explanation: presentation.explanation
      || base.explanation
      || "Bonni hat den Vorgang sicher angehalten. Fehlercode, Phase, Stufe und die vollständigen technischen Details bleiben sichtbar und können gemeinsam kopiert werden.",
    technical: base.technical || base.code || "",
  };
}

function updateErrorRichness(error) {
  if (!error) return -1;
  const chain = Array.isArray(error.codeChain) ? error.codeChain : [];
  const wrapperOnly = error.code === "SUPERVISOR_UPDATE_PROCESS_FAILED";
  return (chain.length * 10_000)
    + (error.outerCode ? 5_000 : 0)
    + (!wrapperOnly && error.code ? 3_000 : 0)
    + (error.phase ? 1_000 : 0)
    + (error.stage ? 1_000 : 0)
    + Math.min(String(error.technical || "").length, 2_000);
}

export function preferDetailedUpdateError(previous, next) {
  if (!previous) return next || null;
  if (!next) return previous;
  return updateErrorRichness(next) >= updateErrorRichness(previous) ? next : previous;
}

export function localUpdateError(localUpdate, actionError = "") {
  const evidence = updateErrorEvidence(localUpdate, actionError);
  const { code } = evidence;
  const rawMessage = evidence.technical;
  if (!rawMessage && !code) return null;

  const pgDumpMissing = code === "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED"
    || /(?:pg_dump[^\n]*(?:ENOENT|nicht gefunden|not found)|(?:ENOENT|nicht gefunden|not found)[^\n]*pg_dump)/iu.test(rawMessage);
  if (pgDumpMissing) {
    return errorPresentation({
      ...evidence,
      code: code || "LOCAL_SOURCE_BACKUP_FAILED",
      title: "Sicherung konnte nicht erstellt werden",
      explanation: "Das PostgreSQL-Sicherungsprogramm „pg_dump“ wurde nicht gefunden. Bonni hat die Aktualisierung deshalb sicher abgebrochen; es wurden noch keine Programmdateien ersetzt.",
    });
  }

  if (code === "POSTGRESQL_TOOL_CONFIG_INVALID") {
    return errorPresentation(evidence, {
      title: "Pfad zu pg_dump ist ungültig",
      explanation: "Der konfigurierte PG_DUMP_PATH verweist nicht auf ein gültiges PostgreSQL-Sicherungsprogramm. Bonni hat vor jeder Dateiänderung sicher abgebrochen.",
    });
  }

  if (code === "POSTGRESQL_TOOL_NOT_EXECUTABLE") {
    return errorPresentation(evidence, {
      title: "pg_dump kann nicht ausgeführt werden",
      explanation: "Das gefundene PostgreSQL-Sicherungsprogramm besitzt keine ausreichende Ausführungsberechtigung oder kann vom Update-Dienst nicht gestartet werden. Bonni hat noch keine Programmdateien ersetzt.",
    });
  }

  if (code === "LOCAL_SOURCE_BACKUP_FAILED") {
    return errorPresentation(evidence, {
      title: "Sicherung konnte nicht erstellt werden",
      explanation: "Bonni konnte die vorgeschriebene Sicherung nicht vollständig erstellen und hat die Aktualisierung deshalb sicher abgebrochen. Es wurden noch keine Programmdateien ersetzt.",
    });
  }

  if (code === "LOCAL_SOURCE_REQUIRED_PREDECESSOR_MISSING") {
    const requirement = localUpdate?.requiredPredecessor || {};
    const requiredUpdateId = String(requirement.updateId || "").trim();
    const number = requiredUpdateId.match(/(?:^|-)([0-9]{2})$/u)?.[1];
    const requiredUpdateLabel = number ? `Update ${number}` : "Erforderliche Zwischenaktualisierung";
    const requiredCoreVersion = requirement.coreVersion
      ? formatBonniCoreVersion(requirement.coreVersion)
      : "";
    const targetCoreVersion = localUpdate?.to?.coreVersion
      ? formatBonniCoreVersion(localUpdate.to.coreVersion)
      : "";
    const requiredStand = requiredCoreVersion ? `Bonni Core ${requiredCoreVersion}` : "der erforderliche Bonni-Core-Zwischenstand";
    const target = targetCoreVersion ? ` vor Bonni Core ${targetCoreVersion}` : "";
    const requirementDetails = [
      rawMessage,
      requiredUpdateId ? `Benötigt: ${requiredUpdateLabel} (${requiredUpdateId})` : "",
      requiredCoreVersion ? `Erforderlicher Zwischenstand: Bonni Core ${requiredCoreVersion}` : "",
    ].filter(Boolean).join("\n");
    return errorPresentation({
      ...evidence,
      technical: requirementDetails || code,
    }, {
      title: `${requiredUpdateLabel} fehlt`,
      explanation: `${requiredUpdateLabel} mit ${requiredStand} muss${target} vollständig abgeschlossen sein. Das Folgepaket kann erst danach sicher installiert werden.`,
    });
  }

  if (code === "SOURCE_UPDATE_LOCAL_MODIFICATION_CONFLICT") {
    return errorPresentation(evidence, {
      title: "Lokale Änderung blockiert das Update",
      explanation: "Eine vom Update verwaltete Programmdatei wurde lokal verändert. Bonni hat den Vorgang vor dem Überschreiben angehalten; die betroffene Datei steht in den technischen Details.",
    });
  }

  if (code === "SOURCE_UPDATE_MULTIPLE_PACKAGES") {
    return errorPresentation(evidence, {
      title: "Mehrere Updatepakete gefunden",
      explanation: "Im UPDATE-Ordner liegt mehr als ein passendes Paket. Bonni startet erst, wenn genau ein eindeutig geprüftes Bonni-Core-Paket ausgewählt werden kann.",
    });
  }

  if (code === "SOURCE_UPDATE_PACKAGE_LOCATION_INVALID") {
    return errorPresentation(evidence, {
      title: "Updatepaket liegt am falschen Ort",
      explanation: "Das Paket wurde außerhalb des vorgesehenen UPDATE-Ordners erkannt. Bonni hat es deshalb nicht ausgeführt.",
    });
  }

  if (code?.startsWith("SOURCE_UPDATE_START_OVERLAY_")) {
    return errorPresentation(evidence, {
      title: "Startautomatik konnte nicht vorbereitet werden",
      explanation: "Die sichere Startreparatur konnte im neuen Bonni-Core-Stand nicht vollständig vorbereitet oder geprüft werden. Der aktive Stand wurde nicht unkontrolliert ersetzt.",
    });
  }

  if (code === "SUPERVISOR_UPDATE_PROCESS_FAILED") {
    return errorPresentation(evidence, {
      title: "Installationsprozess wurde beendet",
      explanation: "Der Installationsserver hat einen untergeordneten Aktualisierungsschritt mit Fehler beendet. Phase, Stufe und vollständige Ausgabe unten zeigen, an welcher Stelle der Vorgang angehalten wurde.",
    });
  }

  if (code?.startsWith("SOURCE_UPDATE_")) {
    return errorPresentation(evidence, {
      title: "Bonni-Core-Paket konnte nicht verarbeitet werden",
      explanation: "Ein geprüfter Schritt des Bonni-Core-Updates ist fehlgeschlagen. Bonni hat den Vorgang sicher angehalten; der tiefste Fehlercode und die vollständige technische Ausgabe bleiben erhalten.",
    });
  }

  return errorPresentation(evidence);
}

export function updateStepSymbol(status) {
  if (status === "completed") return "✓";
  if (status === "running") return "●";
  if (status === "failed") return "×";
  if (status === "waiting") return "◌";
  return "○";
}

export function formatUpdateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
