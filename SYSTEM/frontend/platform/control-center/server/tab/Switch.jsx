import { useState } from "react";

import {
  restartEmergencyBackend,
  startEmergencyBackend,
  stopEmergencyBackend,
  updateEmergencyBackendSettings,
} from "../../../../system/api/emergencyBackendApi.js";
import { BackendTargetCard, DatabaseTargetCard } from "../components/ServerTabComponents.jsx";

export default function SwitchTab({
  activeCardState,
  backendHealth,
  backendTargets,
  databaseCardStates,
  databaseHealth,
  databaseRouting,
  databaseTargets,
  enabled,
  jsonEmergencyEngaged,
  redundantCardState,
  redundantProcessAlive,
  refreshBackendHealth,
  refreshDatabaseHealth,
  runAction,
  runDatabaseFullSync,
  replayJsonEmergency,
  saving,
  setStatusTarget,
  setDatabaseWriteTarget,
  setJsonEmergencyEnabled,
  statusPanel,
  statusTarget,
  switchBackend,
  token,
}) {
  const [syncDirection, setSyncDirection] = useState("normal-to-redundant");
  const [syncConfirmation, setSyncConfirmation] = useState("");
  const source = syncDirection === "normal-to-redundant" ? "normal" : "redundant";
  const target = source === "normal" ? "redundant" : "normal";
  const expectedConfirmation = target === "normal"
    ? "NORMALE DATENBANK ÜBERSCHREIBEN"
    : "REDUNDANTE DATENBANK ÜBERSCHREIBEN";
  const bothReachable = databaseHealth[source]?.available === true && databaseHealth[target]?.available === true;
  const jsonEmergency = databaseRouting.jsonEmergency || {};
  const pendingJsonWrites = Number(jsonEmergency.pendingCount || 0);
  const backendView = statusPanel.kind === "backend";
  const databaseView = statusPanel.kind === "database";
  const inspectedBackend = backendView ? statusPanel.target : "active";
  const inspectedTarget = backendTargets[inspectedBackend];
  const inspectedHealth = backendHealth[inspectedBackend];
  const inspectedIsActive = inspectedBackend === "redundant"
    ? backendTargets.redundantSelected
    : backendTargets.activeSelected && !backendTargets.redundantSelected;

  async function startFullSync() {
    await runDatabaseFullSync({ source, target, confirmation: syncConfirmation });
    setSyncConfirmation("");
  }

  async function withEmergencyBackendEnabled(action) {
    if (!enabled) {
      await updateEmergencyBackendSettings(token, { enabled: true });
    }
    return action();
  }

  return (
    <div className="security-tab-panel" role="tabpanel">
      <div className="security-redundancy-board security-redundancy-board--balanced">
        <div className="security-switch-stack">
          <div className="security-backend-map" aria-label="Backend-Status auswählen">
            <BackendTargetCard
              title="Normales Backend"
              target={backendTargets.active}
              stateLabel={activeCardState.label}
              stateVariant={activeCardState.variant}
              selected={statusTarget === "backend-active"}
              disabled={saving}
              actionsDisabled
              ariaLabel="Status des normalen Backends anzeigen"
              onSelect={() => setStatusTarget("backend-active")}
            />

            <BackendTargetCard
              title="Redundantes Backend"
              target={backendTargets.redundant}
              stateLabel={redundantCardState.label}
              stateVariant={redundantCardState.variant}
              selected={statusTarget === "backend-redundant"}
              disabled={saving}
              actionsDisabled={saving}
              bootDisabled={redundantProcessAlive}
              restartDisabled={!redundantProcessAlive}
              shutdownDisabled={!redundantProcessAlive}
              ariaLabel="Status des redundanten Backends anzeigen"
              onSelect={() => setStatusTarget("backend-redundant")}
              onBoot={() => runAction(
                "Redundantes Backend wurde gebootet.",
                () => withEmergencyBackendEnabled(() => startEmergencyBackend(token)),
                "Bootet",
              )}
              onRestart={() => runAction(
                "Redundantes Backend wurde neu gestartet.",
                () => withEmergencyBackendEnabled(() => restartEmergencyBackend(token)),
                "Startet neu",
              )}
              onShutdown={() => runAction("Redundantes Backend wurde heruntergefahren.", () => stopEmergencyBackend(token), "Fährt herunter")}
            />
          </div>

          <div className="security-database-map" aria-label="Datenbank-Status auswählen">
            <DatabaseTargetCard
              title="Normale Datenbank"
              target={databaseTargets.normal}
              stateLabel={databaseCardStates.normal.label}
              stateVariant={databaseCardStates.normal.variant}
              selected={statusTarget === "database-normal"}
              disabled={saving}
              ariaLabel="Status der normalen Datenbank anzeigen"
              onSelect={() => setStatusTarget("database-normal")}
            />

            <DatabaseTargetCard
              title="Redundante Datenbank"
              target={databaseTargets.redundant}
              stateLabel={databaseCardStates.redundant.label}
              stateVariant={databaseCardStates.redundant.variant}
              selected={statusTarget === "database-redundant"}
              disabled={saving}
              ariaLabel="Status der redundanten Datenbank anzeigen"
              onSelect={() => setStatusTarget("database-redundant")}
            />

            <DatabaseTargetCard
              title="JSON-Notlauf"
              eyebrow="Notlauf"
              target={databaseTargets.json}
              stateLabel={databaseCardStates.json.label}
              stateVariant={databaseCardStates.json.variant}
              selected={statusTarget === "json"}
              disabled={saving}
              ariaLabel="Status des JSON-Notlaufs anzeigen"
              onSelect={() => setStatusTarget("json")}
            />
          </div>
        </div>

        <aside className="security-redundancy-status">
          <div className="security-backend-status__header">
            <div>
              <small>{statusPanel.eyebrow}</small>
              <h3>Status · {statusPanel.title}</h3>
            </div>
            <span className={`security-pill security-pill--${statusPanel.pillVariant}`}>
              {statusPanel.pillLabel}
            </span>
          </div>
          <dl>
            {statusPanel.diagnostics.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {backendView ? <div className="security-backend-status__actions">
            <button
              type="button"
              className="security-action-button security-action-button--primary"
              disabled={saving || inspectedIsActive || inspectedHealth?.reachable !== true}
              onClick={() => switchBackend(inspectedBackend, inspectedTarget.origin)}
            >
              {inspectedIsActive
                ? "Dieses Backend ist aktiv"
                : inspectedHealth?.state === "checking"
                  ? "Status wird geprüft …"
                  : inspectedHealth?.reachable !== true
                    ? "Backend nicht erreichbar"
                    : `Zu ${statusPanel.title} wechseln`}
            </button>
            <button
              type="button"
              className="security-action-button"
              disabled={saving || Object.values(backendHealth).some((health) => health?.state === "checking")}
              onClick={refreshBackendHealth}
            >
              Status neu prüfen
            </button>
          </div> : null}

          {databaseView ? <div className="security-backend-status__actions security-backend-status__actions--single">
            <button
              type="button"
              className="security-action-button"
              disabled={saving || databaseHealth[statusPanel.target]?.state === "checking"}
              onClick={() => refreshDatabaseHealth(statusPanel.target)}
            >
              {databaseHealth[statusPanel.target]?.state === "checking" ? "Verbindung wird geprüft …" : "Datenbank erneut prüfen"}
            </button>
          </div> : null}

          {backendView ? null : <section className="security-database-routing" aria-label="Datenbank Schreibziele">
            <div className="security-database-routing__header">
              <div>
                <h4>Schreibziele</h4>
                <small>Mindestens eine Datenbank bleibt aktiv; JSON übernimmt nur im Ausfall.</small>
              </div>
              <span className={`security-pill ${databaseRouting.degraded ? "security-pill--warn" : "security-pill--ok"}`}>
                {databaseRouting.degraded ? "Eingeschränkt" : "Bereit"}
              </span>
            </div>

            <div className="security-database-routing__target">
              <span>
                <strong>Normale Datenbank</strong>
                <small>{databaseRouting.mode === "both" ? "Primäres Schreibziel" : "Für Schreibvorgänge verwenden"}</small>
              </span>
              <button
                type="button"
                className="security-switch"
                role="switch"
                aria-label="Normale Datenbank als Schreibziel verwenden"
                aria-checked={Boolean(databaseRouting.writeTargets?.normal)}
                disabled={saving}
                onClick={() => setDatabaseWriteTarget(
                  "normal",
                  !Boolean(databaseRouting.writeTargets?.normal),
                )}
              >
                <span className="security-switch__slider" />
              </button>
            </div>

            <div className="security-database-routing__target">
              <span>
                <strong>Redundante Datenbank</strong>
                <small>{databaseRouting.mode === "both" ? "Bestmögliche Spiegelung" : "Für Schreibvorgänge verwenden"}</small>
              </span>
              <button
                type="button"
                className="security-switch"
                role="switch"
                aria-label="Redundante Datenbank als Schreibziel verwenden"
                aria-checked={Boolean(databaseRouting.writeTargets?.redundant)}
                disabled={saving}
                onClick={() => setDatabaseWriteTarget(
                  "redundant",
                  !Boolean(databaseRouting.writeTargets?.redundant),
                )}
              >
                <span className="security-switch__slider" />
              </button>
            </div>

            <div className="security-database-routing__target security-database-routing__target--json">
              <span>
                <strong>JSON-Notlauf</strong>
                <small>
                  {jsonEmergencyEngaged
                    ? pendingJsonWrites > 0
                      ? `${pendingJsonWrites} Schreibvorgänge verschlüsselt zwischengespeichert`
                      : "Automatisch aktiv – neue Schreibvorgänge werden verschlüsselt gespeichert"
                    : pendingJsonWrites > 0
                      ? `${pendingJsonWrites} Vorgänge warten auf manuellen Abgleich`
                      : "Automatisch verwenden, wenn alle Schreibziele ausfallen"}
                </small>
              </span>
              <button
                type="button"
                className="security-switch"
                role="switch"
                aria-label="JSON-Notlauf verwenden"
                aria-checked={Boolean(jsonEmergency.enabled)}
                disabled={saving}
                onClick={() => setJsonEmergencyEnabled(!Boolean(jsonEmergency.enabled))}
              >
                <span className="security-switch__slider" />
              </button>
            </div>

            <p className="security-database-routing__note">
              Bei „Beide“ bleibt Normal primär. Sind alle gewählten PostgreSQL-Ziele ausgefallen, werden neue Schreibvorgänge verschlüsselt im JSON-Notlauf gesammelt. Sobald eine Datenbank wieder erreichbar ist, gehen neue Vorgänge automatisch wieder dorthin.
            </p>

            {pendingJsonWrites > 0 ? (
              <section className="security-json-emergency-replay" aria-label="JSON-Notlauf abgleichen">
                <div>
                  <strong>{pendingJsonWrites} offene JSON-Vorgänge</strong>
                  <small>Der Abgleich wird bewusst nur manuell gestartet; die Warteschlange wird erst nach erfolgreicher Übernahme geleert.</small>
                </div>
                <div className="security-json-emergency-replay__actions">
                  <button
                    type="button"
                    className="security-action-button"
                    disabled={saving || databaseHealth.normal?.available !== true}
                    onClick={() => replayJsonEmergency("normal")}
                  >
                    In Normal übernehmen
                  </button>
                  <button
                    type="button"
                    className="security-action-button"
                    disabled={saving || databaseHealth.redundant?.available !== true}
                    onClick={() => replayJsonEmergency("redundant")}
                  >
                    In Redundant übernehmen
                  </button>
                </div>
              </section>
            ) : null}

            <details className="security-database-full-sync">
              <summary>Manuellen Vollabgleich starten</summary>
              <div className="security-database-full-sync__body">
                <label>
                  <span>Richtung</span>
                  <select value={syncDirection} onChange={(event) => {
                    setSyncDirection(event.target.value);
                    setSyncConfirmation("");
                  }}>
                    <option value="normal-to-redundant">Normal → Redundant</option>
                    <option value="redundant-to-normal">Redundant → Normal</option>
                  </select>
                </label>
                <div className="security-database-full-sync__warning">
                  Die Zieldatenbank wird vollständig überschrieben. Während des Abgleichs sind Schreibvorgänge gesperrt.
                </div>
                <label>
                  <span>Zur Bestätigung exakt eingeben:</span>
                  <code>{expectedConfirmation}</code>
                  <input
                    value={syncConfirmation}
                    onChange={(event) => setSyncConfirmation(event.target.value)}
                    placeholder={expectedConfirmation}
                    autoComplete="off"
                  />
                </label>
                {!bothReachable ? <small>Der Vollabgleich wird freigegeben, sobald beide Datenbanken erreichbar sind.</small> : null}
                <button
                  type="button"
                  className="security-action-button security-action-button--danger"
                  disabled={saving || !bothReachable || syncConfirmation !== expectedConfirmation}
                  onClick={startFullSync}
                >
                  {saving ? "Vollabgleich läuft …" : "Zieldatenbank vollständig überschreiben"}
                </button>
                {databaseRouting.lastFullSync?.completedAt ? (
                  <small>Letzter Vollabgleich: {new Date(databaseRouting.lastFullSync.completedAt).toLocaleString("de-DE")}</small>
                ) : null}
              </div>
            </details>
          </section>}
        </aside>
      </div>
    </div>
  );
}
