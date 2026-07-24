import { useEffect, useState } from "react";

import OidcTab, { EMPTY_OIDC, normalizeOidc } from "./tab/OIDC.jsx";
import {
  getControlCenterSystemSettings,
  saveControlCenterSystemSettings,
} from "../../../system/api/systemSettingsApi.js";

export default function ProviderPage({ token }) {
  const [settings, setSettings] = useState(null);
  const [oidc, setOidc] = useState(EMPTY_OIDC);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const result = await getControlCenterSystemSettings(token);
      setSettings(result);
      setOidc(normalizeOidc(result));
    } catch (err) {
      setError(err?.message || "Provider-Konfiguration konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const payload = {
        oidc,
        database: settings?.database || {},
        json: settings?.json || {},
      };
      const result = await saveControlCenterSystemSettings(token, payload);
      setSettings(result);
      setOidc(normalizeOidc(result));
      setMessage("Provider-Konfiguration wurde gespeichert.");
    } catch (err) {
      setError(err?.message || "Provider-Konfiguration konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  function patchOidc(patch) {
    setOidc((current) => ({ ...current, ...patch }));
  }

  useEffect(() => {
    loadSettings();
  }, [token]);

  return (
    <section className="cc-provider-page cc-system-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Provider</h1>
          <p>Anmeldung und externe Identity Provider verwalten.</p>
        </div>
      </div>

      <div className="cc-system-tabbar" role="tablist" aria-label="Provider-Konfiguration">
        <button
          type="button"
          className="cc-system-tab cc-system-tab--active"
          aria-selected="true"
        >
          OIDC
        </button>
      </div>

      <div className="cc-provider-content">
        {message ? <p className="cc-system-success">{message}</p> : null}
        {error ? <p className="cc-system-error">{error}</p> : null}

        <OidcTab oidc={oidc} settings={settings} onPatch={patchOidc} />

        <div className="cc-system-footer-actions">
          <button className="cc-settings-action-button" type="button" onClick={loadSettings} disabled={loading || saving}>Neu laden</button>
          <button className="cc-settings-action-button cc-settings-action-button--primary" type="button" onClick={saveSettings} disabled={loading || saving}>Konfiguration speichern</button>
        </div>
      </div>
    </section>
  );
}
