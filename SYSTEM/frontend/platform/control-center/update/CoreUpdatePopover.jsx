function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function stepSymbol(status) {
  if (status === "completed") return "✓";
  if (status === "running") return "◉";
  if (status === "failed") return "×";
  if (status === "waiting") return "◌";
  return "○";
}

export default function CoreUpdatePopover({
  status,
  loading,
  action,
  error,
  onCheck,
  onInstall,
  onNavigate,
}) {
  const currentVersion = status?.currentVersion || "—";
  const targetVersion = status?.targetVersion;
  const workflow = status?.workflow;
  const updateAvailable = Boolean(status?.updateAvailable);
  const compatibilityBlocked = status?.compatibility && !status.compatibility.ok;
  const installationBlocked = status?.installation?.allowed === false;
  const runnerUnavailable = status?.runner?.available === false;
  const workflowBusy = ["running", "installing", "rolling-back"].includes(workflow?.status);
  const downloadDetail = workflow?.totalBytes
    ? `${formatBytes(workflow.downloadedBytes)} / ${formatBytes(workflow.totalBytes)}`
    : formatBytes(workflow?.downloadedBytes);

  return (
    <div className="cc-version-popover cc-update-popover" role="dialog" aria-label="Bonni-Core-Aktualisierung">
      <div className="cc-update-popover__heading">
        <div>
          <span>Bonni Core</span>
          <strong>
            {currentVersion}
            {targetVersion ? <><b aria-hidden="true">→</b>{targetVersion}</> : null}
          </strong>
        </div>
        <span className={`cc-update-state${updateAvailable ? " is-available" : ""}`}>
          {updateAvailable ? "Update verfügbar" : "Aktuell"}
        </span>
      </div>

      {workflow ? (
        <section className="cc-update-workflow" aria-label="Aktueller Updatefortschritt">
          <div className="cc-update-download-row">
            <span>Download</span>
            <b>{Math.round(Number(workflow.progressPercent || 0))} %</b>
          </div>
          <div className="cc-update-progress" aria-label={`Download ${workflow.progressPercent || 0} Prozent`}>
            <span style={{ width: `${Math.max(0, Math.min(100, Number(workflow.progressPercent || 0)))}%` }} />
          </div>
          {downloadDetail ? <small>{downloadDetail}</small> : null}

          <ol className="cc-update-checklist">
            {(workflow.steps || []).map((step) => (
              <li key={step.key} className={`is-${step.status}`}>
                <span aria-hidden="true">{stepSymbol(step.status)}</span>
                <div><b>{step.label}</b>{step.detail ? <small>{step.detail}</small> : null}</div>
              </li>
            ))}
          </ol>

          {workflow.message ? (
            <div className={`cc-update-message${["failed", "rolled-back"].includes(workflow.status) ? " is-error" : ""}`}>
              {workflow.message}
            </div>
          ) : null}
        </section>
      ) : null}

      {compatibilityBlocked ? (
        <div className="cc-update-message is-error">
          Der Store hat das Update wegen einer inkompatiblen Erweiterung gesperrt.
        </div>
      ) : null}
      {installationBlocked ? (
        <div className="cc-update-message is-error">
          {status.installation.reason || "Dieses Update benötigt einen manuellen Wartungsschritt."}
        </div>
      ) : null}
      {updateAvailable && runnerUnavailable ? (
        <div className="cc-update-message is-error">
          {status.runner.reason || "Der sichere Docker-Update-Runner ist nicht erreichbar."}
        </div>
      ) : null}
      {status?.versionMismatch ? (
        <div className="cc-update-message is-error">
          Die installierten Bonni-Core-Dateien stammen nicht aus derselben Version. Bitte die Installation prüfen.
        </div>
      ) : null}
      {error ? <div className="cc-update-message is-error">{error}</div> : null}

      <div className="cc-update-actions">
        <button type="button" onClick={onCheck} disabled={loading || Boolean(action)}>
          {action === "check" ? "Prüfe …" : "Auf Updates prüfen"}
        </button>
        {updateAvailable && !workflowBusy ? (
          <button
            type="button"
            className="is-primary"
            onClick={onInstall}
            disabled={loading || Boolean(action) || compatibilityBlocked || installationBlocked || runnerUnavailable}
          >
            {action === "install" ? "Installation startet …" : workflow?.status === "ready" ? "Jetzt installieren" : "Update installieren"}
          </button>
        ) : null}
      </div>

      <nav className="cc-update-menu" aria-label="Update-Menü">
        <button type="button" onClick={() => onNavigate("changelog")}>Versionsbeschreibung</button>
        <button type="button" onClick={() => onNavigate("backup")}>Backup &amp; Wiederherstellung</button>
        <button type="button" onClick={() => onNavigate("update-settings")}>Einstellungen</button>
      </nav>
    </div>
  );
}
