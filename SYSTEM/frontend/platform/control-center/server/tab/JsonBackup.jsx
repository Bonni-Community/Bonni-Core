import { useEffect, useState } from "react";

import {
  buildRunContainerCandidate,
  getRunContainerStatus,
  promoteRunContainerCandidate,
} from "../../../../system/api/runContainerApi.js";
import {
  SecurityField,
  SecurityToggleRow,
  StatusPill,
  formatDateTime,
} from "../components/ServerTabComponents.jsx";

function RunContainerStatusPanel({ token }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setError(null);
      setStatus(await getRunContainerStatus({ token }));
    } catch (err) {
      setError(err?.message || "System-Abgleich konnte nicht geladen werden.");
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function runAction(message, action) {
    setBusy(true);
    try {
      setError(null);
      await action();
      await refresh();
    } catch (err) {
      setError(err?.message || message || "Aktion fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  const identity = status?.identity || {};
  const valid = status?.matchesDatabase !== false;
  const candidate = status?.candidate || status?.candidateIdentity || status?.candidateMeta || null;

  return (
    <div className="security-system-sync-card">
      <div className="security-config-editor__header">
        <div>
          <span className="security-card__eyebrow">System-Abgleich</span>
          <h3>Abgleich & Aktualisierung</h3>
        </div>
        <StatusPill variant={valid ? "ok" : "error"}>{valid ? "gültig" : "prüfen"}</StatusPill>
      </div>

      <p className="security-system-sync-card__lead">
        Prüft, ob RunContainer, Datenbank und Systemstand zusammenpassen. Candidate kann hier vorbereitet und aktiviert werden.
      </p>

      {error ? <p className="security-sync-error">{error}</p> : null}

      <div className="security-sync-kv-grid">
        <div><span>Status</span><strong>{valid ? "gültig" : "ungültig"}</strong></div>
        <div><span>Erstellt am</span><strong>{formatDateTime(identity.createdAt)}</strong></div>
        <div><span>System-Version</span><strong>{identity.systemVersion || "—"}</strong></div>
        <div><span>Schema-Version</span><strong>{identity.schemaVersion || "—"}</strong></div>
        <div><span>Benutzeranzahl</span><strong>{identity.userCount ?? "—"}</strong></div>
        <div><span>Candidate</span><strong>{candidate ? "vorhanden" : "—"}</strong></div>
      </div>

      <div className="security-sync-actions">
        <button type="button" disabled={busy} onClick={refresh}>Abgleich aktualisieren</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction("Candidate konnte nicht gebaut werden.", () => buildRunContainerCandidate({ token, reason: "control-center" }))}
        >
          Candidate bauen
        </button>
        <button
          type="button"
          className="security-primary"
          disabled={busy}
          onClick={() => runAction("Candidate konnte nicht aktiviert werden.", () => promoteRunContainerCandidate({ token }))}
        >
          Candidate aktivieren
        </button>
      </div>
    </div>
  );
}

export default function JsonBackupTab({ settings, jsonForm, onPatchJson, onReload, onSave, saving, token }) {
  const runSystemRoot = settings?.runtime?.runSystemSystemRoot || "run_system/system";

  return (
    <div className="security-tab-panel" role="tabpanel">
      <div className="security-json-grid security-json-grid--system-sync">
        <div className="security-config-editor">
          <div className="security-config-editor__header">
            <div>
              <span className="security-card__eyebrow">JSON / Backup</span>
              <h3>Systemdateien</h3>
            </div>
            <StatusPill variant={jsonForm.enabled ? "ok" : "neutral"}>{jsonForm.enabled ? "Aktiv" : "Inaktiv"}</StatusPill>
          </div>
          <div className="security-config-inline-switches security-config-inline-switches--single">
            <SecurityToggleRow
              title="JSON-Systemdateien verwenden"
              description="Für RunContainer, lokale Systemdiagnose und technische Statusdateien. Die Einstellung wird in der DB gespeichert."
              checked={Boolean(jsonForm.enabled)}
              onChange={(enabled) => onPatchJson({ enabled })}
            />
            <SecurityToggleRow
              title="JSON-Backups vorbereiten"
              description="Erlaubt exportierbare Sicherungen in Datei-Form. Live-Daten bleiben in PostgreSQL."
              checked={Boolean(jsonForm.backupEnabled)}
              onChange={(backupEnabled) => onPatchJson({ backupEnabled })}
            />
          </div>
          <div className="security-redundancy-form security-database-form security-database-form--single">
            <SecurityField
              label="JSON-/Backup-Pfad"
              value={jsonForm.backupPath}
              placeholder={runSystemRoot}
              onChange={(backupPath) => onPatchJson({ backupPath })}
              help="Leer lassen nutzt den Standardpfad aus RUN_SYSTEM_ROOT. Der Pfad selbst wird in SystemSetting gespeichert."
            />
          </div>
          <div className="security-redundancy-actions security-redundancy-actions--visible">
            <span className="security-redundancy-actions__spacer" />
            <button type="button" className="security-action-button" onClick={onReload} disabled={saving}>Neu laden</button>
            <button type="button" className="security-action-button security-action-button--primary" onClick={onSave} disabled={saving}>Konfiguration speichern</button>
          </div>
        </div>

        <RunContainerStatusPanel token={token} />
      </div>
    </div>
  );
}
