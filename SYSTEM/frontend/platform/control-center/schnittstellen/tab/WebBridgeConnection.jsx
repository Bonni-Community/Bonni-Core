import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  createWebBridgeAdminChallenge,
  getWebBridgeSettings,
  saveWebBridgeSettings,
  testWebBridgeSettings,
  verifyWebBridgeAdminChallenge,
  getWebBridgeInbox, syncWebBridge, publishWebBridge,
} from "../../../../system/api/webBridgeApi.js";
import { normalizeProofFields } from "../../../../core/modules/security/two-factor/api/twoFactorDto.js";
import ExactSecretInput from "../../../../core/modules/security/two-factor/components/ExactSecretInput.jsx";
import ProviderProofForm from "../../../../core/modules/security/two-factor/components/ProviderProofForm.jsx";
import DrupalBridgeGuide from "./DrupalBridgeGuide.jsx";
import {
  validateExactSecret,
} from "../../../../core/modules/security/two-factor/model/exactSecretPolicy.js";

const EMPTY = { enabled: false, baseUrl: "", siteId: "", secret: "", secretConfigured: false, webEnabled: false, shopEnabled: false, autoSync: false, pollSeconds: 60 };
const MAX_STAGED_SECRET_LIFETIME_MS = 60_000;

function stagedSecretLifetime(expiresAt) {
  if (expiresAt == null || expiresAt === "") return MAX_STAGED_SECRET_LIFETIME_MS;
  if (typeof expiresAt !== "string") return 0;
  const serverExpiry = Date.parse(expiresAt);
  if (!Number.isFinite(serverExpiry)) return 0;
  return Math.max(0, Math.min(serverExpiry - Date.now(), MAX_STAGED_SECRET_LIFETIME_MS));
}

