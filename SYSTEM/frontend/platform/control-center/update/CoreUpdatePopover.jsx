import {
  formatBonniCoreVersion,
  isUpdateBusy,
  isUpdateFailed,
  localUpdateStateLabel,
  normalizeUpdateState,
} from "./localUpdatePresentation.js";

export default function CoreUpdatePopover({
  status,
  installedVersion,
  loading,
  action,
  error,
  onCheck,
  onNavigate,
}) {
  const currentVersion = status?.currentVersion || installedVersion || "";
  const localUpdate = status?.localSourceUpdate || null;
  const localState = normalizeUpdateState(localUpdate?.state);
  const progressState = normalizeUpdateState(
    localUpdate?.progress?.status || localUpdate?.progress?.phase,
    "idle",
  );
  const displayState = !["none", "idle"].includes(progressState) ? progressState : localState;
  const localFailureState = isUpdateFailed(localState, progressState);
  const localCompleted = !localFailureState
    && (["completed", "already-installed"].includes(localState) || progressState === "completed");
  const releaseAvailable = Boolean(status?.updateAvailable && status?.updateKind !== "local-source");
  const localRelevant = Boolean(localUpdate && (
    isUpdateBusy(localState, progressState)
    || (
      status?.updateKind !== "release"
      && (localUpdate?.updateAvailable || isUpdateFailed(localState, progressState) || localCompleted)
    )
  ));
  const localAttention = localRelevant;
  const localBusy = localRelevant && isUpdateBusy(localState, progressState);
  const localFailure = localRelevant && localFailureState;
  const localSuccess = localRelevant && localCompleted;
  const targetVersion = localRelevant ? localUpdate?.to?.coreVersion : releaseAvailable ? status?.targetVersion : null;
  const currentVersionLabel = formatBonniCoreVersion(currentVersion);
  const targetVersionLabel = targetVersion ? formatBonniCoreVersion(targetVersion) : null;
  const showUpdateAction = releaseAvailable || localAttention;
  const versionConfirmed = status?.releasePlan?.packages?.some((entry) => entry.status === "installed") === true;
  const statusLabel = !status ? "Status offen" : "Kein Update gemeldet";
  const headerLabel = localAttention
      ? localUpdateStateLabel(displayState)
      : releaseAvailable
        ? "Update verfügbar"
        : versionConfirmed ? "Aktuell" : statusLabel;

  return (
    <div className="cc-version-popover cc-update-popover cc-update-popover--compact" role="dialog" aria-label="Bonni-Core-Aktualisierung">
      <div className="cc-update-popover__heading">
        <div>
          <span>Bonni Core</span>
          <strong>
            {currentVersionLabel}
            {targetVersion && targetVersion !== currentVersion ? <><b aria-hidden="true">→</b>{targetVersionLabel}</> : null}
          </strong>
        </div>
        <span className={`cc-update-state${showUpdateAction ? " is-available" : versionConfirmed ? "" : " is-unknown"}${localAttention && !releaseAvailable ? " is-local" : ""}`}>
          {headerLabel}
        </span>
      </div>

      {showUpdateAction ? (
        <section className={`cc-update-compact-card${localFailure ? " is-error" : ""}`}>
          <div>
            <span>{localRelevant ? "Paket" : "Neue Bonni-Core-Version"}</span>
            <strong>{`Bonni Core ${targetVersionLabel}`}</strong>
          </div>
          <p>
            {localSuccess
              ? "Die Aktualisierung wurde erfolgreich abgeschlossen. Alle Details bleiben auf der Aktualisierungsseite nachvollziehbar."
              : localFailure
              ? "Die Aktualisierung benötigt deine Aufmerksamkeit. Der Fehler bleibt auf der Aktualisierungsseite sichtbar."
              : localBusy
                ? "Fortschritt und Neustart werden auf der Aktualisierungsseite angezeigt."
                : "Änderungen, Sicherung und Installationsschritte vor dem Start ansehen."}
          </p>
          <button type="button" className="is-primary" onClick={() => onNavigate("update")}>
            {localSuccess ? "Details ansehen" : localBusy ? "Fortschritt öffnen" : localFailure ? "Fehler ansehen" : "Aktualisieren"}
          </button>
        </section>
      ) : versionConfirmed ? (
        <div className="cc-update-compact-current">
          <span aria-hidden="true">✓</span>
          <div><strong>Bonni Core ist aktuell</strong><small>Derzeit ist keine Aktualisierung vorgemerkt.</small></div>
        </div>
      ) : (
        <div className="cc-update-compact-status" role="status">
          {!status && error ? "Der Update-Status konnte nicht geladen werden." : !status && loading ? "Der Update-Status wird geladen …" : statusLabel}
        </div>
      )}

      {error ? (
        <button type="button" className="cc-update-compact-error" onClick={() => onNavigate("update")}>
          <span>Letzter Updatefehler</span>
          <strong>{error}</strong>
          <small>Details dauerhaft öffnen →</small>
        </button>
      ) : null}

      <div className="cc-update-actions cc-update-actions--compact">
        <button type="button" onClick={onCheck} disabled={loading || Boolean(action)}>
          {action === "check" ? "Prüfe …" : "Auf Updates prüfen"}
        </button>
      </div>

      <nav className="cc-update-menu" aria-label="Update-Menü">
        <button type="button" onClick={() => onNavigate("changelog")}>Versionsbeschreibung</button>
        <button type="button" onClick={() => onNavigate("backup")}>Backup &amp; Wiederherstellung</button>
        <button type="button" onClick={() => onNavigate("update-settings")}>Einstellungen</button>
      </nav>
    </div>
  );
}
