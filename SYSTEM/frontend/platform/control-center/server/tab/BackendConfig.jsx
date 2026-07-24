import { scheduleEmergencyBackend } from "../../../../system/api/emergencyBackendApi.js";
import { BackendConfigCard, ConfigStatusCard, StatusPill } from "../components/ServerTabComponents.jsx";

export default function BackendConfigTab({
  activeCardState,
  backendDiagnostics,
  backendTargets,
  configTarget,
  form,
  redundantCardState,
  runAction,
  saveSettings,
  saving,
  setConfigTarget,
  setForm,
  token,
}) {
  return (
    <div className="security-tab-panel" role="tabpanel">
      <div className="security-config-overview-grid" aria-label="Backend zur Konfiguration auswählen">
        <BackendConfigCard
          title="Normales Backend"
          target={backendTargets.active}
          stateLabel={activeCardState.label}
          stateVariant={activeCardState.variant}
          selected={configTarget === "active"}
          onSelect={() => setConfigTarget("active")}
        />
        <BackendConfigCard
          title="Redundantes Backend"
          target={backendTargets.redundant}
          stateLabel={redundantCardState.label}
          stateVariant={redundantCardState.variant}
          selected={configTarget === "redundant"}
          onSelect={() => setConfigTarget("redundant")}
        />
        <ConfigStatusCard
          diagnostics={backendDiagnostics}
          title={`Status · ${configTarget === "active" ? "Normales Backend" : "Redundantes Backend"}`}
        />
      </div>

      {configTarget === "active" ? (
        <div className="security-config-editor">
          <div className="security-config-editor__header">
            <div>
              <span className="security-card__eyebrow">Normales Backend konfigurieren</span>
              <h3>Normales Backend</h3>
            </div>
            <StatusPill variant="ok">Aktiv</StatusPill>
          </div>
          <div className="security-redundancy-form security-redundancy-form--config security-redundancy-form--three">
            <label>
              <span>Start verzögern</span>
              <input value="0" readOnly />
              <small>Das normale Backend startet direkt mit dem System.</small>
            </label>
            <label>
              <span>Port</span>
              <input value={backendTargets.active.port} readOnly />
              <small>Aktiver Backend-Port.</small>
            </label>
            <label>
              <span>Bind-Adresse</span>
              <input value={backendTargets.active.host} readOnly />
              <small>Wird aktuell über die Startkonfiguration gesetzt.</small>
            </label>
          </div>
        </div>
      ) : (
        <div className="security-config-editor">
          <div className="security-config-editor__header">
            <div>
              <span className="security-card__eyebrow">Redundantes Backend konfigurieren</span>
              <h3>Redundantes Backend</h3>
            </div>
            <StatusPill variant={form.enabled ? "ok" : "neutral"}>{form.enabled ? "Verwendet" : "Deaktiviert"}</StatusPill>
          </div>

          <div className="security-config-inline-switches">
            <label className="security-switch-row">
              <span className="security-switch-row__text">
                <strong>Redundantes Backend verwenden</strong>
                <small>Schaltet das zweite Backend-Ziel frei.</small>
              </span>
              <span className="security-switch">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                <span className="security-switch__slider" />
              </span>
            </label>
            <label className="security-switch-row">
              <span className="security-switch-row__text">
                <strong>Automatisch starten</strong>
                <small>Startet nach dem normalen Backend.</small>
              </span>
              <span className="security-switch">
                <input
                  type="checkbox"
                  checked={form.autoStart}
                  onChange={(event) => setForm((current) => ({ ...current, autoStart: event.target.checked }))}
                />
                <span className="security-switch__slider" />
              </span>
            </label>
          </div>

          <div className="security-redundancy-form security-redundancy-form--config security-redundancy-form--three">
            <label>
              <span>Start verzögern</span>
              <input
                type="number"
                min="0"
                step="10"
                value={form.autoStartDelaySeconds}
                onChange={(event) => setForm((current) => ({ ...current, autoStartDelaySeconds: event.target.value }))}
              />
              <small>Sekunden nach gesundem normalen Backend.</small>
            </label>
            <label>
              <span>Port</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={form.port}
                onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))}
              />
              <small>Standard: 4001</small>
            </label>
            <label>
              <span>Bind-Adresse</span>
              <input
                value={form.bind}
                onChange={(event) => setForm((current) => ({ ...current, bind: event.target.value }))}
              />
              <small>Für lokale Entwicklung meistens 127.0.0.1.</small>
            </label>
          </div>

          <div className="security-redundancy-actions security-redundancy-actions--visible">
            <button type="button" className="security-primary" onClick={saveSettings} disabled={saving}>Speichern</button>
            <button type="button" onClick={() => runAction("Autostart geplant.", () => scheduleEmergencyBackend(token))} disabled={saving || !form.enabled || !form.autoStart}>Autostart planen</button>
          </div>
        </div>
      )}
    </div>
  );
}
