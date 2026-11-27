import { useEffect, useMemo, useRef, useState } from "react";

import {
  checkCoreUpdate,
  checkLocalSourceUpdate,
  fetchCoreUpdateStatus,
  finalizeCoreDeploymentLifecycle,
  installCoreUpdate,
  installLocalSourceUpdate,
  rollbackCoreDeploymentLifecycle,
} from "../../../system/api/coreUpdateApi.js";
import {
  ACCEPTED_UPDATE_STATUS_TIMEOUT_MS,
  ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS,
  deploymentLifecycleInstallationBlock,
  formatBonniCoreVersion,
  formatUpdateTime,
  hasAcceptedUpdateStatusTimedOut,
  hasObservedAcceptedUpdate,
  isUpdateBusy,
  isUpdateFailed,
  localUpdateError,
  localUpdateReleaseNotes,
  localUpdateStateLabel,
  normalizeAcceptedUpdateTransition,
  normalizeDeploymentLifecycle,
  normalizeFiveStepProgress,
  normalizeUpdateConfirmation,
  normalizeUpdateActionError,
  normalizeUpdateState,
  normalizeUpdateSteps,
  preferDetailedUpdateError,
  UPDATE_ACTION_ERROR_STORAGE_KEY,
  updateExecutionObservation,
  updateStepSymbol,
} from "./localUpdatePresentation.js";
import {
  confirmInstallationUpdate,
  fetchInstallationUpdateStatus,
  INSTALLATION_MONITOR_ACCESS_STORAGE_KEY,
  installationMonitorRequestsCoreSwitch,
  mergeInstallationMonitorStatus,
  normalizeInstallationMonitorAccess,
  retryInstallationUpdateCutover,
} from "./localUpdateMonitorApi.js";
import DeploymentLifecyclePanel from "./DeploymentLifecyclePanel.jsx";
import CoreReleaseOverview from "./CoreReleaseOverview.jsx";
import "./CoreUpdatePage.css";

const POLL_INTERVAL_MS = 2_500;
const MAX_TIMELINE_ENTRIES = 60;
const ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY = "bonni.core-update.accepted-transition";
const ACCEPTED_UPDATE_TIMEOUT_WARNING = "Der Installationsauftrag wurde angenommen, aber innerhalb einer Minute wurde kein neuer Update-Status gemeldet. Der zuletzt gemeldete Zustand bleibt sichtbar; bitte prüfe die Verbindung oder den Update-Dienst.";
const ACCEPTED_UPDATE_TIMEOUT_CONNECTION = "Der Installationsauftrag wurde angenommen, aber Bonni Core meldet weiterhin keinen neuen Status.";
const UPDATE_PAGE_TABS = Object.freeze([
  { key: "update", label: "Update" },
  { key: "status", label: "Status" },
  { key: "history", label: "Historie" },
]);

function storageKey(updateId) {
  return `bonni.local-update.timeline:${updateId || "current"}`;
}

function dismissedErrorKey(updateId) {
  return `bonni.local-update.dismissed-error:${updateId || "current"}`;
}

function actionErrorKey(updateId) {
  return `bonni.local-update.action-error:${updateId || "current"}`;
}

function reportedErrorKey(updateId) {
  return `bonni.local-update.reported-error:${updateId || "current"}`;
}

function readSessionValue(key, fallback) {
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key, value) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Die Ansicht funktioniert auch dann, wenn Sitzungsspeicher gesperrt ist.
  }
}

function removeSessionValue(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Die Ansicht funktioniert auch dann, wenn Sitzungsspeicher gesperrt ist.
  }
}

function readAcceptedInstallTransition() {
  const stored = readSessionValue(ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY, null);
  const normalized = normalizeAcceptedUpdateTransition(stored);
  if (!normalized && stored) removeSessionValue(ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY);
  return normalized;
}

function readInstallationMonitorAccess() {
  const stored = readSessionValue(INSTALLATION_MONITOR_ACCESS_STORAGE_KEY, null);
  const normalized = normalizeInstallationMonitorAccess(stored);
  if (!normalized && stored) removeSessionValue(INSTALLATION_MONITOR_ACCESS_STORAGE_KEY);
  return normalized;
}

function appendUniqueEvents(previous, additions) {
  const signatures = new Set(previous.map((event) => event.signature));
  const next = [...previous];
  let changed = false;
  for (const event of additions) {
    if (!event?.signature || signatures.has(event.signature)) continue;
    signatures.add(event.signature);
    next.push(event);
    changed = true;
  }
  return changed ? next.slice(-MAX_TIMELINE_ENTRIES) : previous;
}

function statusKind(state) {
  if (["completed", "already-installed"].includes(state)) return "success";
  if (isUpdateFailed(state)) return "error";
  if (isUpdateBusy(state)) return "running";
  return "info";
}

function releaseNotesForStatus(status, localUpdate) {
  if (localUpdate) return localUpdateReleaseNotes(localUpdate);
  const releaseNotes = status?.manifest?.releaseNotes || {};
  const rawChanges = releaseNotes.changes || releaseNotes.highlights || [];
  return {
    title: releaseNotes.title || "Was ändert sich?",
    summary: releaseNotes.summary
      || releaseNotes.descriptions?.de
      || releaseNotes.descriptions?.en
      || "Diese Version aktualisiert Bonni Core auf den angezeigten Stand.",
    changes: rawChanges.map((entry, index) => typeof entry === "string"
      ? { key: `release-${index}`, type: "Änderung", title: entry, detail: "" }
      : {
          key: entry?.key || `release-${index}`,
          type: entry?.type || "Änderung",
          title: entry?.title || entry?.label || "Technische Änderung",
          detail: entry?.detail || entry?.description || "",
        }),
    supplied: Boolean(releaseNotes.title || releaseNotes.summary || rawChanges.length),
  };
}

