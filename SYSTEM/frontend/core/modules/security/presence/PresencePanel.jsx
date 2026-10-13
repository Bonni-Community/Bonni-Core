import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../../../system/api/apiClient.js";
import { lastSeenLabel } from "./presence-format.js";
import "../nfc/NfcTagsPanel.css";
import "./PresencePanel.css";

const base = "/api/system/user/presence";
const transport = { allowFailover: false, cache: "no-store", sensitive: true };
const statusLabels = { IN: "Anwesend", OUT: "Abgemeldet", UNKNOWN: "Unbekannt", EXPIRED: "Zeit abgelaufen" };
function messageFor(error) {
  const code = error?.code || error?.data?.code || error?.data?.error;
  if (code === "PRESENCE_CONFLICT") return "Der Status wurde zwischenzeitlich geändert. Bitte aktualisieren und erneut prüfen.";
  if (code === "FORBIDDEN") return "Diese Einstellung dürfen nur Administratoren verwalten.";
  if (code === "NFC_NOT_AVAILABLE") return "Karte nicht zugeordnet oder gesperrt. Keine Anwesenheitsänderung.";
  return "Anwesenheit konnte nicht geprüft oder geändert werden. Bitte erneut versuchen.";
}

function PresenceBridges({ token }) {
  const [bridges, setBridges] = useState([]);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState("COUNT");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const alive = useRef(true);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
    alive.current = true;
    setSecret(""); setBridges([]); setBusy(false); setError(""); setRevokeId("");
    const controller = new AbortController();
    apiRequest(`${base}/bridges`, { ...transport, token, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setBridges(value); })
      .catch(err => { if (!controller.signal.aborted) setError(messageFor(err)); });
    const hide = () => { if (document.hidden) setSecret(""); };
    document.addEventListener("visibilitychange", hide);
    return () => { epoch.current += 1; alive.current = false; controller.abort(); document.removeEventListener("visibilitychange", hide); };
  }, [token]);
  useEffect(() => {
    if (!secret) return undefined;
    const timer = setTimeout(() => setSecret(""), 120_000);
    return () => clearTimeout(timer);
  }, [secret]);
  async function create() {
    if (busy || !label.trim()) return;
    const requestEpoch = epoch.current;
    setSecret(""); setBusy(true); setError("");
    try {
      const result = await apiRequest(`${base}/bridges`, { ...transport, token, method: "POST", body: { label, scope } });
      const { token: oneTimeToken, ...bridge } = result;
      if (!alive.current || requestEpoch !== epoch.current) return;
      setBridges(values => [bridge, ...values]);
      if (!document.hidden) setSecret(oneTimeToken);
      setLabel("");
    } catch (err) { if (alive.current && requestEpoch === epoch.current) setError(messageFor(err)); }
    finally { if (alive.current && requestEpoch === epoch.current) setBusy(false); }
  }
  async function revoke() {
    if (busy) return;
    const requestEpoch = epoch.current;
    setBusy(true); setSecret(""); setError("");
    try {
      await apiRequest(`${base}/bridges/${encodeURIComponent(revokeId)}/revoke`, { ...transport, token, method: "POST", body: {} });
      if (alive.current && requestEpoch === epoch.current) { setBridges(items => items.map(item => item.id === revokeId ? { ...item, revokedAt: new Date().toISOString() } : item)); setRevokeId(""); }
    } catch (err) { if (alive.current && requestEpoch === epoch.current) setError(messageFor(err)); }
    finally { if (alive.current && requestEpoch === epoch.current) setBusy(false); }
  }
  return <section className="bonni-nfc-panel" aria-label="Anwesenheits-Bridge">
    <h3>Bridge-Lesezugänge</h3>
    <p>Nur lesend, 90 Tage gültig und jederzeit sperrbar. Es werden keine Namen, Tagnummern oder Kontodaten übertragen.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="bonni-nfc-panel__fields">
      <label>Bezeichnung<input value={label} maxLength={80} disabled={busy} onChange={event => setLabel(event.target.value)} placeholder="Zum Beispiel Anwesenheitsanzeige" /></label>
      <label>Freigabe<select value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="COUNT">Nur Anzahl</option><option value="MEMBERS">Anzahl und einzelne Mitglieds-IDs</option></select></label>
      <button type="button" disabled={busy || !label.trim()} onClick={create}>Lesezugang erstellen</button>
    </div>
    {secret ? <div className="bonni-presence-secret">
      <p>Dieser Schlüssel wird nur jetzt angezeigt und nach zwei Minuten ausgeblendet. Sicher in der Bridge hinterlegen.</p>
      <label>Bridge-Schlüssel<input readOnly value={secret} autoComplete="off" spellCheck={false} /></label>
      <button type="button" onClick={() => setSecret("")}>Schlüssel ausblenden</button>
    </div> : null}
    <p>Abfrage: <code>GET /api/bridge/presence</code></p>
    <p>Ein Mitglied: <code>GET /api/bridge/presence/members/MITGLIEDS-ID</code></p>
    <p>Schlüssel im HTTP-Header: <code>Authorization: Bearer BRIDGE-SCHLÜSSEL</code>. Nur über HTTPS verwenden.</p>
    <ul className="bonni-nfc-panel__list">{bridges.map(bridge => <li key={bridge.id}>
      <div><strong>{bridge.label}</strong><span>{bridge.scope === "COUNT" ? "Nur Anzahl" : "Einzelstatus und Anzahl"} · {bridge.revokedAt ? "Gesperrt" : new Date(bridge.expiresAt) <= new Date() ? "Abgelaufen" : "Aktiv"}</span><small>Gültig bis {new Date(bridge.expiresAt).toLocaleDateString("de-DE")}</small></div>
      {!bridge.revokedAt ? <button type="button" disabled={busy} onClick={() => setRevokeId(bridge.id)}>Sperren</button> : null}
    </li>)}</ul>
    {revokeId ? <div role="alert"><p>Lesezugang wirklich sperren? Die angeschlossene Bridge kann danach nicht mehr abfragen.</p><button type="button" disabled={busy} onClick={revoke}>Endgültig sperren</button><button type="button" disabled={busy} onClick={() => setRevokeId("")}>Abbrechen</button></div> : null}
  </section>;
}

