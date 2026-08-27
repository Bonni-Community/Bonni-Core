import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  createJitsiAdminChallenge,
  getJitsiSettings,
  saveJitsiSettings,
  testJitsiSettings,
  verifyJitsiAdminChallenge,
} from "../../../../system/api/jitsiSettingsApi.js";
import { normalizeProofFields } from "../../../../core/modules/security/two-factor/api/twoFactorDto.js";
import ExactSecretInput from "../../../../core/modules/security/two-factor/components/ExactSecretInput.jsx";
import ProviderProofForm from "../../../../core/modules/security/two-factor/components/ProviderProofForm.jsx";
import {
  countUnicodeCodePoints,
  validateExactSecret,
} from "../../../../core/modules/security/two-factor/model/exactSecretPolicy.js";

const EMPTY = { enabled: false, serverUrl: "", appId: "", secret: "", secretConfigured: false };
const MAX_STAGED_SECRET_LIFETIME_MS = 60_000;

function stagedSecretLifetime(expiresAt) {
  if (expiresAt == null || expiresAt === "") return MAX_STAGED_SECRET_LIFETIME_MS;
  if (typeof expiresAt !== "string") return 0;
  const serverExpiry = Date.parse(expiresAt);
  if (!Number.isFinite(serverExpiry)) return 0;
  return Math.max(0, Math.min(serverExpiry - Date.now(), MAX_STAGED_SECRET_LIFETIME_MS));
}

