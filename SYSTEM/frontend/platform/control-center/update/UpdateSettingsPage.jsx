import { useEffect, useState } from "react";

import { fetchCoreUpdateStatus, saveCoreUpdateSettings } from "../../../system/api/coreUpdateApi.js";
import "./UpdateSettingsPage.css";

export default function UpdateSettingsPage({ token, onBack }) {
  const [settings, setSettings] = useState(null);
  const [releaseSource, setReleaseSource] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    fetchCoreUpdateStatus(token)
      .then((payload) => {
        setSettings(payload.settings);
        setReleaseSource(payload.releaseSource || null);
      })
      .catch((loadError) => setError(loadError?.message || "Einstellungen konnten nicht geladen werden."));
  }, [token]);

  async function save() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await saveCoreUpdateSettings(token, settings);
      setSettings(result.settings);
      setMessage("Einstellungen gespeichert.");
    } catch (saveError) {
      setError(saveError?.message || "Einstellungen konnten nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cc-menu-layout-page cc-update-settings-page">
      <header className="cc-user-page__header cc-menu-page-header">
        <div><p className="cc-monitoring-eyebrow">Bonni Core Update</p><h1>Einstellungen</h1><p>Verhalten der zentralen Bonni-Core-Aktualisierung.</p></div>
        <button type="button" onClick={onBack}>Schließen</button>
      </header>
      {error ? <div className="cc-update-settings-message is-error">{error}</div> : null}
      {message ? <div className="cc-update-settings-message is-success">{message}</div> : null}
      <section className="cc-update-settings-source" aria-label="Bonni-Core-Updatequelle">
        <div>
          <span>Feste Updatequelle</span>
          <strong>Bonni-Community/bonni-core</strong>
          <small>Geprüfte Releasepakete werden später serverseitig von GitHub geladen und nach der Prüfung an UPDATE übergeben.</small>
        </div>
        <a
          href={releaseSource?.repositoryUrl || "https://github.com/Bonni-Community/bonni-core"}
          target="_blank"
          rel="noreferrer"
        >Repository öffnen</a>
      </section>
      {settings ? (
        <div className="cc-update-settings-card">
          <label><div><strong>Automatisch nach Updates suchen</strong><small>Bonni Core prüft regelmäßig, ob eine neue stabile Version vorhanden ist.</small></div><input type="checkbox" checked={settings.automaticChecks} onChange={(event) => setSettings({ ...settings, automaticChecks: event.target.checked })} /></label>
          <label><div><strong>Updatepaket automatisch herunterladen</strong><small>Download und Prüfung laufen automatisch; die Installation wird weiterhin bestätigt.</small></div><input type="checkbox" checked={settings.automaticDownload} disabled={!settings.automaticChecks} onChange={(event) => setSettings({ ...settings, automaticDownload: event.target.checked })} /></label>
          <label><div><strong>Backup vor jeder Installation</strong><small>Diese Sicherheitsprüfung kann nicht abgeschaltet werden.</small></div><input type="checkbox" checked readOnly disabled /></label>
          <label className="cc-update-settings-select"><div><strong>Installation</strong><small>Das Umschalten erfolgt ausschließlich nach einer Bestätigung durch einen System-Administrator.</small></div><select value="manual" disabled><option value="manual">Nur manuell</option></select></label>
          <footer><span>Updatekanal: Stabil</span><button type="button" onClick={save} disabled={busy}>{busy ? "Speichere …" : "Speichern"}</button></footer>
        </div>
      ) : <p>Lade Einstellungen …</p>}
    </section>
  );
}