export default function PresencePanel({ token }) {
  const [snapshot, setSnapshot] = useState(null);
  const [timeoutDraft, setTimeoutDraft] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [showBridge, setShowBridge] = useState(false);
  const [code, setCode] = useState("");
  const [direction, setDirection] = useState("IN");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busyRef = useRef(false);
  const requestRef = useRef(0);
  const controllerRef = useRef(null);
  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const data = await apiRequest(base, { ...transport, token, signal: controller.signal });
      if (!controller.signal.aborted) { setSnapshot(data); setError(""); }
    } catch (err) { if (!controller.signal.aborted) setError(messageFor(err)); }
  }, [token]);
  useEffect(() => {
    setSnapshot(null); setCode(""); setMessage(""); setTimeoutDraft(null); setShowBridge(false);
    busyRef.current = false; setBusy(false);
    void refresh();
    const timer = setInterval(() => { if (!document.hidden && !busyRef.current) void refresh(); }, 15_000);
    return () => { clearInterval(timer); controllerRef.current?.abort(); requestRef.current += 1; };
  }, [refresh]);
  async function mark(body) {
    if (busyRef.current) return;
    const requestId = ++requestRef.current;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    controllerRef.current?.abort();
    try {
      const result = await apiRequest(base, { ...transport, token, method: "POST", body });
      if (requestId !== requestRef.current) return;
      setCode(""); setMessage(`Gespeichert: ${statusLabels[result.status]}.`);
      await refresh();
    } catch (err) { if (requestId === requestRef.current) setError(messageFor(err)); }
    finally { if (requestId === requestRef.current) { busyRef.current = false; setBusy(false); } }
  }
  async function saveTimeout() {
    if (busyRef.current) return;
    const requestId = ++requestRef.current;
    busyRef.current = true; setBusy(true); setError("");
    try {
      await apiRequest(`${base}/settings`, { ...transport, token, method: "POST", body: { timeoutMinutes: Number(timeoutDraft ?? snapshot?.timeoutMinutes ?? 60) } });
      if (requestId !== requestRef.current) return;
      setTimeoutDraft(null); setMessage("Anwesenheitsfrist gespeichert."); await refresh();
    } catch (err) { if (requestId === requestRef.current) setError(messageFor(err)); }
    finally { if (requestId === requestRef.current) { busyRef.current = false; setBusy(false); } }
  }
  const members = (snapshot?.members || []).filter(member => `${member.displayName} ${member.memberId}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="cc-user-panel bonni-presence-panel" aria-label="Anwesenheit">
    <header><h3>Anwesenheit</h3><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Schließen" : "Kommen / Gehen"}</button></header>
    {snapshot ? <p role="status">{snapshot.presentCount} anwesend · {snapshot.absentCount} abgemeldet · {snapshot.expiredCount} Zeit abgelaufen · {snapshot.unknownCount} unbekannt</p> : <p>Anwesenheit wird geladen …</p>}
    {error ? <p role="alert">{error} Die Anzeige ist möglicherweise nicht aktuell.</p> : null}
    {snapshot ? <small>Abgefragt: {new Date(snapshot.asOf).toLocaleTimeString("de-DE")}. Der Status beruht auf der letzten Meldung, nicht auf einer automatischen Ortung.</small> : null}
    {expanded ? <div className="bonni-nfc-panel">
      <p>Eine bestätigte StüberlApp-Buchung mit NFC oder Barcode zählt als „gesehen“ und startet die Frist neu. Hier lässt sich außerdem „Kommen“ oder „Gehen“ erfassen. Ein abgelaufener Zeitraum ist keine bestätigte Abmeldung.</p>
      <div className="bonni-nfc-panel__fields">
        <label>Anwesenheitsfrist in Minuten<input type="number" min={5} max={1440} step={1} disabled={busy} value={timeoutDraft ?? snapshot?.timeoutMinutes ?? 60} onChange={event => setTimeoutDraft(event.target.value)} /></label>
        <button type="button" disabled={busy || !Number.isInteger(Number(timeoutDraft ?? snapshot?.timeoutMinutes ?? 60)) || Number(timeoutDraft ?? snapshot?.timeoutMinutes ?? 60) < 5 || Number(timeoutDraft ?? snapshot?.timeoutMinutes ?? 60) > 1440} onClick={saveTimeout}>Frist speichern (Admin)</button>
      </div>
      <p>Die Frist gilt ab „zuletzt gesehen“, auch für bestehende Meldungen. Standard: 60 Minuten. Ein erneuter Blick auf diese Anzeige verlängert sie nicht.</p>
      <div className="bonni-nfc-panel__fields">
        <label>Leser meldet<select value={direction} disabled={busy} onChange={event => setDirection(event.target.value)}><option value="IN">Kommen</option><option value="OUT">Gehen</option></select></label>
        <label>NFC oder Mitgliedsbarcode<input value={code} disabled={busy} maxLength={128} autoComplete="off" onChange={event => setCode(event.target.value)} placeholder="Karte einlesen" onKeyDown={event => { if (event.key === "Enter" && code) { event.preventDefault(); void mark({ code, status: direction }); } }} /></label>
        <button type="button" disabled={busy || !code.trim()} onClick={() => mark({ code, status: direction })}>{direction === "IN" ? "Kommen erfassen" : "Gehen erfassen"}</button>
        <label>Mitglied suchen<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Name oder Mitglieds-ID" /></label>
      </div>
      {message ? <p role="status">{message}</p> : null}
      <ul className="bonni-nfc-panel__list">{members.slice(0, 30).map(member => <li key={member.memberId}>
        <div><strong>{member.displayName}</strong><small>{member.memberId}</small><span>{statusLabels[member.status]}</span><span title={member.lastSeenAt ? new Date(member.lastSeenAt).toLocaleString("de-DE") : undefined}>{lastSeenLabel(member.lastSeenAt)}</span>{member.status === "IN" && member.presentUntil ? <small>Anwesend bis {new Date(member.presentUntil).toLocaleTimeString("de-DE")}</small> : null}</div>
        <div className="bonni-presence-actions">{Object.entries(statusLabels).filter(([status]) => status !== "EXPIRED").map(([status, label]) => <button key={status} type="button" disabled={busy || (status !== "IN" && status === member.status)} onClick={() => mark({ memberId: member.memberId, status, expectedVersion: member.version })}>{status === "IN" ? "Jetzt gesehen" : label}</button>)}</div>
      </li>)}</ul>
      {members.length > 30 || snapshot?.truncated ? <p>Bitte die Suche eingrenzen; es werden höchstens 30 Treffer angezeigt.</p> : null}
      <button type="button" aria-expanded={showBridge} onClick={() => setShowBridge(value => !value)}>{showBridge ? "Bridge schließen" : "Bridge-Lesezugänge verwalten"}</button>
      {showBridge ? <PresenceBridges token={token} /> : null}
    </div> : null}
  </section>;
}
