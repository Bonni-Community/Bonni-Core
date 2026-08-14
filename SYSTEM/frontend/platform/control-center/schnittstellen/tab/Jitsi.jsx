import { useEffect, useState } from "react";

import {
  createJitsiAdminChallenge,
  getJitsiSettings,
  saveJitsiSettings,
  testJitsiSettings,
  verifyJitsiAdminChallenge,
} from "../../../../system/api/jitsiSettingsApi.js";

const EMPTY = { enabled: false, serverUrl: "", appId: "", secret: "", secretConfigured: false };

export default function JitsiTab({ token }) {
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [proof, setProof] = useState({ code: "", token: "", password: "", recoveryCode: "" });
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await getJitsiSettings(token);
      setForm({ ...EMPTY, ...(result?.settings || {}), secret: "" });
    } catch (loadError) {
      setError(loadError?.message || "Jitsi-Konfiguration konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token]);

  function patch(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function testConnection() {
    setMessage("");
    setError("");
    try {
      const result = await testJitsiSettings(token, form.serverUrl);
      if (!result?.ok) throw new Error(`Jitsi antwortet nicht gültig (HTTP ${result?.status || 0}).`);
      setMessage("Jitsi-Server wurde erfolgreich geprüft.");
    } catch (testError) {
      setError(testError?.message || "Jitsi-Verbindung konnte nicht geprüft werden.");
    }
  }

  async function beginSave() {
    setMessage("");
    setError("");
    try {
      const result = await createJitsiAdminChallenge(token);
      setChallenge(result?.challenge || result);
      setProof({ code: "", token: "", password: "", recoveryCode: "" });
      setUseRecoveryCode(false);
    } catch (challengeError) {
      setError(challengeError?.message || "Für diese Änderung muss die Zwei-Faktor-Authentifizierung (2FA) eingerichtet sein.");
    }
  }

  async function confirmSave() {
    setSaving(true);
    setError("");
    try {
      const challengeId = challenge?.id;
      if (!challengeId) throw new Error("Abfrage der Zwei-Faktor-Authentifizierung fehlt.");
      const submittedProof = challenge?.provider === "local"
        ? useRecoveryCode
          ? { recoveryCode: proof.recoveryCode }
          : { code: proof.code }
        : Object.fromEntries((challenge?.proofFields || []).map((field) => [field.name, proof[field.name]]));
      await verifyJitsiAdminChallenge(token, challengeId, submittedProof);
      const result = await saveJitsiSettings(token, {
        challengeId,
        enabled: form.enabled,
        serverUrl: form.serverUrl,
        appId: form.appId,
        ...(form.secret ? { secret: form.secret } : {}),
      });
      setForm({ ...EMPTY, ...(result?.settings || {}), secret: "" });
      setChallenge(null);
      setMessage("Jitsi-Konfiguration wurde geschützt gespeichert.");
    } catch (saveError) {
      setError(saveError?.message || "Jitsi-Konfiguration konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cc-system-tab-panel">
      {message ? <p className="cc-system-success">{message}</p> : null}
      {error ? <p className="cc-system-error">{error}</p> : null}
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>Jitsi / WebRTC</h2>
            <p>Ein zentraler, geschützter Videoserver für alle Bonni-Anwendungen.</p>
          </div>
          <span className={`cc-system-status ${form.enabled ? "cc-system-status--green" : "cc-system-status--gray"}`}>
            {form.enabled ? "aktiv" : "inaktiv"}
          </span>
        </div>

        <div className="cc-system-form-grid">
          <label>
            <span>Jitsi-Server</span>
            <input value={form.serverUrl} onChange={(event) => patch("serverUrl", event.target.value)} placeholder="https://meet.ihre-domain.de" disabled={loading || saving} />
          </label>
          <label>
            <span>JWT App-ID</span>
            <input value={form.appId} onChange={(event) => patch("appId", event.target.value)} autoComplete="off" disabled={loading || saving} />
          </label>
          <label>
            <span>JWT-Schlüssel</span>
            <input type="password" value={form.secret} onChange={(event) => patch("secret", event.target.value)} placeholder={form.secretConfigured ? "Gespeichert – leer lassen zum Behalten" : "Mindestens 32 zufällige Zeichen"} autoComplete="new-password" disabled={loading || saving} />
          </label>
          <label className="cc-system-checkbox-row">
            <input type="checkbox" checked={form.enabled} onChange={(event) => patch("enabled", event.target.checked)} disabled={loading || saving} />
            <span>Jitsi-Verbindung für Fachanwendungen aktivieren</span>
          </label>
        </div>

        <div className="cc-system-footer-actions">
          <button className="cc-settings-action-button" type="button" onClick={testConnection} disabled={loading || saving || !form.serverUrl}>Verbindung testen</button>
          <button className="cc-settings-action-button cc-settings-action-button--primary" type="button" onClick={beginSave} disabled={loading || saving}>Mit Zwei-Faktor-Authentifizierung (2FA) speichern</button>
        </div>
      </div>

      {challenge ? (
        <div className="cc-system-card">
          <div className="cc-system-card__header"><div><h2>Änderung mit Zwei-Faktor-Authentifizierung (2FA) bestätigen</h2><p>Bestätige die Änderung über {challenge.providerLabel || "deinen eingerichteten 2FA-Anbieter"}.</p></div></div>
          <div className="cc-system-form-grid">
            {(challenge.provider === "local" && useRecoveryCode
              ? [{ name: "recoveryCode", label: "Wiederherstellungscode", type: "password", autocomplete: "off" }]
              : challenge.proofFields || [{ name: "code", label: "Authenticator-Code", type: "password", autocomplete: "one-time-code" }]
            ).map((field, index) => (
              <label key={field.name}>
                <span>{field.label}</span>
                <input
                  type={field.type || "password"}
                  inputMode={["code", "token"].includes(field.name) ? "numeric" : undefined}
                  value={proof[field.name] || ""}
                  onChange={(event) => setProof((current) => ({ ...current, [field.name]: event.target.value }))}
                  autoComplete={field.autocomplete || "off"}
                  autoFocus={index === 0}
                />
                {field.help ? <small>{field.help}</small> : null}
              </label>
            ))}
          </div>
          <div className="cc-system-footer-actions">
            <button className="cc-settings-action-button" type="button" onClick={() => setChallenge(null)}>Abbrechen</button>
            {challenge.provider === "local" ? <button className="cc-settings-action-button" type="button" onClick={() => setUseRecoveryCode((current) => !current)}>{useRecoveryCode ? "Authenticator-App verwenden" : "Wiederherstellungscode verwenden"}</button> : null}
            <button
              className="cc-settings-action-button cc-settings-action-button--primary"
              type="button"
              onClick={confirmSave}
              disabled={saving || (challenge.provider === "local"
                ? !(useRecoveryCode ? proof.recoveryCode : proof.code)
                : (challenge.proofFields || []).some((field) => !proof[field.name]))}
            >Bestätigen und speichern</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
