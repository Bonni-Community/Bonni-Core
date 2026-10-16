import { useEffect, useState } from "react";

import { fetchCoreUpdateStatus, saveCoreUpdateSettings } from "../../../system/api/coreUpdateApi.js";
import "./UpdateSettingsPage.css";

export default function UpdateSettingsPage({ token, onBack }) {
  const [settings, setSettings] = useState(null);
  const [serverTimeZone, setServerTimeZone] = useState("");
  const [releaseSource, setReleaseSource] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    fetchCoreUpdateStatus(token)
      .then((payload) => {
        setSettings(payload.settings);
        setServerTimeZone(payload.serverTimeZone || "");
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
          <small>Bonni Core lädt öffentliche, signierte Releases direkt von GitHub nach UPDATE. Ein separater Dienst führt die Installation aus.</small>
        </div>
        <a
          href={releaseSource?.repositoryUrl || "https://github.com/Bonni-Community/bonni-core"}
          target="_blank"
          rel="noreferrer"
        >Repository öffnen</a>
      </section>
      {settings ? (
        <div className="cc-update-settings-card">
          <label className="cc-update-settings-select"><div><strong>Update-Automatik</strong><small>Die manuelle Suche und Installation bleiben in jeder Betriebsart verfügbar.</small></div><select aria-label="Update-Automatik" value={settings.mode || (settings.automaticChecks ? "check" : "off")} onChange={event => setSettings({...settings, mode:event.target.value})}>
            <option value="check">Nur nach Updates suchen</option>
            <option value="scheduled">Automatisch zur Uhrzeit installieren</option>
            <option value="off">Automatik ausgeschaltet</option>
          </select></label>
          {settings.mode === "scheduled" ? <>
            <label><div><strong>Tägliche Installationszeit</strong><small>Während der Umschaltung ist Bonni Core kurz nicht verfügbar.</small></div><input aria-label="Tägliche Installationszeit" type="time" required value={settings.scheduleTime || "03:00"} onChange={event => setSettings({...settings, scheduleTime:event.target.value})} /></label>
            <p>Es gilt die Serverzeit{serverTimeZone ? ` (${serverTimeZone})` : ""}. Sommer- und Winterzeit richten sich nach dem Server. Verpasste Termine werden nicht tagsüber nachgeholt.</p>
          </> : null}
          <label><div><strong>Sicherung und Installationsprüfung</strong><small>Vor jedem Wechsel: Rückkehrpunkt erstellen und die neue Version im separaten Backend prüfen.</small></div><input type="checkbox" checked readOnly disabled /></label>
          <footer><span>Updatekanal: Stabil</span><button type="button" onClick={save} disabled={busy}>{busy ? "Speichere …" : "Speichern"}</button></footer>
        </div>
      ) : <p>Lade Einstellungen …</p>}
    </section>
  );
}
