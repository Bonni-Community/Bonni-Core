import { useEffect, useRef, useState } from "react";
import { listNfcTags, registerNfcTag, revokeNfcTag, nfcErrorMessage } from "./nfcApi.js";
import { readNfcTag } from "./nfcReader.js";
import "./NfcTagsPanel.css";

export default function NfcTagsPanel({ token, member }) {
  const memberId = member?.memberId || member?.id;
  const [tags, setTags] = useState([]);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState("NFC");
  const [label, setLabel] = useState("");
  const [loginAccountId, setLoginAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const readerAbort = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listNfcTags(token, memberId, controller.signal).then(value => {
      if (!controller.signal.aborted) setTags(value);
    }).catch(err => { if (!controller.signal.aborted) setError(nfcErrorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, memberId]);
  useEffect(() => () => readerAbort.current?.abort(), []);
  async function register() {
    if (busy || !code.trim()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const tag = await registerNfcTag(token, memberId, { code, kind, label: label.trim() || (kind === "NFC" ? "NFC-Tag" : "Mitgliedskarte"), loginAccountId: loginAccountId || null });
      setTags(items => [tag, ...items]); setCode(""); setLabel("");
      setMessage("Tag zugeordnet.");
    } catch (err) { setError(nfcErrorMessage(err)); }
    finally { setBusy(false); }
  }
  async function enrollFromReader() {
    if (busy || loading || kind !== "NFC") return;
    const controller = new AbortController();
    readerAbort.current = controller;
    setBusy(true); setReading(true); setError(""); setMessage("");
    try {
      const detectedCode = await readNfcTag({ signal: controller.signal });
      const tag = await registerNfcTag(token, memberId, {
        code: detectedCode,
        kind: "NFC",
        label: label.trim() || "NFC-Tag",
        loginAccountId: loginAccountId || null,
      });
      setTags(items => [tag, ...items]); setLabel("");
      setMessage("NFC-Tag erkannt und diesem Mitglied zugeordnet.");
    } catch (err) {
      if (err?.code === "NFC_READER_CANCELLED") setMessage("Das NFC-Einlesen wurde abgebrochen.");
      else setError(nfcErrorMessage(err));
    } finally {
      readerAbort.current = null; setReading(false); setBusy(false);
    }
  }
  function cancelReader() {
    readerAbort.current?.abort();
  }
  async function revoke() {
    if (busy || !revokeId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await revokeNfcTag(token, memberId, revokeId);
      setTags(items => items.map(tag => tag.id === revokeId ? { ...tag, revokedAt: new Date().toISOString() } : tag));
      setRevokeId(""); setMessage("Tag gesperrt. Für Ersatz bitte einen neuen Tag zuordnen.");
    } catch (err) { setError(nfcErrorMessage(err)); }
    finally { setBusy(false); }
  }
  const date = value => value ? new Date(value).toLocaleString("de-DE") : "Noch nicht verwendet";
  return <section className="bonni-nfc-panel" aria-label="NFC-Tag und Mitgliedsbarcode">
    <h3>NFC-Tag</h3>
    <p>Bonni Core verwaltet hier den Sicherheitsfaktor und die Zuordnung. Zum Anlernen kannst du einen NFC-Tag an das Lesefeld des Tablets halten. Scanner-Adapter und Fachlogik bleiben getrennt.</p>
    <p><strong>Core-Sicherheitsstufe:</strong> Identifikation-only. NFC ersetzt weder Passwort noch 2FA und erstellt keine Anmeldung.</p>
    {error ? <p role="alert" className="cc-member-error">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    <div className="bonni-nfc-panel__fields">
      <label>Medium<select value={kind} disabled={busy} onChange={e => { setKind(e.target.value); setCode(""); }}><option value="NFC">NFC-Tag</option><option value="BARCODE">Mitgliedsbarcode</option></select></label>
      <label>{kind === "NFC" ? "Chipnummer" : "Barcode"}<input value={code} maxLength={128} autoComplete="off" spellCheck={false} disabled={busy} onChange={e => setCode(e.target.value)} placeholder="Externen Leser verwenden oder Code eingeben" onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }} /></label>
      {kind === "NFC" ? <div className="bonni-nfc-panel__reader">
        <button type="button" disabled={busy || loading} onClick={enrollFromReader}>{reading ? "Tag ans Tablet halten …" : "NFC-Tag anlernen"}</button>
        {reading ? <button type="button" disabled={!reading} onClick={cancelReader}>Abbrechen</button> : null}
        <small>Core startet den Anlernvorgang. Der Reader liefert nur die gelesene Tag-Nummer; die Zuordnung wird anschließend in Core gespeichert.</small>
      </div> : null}
      <small>Beim Barcode wird intern der Mitglieder-Namensraum verwendet; Produktbarcodes bleiben unverändert. Ein Code kann weiterhin manuell eingegeben werden.</small>
      <label>Bezeichnung (optional)<input value={label} maxLength={80} disabled={busy} onChange={e => setLabel(e.target.value)} placeholder="Zum Beispiel Schlüsselanhänger" /></label>
      <label>Für Core-Anmeldung verwenden<select value={loginAccountId} disabled={busy} onChange={e => setLoginAccountId(e.target.value)}>
        <option value="">Nur Mitglied auswählen</option>
        {(member?.accounts || []).filter(account => account.isActive).map(account => <option key={account.accountId || account.id} value={account.accountId || account.id}>{account.loginName}</option>)}
      </select></label>
      <small>Bei der Core-Anmeldung ersetzt der Tag den Benutzernamen. Passwort und vorhandene 2FA bleiben erforderlich.</small>
      <button type="button" disabled={busy || loading || !code.trim()} onClick={register}>{busy ? "Bitte warten …" : "Tag zuordnen"}</button>
    </div>
    {loading ? <p role="status">Tags werden geladen …</p> : !tags.length ? <p>Noch keine Tags zugeordnet.</p> : <ul className="bonni-nfc-panel__list">{tags.map(tag => <li key={tag.id}>
      <div><strong>{tag.label}</strong><span>{tag.kind === "BARCODE" ? "Barcode" : "NFC"} · {tag.revokedAt ? "Gesperrt" : "Aktiv"} · {tag.loginAccountId ? "Mit Core-Anmeldung" : "Mitgliedsauswahl"}</span><small>Letzte Verwendung: {date(tag.lastUsedAt)}</small></div>
      {!tag.revokedAt ? <button type="button" disabled={busy} onClick={() => setRevokeId(tag.id)}>Sperren</button> : null}
    </li>)}</ul>}
    {revokeId ? <div className="bonni-nfc-panel__confirm" role="alert">
      <p>„{tags.find(tag => tag.id === revokeId)?.label}“ dauerhaft sperren? Bestehende Core-Anmeldungen werden dadurch nicht beendet.</p>
      <button type="button" disabled={busy} onClick={revoke}>Tag endgültig sperren</button>
      <button type="button" disabled={busy} onClick={() => setRevokeId("")}>Abbrechen</button>
    </div> : null}
  </section>;
}
