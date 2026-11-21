import { useEffect, useState } from "react";
import "./SystemErasurePanel.css";
const labels = { REQUESTED: "Antrag angenommen", APPROVED_PENDING_CHECKS: "Antrag freigegeben", DEACTIVATED: "Zugang deaktiviert", WAITING_CYCLE: "Wartet auf Löschzyklus", BLOCKED: "Löschung verzögert", ERASING: "Löschung läuft", COMPLETED: "Löschung abgeschlossen" };
const date = value => value ? new Date(value).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }) : "";
export default function ErasureStatusPage() {
 const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
 const [secret] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("erasure-status"));
 async function load(signal) {
  setBusy(true); setError("");
  try {
   const response = await fetch("/api/privacy/erasure/status", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: secret }), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal });
   if (!response.ok) throw Error(response.status === 429 ? "Bitte warte einige Minuten und versuche es erneut." : "Dieser Statuszugang ist nicht verfügbar oder bereits abgelaufen.");
   const next = await response.json();
   if (!labels[next.state] || !Array.isArray(next.events)) throw Error("Der Bearbeitungsstand konnte nicht geladen werden.");
   if (!signal?.aborted) setData(next);
  } catch (e) { if (!signal?.aborted) setError(e.message || "Der Status konnte nicht geladen werden."); }
  finally { if (!signal?.aborted) setBusy(false); }
 }
 useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort(); }, [secret]);
 return <main className="bonni-erasure bonni-erasure__public">
  <p>Bonni Core · StüberlApp</p><h1>Dein Löschantrag</h1>
  <p>Hier kannst du den Stand auch nach der Deaktivierung deines Zugangs verfolgen. Bewahre deinen persönlichen Link auf und gib ihn nicht weiter.</p>
  {data ? <><h2>{labels[data.state]}</h2>
   {data.state !== "COMPLETED" ? <p>{data.nextRunAt ? `Nächster geplanter Löschlauf: ${date(data.nextRunAt)} Uhr (Europe/Berlin). Ungeklärte Vorgänge können den Abschluss verzögern.` : "Der automatische Löschlauf ist pausiert. Die Verwaltung muss einen neuen Termin festlegen."}</p> : null}
   {data.retainedCount > 0 ? <p>{data.retainedCount} Nachweise werden getrennt und geschützt bis zu ihrem festgelegten Enddatum aufbewahrt.</p> : null}
   <ol className="bonni-erasure__timeline">{[...data.events].reverse().map((event, index) => <li key={index}><time>{date(event.at)}</time><p>{event.message}</p></li>)}</ol>
   {data.expiresAt ? <p>Dieser Statuszugang bleibt bis zum {date(data.expiresAt)} verfügbar.</p> : null}
  </> : null}
  {error ? <p role="alert">{error}</p> : null}
  <button type="button" disabled={busy} onClick={() => load()}>{busy ? "Stand wird geladen …" : "Status aktualisieren"}</button>
 </main>;
}
