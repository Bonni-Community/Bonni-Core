import { useState } from "react";

import {
  formatBonniCoreVersion,
  formatDeploymentLifecycleDate,
  formatDeploymentLifecycleRemaining,
} from "./localUpdatePresentation.js";

export default function DeploymentLifecyclePanel({
  lifecycle,
  initialView = "verification",
  finalizing = false,
  rollingBack = false,
  confirmFinalize = false,
  confirmRollback = false,
  actionError = "",
  onRequestFinalize,
  onRequestRollback,
  onCancelAction,
  onFinalize,
  onRollback,
}) {
  const [activeView, setActiveView] = useState(initialView === "status" ? "status" : "verification");
  if (!lifecycle) return null;
  const proofAvailable = Boolean(
    lifecycle.holdId
    && Number.isSafeInteger(lifecycle.generation)
    && lifecycle.generation > 0,
  );
  const busy = finalizing || rollingBack || lifecycle.phase === "rollback";
  const remaining = formatDeploymentLifecycleRemaining(lifecycle.remainingMs);
  const statusActive = activeView === "status";
  const verificationActive = activeView === "verification";

  return (
    <section className="cc-update-observation" aria-labelledby="cc-update-observation-title">
      <nav className="cc-update-observation__tabs" role="tablist" aria-label="Aktualisierungsansichten">
        <button
          id="cc-update-status-tab"
          type="button"
          role="tab"
          aria-selected={statusActive}
          aria-controls="cc-update-status-panel"
          onClick={() => setActiveView("status")}
        >
          Status
        </button>
        <button
          id="cc-update-verification-tab"
          type="button"
          role="tab"
          aria-selected={verificationActive}
          aria-controls="cc-update-verification-panel"
          onClick={() => setActiveView("verification")}
        >
          Funktionsprüfung
        </button>
      </nav>

      {statusActive ? (
        <div
          id="cc-update-status-panel"
          className="cc-update-observation__view"
          role="tabpanel"
          aria-labelledby="cc-update-status-tab"
        >
          <div className="cc-update-observation__heading">
            <div>
              <span>Bonni Core · Status</span>
              <h2 id="cc-update-observation-title">
                Bonni Core {formatBonniCoreVersion(lifecycle.targetVersion)} ist aktiv
              </h2>
              <p>Funktionsprüfung läuft</p>
            </div>
            <dl>
              <div><dt>Aktiver Stand</dt><dd>{formatBonniCoreVersion(lifecycle.targetVersion)}</dd></div>
              <div><dt>Rückfallstand</dt><dd>{formatBonniCoreVersion(lifecycle.previousVersion)}</dd></div>
              <div><dt>Aktiv seit</dt><dd>{formatDeploymentLifecycleDate(lifecycle.activatedAt)}</dd></div>
              <div><dt>Automatische Übernahme</dt><dd>{formatDeploymentLifecycleDate(lifecycle.holdUntil)}</dd></div>
            </dl>
          </div>

          <p className="cc-update-observation__note">
            Der neue Programmstand ist aktiv und kann normal verwendet werden. Die Funktionsprüfung bleibt {remaining} aktiv.
          </p>
        </div>
      ) : (
        <div
          id="cc-update-verification-panel"
          className="cc-update-observation__view"
          role="tabpanel"
          aria-labelledby="cc-update-verification-tab"
        >
          <div className="cc-update-observation__heading">
            <div>
              <span>Bonni Core · Status</span>
              <h2 id="cc-update-observation-title">Funktionsüberprüfung durch Anwender</h2>
              <p>{remaining} aktiv</p>
            </div>
            <dl>
              <div><dt>Aktiv seit</dt><dd>{formatDeploymentLifecycleDate(lifecycle.activatedAt)}</dd></div>
              <div><dt>Automatische Übernahme</dt><dd>{formatDeploymentLifecycleDate(lifecycle.holdUntil)}</dd></div>
            </dl>
          </div>

          <p className="cc-update-observation__note">
            Bonni Core nutzt weiterhin dieselbe gemeinsame Datenbank. Ein Downgrade stellt nur den gesicherten Programmstand wieder her; Nutzdaten werden nicht zurückgesetzt.
          </p>

          {confirmRollback ? (
            <div className="cc-update-observation__confirm" role="group" aria-labelledby="cc-update-rollback-confirm-title">
              <strong id="cc-update-rollback-confirm-title">Auf Bonni Core {formatBonniCoreVersion(lifecycle.previousVersion)} zurückkehren?</strong>
              <p>Vor dem Rückfall wird erneut eine Sicherung erstellt. Danach installiert der Update-Dienst den hashgeprüften Vorgängerstand und startet Bonni Core neu.</p>
              <div>
                <button type="button" className="is-danger" onClick={onRollback} disabled={busy || !proofAvailable}>
                  {rollingBack ? "Downgrade wird gestartet …" : "Downgrade bestätigen"}
                </button>
                <button type="button" onClick={onCancelAction} disabled={busy}>Abbrechen</button>
              </div>
            </div>
          ) : confirmFinalize ? (
            <div className="cc-update-observation__confirm" role="group" aria-labelledby="cc-update-finalize-confirm-title">
              <strong id="cc-update-finalize-confirm-title">Bonni Core {formatBonniCoreVersion(lifecycle.targetVersion)} jetzt übernehmen?</strong>
              <p>Die 14-Tage-Prüfphase endet vorzeitig. Der gesicherte Vorgängerstand wird entfernt und das nächste Update wieder freigegeben.</p>
              <div>
                <button type="button" className="is-primary" onClick={onFinalize} disabled={busy || !proofAvailable}>
                  {finalizing ? "Wird übernommen …" : "Übernehmen bestätigen"}
                </button>
                <button type="button" onClick={onCancelAction} disabled={busy}>Abbrechen</button>
              </div>
            </div>
          ) : (
            <div className="cc-update-observation__actions">
              <button
                type="button"
                className="is-downgrade"
                onClick={onRequestRollback}
                disabled={busy || !proofAvailable || !lifecycle.canRollback}
              >
                <span>Downgrade</span>
                <strong>{formatBonniCoreVersion(lifecycle.previousVersion)}</strong>
              </button>
              <button
                type="button"
                className="is-accept"
                onClick={onRequestFinalize}
                disabled={busy || !proofAvailable || !lifecycle.canFinalize}
              >
                <span>Übernehmen</span>
                <strong>{formatBonniCoreVersion(lifecycle.targetVersion)}</strong>
              </button>
            </div>
          )}

          {!proofAvailable ? (
            <p className="cc-update-observation__error" role="status">Der servergebundene Prüfbeleg fehlt. Beide Aktionen bleiben sicher gesperrt.</p>
          ) : null}
          {actionError ? <p className="cc-update-observation__error" role="alert">{actionError}</p> : null}
        </div>
      )}
    </section>
  );
}