function FiveStepProgress({ steps }) {
  return (
    <ol className="cc-update-page-steps cc-update-page-five-steps" aria-label="Update-Fortschritt in fünf Phasen">
      {steps.map((step) => (
        <li key={step.key} className={`is-${step.status}`}>
          <span aria-hidden="true">{step.status === "completed" ? updateStepSymbol(step.status) : step.number}</span>
          <div>
            <strong>{step.label}</strong>
            {step.detail ? <p>{step.detail}</p> : null}
            {step.rollbackDetail ? <p className="cc-update-page-rollback-detail">{step.rollbackDetail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function CoreUpdatePage({ token, onBack }) {
  const restoredAcceptedStart = useMemo(() => readAcceptedInstallTransition(), []);
  const restoredMonitorAccess = useMemo(() => readInstallationMonitorAccess(), []);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [actionError, setActionError] = useState(() => readSessionValue(UPDATE_ACTION_ERROR_STORAGE_KEY, null));
  const [reportedError, setReportedError] = useState(null);
  const [connectionWarning, setConnectionWarning] = useState(
    restoredAcceptedStart?.expired ? ACCEPTED_UPDATE_TIMEOUT_CONNECTION : "",
  );
  const [timeline, setTimeline] = useState([]);
  const [timelineUpdateId, setTimelineUpdateId] = useState("");
  const [dismissedError, setDismissedError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFallbackText, setCopyFallbackText] = useState("");
  const [optimisticStart, setOptimisticStart] = useState(restoredAcceptedStart);
  const [startTransitionWarning, setStartTransitionWarning] = useState(
    restoredAcceptedStart?.expired ? ACCEPTED_UPDATE_TIMEOUT_WARNING : "",
  );
  const [monitorAccess, setMonitorAccess] = useState(restoredMonitorAccess);
  const [statusSource, setStatusSource] = useState(restoredMonitorAccess ? "installation" : "core");
  const [lifecycleFinalizing, setLifecycleFinalizing] = useState(false);
  const [lifecycleRollingBack, setLifecycleRollingBack] = useState(false);
  const [confirmLifecycleFinalize, setConfirmLifecycleFinalize] = useState(false);
  const [confirmLifecycleRollback, setConfirmLifecycleRollback] = useState(false);
  const [lifecycleActionError, setLifecycleActionError] = useState("");
  const [acknowledgedLifecycleHold, setAcknowledgedLifecycleHold] = useState("");
  const [activeTab, setActiveTab] = useState("update");
  const [confirmationClock, setConfirmationClock] = useState(() => Date.now());
  const [confirmingVersion, setConfirmingVersion] = useState(false);
  const [retryingCutover, setRetryingCutover] = useState(false);
  const [confirmationActionError, setConfirmationActionError] = useState("");
  const [monitorReclaimAttempt, setMonitorReclaimAttempt] = useState(0);
  const mountedRef = useRef(true);
  const statusRef = useRef(null);
  const statusSequenceRef = useRef(0);
  const statusInFlightRef = useRef(0);
  const confirmationPrimaryRef = useRef(null);
  const startButtonRef = useRef(null);
  const confirmationDialogRef = useRef(null);
  const confirmationWasOpenRef = useRef(false);
  const optimisticStartRef = useRef(restoredAcceptedStart);
  const monitorAccessRef = useRef(restoredMonitorAccess);
  const monitorReclaimKeyRef = useRef("");
  const monitorReclaimInFlightRef = useRef(false);
  const frontendReloadScheduledRef = useRef(false);
  const defaultedLifecycleHoldRef = useRef("");

  function setAcceptedInstallTransition(value) {
    optimisticStartRef.current = value;
    setOptimisticStart(value);
    if (value) writeSessionValue(ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY, value);
    else removeSessionValue(ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY);
  }

  function setInstallationMonitorAccess(value) {
    const normalized = value ? normalizeInstallationMonitorAccess(value) : null;
    monitorAccessRef.current = normalized;
    setMonitorAccess(normalized);
    if (normalized) writeSessionValue(INSTALLATION_MONITOR_ACCESS_STORAGE_KEY, normalized);
    else removeSessionValue(INSTALLATION_MONITOR_ACCESS_STORAGE_KEY);
  }

  function commitStatus(payload, source) {
    statusRef.current = payload;
    setStatus(payload);
    setStatusSource(source);
  }

  function scheduleUpdatedFrontendReload() {
    if (frontendReloadScheduledRef.current) return;
    frontendReloadScheduledRef.current = true;
    window.setTimeout(() => window.location.reload(), 0);
  }

  async function loadStatus({ scan = false, initial = false, poll = false } = {}) {
    if (!token) return { ok: false, error: new Error("Keine aktive Sitzung.") };
    if (poll && statusInFlightRef.current > 0) return { ok: false, skipped: true };
    const sequence = ++statusSequenceRef.current;
    statusInFlightRef.current += 1;
    if (initial) setLoading(true);
    let monitorError = null;
    try {
      const monitor = monitorAccessRef.current;
      if (monitor) {
        try {
          const monitorPayload = await fetchInstallationUpdateStatus(monitor);
          if (!mountedRef.current || sequence !== statusSequenceRef.current) return { ok: false, stale: true };
          const monitoredStatus = mergeInstallationMonitorStatus(statusRef.current, monitorPayload);
          commitStatus(monitoredStatus, "installation");
          setConnectionWarning("");
          const acceptedStart = optimisticStartRef.current;
          if (hasObservedAcceptedUpdate(monitoredStatus, acceptedStart)) {
            setAcceptedInstallTransition(null);
            setStartTransitionWarning("");
          }

          const shouldReturnToCore = installationMonitorRequestsCoreSwitch(monitorPayload);
          if (!shouldReturnToCore) return { ok: true, payload: monitoredStatus, source: "installation" };

          try {
            const corePayload = await fetchCoreUpdateStatus(token);
            if (!mountedRef.current || sequence !== statusSequenceRef.current) return { ok: false, stale: true };
            commitStatus(corePayload, "core");
            setInstallationMonitorAccess(null);
            setAcceptedInstallTransition(null);
            setStartTransitionWarning("");
            setConnectionWarning("");
            scheduleUpdatedFrontendReload();
            return { ok: true, payload: corePayload, source: "core" };
          } catch {
            setConnectionWarning(monitorPayload.progress?.status === "failed"
              ? "Der Installationsserver bleibt erreichbar. Bonni Core konnte noch nicht wieder übernommen werden."
              : "Bonni Core wird geprüft. Danach wechselt die Aktualisierungsseite automatisch zurück.");
            return { ok: true, payload: monitoredStatus, source: "installation" };
          }
        } catch (error) {
          monitorError = error;
          if (error?.message === "INSTALLATION_MONITOR_ACCESS_INVALID") {
            setInstallationMonitorAccess(null);
          } else {
            // Solange der begrenzte Monitorzugang gueltig ist, bleibt der
            // Installationsserver die verbindliche Statusquelle. Ein noch
            // antwortender alter Core-Stand darf den Fortschritt nicht
            // kurzzeitig ueberschreiben.
            throw error;
          }
        }
      }

      if (scan && !monitorAccessRef.current) await checkLocalSourceUpdate(token).catch(() => null);
      const payload = await fetchCoreUpdateStatus(token);
      if (!mountedRef.current || sequence !== statusSequenceRef.current) return { ok: false, stale: true };
      const acceptedStart = optimisticStartRef.current;
      if (hasObservedAcceptedUpdate(payload, acceptedStart)) {
        setAcceptedInstallTransition(null);
        setStartTransitionWarning("");
        setConnectionWarning("");
      } else if (acceptedStart?.expired) {
        // Ein erfolgreicher, aber unveränderter Status ist noch kein Beweis,
        // dass der zuvor angenommene Auftrag nicht mehr in der Queue liegt.
        // Erst ein neuer Ausführungsstatus oder die explizite Prüfung unten
        // darf einen erneuten Installationsstart freigeben.
        setConnectionWarning(ACCEPTED_UPDATE_TIMEOUT_CONNECTION);
      } else {
        setConnectionWarning("");
      }
      commitStatus(payload, "core");
      return { ok: true, payload, source: "core" };
    } catch (error) {
      if (mountedRef.current && sequence === statusSequenceRef.current) {
        const acceptedStart = optimisticStartRef.current;
        setConnectionWarning(monitorAccessRef.current
          ? "Der Installationsserver wird erneut verbunden. Der aktuelle Fortschritt bleibt erhalten."
          : acceptedStart
            ? acceptedStart.expired
              ? ACCEPTED_UPDATE_TIMEOUT_CONNECTION
              : acceptedStart.kind === "release"
                ? "Der isolierte Candidate wird vorbereitet. Der aktive Stand bleibt erreichbar …"
                : "Der Installationsserver übernimmt. Die Fortschrittsverbindung wird automatisch hergestellt …"
            : monitorError?.message || error?.message || "Die Verbindung zu Bonni Core wird wiederhergestellt …");
      }
      return { ok: false, error: monitorError || error };
    } finally {
      statusInFlightRef.current = Math.max(0, statusInFlightRef.current - 1);
      if (initial && mountedRef.current && sequence === statusSequenceRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    loadStatus({ scan: true, initial: true });
    const interval = window.setInterval(() => loadStatus({ poll: true }), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      statusSequenceRef.current += 1;
      window.clearInterval(interval);
    };
  }, [token]);

  useEffect(() => {
    if (!optimisticStart) return undefined;
    const startedAt = Date.parse(String(optimisticStart.startedAt || ""));
    const elapsed = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : ACCEPTED_UPDATE_STATUS_TIMEOUT_MS;
    let statusTimeout;
    if (!optimisticStart.expired) {
      const remaining = Math.max(0, ACCEPTED_UPDATE_STATUS_TIMEOUT_MS - elapsed);
      statusTimeout = window.setTimeout(() => {
        const current = optimisticStartRef.current;
        if (
          !current
          || current.expired
          || current.startedAt !== optimisticStart.startedAt
          || !hasAcceptedUpdateStatusTimedOut(current)
        ) return;
        setAcceptedInstallTransition({ ...current, expired: true });
        setConnectionWarning(ACCEPTED_UPDATE_TIMEOUT_CONNECTION);
        setStartTransitionWarning(ACCEPTED_UPDATE_TIMEOUT_WARNING);
      }, remaining);
    }
    const storageRemaining = Math.max(0, ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS - elapsed);
    const storageTimeout = window.setTimeout(() => {
      if (optimisticStartRef.current?.startedAt === optimisticStart.startedAt) {
        removeSessionValue(ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY);
      }
    }, storageRemaining);
    return () => {
      if (statusTimeout) window.clearTimeout(statusTimeout);
      window.clearTimeout(storageTimeout);
    };
  }, [optimisticStart]);

  const localUpdate = status?.localSourceUpdate || null;
  const localProgress = localUpdate?.progress || null;
  const localState = normalizeUpdateState(localUpdate?.state);
  const progressState = normalizeUpdateState(localProgress?.status || localProgress?.phase, "idle");
  const displayState = !["none", "idle"].includes(progressState) ? progressState : localState;
  const localBusy = isUpdateBusy(localState, progressState);
  const localFailed = isUpdateFailed(localState, progressState);
  const localCompleted = !localFailed
    && (["completed", "already-installed"].includes(localState) || progressState === "completed");
  const localRelevant = Boolean(localUpdate && (
    localBusy
    || (
      status?.updateKind !== "release"
      && (
        status?.updateKind === "local-source"
        || localUpdate?.updateAvailable
        || localFailed
        || (!status?.updateKind && localCompleted)
      )
    )
  ));
  const deploymentLifecycle = useMemo(
    () => !status?.deploymentLifecycle
      ? null
      : normalizeDeploymentLifecycle(status.deploymentLifecycle, Date.now(), {
          currentVersion: status?.currentVersion,
        }),
    [status?.currentVersion, status?.deploymentLifecycle],
  );
  const workflowState = normalizeUpdateState(status?.workflow?.status, status?.updateAvailable ? "available" : "none");
  const optimisticRunning = Boolean(optimisticStart && !optimisticStart.expired);
  const observedBusy = localRelevant ? localBusy : isUpdateBusy(workflowState);
  const observedFailed = localRelevant ? localFailed : isUpdateFailed(workflowState);
  const observedCompleted = localRelevant ? localCompleted : workflowState === "completed";
  const pageState = optimisticRunning ? "running" : localRelevant ? displayState : workflowState;
  const executionBusy = optimisticRunning || observedBusy;
  const failed = !optimisticRunning && observedFailed;
  const completed = !optimisticRunning && observedCompleted;
  const localAvailable = Boolean(localUpdate?.updateAvailable)
    || ["available", "ready"].includes(localState);
  const releaseAvailable = Boolean(status?.updateAvailable && status?.updateKind !== "local-source");
  const updateAvailable = localRelevant ? localAvailable : releaseAvailable;
  const localRunnerUnavailable = Boolean(localRelevant && localAvailable && localUpdate?.runner?.available !== true);
  const localMonitorUnavailable = Boolean(
    localRelevant
    && localAvailable
    && localUpdate?.runner?.available === true
    && localUpdate?.runner?.monitor?.available !== true,
  );
  const lifecycleBlock = deploymentLifecycleInstallationBlock({
    lifecycle: deploymentLifecycle,
    localRelevant,
    updateAvailable,
    installation: status?.installation,
  });
  const localLifecycleBlocked = lifecycleBlock.localLifecycleBlocked;
  const connectionInstallationBlocked = Boolean(
    !optimisticRunning
    && (connectionWarning || startTransitionWarning),
  );
  const installationBlocked = !optimisticRunning && (
    connectionInstallationBlocked
    || localRunnerUnavailable
    || localMonitorUnavailable
    || lifecycleBlock.blocked
  );
  const installationBlockedReason = connectionInstallationBlocked
    ? monitorAccess && statusSource === "installation"
      ? "Der Installationsserver ist vorübergehend nicht erreichbar. Eine erneute Installation bleibt gesperrt, bis sein Status wieder bestätigt wurde."
      : "Der aktuelle Update-Status ist nicht erreichbar. Eine erneute Installation bleibt gesperrt, bis Bonni Core wieder erfolgreich antwortet."
    : localRunnerUnavailable
    ? localUpdate?.runner?.reason || "Der Update-Dienst ist nicht erreichbar."
    : localMonitorUnavailable
      ? "Der unabhängige Installationsserver ist noch nicht aktiv. Bitte Bonni Core einmal vollständig beenden und anschließend mit npm start neu starten."
    : lifecycleBlock.blocked
      ? lifecycleBlock.reason
      : "";
  const activeProgress = optimisticRunning
    ? {
        status: "running",
        message: "Der Installationsauftrag wurde angenommen. Die bestätigte Servermeldung wird abgerufen.",
        updatedAt: optimisticStart.startedAt,
        steps: [{
          key: "accepted-install",
          label: "Auftrag angenommen – Serverstatus wird geprüft",
          detail: "Der nächste Fortschritt wird erst angezeigt, sobald Core oder Installationsmonitor ihn bestätigt.",
          status: "running",
        }],
      }
    : localRelevant ? localProgress : status?.workflow;
  const updateConfirmation = normalizeUpdateConfirmation(activeProgress, confirmationClock);
  const confirmationActive = Boolean(updateConfirmation?.active);
  const confirmationRollbackRequired = Boolean(updateConfirmation?.rollbackRequired && !updateConfirmation?.terminalFailed);
  const confirmationTerminalFailed = Boolean(updateConfirmation?.terminalFailed);
  const confirmationVisible = confirmationActive || confirmationRollbackRequired || confirmationTerminalFailed;
  const busy = executionBusy && !confirmationVisible;
  const presentationState = confirmationActive
    ? "awaiting-confirmation"
    : confirmationTerminalFailed
      ? "confirmation-failed"
      : confirmationRollbackRequired
        ? "rollback-required"
        : pageState;
  const updateId = optimisticStart?.updateId || (localRelevant
    ? localUpdate?.updateId || "current"
    : status?.workflow?.id || status?.manifest?.id || status?.targetVersion || "current");
  const rawSteps = normalizeUpdateSteps(activeProgress, { kind: localRelevant ? "local-source" : "release" });
  const fiveStepPresentationProgress = activeProgress || (completed ? { status: pageState } : null);
  const fiveStepProgress = normalizeFiveStepProgress(fiveStepPresentationProgress, {
    kind: localRelevant ? "local-source" : "release",
    rawSteps,
    backup: status?.backup,
    updateId: localRelevant ? localUpdate?.updateId : "",
    manifestSha256: localRelevant ? localUpdate?.manifestSha256 : "",
  });
  const fiveSteps = fiveStepProgress.steps;
  const progressPercent = fiveStepProgress.percent;
  const progressActive = busy || fiveStepProgress.backupActive;
  const currentStep = rawSteps.find((step) => step.status === "running")
    || rawSteps.find((step) => step.status === "failed")
    || rawSteps.find((step) => step.status === "waiting")
    || (completed ? rawSteps.at(-1) : null);
  const currentFiveStep = fiveSteps.find((step) => step.status === "running")
    || fiveSteps.find((step) => step.status === "failed")
    || fiveSteps.find((step) => step.status === "waiting")
    || (completed ? fiveSteps.at(-1) : null);
  const currentStepLabel = currentStep?.label
    || currentFiveStep?.label
    || (completed ? "Bonni Core ist wieder einsatzbereit" : localUpdateStateLabel(pageState));
  const currentStepDetail = currentStep?.detail
    || currentFiveStep?.detail
    || currentFiveStep?.rollbackDetail
    || activeProgress?.message
    || (progressActive
      ? localRelevant
        ? "Der Installationsdienst meldet den nächsten Schritt automatisch."
        : "Der serverseitige Deployment-Lifecycle meldet den nächsten bestätigten Schritt automatisch."
      : "Nach dem Start wird der jeweils ausgeführte Schritt hier angezeigt.");
  const stepsSignature = JSON.stringify(rawSteps.map((step) => [step.key, step.status, step.detail]));
  const releaseNotes = useMemo(
    () => releaseNotesForStatus(status, localRelevant ? localUpdate : null),
    [status, localRelevant, localUpdate],
  );
  const stateNeedsError = localRelevant
    ? failed
    : failed || ["rolling-back", "rolled-back"].includes(workflowState) || Boolean(status?.workflow?.error);
  const stateError = stateNeedsError
    ? localRelevant
      ? localUpdateError(localUpdate)
      : localUpdateError({
          errorCode: status?.workflow?.errorCode,
          error: status?.workflow?.error,
          message: status?.workflow?.message,
          progress: status?.workflow,
        })
    : null;
  const scopedReportedError = reportedError?.updateId === updateId ? reportedError : null;
  const persistentStateError = preferDetailedUpdateError(
    scopedReportedError,
    stateError ? { ...stateError, updateId } : null,
  );
  const currentError = completed || installing || confirmationVisible
    ? null
    : actionError
      ? localUpdateError(localRelevant ? localUpdate : {}, actionError)
      : persistentStateError;
  const visibleError = currentError && currentError.signature !== dismissedError ? currentError : null;
  const canRetry = Boolean(updateAvailable && !progressActive && !installationBlocked);

  useEffect(() => {
    if (
      !token
      || !localRelevant
      || !localBusy
      || !localUpdate?.updateId
      || !localUpdate?.manifestSha256
      || monitorAccessRef.current
    ) return undefined;
    const reclaimKey = `${localUpdate.updateId}:${localUpdate.manifestSha256}`;
    if (
      monitorReclaimInFlightRef.current
      || monitorReclaimKeyRef.current === `${reclaimKey}:complete`
    ) return undefined;
    monitorReclaimKeyRef.current = reclaimKey;
    monitorReclaimInFlightRef.current = true;
    let cancelled = false;
    setInstalling(true);
    void installLocalSourceUpdate(token, {
      updateId: localUpdate.updateId,
      manifestSha256: localUpdate.manifestSha256,
    }).then((installation) => {
      if (cancelled || !mountedRef.current) return;
      const access = normalizeInstallationMonitorAccess(installation?.monitor);
      if (!access) throw new Error("Der sichere Fortschrittszugang konnte nicht wiederhergestellt werden.");
      setInstallationMonitorAccess(access);
      monitorReclaimKeyRef.current = `${reclaimKey}:complete`;
      setStatusSource("installation");
      setConnectionWarning("Der laufende Installationsauftrag wurde sicher mit dieser Browsersitzung verbunden.");
      clearActionError();
    }).catch((error) => {
      if (cancelled || !mountedRef.current) return;
      monitorReclaimKeyRef.current = "";
      persistActionError(normalizeUpdateActionError(
        error,
        "Der laufende Installationsauftrag kann nicht mit dieser Browsersitzung verbunden werden.",
        localUpdate.updateId,
      ));
      if (monitorReclaimAttempt < 20) {
        window.setTimeout(() => {
          if (mountedRef.current && !monitorAccessRef.current) {
            setMonitorReclaimAttempt((attempt) => attempt + 1);
          }
        }, 1_500);
      }
    }).finally(() => {
      monitorReclaimInFlightRef.current = false;
      if (!cancelled && mountedRef.current) setInstalling(false);
    });
    return () => { cancelled = true; };
  }, [
    localBusy,
    localRelevant,
    localUpdate?.manifestSha256,
    localUpdate?.updateId,
    monitorReclaimAttempt,
    token,
  ]);

  useEffect(() => {
    if (!confirmationActive) return undefined;
    setConfirmationClock(Date.now());
    const interval = window.setInterval(() => setConfirmationClock(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [confirmationActive, updateConfirmation?.deadlineAt]);

  useEffect(() => {
    if (!updateId || updateId === timelineUpdateId) return;
    setTimelineUpdateId(updateId);
    setTimeline(readSessionValue(storageKey(updateId), []));
    setDismissedError(readSessionValue(dismissedErrorKey(updateId), ""));
    setReportedError(readSessionValue(reportedErrorKey(updateId), null));
    const scopedError = readSessionValue(actionErrorKey(updateId), null);
    const sharedError = readSessionValue(UPDATE_ACTION_ERROR_STORAGE_KEY, null);
    const sharedApplies = sharedError && (
      !sharedError.updateId
      || sharedError.updateId === "current"
      || sharedError.updateId === updateId
    );
    setActionError(scopedError || (sharedApplies ? sharedError : null));
  }, [timelineUpdateId, updateId]);

  useEffect(() => {
    if (!updateId || timelineUpdateId !== updateId) return;
    if (completed) {
      setReportedError(null);
      removeSessionValue(reportedErrorKey(updateId));
      return;
    }
    if (!stateError) return;
    const nextError = { ...stateError, updateId };
    setReportedError((previous) => {
      const previousForUpdate = previous?.updateId === updateId ? previous : null;
      const preferred = preferDetailedUpdateError(previousForUpdate, nextError);
      if (preferred !== previousForUpdate) writeSessionValue(reportedErrorKey(updateId), preferred);
      return preferred;
    });
  }, [completed, stateError?.signature, timelineUpdateId, updateId]);

  useEffect(() => {
    if (!status || !updateId || timelineUpdateId !== updateId) return;
    if (!localRelevant && !status?.workflow && !status?.updateAvailable) return;
    const timestamp = activeProgress?.updatedAt || status?.checkedAt || new Date().toISOString();
    const detail = localRelevant
      ? localProgress?.message || localUpdate?.message || ""
      : status?.workflow?.message || "";
    const additions = [{
      signature: `state:${pageState}:${detail}`,
      time: timestamp,
      kind: statusKind(pageState),
      title: localUpdateStateLabel(pageState),
      detail,
    }];
    for (const step of rawSteps) {
      if (step.status === "pending") continue;
      additions.push({
        signature: `step:${step.key}:${step.status}:${step.detail}`,
        time: timestamp,
        kind: step.status === "completed" ? "success" : step.status === "failed" ? "error" : "running",
        title: step.label,
        detail: step.detail,
      });
    }
    setTimeline((previous) => {
      const next = appendUniqueEvents(previous, additions);
      writeSessionValue(storageKey(updateId), next);
      return next;
    });
  }, [
    activeProgress?.message,
    activeProgress?.updatedAt,
    localRelevant,
    localUpdate?.message,
    pageState,
    status?.checkedAt,
    status?.updateAvailable,
    stepsSignature,
    timelineUpdateId,
    updateId,
  ]);

  useEffect(() => {
    let frame;
    if (confirmInstall) {
      confirmationWasOpenRef.current = true;
      frame = window.requestAnimationFrame(() => confirmationPrimaryRef.current?.focus());
    } else if (confirmationWasOpenRef.current && !installing) {
      confirmationWasOpenRef.current = false;
      frame = window.requestAnimationFrame(() => startButtonRef.current?.focus());
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [confirmInstall, installing]);

  useEffect(() => {
    setCopied(false);
    setCopyFallbackText("");
  }, [visibleError?.signature]);

  useEffect(() => {
    setConfirmationActionError("");
  }, [updateConfirmation?.state, updateConfirmation?.attempt]);

  useEffect(() => {
    setConfirmLifecycleFinalize(false);
    setConfirmLifecycleRollback(false);
    setLifecycleActionError("");
    const holdId = deploymentLifecycle?.phase === "observation" ? deploymentLifecycle.holdId : "";
    const acknowledgedHold = holdId
      && readSessionValue(`bonni.core-update.activated:${holdId}`, false)
      ? holdId
      : "";
    setAcknowledgedLifecycleHold(acknowledgedHold);
    if (acknowledgedHold && defaultedLifecycleHoldRef.current !== acknowledgedHold) {
      defaultedLifecycleHoldRef.current = acknowledgedHold;
      setActiveTab("status");
    } else if (!holdId) {
      defaultedLifecycleHoldRef.current = "";
    }
  }, [deploymentLifecycle?.generation, deploymentLifecycle?.holdId, deploymentLifecycle?.status]);

  function persistActionError(normalized) {
    const value = { ...normalized, updateId };
    setActionError(value);
    writeSessionValue(actionErrorKey(updateId), value);
    writeSessionValue(UPDATE_ACTION_ERROR_STORAGE_KEY, value);
  }

  function clearActionError() {
    setActionError(null);
    removeSessionValue(actionErrorKey(updateId));
    removeSessionValue(UPDATE_ACTION_ERROR_STORAGE_KEY);
  }

  function clearReportedError() {
    setReportedError(null);
    removeSessionValue(reportedErrorKey(updateId));
  }

  async function handleCheck() {
    if (!token || checking || installing || lifecycleFinalizing || lifecycleRollingBack) return;
    setChecking(true);
    setDismissedError("");
    writeSessionValue(dismissedErrorKey(updateId), "");
    try {
      const checks = await Promise.allSettled([checkCoreUpdate(token), checkLocalSourceUpdate(token)]);
      const statusResult = await loadStatus();
      const rejected = checks.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (!statusResult.ok) {
        throw statusResult.error || new Error("Der aktuelle Update-Status konnte nicht bestätigt werden.");
      }
      setAcceptedInstallTransition(null);
      setStartTransitionWarning("");
      setConnectionWarning("");
      clearActionError();
    } catch (error) {
      persistActionError(normalizeUpdateActionError(error, "Updateprüfung fehlgeschlagen.", updateId));
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall() {
    if (!token || installing || progressActive || lifecycleFinalizing || lifecycleRollingBack || installationBlocked) return;
    setActiveTab("update");
    setInstalling(true);
    setConfirmInstall(false);
    clearActionError();
    clearReportedError();
    setDismissedError("");
    writeSessionValue(dismissedErrorKey(updateId), "");
    try {
      const kind = localRelevant ? "local-source" : "release";
      const baselineObservation = updateExecutionObservation(status, kind);
      const acceptedTransition = {
        kind,
        updateId,
        targetVersion: kind === "release"
          ? String(status?.targetVersion || baselineObservation.targetVersion || "")
          : "",
        baselineSignature: baselineObservation.signature,
        startedAt: new Date().toISOString(),
      };
      let monitorAccessError = null;
      if (localRelevant) {
        if (!localUpdate.updateId || !localUpdate.manifestSha256) {
          throw new Error("Das Testupdate ist nicht eindeutig identifiziert. Bitte erneut prüfen.");
        }
        const installation = await installLocalSourceUpdate(token, {
          updateId: localUpdate.updateId,
          manifestSha256: localUpdate.manifestSha256,
        });
        const access = normalizeInstallationMonitorAccess(installation?.monitor);
        if (!access) {
          monitorAccessError = new Error("Der Installationsserver hat keinen sicheren Fortschrittszugang bereitgestellt.");
        } else {
          setInstallationMonitorAccess(access);
          setStatusSource("installation");
        }
      } else {
        await installCoreUpdate(token, status?.targetVersion);
      }
      setStartTransitionWarning("");
      setAcceptedInstallTransition(acceptedTransition);
      setConnectionWarning(localRelevant
        ? "Der Installationsserver übernimmt den Fortschritt. Bonni Core kann jetzt sicher neu gestartet werden …"
        : "Der isolierte Candidate wird vorbereitet. Der aktive Bonni-Core-Stand bleibt während der Prüfung erreichbar …");
      if (monitorAccessError) throw monitorAccessError;
      await loadStatus();
    } catch (error) {
      persistActionError(normalizeUpdateActionError(
        error,
        "Die Aktualisierung konnte nicht gestartet werden.",
        updateId,
      ));
    } finally {
      setInstalling(false);
    }
  }

  async function handleConfirmActivatedVersion() {
    const access = monitorAccessRef.current;
    if (!access || confirmingVersion || retryingCutover || !updateConfirmation?.canConfirm) return;
    setConfirmingVersion(true);
    setConfirmationActionError("");
    try {
      const result = await confirmInstallationUpdate(access);
      if (result?.progress) {
        commitStatus(mergeInstallationMonitorStatus(statusRef.current, result), "installation");
      }
      const refreshed = await loadStatus();
      if (!refreshed.ok) {
        throw new Error("INSTALLATION_CONFIRMATION_STATUS_UNAVAILABLE");
      }
    } catch {
      setConfirmationActionError(
        "Die Bestätigung wurde nicht angenommen. Der Installationsmonitor bleibt zuständig und führt bei Fristablauf automatisch zur alten Version zurück.",
      );
    } finally {
      setConfirmingVersion(false);
    }
  }

  async function handleRetryCandidateCutover() {
    const access = monitorAccessRef.current;
    if (!access || confirmingVersion || retryingCutover || !updateConfirmation?.canRetry) return;
    setRetryingCutover(true);
    setConfirmationActionError("");
    try {
      const result = await retryInstallationUpdateCutover(access);
      if (result?.progress) {
        commitStatus(mergeInstallationMonitorStatus(statusRef.current, result), "installation");
      }
      setConfirmationClock(Date.now());
      const refreshed = await loadStatus();
      if (!refreshed.ok) {
        throw new Error("INSTALLATION_RETRY_STATUS_UNAVAILABLE");
      }
    } catch {
      setConfirmationActionError(
        "Der zweite Umschaltversuch konnte nicht sicher gestartet werden. Die alte Version bleibt aktiv.",
      );
    } finally {
      setRetryingCutover(false);
    }
  }

  async function handleFinalizeLifecycle() {
    if (
      !token
      || lifecycleFinalizing
      || !deploymentLifecycle?.canFinalize
      || !deploymentLifecycle.holdId
      || !Number.isSafeInteger(deploymentLifecycle.generation)
      || deploymentLifecycle.generation <= 0
    ) return;
    setLifecycleFinalizing(true);
    setLifecycleActionError("");
    try {
      await finalizeCoreDeploymentLifecycle(token, {
        holdId: deploymentLifecycle.holdId,
        generation: deploymentLifecycle.generation,
      });
      const refreshed = await loadStatus();
      if (!refreshed.ok) {
        throw refreshed.error || new Error("Der abgeschlossene Lifecycle konnte noch nicht bestätigt werden.");
      }
      setConfirmLifecycleFinalize(false);
    } catch (error) {
      setLifecycleActionError(
        error?.message || "Der Rückfallstand konnte nicht serverseitig abgeschlossen werden.",
      );
    } finally {
      setLifecycleFinalizing(false);
    }
  }

  async function handleRollbackLifecycle() {
    if (
      !token
      || lifecycleRollingBack
      || lifecycleFinalizing
      || !deploymentLifecycle?.canRollback
      || !deploymentLifecycle.holdId
      || !Number.isSafeInteger(deploymentLifecycle.generation)
      || deploymentLifecycle.generation <= 0
    ) return;
    setActiveTab("update");
    setLifecycleRollingBack(true);
    setLifecycleActionError("");
    try {
      const result = await rollbackCoreDeploymentLifecycle(token, {
        holdId: deploymentLifecycle.holdId,
        generation: deploymentLifecycle.generation,
      });
      const access = normalizeInstallationMonitorAccess(result?.monitor);
      if (!access) throw new Error("Der Installationsserver hat keinen sicheren Fortschrittszugang bereitgestellt.");
      setInstallationMonitorAccess(access);
      setStatusSource("installation");
      setAcceptedInstallTransition({
        kind: "local-source",
        updateId: access.updateId,
        targetVersion: deploymentLifecycle.previousVersion || "",
        baselineSignature: updateExecutionObservation(status, "local-source").signature,
        startedAt: new Date().toISOString(),
      });
      setConnectionWarning("Der gesicherte Vorgängerstand wird vorbereitet. Der Installationsserver übernimmt den Fortschritt …");
      setConfirmLifecycleRollback(false);
      await loadStatus();
    } catch (error) {
      setLifecycleActionError(error?.message || "Der gesicherte Vorgängerstand konnte nicht gestartet werden.");
    } finally {
      setLifecycleRollingBack(false);
    }
  }

  function acknowledgeActivatedVersion({ openStatus = false } = {}) {
    const holdId = deploymentLifecycle?.holdId;
    if (holdId) {
      writeSessionValue(`bonni.core-update.activated:${holdId}`, true);
      setAcknowledgedLifecycleHold(holdId);
      defaultedLifecycleHoldRef.current = holdId;
    }
    if (openStatus) setActiveTab("status");
    else onBack?.();
  }

  function dismissCurrentError() {
    if (!currentError) return;
    setDismissedError(currentError.signature);
    writeSessionValue(dismissedErrorKey(updateId), currentError.signature);
    clearActionError();
    clearReportedError();
  }

  function errorDetailsText() {
    if (!currentError) return "";
    return [
      currentError.title,
      currentError.explanation,
      currentError.code ? `Tiefster Fehlercode: ${currentError.code}` : "",
      currentError.codeChain?.length > 1 ? `Fehlerkette: ${currentError.codeChain.join(" → ")}` : "",
      currentError.phase ? `Phase: ${currentError.phase}` : "",
      currentError.stage ? `Stufe: ${currentError.stage}` : "",
      `Update: ${updateId}`,
      currentError.technical ? `Technische Details: ${currentError.technical}` : "",
    ].filter(Boolean).join("\n");
  }

  async function copyErrorDetails() {
    const text = errorDetailsText();
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("CLIPBOARD_API_UNAVAILABLE");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyFallbackText("");
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      let copiedWithFallback = false;
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        copiedWithFallback = Boolean(document.execCommand?.("copy"));
        textarea.remove();
      } catch {
        copiedWithFallback = false;
      }
      setCopied(copiedWithFallback);
      setCopyFallbackText(copiedWithFallback ? "" : text);
      if (copiedWithFallback) window.setTimeout(() => setCopied(false), 2_000);
    }
  }

  function handleConfirmationKeyDown(event) {
    if (event.key === "Escape" && !installing) {
      event.preventDefault();
      setConfirmInstall(false);
    }
  }

  function handleUpdateTabKeyDown(event) {
    if (progressActive || confirmationVisible || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = UPDATE_PAGE_TABS.findIndex((tab) => tab.key === activeTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? UPDATE_PAGE_TABS.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + UPDATE_PAGE_TABS.length)
          % UPDATE_PAGE_TABS.length;
    const nextTab = UPDATE_PAGE_TABS[nextIndex];
    const tablist = event.currentTarget.parentElement;
    setActiveTab(nextTab.key);
    window.requestAnimationFrame(() => {
      tablist?.querySelector(`#cc-update-${nextTab.key}-tab`)?.focus();
    });
  }

  const counts = localRelevant ? localUpdate?.counts || {} : {};
  const fileCount = Number(counts.files ?? counts.fileCount ?? 0) || 0;
  const inventoryCount = Number(counts.inventory ?? counts.inventoryCount ?? 0) || 0;
  const deleteCount = Number(counts.delete ?? counts.deletions ?? counts.deleteCount ?? 0) || 0;
  const currentCoreVersion = formatBonniCoreVersion(
    localRelevant ? localUpdate?.from?.coreVersion : status?.currentVersion,
  );
  const targetCoreVersion = formatBonniCoreVersion(
    localRelevant ? localUpdate?.to?.coreVersion : status?.targetVersion,
  );
  const hasCoreTarget = targetCoreVersion !== "—";
  const lifecycleObservationActive = deploymentLifecycle?.phase === "observation";
  const lifecycleHoldAcknowledged = Boolean(
    lifecycleObservationActive
    && deploymentLifecycle.holdId
    && (
      acknowledgedLifecycleHold === deploymentLifecycle.holdId
      || readSessionValue(`bonni.core-update.activated:${deploymentLifecycle.holdId}`, false)
    ),
  );
  const lifecycleActivatedVisible = Boolean(
    confirmationVisible
    || (
      lifecycleObservationActive
      && deploymentLifecycle.holdId
      && !lifecycleHoldAcknowledged
    ),
  );
  const displayedTab = lifecycleHoldAcknowledged
    && defaultedLifecycleHoldRef.current !== deploymentLifecycle.holdId
    ? "status"
    : activeTab;
  const displayCurrentVersion = lifecycleObservationActive
    ? formatBonniCoreVersion(deploymentLifecycle.previousVersion)
    : currentCoreVersion;
  const displayTargetVersion = lifecycleObservationActive
    ? formatBonniCoreVersion(deploymentLifecycle.targetVersion)
    : targetCoreVersion;
  const showVersionTransition = lifecycleObservationActive
    || (hasCoreTarget && (localRelevant || releaseAvailable));

  if (loading && !status) {
    return <section className="cc-core-update-page"><div className="cc-update-page-loading">Aktualisierungsstatus wird geladen …</div></section>;
  }

  return (
    <section className="cc-core-update-page" aria-label="Bonni-Core-Aktualisierung">
      <header className="cc-update-page-hero">
        <div className="cc-update-page-hero__topline">
          <span>Bonni Core · Aktualisierung</span>
          <button type="button" onClick={onBack} aria-label="Aktualisierung schließen">×</button>
        </div>
        <div className="cc-update-page-hero__content">
          <div>
            <span className={`cc-update-page-status is-${statusKind(presentationState)}`}>
              {optimisticRunning ? "Aktualisierung gestartet" : localUpdateStateLabel(presentationState)}
            </span>
            <h1>{showVersionTransition
              ? `Bonni Core ${displayCurrentVersion} → ${displayTargetVersion}`
              : "Bonni Core-Systemupdate"}</h1>
            <p>{showVersionTransition
              ? `Paket ${displayTargetVersion}`
              : "Geprüfte Aktualisierung des Bonni-Core-Systems"}</p>
          </div>
        </div>
      </header>

      <nav className="cc-update-page-tabs" role="tablist" aria-label="Aktualisierungsbereiche">
        {UPDATE_PAGE_TABS.map((tab) => {
          const selected = displayedTab === tab.key;
          const locked = progressActive || confirmationVisible || lifecycleActivatedVisible;
          return (
            <button
              id={`cc-update-${tab.key}-tab`}
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`cc-update-${tab.key}-panel`}
              aria-disabled={locked}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!locked) setActiveTab(tab.key);
              }}
              onKeyDown={handleUpdateTabKeyDown}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {optimisticRunning || monitorAccess || startTransitionWarning || connectionWarning ? (
        <div className="cc-update-page-connection" role="status">
          <span aria-hidden="true" />
          {startTransitionWarning || connectionWarning || (monitorAccess && statusSource === "installation"
            ? "Installationsserver aktiv – der Fortschritt bleibt auch während des Core-Neustarts erreichbar."
            : optimisticRunning
              ? optimisticStart?.kind === "release"
                ? "Der Installationsauftrag wurde angenommen. Der isolierte Candidate wird vorbereitet …"
                : "Der Installationsauftrag wurde angenommen. Der Installationsserver übernimmt …"
              : "Bonni Core startet neu. Die Verbindung wird automatisch wiederhergestellt …")}
        </div>
      ) : null}

      {confirmationVisible ? (
        <section
          id="cc-update-update-panel"
          className={`cc-update-confirmation-gate ${confirmationActive ? "is-active" : "is-old-active"}`}
          role="tabpanel"
          aria-labelledby="cc-update-update-tab"
        >
          {confirmationActive ? (
            <>
              <div className="cc-update-confirmation-gate__heading">
                <div>
                  <span>Unabhängiger Installationsmonitor · Bestätigung</span>
                  <h2>Neue Version innerhalb von 60 Sekunden bestätigen</h2>
                </div>
                <strong>{updateConfirmation.remainingSeconds === null
                  ? "Frist wird geprüft"
                  : `Noch ${updateConfirmation.remainingSeconds} Sekunden`}</strong>
              </div>
              <p>
                Prüfe kurz, ob Bonni Core mit der neuen Version funktioniert. Ohne ausdrückliche Bestätigung
                aktiviert der Installationsmonitor automatisch wieder die alte Version.
              </p>
              <FiveStepProgress steps={fiveSteps} />
              <div
                className="cc-update-confirmation-countdown"
                role="progressbar"
                aria-label="Verbleibende Bestätigungszeit"
                aria-valuemin="0"
                aria-valuemax="60"
                aria-valuenow={updateConfirmation.remainingSeconds ?? 0}
                aria-valuetext={updateConfirmation.remainingSeconds === null
                  ? "Bestätigungsfrist wird vom Installationsmonitor geprüft"
                  : `Noch ${updateConfirmation.remainingSeconds} Sekunden bis zur automatischen Rückkehr`}
              >
                <span style={{ width: `${updateConfirmation.remainingPercent}%` }} />
              </div>
              {updateConfirmation.attempt ? (
                <small>Umschaltversuch {updateConfirmation.attempt} von {updateConfirmation.maxAttempts || 2}</small>
              ) : null}
              {confirmationActionError ? <p className="cc-update-confirmation-gate__error" role="alert">{confirmationActionError}</p> : null}
              <button
                type="button"
                className="cc-update-page-primary"
                onClick={handleConfirmActivatedVersion}
                disabled={!monitorAccess || !updateConfirmation.canConfirm || confirmingVersion || retryingCutover}
              >
                {confirmingVersion ? "Bestätigung wird sicher übermittelt …" : "Neue Version funktioniert"}
              </button>
              {!updateConfirmation.canConfirm ? (
                <p className="cc-update-confirmation-gate__waiting" role="status">
                  Die Bestätigungsfrist ist abgelaufen. Der Installationsmonitor prüft jetzt automatisch die sichere Rückkehr.
                </p>
              ) : null}
            </>
          ) : confirmationRollbackRequired ? (
            <>
              <div className="cc-update-confirmation-gate__heading">
                <div>
                  <span>Sichere automatische Rückkehr</span>
                  <h2>Alte Version wieder aktiv</h2>
                </div>
                <strong>Erster Versuch beendet</strong>
              </div>
              <p>
                Die neue Version wurde nicht rechtzeitig bestätigt. Der Installationsmonitor hat deshalb
                automatisch und kontrolliert auf die alte, funktionierende Version zurückgeschaltet.
              </p>
              <FiveStepProgress steps={fiveSteps} />
              {confirmationActionError ? <p className="cc-update-confirmation-gate__error" role="alert">{confirmationActionError}</p> : null}
              <button
                type="button"
                className="cc-update-page-primary"
                onClick={handleRetryCandidateCutover}
                disabled={!monitorAccess || !updateConfirmation.canRetry || retryingCutover || confirmingVersion}
              >
                {retryingCutover ? "Zweiter Umschaltversuch wird gestartet …" : "Zweiten Umschaltversuch starten"}
              </button>
            </>
          ) : (
            <>
              <div className="cc-update-confirmation-gate__heading">
                <div>
                  <span>Bestätigung endgültig fehlgeschlagen</span>
                  <h2>Alte Version wieder aktiv</h2>
                </div>
                <strong>Update sicher beendet</strong>
              </div>
              <p>
                Auch der zweite Umschaltversuch wurde nicht innerhalb der Frist bestätigt. Die alte Version
                ist aktiv; der Installationsmonitor hat diesen Update-Lauf terminal und ohne weiteren Browserversuch beendet.
              </p>
              <FiveStepProgress steps={fiveSteps} />
            </>
          )}
        </section>
      ) : null}

      {progressActive ? <section
        id="cc-update-update-panel"
        className="cc-update-page-card cc-update-page-progress-card is-running"
        role="tabpanel"
        aria-labelledby="cc-update-update-tab"
      >
        <div className="cc-update-page-section-title">
          <div><span>Installation</span><h2 id="cc-update-progress-title">Fortschritt</h2></div>
          <strong>{optimisticRunning ? "gestartet" : `${Math.round(progressPercent)} %`}</strong>
        </div>
        <div className="cc-update-page-current-step" aria-live="polite" aria-atomic="true">
          <span>Aktueller Schritt</span>
          <strong>{currentStepLabel}</strong>
          <p>{currentStepDetail}</p>
        </div>
        <div
          className="cc-update-page-progress"
          role="progressbar"
          aria-labelledby="cc-update-progress-title"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(progressPercent)}
          aria-valuetext={optimisticRunning
            ? "Aktualisierung gestartet; bestätigter Serverstatus wird abgerufen"
            : `${Math.round(progressPercent)} Prozent Gesamtfortschritt`}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <FiveStepProgress steps={fiveSteps} />
      </section> : null}

      {!progressActive && !confirmationVisible && visibleError ? (
        <section className="cc-update-page-error" role="alert" aria-label="Fehler bei der Aktualisierung">
          <div className="cc-update-page-error__icon" aria-hidden="true">!</div>
          <div className="cc-update-page-error__body">
            <span>Aktualisierung sicher angehalten</span>
            <h2>{visibleError.title}</h2>
            <p>{visibleError.explanation}</p>
            {fiveStepProgress.hasEvidence ? <FiveStepProgress steps={fiveSteps} /> : null}
            <details open>
              <summary>Technische Details</summary>
              {visibleError.code ? <div><b>Tiefster Fehlercode</b><code>{visibleError.code}</code></div> : null}
              {visibleError.codeChain?.length > 1 ? (
                <div><b>Fehlerkette</b><code>{visibleError.codeChain.join(" → ")}</code></div>
              ) : null}
              {visibleError.phase ? <div><b>Phase</b><code>{visibleError.phase}</code></div> : null}
              {visibleError.stage ? <div><b>Stufe</b><code>{visibleError.stage}</code></div> : null}
              {visibleError.technical ? <pre>{visibleError.technical}</pre> : null}
            </details>
            <div className="cc-update-page-error__actions">
              <button type="button" onClick={copyErrorDetails}>{copied ? "Kopiert" : "Fehler kopieren"}</button>
              <button type="button" onClick={dismissCurrentError}>Hinweis schließen</button>
              {canRetry ? (
                <button type="button" className="is-primary" onClick={() => setConfirmInstall(true)}>
                  Erneut versuchen
                </button>
              ) : null}
            </div>
            {copyFallbackText ? (
              <div className="cc-update-page-copy-fallback" role="status">
                <strong>Automatisches Kopieren ist nicht möglich. Text markieren und manuell kopieren:</strong>
                <textarea
                  aria-label="Fehlerdetails zum manuellen Kopieren"
                  readOnly
                  value={copyFallbackText}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {!progressActive && !confirmationVisible && completed && fiveStepProgress.hasEvidence ? (
        <section className="cc-update-page-card cc-update-page-progress-card is-completed" aria-label="Abgeschlossener Update-Fortschritt">
          <div className="cc-update-page-section-title">
            <div><span>Installation</span><h2>Aktualisierung abgeschlossen</h2></div>
            <strong>100 %</strong>
          </div>
          <FiveStepProgress steps={fiveSteps} />
        </section>
      ) : null}

      {!progressActive && lifecycleActivatedVisible && !confirmationVisible ? (
        <section className="cc-update-activated" role="status" aria-labelledby="cc-update-activated-title">
          <span className="cc-update-activated__check" aria-hidden="true">✓</span>
          <div>
            <h2 id="cc-update-activated-title">Neue Version ist jetzt aktiv</h2>
            <strong>Bonni Core {displayTargetVersion} wird jetzt verwendet.</strong>
            <p>Sie können das System wie gewohnt nutzen und die neue Version überprüfen.</p>
            <p>Sollten Probleme auftreten, können Sie unter „Status“ zur vorherigen Version zurückkehren.</p>
            <div className="cc-update-activated__actions">
              <button type="button" onClick={() => acknowledgeActivatedVersion({ openStatus: true })}>Status öffnen</button>
              <button type="button" className="is-primary" onClick={() => acknowledgeActivatedVersion()}>Verstanden</button>
            </div>
          </div>
        </section>
      ) : null}

      {!progressActive && !lifecycleActivatedVisible && displayedTab === "update" ? (
        <div
          id="cc-update-update-panel"
          className="cc-update-page-layout"
          role="tabpanel"
          aria-labelledby="cc-update-update-tab"
        >
        <main className="cc-update-page-main">
          {!localRelevant ? <CoreReleaseOverview status={status} /> : null}

          <section className="cc-update-page-card cc-update-page-changes">
            <div className="cc-update-page-section-title">
              <div><span>Versionsbeschreibung</span><h2>{releaseNotes.title}</h2></div>
              {!releaseNotes.supplied ? <b>Technische Übersicht</b> : null}
            </div>
            <p className="cc-update-page-summary">{releaseNotes.summary}</p>
            <div className="cc-update-page-change-list">
              {releaseNotes.changes.length ? releaseNotes.changes.map((change) => (
                <article key={change.key}>
                  <span>{change.type}</span>
                  <div><strong>{change.title}</strong>{change.detail ? <p>{change.detail}</p> : null}</div>
                </article>
              )) : <p>Für dieses Update wurden keine einzelnen Änderungspunkte hinterlegt.</p>}
            </div>
          </section>

        </main>

        <aside className="cc-update-page-sidebar">
          <section className="cc-update-page-card cc-update-page-package">
            <span>Paketübersicht</span>
            <dl>
              <div><dt>Geänderte Dateien</dt><dd>{fileCount}</dd></div>
              <div><dt>Geprüfte Indexeinträge</dt><dd>{inventoryCount || "—"}</dd></div>
              <div><dt>Löschungen</dt><dd>{deleteCount}</dd></div>
            </dl>
            {localRelevant && Array.isArray(localUpdate?.components) && localUpdate.components.length ? (
              <div className="cc-update-page-components">
                <span>Betroffener Bereich</span>
                <b>Bonni Core</b>
              </div>
            ) : null}
          </section>

          <section className="cc-update-page-card cc-update-page-start">
            <span>Sicher aktualisieren</span>
            <h2>{busy ? "Aktualisierung läuft" : completed ? "Bonni ist aktuell" : installationBlocked ? "Installation gesperrt" : updateAvailable ? "Bereit zum Start" : "Kein Update gemeldet"}</h2>
            <ul>
              <li>Paket und Dateihashes werden zuerst geprüft.</li>
              <li>Vor Änderungen wird eine Sicherung erstellt.</li>
              <li>{localRelevant
                ? "Der Installationsserver hält den Fortschritt beim Core-Neustart erreichbar."
                : "Der Candidate wird isoliert geprüft; erst danach erfolgt der kontrollierte Single-Active-Wechsel."}</li>
            </ul>
            {installationBlocked ? (
              <p className="cc-update-page-runner-error" role="status">{installationBlockedReason}</p>
            ) : null}
            {confirmInstall && updateAvailable && !busy ? (
              <div
                ref={confirmationDialogRef}
                className="cc-update-page-confirm"
                role="group"
                aria-labelledby="cc-update-confirm-title"
                aria-describedby="cc-update-confirm-description"
                onKeyDown={handleConfirmationKeyDown}
              >
                <strong id="cc-update-confirm-title">Aktualisierung wirklich starten?</strong>
                <p id="cc-update-confirm-description">{localRelevant
                  ? "Der Installationsserver übernimmt die Anzeige, während Bonni Core kontrolliert neu startet."
                  : "Der aktive Stand bleibt während der isolierten Candidate-Prüfung erreichbar. Der Produktivzugriff wechselt erst nach bestandener Prüfung kontrolliert."}</p>
                <button ref={confirmationPrimaryRef} type="button" onClick={handleInstall} disabled={installing || lifecycleFinalizing || installationBlocked}>
                  {installing ? "Wird gestartet …" : "Installieren"}
                </button>
                <button type="button" onClick={() => setConfirmInstall(false)} disabled={installing}>Abbrechen</button>
              </div>
            ) : updateAvailable && !busy && !completed ? (
              <div className="cc-update-offer-actions">
                <button type="button" className="cc-update-page-secondary" onClick={onBack}>Überspringen</button>
                <button
                  ref={startButtonRef}
                  type="button"
                  className="cc-update-page-primary"
                  onClick={() => setConfirmInstall(true)}
                  disabled={installationBlocked || installing || lifecycleFinalizing || lifecycleRollingBack}
                >
                  {localLifecycleBlocked
                    ? "Gesperrt bis Rückfallabschluss"
                    : failed ? "Erneut installieren" : "Installieren"}
                </button>
              </div>
            ) : null}
            <button type="button" className="cc-update-page-secondary" onClick={handleCheck} disabled={checking || installing || lifecycleFinalizing || lifecycleRollingBack || busy}>
              {checking ? "Prüfung läuft …" : "Erneut auf Updates prüfen"}
            </button>
          </section>
        </aside>
        </div>
      ) : null}

      {!progressActive && !lifecycleActivatedVisible && displayedTab === "status" ? (
        <div
          id="cc-update-status-panel"
          className="cc-update-page-tab-panel"
          role="tabpanel"
          aria-labelledby="cc-update-status-tab"
        >
          {lifecycleObservationActive ? (
            <DeploymentLifecyclePanel
              lifecycle={deploymentLifecycle}
              finalizing={lifecycleFinalizing}
              rollingBack={lifecycleRollingBack}
              confirmFinalize={confirmLifecycleFinalize}
              confirmRollback={confirmLifecycleRollback}
              actionError={lifecycleActionError}
              onRequestFinalize={() => {
                setLifecycleActionError("");
                setConfirmLifecycleRollback(false);
                setConfirmLifecycleFinalize(true);
              }}
              onRequestRollback={() => {
                setLifecycleActionError("");
                setConfirmLifecycleFinalize(false);
                setConfirmLifecycleRollback(true);
              }}
              onCancelAction={() => {
                setConfirmLifecycleFinalize(false);
                setConfirmLifecycleRollback(false);
              }}
              onFinalize={handleFinalizeLifecycle}
              onRollback={handleRollbackLifecycle}
            />
          ) : (
            <section className="cc-update-status-overview" aria-labelledby="cc-update-status-title">
              <div>
                <span>Bonni Core · Status</span>
                <h2 id="cc-update-status-title">
                  Bonni Core {formatBonniCoreVersion(status?.currentVersion)} ist aktiv
                </h2>
                <p>Derzeit läuft keine 14-Tage-Funktionsprüfung.</p>
              </div>
              <dl>
                <div><dt>Aktiver Stand</dt><dd>{formatBonniCoreVersion(status?.currentVersion)}</dd></div>
                <div><dt>Update-Status</dt><dd>{localUpdateStateLabel(pageState)}</dd></div>
              </dl>
            </section>
          )}
        </div>
      ) : null}

      {!progressActive && !lifecycleActivatedVisible && displayedTab === "history" ? (
        <section
          id="cc-update-history-panel"
          className="cc-update-page-card cc-update-page-history"
          role="tabpanel"
          aria-labelledby="cc-update-history-tab"
        >
          <div className="cc-update-page-section-title">
            <div><span>Protokoll</span><h2>Bisheriger Verlauf</h2></div>
            <b>{timeline.length} Einträge</b>
          </div>
          {timeline.length ? (
            <ol>
              {timeline.map((event) => (
                <li key={event.signature} className={`is-${event.kind}`}>
                  <time>{formatUpdateTime(event.time)}</time>
                  <span aria-hidden="true" />
                  <div><strong>{event.title}</strong>{event.detail ? <p>{event.detail}</p> : null}</div>
                </li>
              ))}
            </ol>
          ) : <p className="cc-update-page-empty-progress">Noch keine Installationsschritte protokolliert.</p>}
        </section>
      ) : null}
    </section>
  );
}
