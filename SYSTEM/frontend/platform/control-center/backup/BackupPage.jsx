import { useEffect, useState } from "react";

import {
  createSystemBackup,
  fetchSystemBackups,
  requestSystemRestore,
  validateSystemBackup,
} from "../../../system/api/systemBackupApi.js";
import "./BackupPage.css";

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusLabel(status) {
  if (status === "completed") return "Vollständig";
  if (status === "running") return "Wird erstellt";
  if (status === "failed") return "Fehlgeschlagen";
  return status || "Unbekannt";
}

export default function BackupPage({ token }) {
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [restoreBackup, setRestoreBackup] = useState(null);
  const [confirmation, setConfirmation] = useState("");

  async function load() {
    if (!token) return;
    try {
      setOverview(await fetchSystemBackups(token));
      setError("");
    } catch (loadError) {
      setError(loadError?.message || "Backups konnten nicht geladen werden.");
    }
  }

  useEffect(() => {
    load();
  }, [token]);

  async function createBackup() {
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const result = await createSystemBackup(token);
      setMessage(`Backup ${result.backup?.id || ""} wurde erstellt und geprüft.`);
      await load();
    } catch (actionError) {
      setError(actionError?.message || "Backup konnte nicht erstellt werden.");
    } finally {
      setBusy("");
    }
  }

  async function validateBackup(backup) {
    setBusy(`validate:${backup.id}`);
    setError("");
    setMessage("");
    try {
      const result = await validateSystemBackup(token, backup.id);
      setMessage(`${backup.id}: ${result.checkedFiles} Dateien erfolgreich geprüft.`);
    } catch (actionError) {
      setError(actionError?.message || "Backupprüfung fehlgeschlagen.");
    } finally {
      setBusy("");
    }
  }

  async function requestRestore() {
    if (!restoreBackup || confirmation !== restoreBackup.id) return;
    setBusy(`restore:${restoreBackup.id}`);
    setError("");
    setMessage("");
    try {
      const result = await requestSystemRestore(token, restoreBackup.id, confirmation);
      setMessage(result.message || "Wiederherstellung wurde für den nächsten kontrollierten Start vorgemerkt.");
      setRestoreBackup(null);
      setConfirmation("");
      await load();
    } catch (actionError) {
      setError(actionError?.message || "Wiederherstellung konnte nicht vorbereitet werden.");
    } finally {
      setBusy("");
    }
  }

  const backups = overview?.backups || [];
  const latest = overview?.latest;

  return (
    <section className="cc-menu-layout-page cc-backup-page">
      <header className="cc-user-page__header cc-menu-page-header cc-backup-header">
        <div>
          <p className="cc-backup-eyebrow">Bonni Core</p>
          <h1>Backup &amp; Wiederherstellung</h1>
          <p>Datenbank, Einstellungen und persistente Dateien gemeinsam sichern und vor einer Wiederherstellung prüfen.</p>
        </div>
        <button type="button" onClick={createBackup} disabled={Boolean(busy)}>
          {busy === "create" ? "Backup läuft …" : "Neues Backup"}
        </button>
      </header>

      {error ? <div className="cc-backup-message is-error">{error}</div> : null}
      {message ? <div className="cc-backup-message is-success">{message}</div> : null}
      {overview?.restoreRequest ? (
        <div className={`cc-backup-message${overview.restoreRequest.status === "failed" ? " is-error" : " is-warning"}`}>
          Wiederherstellung {overview.restoreRequest.status === "failed" ? "fehlgeschlagen" : "vorgemerkt"}: {overview.restoreRequest.backupId}
        </div>
      ) : null}

      <section className="cc-backup-summary">
        <article><span>Bereitschaft</span><strong>{overview?.status === "running" ? "Sicherung läuft" : "Bereit"}</strong></article>
        <article><span>Letztes Backup</span><strong>{latest ? new Date(latest.createdAt).toLocaleString("de-DE") : "Noch keines"}</strong></article>
        <article><span>Gesicherte Bereiche</span><strong>Datenbank · Einstellungen · Dateien</strong></article>
        <article><span>Prüfung</span><strong>SHA-256 für jede Datei</strong></article>
      </section>

      <section className="cc-backup-list-section">
        <div className="cc-backup-section-heading"><div><span>Rückkehrpunkte</span><h2>Vorhandene Backups</h2></div><b>{backups.length}</b></div>
        {backups.length ? (
          <div className="cc-backup-list">
            {backups.map((backup) => (
              <article key={backup.id} className={`cc-backup-card is-${backup.status}`}>
                <div className="cc-backup-card__main">
                  <div className="cc-backup-card__title">
                    <span className="cc-backup-dot" aria-hidden="true" />
                    <div><strong>{backup.id}</strong><small>{new Date(backup.createdAt).toLocaleString("de-DE")} · Bonni Core {backup.coreVersion}</small></div>
                  </div>
                  <span>{statusLabel(backup.status)}</span>
                </div>
                <div className="cc-backup-components">
                  {(backup.components || []).map((component) => (
                    <div key={component.key}>
                      <span>{component.status === "completed" ? "✓" : component.status === "failed" ? "×" : "○"}</span>
                      <div><b>{component.label}</b><small>{component.fileCount || 0} Dateien · {formatBytes(component.sizeBytes)}</small></div>
                    </div>
                  ))}
                </div>
                {backup.error ? <p className="cc-backup-card__error">{backup.error}</p> : null}
                <div className="cc-backup-card__actions">
                  <button type="button" onClick={() => validateBackup(backup)} disabled={Boolean(busy) || backup.status !== "completed"}>
                    {busy === `validate:${backup.id}` ? "Prüfe …" : "Backup prüfen"}
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => { setRestoreBackup(backup); setConfirmation(""); }}
                    disabled={Boolean(busy) || backup.status !== "completed"}
                  >
                    Wiederherstellen
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="cc-backup-empty">Noch kein Backup vorhanden.</div>}
      </section>

      {restoreBackup ? (
        <div className="cc-backup-restore-backdrop" role="presentation" onMouseDown={() => setRestoreBackup(null)}>
          <section className="cc-backup-restore-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span>Wiederherstellung</span>
            <h2>{restoreBackup.id}</h2>
            <p>Bonni Core erstellt zuerst ein zusätzliches Sicherheitsbackup. Danach wird dieser Rückkehrpunkt beim nächsten kontrollierten Backend-Start wiederhergestellt.</p>
            <label>
              <span>Zur Bestätigung die Backup-ID eingeben</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={restoreBackup.id} />
            </label>
            <div>
              <button type="button" onClick={() => setRestoreBackup(null)}>Abbrechen</button>
              <button type="button" className="is-danger" onClick={requestRestore} disabled={confirmation !== restoreBackup.id || Boolean(busy)}>
                {busy.startsWith("restore:") ? "Wird vorbereitet …" : "Wiederherstellung vormerken"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