export default function WebBridgeConnection({ token, provider }) {
  const [form, setForm] = useState(EMPTY);
  const cmsLabel = provider === "typo3" ? "TYPO3" : "Drupal";
  const [record, setRecord] = useState(null);
  const [items, setItems] = useState([]);
  const [content, setContent] = useState({ title: "", text: "", events: [], products: [] });
  const [action, setAction] = useState("");
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
      const result = await getWebBridgeSettings(token, provider);
      setForm({ ...EMPTY, ...(result?.settings || {}), secret: "" });
      setRecord(result);
      setContent(result?.publication?.data || { title: "", text: "", events: [], products: [] });
      setItems((await getWebBridgeInbox(token, provider))?.items || []);
    } catch (loadError) {
      setError(loadError?.message || "Verbindungseinstellungen konnten nicht geladen werden.");
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
    setAction("test");
    setMessage("");
    setError("");
    try {
      const result = await testWebBridgeSettings(token, provider);
      if (!result?.ok) throw new Error(`Die Website antwortet nicht gültig (HTTP ${result?.status || 0}).`);
      setMessage("Website-Adresse wurde erfolgreich geprüft.");
    } catch (testError) {
      setError(testError?.message || "Die Verbindung konnte nicht geprüft werden.");
    } finally { setAction(""); }
  }

  async function beginSave() {
    if (challengeCreationLatchRef.current || challenge || saving) return;
    challengeCreationLatchRef.current = true;
    setChallengeCreating(true);
    setMessage("");
    setError("");
    let stagedSecret = form.secret;
    if (stagedSecret) {
      const validationError = validateExactSecret(stagedSecret, { label: "Der Verbindungsschlüssel" });
      if (validationError || !/^[a-f0-9]{64}$/.test(stagedSecret)) {
        purgeSecret();
        setError(validationError || "Der Verbindungsschlüssel muss aus genau 64 kleinen Hex-Zeichen bestehen.");
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
      const result = await createWebBridgeAdminChallenge(token);
      const nextChallenge = result?.challenge || result;
      const proofFields = normalizeProofFields(nextChallenge?.proofFields);
      if (!nextChallenge?.id || !proofFields.length || proofFields.some((field) => field.name === "recoveryCode")) {
        throw new Error("Der 2FA-Anbieter hat keinen gültigen Prüfvertrag geliefert.");
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
        await verifyWebBridgeAdminChallenge(token, challengeId, requestProof);
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
      const result = await saveWebBridgeSettings(token, provider, {
        challengeId,
        enabled: form.enabled,
        baseUrl: form.baseUrl,
        siteId: form.siteId,
        webEnabled: form.webEnabled, shopEnabled: form.shopEnabled, autoSync: form.autoSync, pollSeconds: Number(form.pollSeconds),
        ...(requestSecret ? { secret: requestSecret } : {}),
      });
      setForm({ ...EMPTY, ...(result?.settings || {}), secret: "" });
      setRecord(result);
      setItems((await getWebBridgeInbox(token, provider))?.items || []);
      setChallenge(null);
      setMessage("Verbindungseinstellungen wurden geschützt gespeichert.");
    } catch (saveError) {
      purgeSecret();
      setChallenge(null);
      setError(saveError?.message || "Verbindungseinstellungen konnten nicht gespeichert werden.");
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

  async function refresh() {
    const [next, inbox] = await Promise.all([getWebBridgeSettings(token, provider), getWebBridgeInbox(token, provider)]);
    setRecord(next); setItems(inbox?.items || []);
  }
  async function synchronize(publish = false) {
    setAction(publish ? "publish" : "sync"); setError(""); setMessage("");
    try {
      if (publish) await publishWebBridge(token, provider, content);
      const result = await syncWebBridge(token, provider);
      await refresh();
      setMessage(`${result.published ? "Web-Inhalte übertragen. " : ""}${result.imported} neue Bestellung(en) empfangen.${result.hasMore ? " Weitere Bestellungen warten auf Abholung." : ""}${result.rejected ? " Einträge konnten nicht übernommen werden; sie bleiben auf der Website gespeichert." : ""}`);
    } catch (error) {
      setError(error?.message || "Die Übertragung ist derzeit nicht möglich.");
      await refresh().catch(() => {});
    } finally { setAction(""); }
  }
  const formatDate = (value) => value ? new Date(value).toLocaleString("de-DE") : "Noch keine Übertragung";
  return (
    <div className="cc-system-tab-panel">
      {message ? <p className="cc-system-success">{message}</p> : null}
      {error ? <p className="cc-system-error">{error}</p> : null}
      {provider === "drupal" ? <DrupalBridgeGuide /> : null}
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>{cmsLabel} – Verbindung</h2>
            <p>Bonni ruft diese öffentliche Website aus dem lokalen Netz auf.</p>
          </div>
          <span className={`cc-system-status ${form.enabled ? "cc-system-status--green" : "cc-system-status--gray"}`}>
            {form.enabled ? "aktiv" : "inaktiv"}
          </span>
        </div>

        <div className="cc-system-form-grid">
          <label>
            <span>Website-Adresse</span>
            <input value={form.baseUrl} onChange={(event) => patch("baseUrl", event.target.value)} placeholder="https://www.ihre-domain.de" disabled={loading || saving || Boolean(action) || Boolean(challenge)} />
          </label>
          <label>
            <span>Site-ID</span>
            <input value={form.siteId} onChange={(event) => patch("siteId", event.target.value)} autoComplete="off" disabled={loading || saving || Boolean(action) || Boolean(challenge)} />
          </label>
          <ExactSecretInput
            inputRef={secretInputRef}
            label="Verbindungsschlüssel"
            value={form.secret}
            onChange={(value) => patch("secret", value)}
            placeholder={form.secretConfigured ? "Gespeichert – leer lassen zum Behalten" : "64 zufällige Hex-Zeichen"}
            autoComplete="new-password"
            disabled={loading || saving || Boolean(action) || Boolean(challenge)}
            required={false}
          />
          <label className="cc-system-checkbox-row">
            <input type="checkbox" checked={form.enabled} onChange={(event) => patch("enabled", event.target.checked)} disabled={loading || saving || Boolean(action) || Boolean(challenge)} />
            <span>Verbindung aktivieren</span>
          </label>
          {[['webEnabled', 'Öffentliche Web-Inhalte übertragen'], ['shopEnabled', 'Shop-Bestellungen abholen'], ['autoSync', 'In Produktivbetrieb automatisch synchronisieren']].map(([key, label]) => <label className="cc-system-checkbox-row" key={key}>
            <input type="checkbox" checked={Boolean(form[key])} onChange={(event) => patch(key, event.target.checked)} disabled={loading || saving || Boolean(action) || Boolean(challenge)} />
            <span>{label}</span>
          </label>)}
          <label><span>Abholintervall in Sekunden</span><input type="number" min="30" max="3600" value={form.pollSeconds} onChange={(event) => patch('pollSeconds', event.target.value)} disabled={loading || saving || Boolean(action) || Boolean(challenge)} /></label>
        </div>
        <p>Verbindungsschlüssel und Site-ID werden in beiden Systemen eingerichtet. Die Prüfung verwendet die gespeicherten Einstellungen.</p>
        {provider === 'typo3' ? <p>Für Shop-Bestellungen muss die verwendete TYPO3-Shop-Erweiterung an den Bestelleingang angeschlossen werden.</p> : <p>Für Drupal Commerce das beiliegende Commerce-Modul aktivieren.</p>}

        <div className="cc-system-footer-actions">
          <button className="cc-settings-action-button" type="button" onClick={testConnection} disabled={loading || saving || Boolean(action) || !form.secretConfigured}>Gespeicherte Verbindung prüfen</button>
          <button className="cc-settings-action-button cc-settings-action-button--primary" type="button" onClick={beginSave} disabled={loading || saving || Boolean(action) || challengeCreating || Boolean(challenge)}>{challengeCreating ? "2FA-Abfrage wird erstellt …" : "Mit Zwei-Faktor-Authentifizierung (2FA) speichern"}</button>
        </div>
      </div>

      <div className="cc-system-card">
        <h2>Übertragung &amp; Bestelleingang</h2>
        <p>{record?.status?.state === 'waiting' ? 'Die Verbindung wartet auf einen erneuten Versuch.' : record?.status?.state === 'connected' ? 'Die letzte Übertragung war erfolgreich.' : record?.status?.state === 'attention' ? 'Bitte die nicht übernommenen Einträge im Shop prüfen.' : 'Die Verbindung kann nach dem Speichern geprüft werden.'}</p>
        <div className="cc-web-bridge-summary">
          <span><strong>{record?.inboxCount || 0}</strong>Empfangene Einträge</span>
          <span><strong>{record?.waitingForReceipt || 0}</strong>Offene Empfangsbestätigungen</span>
          <span><strong>{formatDate(record?.status?.lastSuccessAt)}</strong>Letzte Übertragung</span>
        </div>
        {record?.status?.nextAttemptAt ? <p>Nächster automatischer Versuch: {formatDate(record.status.nextAttemptAt)}</p> : null}
        <button type="button" className="cc-settings-action-button" onClick={() => synchronize()} disabled={loading || saving || Boolean(action) || Boolean(challenge) || !record?.settings?.enabled}>{action === 'sync' ? 'Wird abgeholt …' : 'Jetzt synchronisieren'}</button>
        <p>Die Empfangsbestätigung bestätigt das lokale Speichern. Die automatische Weitergabe an Bonni-Apps und die Verbuchung in Kontor werden im nächsten Schritt angeschlossen.</p>
        <div className="cc-web-bridge-inbox">
          {items.length === 0 ? <p>Noch keine Bestellungen eingegangen.</p> : <p>Die letzten {items.length} Eingänge dieser Website:</p>}
          {items.map(({ event, receivedAt, acknowledged }) => <details key={event.id}>
            <summary>{event.order.number || event.order.id} · {event.order.total} {event.order.currency} · {event.order.status}</summary>
            <p>{event.type === 'order.placed' ? 'Neue Bestellung' : event.type === 'order.cancelled' ? 'Stornomeldung aus dem Shop' : 'Bestellaktualisierung'} · Empfangen: {formatDate(receivedAt)} · {acknowledged ? `${cmsLabel} hat den Empfang bestätigt` : 'Empfangsbestätigung ausstehend'}</p>
            <p>{event.order.email || ''} · Vom Shop gemeldeter bezahlter Betrag: {event.order.paidTotal} {event.order.currency}</p>
            <table><thead><tr><th>Artikel</th><th>Menge</th><th>Einzelpreis</th></tr></thead><tbody>{event.order.items.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.quantity}</td><td>{item.unitPrice} {event.order.currency}</td></tr>)}</tbody></table>
          </details>)}
        </div>
      </div>
      <div className="cc-system-card cc-web-bridge-content">
        <h2>Öffentliche Web-Inhalte</h2>
        <p>Diese Inhalte werden ausdrücklich für die öffentliche Website freigegeben.</p>
        <label><span>Überschrift</span><input maxLength={160} value={content.title} onChange={(event) => setContent((current) => ({ ...current, title: event.target.value }))} disabled={Boolean(action) || loading || Boolean(challenge)} /></label>
        <label><span>Text</span><textarea maxLength={10000} value={content.text} onChange={(event) => setContent((current) => ({ ...current, text: event.target.value }))} disabled={Boolean(action) || loading || Boolean(challenge)} /></label>
        {content.events.length || content.products.length ? <p>{content.events.length} freigegebene Veranstaltungen und {content.products.length} Produktdaten bleiben in der Freigabe enthalten.</p> : null}
        {provider === 'drupal' ? <section aria-label="Drupal-Shop-Produkte">
          <h3>Drupal-Shop-Produkte</h3>
          <p>Mit aktiviertem Katalogimport in Drupal werden diese Daten zu Shop-Artikeln. Entfernte oder nicht verfügbare Artikel werden dort ausgeblendet. Die Freigabe ersetzt den gesamten Bonni-Katalog dieser Website.</p>
          {content.products.map((product, index) => <fieldset key={product.id} disabled={loading || saving || Boolean(action) || Boolean(challenge)}>
            <legend>Artikel {index + 1}</legend>
            {[
              ['sku', 'Artikelnummer', 160], ['title', 'Artikelname', 200],
              ['description', 'Beschreibung', 5000], ['price', 'Preis (z. B. 19.90)', 24], ['currency', 'Währung (z. B. EUR)', 3],
            ].map(([field, label, max]) => <label key={field}><span>{label}</span><input aria-label={`${label} ${index + 1}`} maxLength={max} value={product[field]} onChange={(event) => setContent(current => ({...current, products: current.products.map(item => item.id === product.id ? {...item, [field]: event.target.value} : item)}))} /></label>)}
            <label><input type="checkbox" checked={product.available} onChange={event => setContent(current => ({...current, products: current.products.map(item => item.id === product.id ? {...item, available: event.target.checked} : item)}))} /> Im Shop verfügbar</label>
            <button type="button" onClick={() => setContent(current => ({...current, products: current.products.filter(item => item.id !== product.id)}))}>Artikel aus Freigabe entfernen</button>
          </fieldset>)}
          <button type="button" disabled={loading || saving || Boolean(action) || Boolean(challenge) || content.products.length >= 200} onClick={() => setContent(current => ({...current, products: [...current.products, {id: crypto.randomUUID(), sku: '', title: '', description: '', price: '0.00', currency: 'EUR', available: false}]}))}>Shop-Artikel hinzufügen</button>
        </section> : null}
        {record?.publication && !record.publication.scopeMatches ? <p>Die Freigabe stammt von einer früheren Verbindung. Bitte Inhalt prüfen und neu freigeben.</p> : null}
        {record?.publication?.pending && record.publication.scopeMatches ? <p>Die Freigabe ist lokal gespeichert und wartet auf Übertragung.</p> : null}
        <button type="button" className="cc-settings-action-button" onClick={() => synchronize(true)} disabled={loading || saving || Boolean(action) || Boolean(challenge) || !record?.settings?.enabled || !record?.settings?.webEnabled}>{action === 'publish' ? 'Wird veröffentlicht …' : 'Für die Website freigeben und übertragen'}</button>
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
            submitLabel="Bestätigen und speichern"
            onVerify={confirmSave}
            onCancel={cancelChallenge}
          />
        </div>
      ) : null}
    </div>
  );
}
