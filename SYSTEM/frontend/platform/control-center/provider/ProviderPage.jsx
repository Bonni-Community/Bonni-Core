import { useEffect, useState } from "react";

import OidcTab, { EMPTY_OIDC, normalizeOidc } from "./tab/OIDC.jsx";
import TwoFactorTab, { EMPTY_TWO_FACTOR, normalizeTwoFactor } from "./tab/TwoFactor.jsx";
import {
  getControlCenterSystemSettings,
  saveControlCenterSystemSettings,
} from "../../../system/api/systemSettingsApi.js";

export default function ProviderPage({ token }) {
  const [settings, setSettings] = useState(null);
  const [oidc, setOidc] = useState(EMPTY_OIDC);
  const [twoFactor, setTwoFactor] = useState(EMPTY_TWO_FACTOR);
  const [activeTab, setActiveTab] = useState("oidc");
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
      setTwoFactor(normalizeTwoFactor(result));
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
        twoFactor,
        database: settings?.database || {},
        json: settings?.json || {},
      };
      const result = await saveControlCenterSystemSettings(token, payload);
      setSettings(result);
      setOidc(normalizeOidc(result));
      setTwoFactor(normalizeTwoFactor(result));
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

  function patchTwoFactor(patch) {
    setTwoFactor((current) => ({ ...current, ...patch }));
  }

  useEffect(() => {
    loadSettings();
  }, [token]);

  return (
    <section className="cc-provider-page cc-system-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Provider</h1>
          <p>Anmeldung, Identitätsanbieter und Zwei-Faktor-Authentifizierung verwalten.</p>
        </div>
      </div>

      <div className="cc-system-tabbar" role="tablist" aria-label="Provider-Konfiguration">
        <button
          type="button"
          className={`cc-system-tab ${activeTab === "oidc" ? "cc-system-tab--active" : ""}`}
          aria-selected={activeTab === "oidc"}
          onClick={() => setActiveTab("oidc")}
        >
          OIDC
        </button>
        <button
          type="button"
          className={`cc-system-tab ${activeTab === "two-factor" ? "cc-system-tab--active" : ""}`}
          aria-selected={activeTab === "two-factor"}
          onClick={() => setActiveTab("two-factor")}
        >
          Zwei-Faktor-Authentifizierung (2FA)
        </button>
      </div>

      <div className="cc-provider-content">
        {message ? <p className="cc-system-success">{message}</p> : null}
        {error ? <p className="cc-system-error">{error}</p> : null}

        {activeTab === "oidc"
          ? <OidcTab oidc={oidc} settings={settings} onPatch={patchOidc} />
          : <TwoFactorTab twoFactor={twoFactor} onPatch={patchTwoFactor} />}

        <div className="cc-system-footer-actions">
          <button className="cc-settings-action-button" type="button" onClick={loadSettings} disabled={loading || saving}>Neu laden</button>
          <button className="cc-settings-action-button cc-settings-action-button--primary" type="button" onClick={saveSettings} disabled={loading || saving}>Konfiguration speichern</button>
        </div>
      </div>
    </section>
  );
}
