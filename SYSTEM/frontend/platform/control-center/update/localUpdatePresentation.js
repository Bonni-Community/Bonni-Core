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
]);

export const UPDATE_ACTION_ERROR_STORAGE_KEY = "bonni.core-update.last-action-error";
export const ACCEPTED_UPDATE_STATUS_TIMEOUT_MS = 60_000;
export const ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS = 5 * 60_000;

export function formatBonniCoreVersion(value) {
  const version = String(value || "").trim();
  if (!version) return "—";
  return version;
}

const LOCAL_SOURCE_STEP_LABELS = Object.freeze({
  validate: "Neue Pakete werden geprüft",
  handoff: "Installationsdienst übernimmt",
  stop: "Wechsel wird vorbereitet",
  install: "Aktualisierung wird durchgeführt",
  restart: "Bonni Core wird neu gestartet",
  health: "Funktionstest – Bonni Core wird geprüft",
  return: "Aktualisierung wird abgeschlossen",
  rollback: "Fehler erkannt – bisheriger Stand wird wiederhergestellt",
  "rolling-back": "Fehler erkannt – bisheriger Stand wird wiederhergestellt",
});

const SIGNED_RELEASE_STEP_LABELS = Object.freeze({
  candidate: "Isolierten Candidate mit Testkopie vorbereiten",
  "candidate-prepare": "Isolierten Candidate mit Testkopie vorbereiten",
  "candidate-start": "Isolierten Candidate mit Testkopie vorbereiten",
  health: "Isolierten Candidate vollständig prüfen",
  "candidate-health": "Isolierten Candidate vollständig prüfen",
  switch: "Kontrollierter Wechsel auf den geprüften Stand",
  cutover: "Kontrollierter Wechsel auf den geprüften Stand",
  "controlled-switch": "Kontrollierter Wechsel auf den geprüften Stand",
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
    causeCode: data?.causeCode || nested?.causeCode || data?.details?.causeCode || null,
    technicalMessage: data?.technicalMessage
      || nested?.technicalMessage
      || data?.details?.technicalMessage
      || error?.cause?.message
      || "",
    updateId: String(updateId || "current"),
    createdAt: new Date().toISOString(),
  };
}

export function normalizeUpdateState(value, fallback = "none") {
  return String(value || fallback).trim().toLowerCase();
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
  if (normalized === "rolling-back") return "Sichere Rückkehr läuft";
  if (BUSY_STATES.has(normalized)) return "Aktualisierung läuft";
  if (["already-installed", "completed"].includes(normalized)) return "Erfolgreich installiert";
  if (normalized === "rolled-back") return "Auf vorherigen Stand zurückgesetzt";
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

function localCoreReleaseText(value, { kontorUnchanged, packageVersion }) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (kontorUnchanged) {
    text = text
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => !/(?:Kontor\s*-?\s*App|KontorApp|Kontor-Bereich)/iu.test(sentence))
      .join(" ")
      .trim();
  }
  const build = String(packageVersion || "").match(/^(\d+\.\d+\.\d+)[+-]([A-Za-z][0-9A-Za-z.-]*)$/u);
  if (build) text = text.split(`${build[1]}.${build[2]}`).join(packageVersion);
  return text;
}

export function localUpdateReleaseNotes(localUpdate) {
  const notes = localUpdate?.releaseNotes || localUpdate?.changeSummary || null;
  const packageVersion = localUpdate?.to?.coreVersion
    ? formatBonniCoreVersion(localUpdate.to.coreVersion)
    : "";
  const kontorUnchanged = Boolean(
    localUpdate?.from?.kontorAppVersion
    && localUpdate?.to?.kontorAppVersion
    && localUpdate.from.kontorAppVersion === localUpdate.to.kontorAppVersion,
  );
  const releaseTextOptions = { kontorUnchanged, packageVersion };
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

function errorCodeFrom(value) {
  return value?.errorCode || value?.code || value?.error?.code || null;
}

export function localUpdateError(localUpdate, actionError = "") {
  const progress = localUpdate?.progress || null;
  const progressError = typeof progress?.error === "string"
    ? progress.error
    : progress?.error?.message || "";
  const actionMessage = typeof actionError === "string"
    ? actionError
    : actionError?.message || "";
  const actionTechnical = typeof actionError === "object"
    ? actionError?.technicalMessage || actionError?.detail || ""
    : "";
  const rawMessage = String(actionTechnical || actionMessage || progressError || localUpdate?.error || localUpdate?.message || "").trim();
  const code = (typeof actionError === "object" ? actionError?.causeCode || actionError?.code : null)
    || errorCodeFrom(localUpdate)
    || errorCodeFrom(progress)
    || null;
  if (!rawMessage && !code) return null;

  const signature = `${code || "NO_CODE"}:${rawMessage}`;
  const pgDumpMissing = code === "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED"
    || /(?:pg_dump[^\n]*(?:ENOENT|nicht gefunden|not found)|(?:ENOENT|nicht gefunden|not found)[^\n]*pg_dump)/iu.test(rawMessage);
  if (pgDumpMissing) {
    return {
      signature,
      code: code || "LOCAL_SOURCE_BACKUP_FAILED",
      title: "Sicherung konnte nicht erstellt werden",
      explanation: "Das PostgreSQL-Sicherungsprogramm „pg_dump“ wurde nicht gefunden. Bonni hat die Aktualisierung deshalb sicher abgebrochen; es wurden noch keine Programmdateien ersetzt.",
      technical: rawMessage,
    };
  }

  if (code === "POSTGRESQL_TOOL_CONFIG_INVALID") {
    return {
      signature,
      code,
      title: "Pfad zu pg_dump ist ungültig",
      explanation: "Der konfigurierte PG_DUMP_PATH verweist nicht auf ein gültiges PostgreSQL-Sicherungsprogramm. Bonni hat vor jeder Dateiänderung sicher abgebrochen.",
      technical: rawMessage,
    };
  }

  if (code === "POSTGRESQL_TOOL_NOT_EXECUTABLE") {
    return {
      signature,
      code,
      title: "pg_dump kann nicht ausgeführt werden",
      explanation: "Das gefundene PostgreSQL-Sicherungsprogramm besitzt keine ausreichende Ausführungsberechtigung oder kann vom Update-Dienst nicht gestartet werden. Bonni hat noch keine Programmdateien ersetzt.",
      technical: rawMessage,
    };
  }

  if (code === "LOCAL_SOURCE_BACKUP_FAILED") {
    return {
      signature,
      code,
      title: "Sicherung konnte nicht erstellt werden",
      explanation: "Bonni konnte die vorgeschriebene Sicherung nicht vollständig erstellen und hat die Aktualisierung deshalb sicher abgebrochen. Es wurden noch keine Programmdateien ersetzt.",
      technical: rawMessage,
    };
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
    return {
      signature,
      code,
      title: `${requiredUpdateLabel} fehlt`,
      explanation: `${requiredUpdateLabel} mit ${requiredStand} muss${target} vollständig abgeschlossen sein. Das Folgepaket kann erst danach sicher installiert werden.`,
      technical: requirementDetails || code,
    };
  }

  return {
    signature,
    code,
    title: "Aktualisierung konnte nicht abgeschlossen werden",
    explanation: "Bonni hat den Vorgang angehalten. Die technischen Details bleiben sichtbar, bis du sie schließt oder die Aktualisierung erneut startest.",
    technical: rawMessage || code,
  };
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