export default function JitsiTab({ token }) {
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [challengeCreating, setChallengeCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState(null);
  const secretInputRef = useRef(null);
  const pendingSecretRef = useRef("");
  const challengeCreationLatchRef = useRef(false);

  const purgeSecretDomAndRef = useCallback(() => {
    if (secretInputRef.current) secretInputRef.current.value = "";
    pendingSecretRef.current = "";
  }, []);

  const clearSecretInput = useCallback(() => {
    if (secretInputRef.current) secretInputRef.current.value = "";
    setForm((current) => current.secret ? { ...current, secret: "" } : current);
  }, []);

  const purgeSecret = useCallback(() => {
    purgeSecretDomAndRef();
    setForm((current) => current.secret ? { ...current, secret: "" } : current);
  }, [purgeSecretDomAndRef]);

  async function load() {
    purgeSecret();
    setChallenge(null);
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
  useLayoutEffect(() => {
    const handlePageHide = () => purgeSecret();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      purgeSecretDomAndRef();
    };
  }, [purgeSecret, purgeSecretDomAndRef]);
  useEffect(() => {
    if (!challenge) return undefined;
    const lifetime = stagedSecretLifetime(challenge.expiresAt);
    if (lifetime <= 0) {
      purgeSecret();
      setChallenge(null);
      setError("Die 2FA-Abfrage ist abgelaufen. Das zwischengespeicherte Secret wurde verworfen.");
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      purgeSecret();
      setChallenge(null);
      setError("Die 2FA-Abfrage ist abgelaufen. Das zwischengespeicherte Secret wurde verworfen.");
    }, lifetime);
    return () => window.clearTimeout(timeout);
  }, [challenge, purgeSecret]);

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
    if (challengeCreationLatchRef.current || challenge || saving) return;
    challengeCreationLatchRef.current = true;
    setChallengeCreating(true);
    setMessage("");
    setError("");
    let stagedSecret = form.secret;
    if (stagedSecret) {
      const validationError = validateExactSecret(stagedSecret, { label: "Der JWT-Schlüssel" });
      if (validationError || countUnicodeCodePoints(stagedSecret) < 32) {
        purgeSecret();
        setError(validationError || "Der JWT-Schlüssel muss mindestens 32 Zeichen enthalten.");
        stagedSecret = null;
        challengeCreationLatchRef.current = false;
        setChallengeCreating(false);
        return;
      }
    }
    pendingSecretRef.current = stagedSecret;
    stagedSecret = null;
    // Das Secret verlaesst DOM und React-State synchron vor dem ersten await.
    clearSecretInput();
    try {
      const result = await createJitsiAdminChallenge(token);
      const nextChallenge = result?.challenge || result;
      const proofFields = normalizeProofFields(nextChallenge?.proofFields);
      if (!nextChallenge?.id || !proofFields.length || proofFields.some((field) => field.name === "recoveryCode")) {
        throw new Error("Der 2FA-Anbieter hat keinen gueltigen Pruefvertrag geliefert.");
      }
      setChallenge({ ...nextChallenge, proofFields });
    } catch (challengeError) {
      purgeSecret();
      setChallenge(null);
      setError(challengeError?.message || "Für diese Änderung muss die Zwei-Faktor-Authentifizierung (2FA) eingerichtet sein.");
    } finally {
      challengeCreationLatchRef.current = false;
      setChallengeCreating(false);
    }
  }

  async function confirmSave(submittedProof) {
    setSaving(true);
    setError("");
    let requestProof = submittedProof;
    let requestSecret = null;
    try {
      const challengeId = challenge?.id;
      if (!challengeId) throw new Error("Abfrage der Zwei-Faktor-Authentifizierung fehlt.");
      try {
        await verifyJitsiAdminChallenge(token, challengeId, requestProof);
      } finally {
        // ProviderProofForm hat DOM/React-State schon vor dem Request geleert;
        // nach der Verifikation bleibt auch keine lokale Proof-Referenz fuer
        // den anschliessenden Speichervorgang erhalten.
        requestProof = null;
        submittedProof = null;
      }
      // Erst unmittelbar vor dem sensitiven PUT wird das staged Secret in
      // eine lokale Referenz verschoben; der Ref ist ab hier bereits leer.
      requestSecret = pendingSecretRef.current;
      pendingSecretRef.current = "";
      const result = await saveJitsiSettings(token, {
        challengeId,
        enabled: form.enabled,
        serverUrl: form.serverUrl,
        appId: form.appId,
        ...(requestSecret ? { secret: requestSecret } : {}),
      });
      setForm({ ...EMPTY, ...(result?.settings || {}), secret: "" });
      setChallenge(null);
      setMessage("Jitsi-Konfiguration wurde geschützt gespeichert.");
    } catch (saveError) {
      purgeSecret();
      setChallenge(null);
      setError(saveError?.message || "Jitsi-Konfiguration konnte nicht gespeichert werden.");
      throw saveError;
    } finally {
      requestSecret = null;
      requestProof = null;
      submittedProof = null;
      purgeSecretDomAndRef();
      setSaving(false);
    }
  }

  function cancelChallenge() {
    purgeSecret();
    setChallenge(null);
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
          <ExactSecretInput
            inputRef={secretInputRef}
            label="JWT-Schlüssel"
            value={form.secret}
            onChange={(value) => patch("secret", value)}
            placeholder={form.secretConfigured ? "Gespeichert – leer lassen zum Behalten" : "Mindestens 32 zufällige Zeichen"}
            autoComplete="new-password"
            disabled={loading || saving}
            required={false}
          />
          <label className="cc-system-checkbox-row">
            <input type="checkbox" checked={form.enabled} onChange={(event) => patch("enabled", event.target.checked)} disabled={loading || saving} />
            <span>Jitsi-Verbindung für Fachanwendungen aktivieren</span>
          </label>
        </div>

        <div className="cc-system-footer-actions">
          <button className="cc-settings-action-button" type="button" onClick={testConnection} disabled={loading || saving || !form.serverUrl}>Verbindung testen</button>
          <button className="cc-settings-action-button cc-settings-action-button--primary" type="button" onClick={beginSave} disabled={loading || saving || challengeCreating || Boolean(challenge)}>{challengeCreating ? "2FA-Abfrage wird erstellt …" : "Mit Zwei-Faktor-Authentifizierung (2FA) speichern"}</button>
        </div>
      </div>

      {challenge ? (
        <div className="cc-system-card">
          <div className="cc-system-card__header"><div><h2>Änderung mit Zwei-Faktor-Authentifizierung (2FA) bestätigen</h2><p>Bestätige die Änderung über {challenge.providerLabel || "deinen eingerichteten 2FA-Anbieter"}.</p></div></div>
          <ProviderProofForm
            provider={{
              id: challenge.provider,
              label: challenge.providerLabel || "2FA-Anbieter",
            }}
            proofFields={challenge.proofFields}
            recoveryAllowed={challenge.provider === "local"}
            busy={saving}
            submitLabel="Bestaetigen und speichern"
            onVerify={confirmSave}
            onCancel={cancelChallenge}
          />
        </div>
      ) : null}
    </div>
  );
}
