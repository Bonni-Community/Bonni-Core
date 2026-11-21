import ErasureRetentionPanel from "./ErasureRetentionPanel.jsx";
import ErasureCaseApproval from "./ErasureCaseApproval.jsx";
import "./SystemErasurePanel.css";
import { useEffect, useState } from "react";
import { readErasureCycle, saveErasureCycle, checkErasureCase } from "../api/erasureApi.js";

const labels = { REQUESTED: "Freigabe ausstehend", COMPLETED: "Abgeschlossen", BLOCKED: "Prüfung erforderlich", ERASING: "Löschung läuft", WAITING_CYCLE: "Wartet auf Löschzyklus",
  DEACTIVATED: "Deaktiviert", APPROVED_PENDING_CHECKS: "Vorbereitung ausstehend" };
export default function ErasureCycleSettings({ token, actorAccountId }) {
  const [settings, setSettings] = useState(null), [cases, setCases] = useState([]), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("active"), [search, setSearch] = useState(""), [selected, setSelected] = useState(null), [report, setReport] = useState(null);
  async function refresh() { try { const data = await readErasureCycle(token); setSettings(data.settings); setCases(data.cases || []); } catch { setMessage("Die Fallübersicht konnte nicht aktualisiert werden."); } }
  async function check(row) { if (busy) return; setBusy(true); setMessage(""); setReport(null); try { const data = await checkErasureCase(token, row.id); setReport({ id: row.id, ...data }); await refresh(); } catch (e) { setMessage(e.code === "ERASURE_REVIEW_MFA_REQUIRED" ? "Bitte mit einem persönlichen 2FA-Verwaltungszugang anmelden." : "Die Fallprüfung konnte nicht bestätigt werden."); } finally { setBusy(false); } }
  const reasons = { BALANCE: "Kontostand ist nicht null", CREDIT: "Guthaben ist noch vorhanden", CLAIM: "Forderung ist noch offen", OPEN_TAB: "Bierdeckel ist noch offen", INVOICE: "Rechnung oder Abrechnung ist noch offen", PAYMENT: "Zahlung ist noch ungeklärt", TRANSFER: "Übertragung ist noch offen", CLARIFICATION: "Klärung ist noch offen", RESERVATION: "Reservierung ist noch offen", ORDER: "Bestellung ist noch offen", OFFLINE: "Geräteabgleich fehlt", RETENTION: "Aufbewahrungsentscheidung fehlt", RETENTION_CHANGED: "Daten haben sich seit der Entscheidung geändert", SHARED_SUBJECT: "Gemeinsam genutzte Daten müssen geprüft werden", UNSUPPORTED_DATA: "Datenart muss gesondert geprüft werden", DOCUMENT_REVIEW: "Beleg liegt außerhalb der eindeutig zugeordneten persönlichen Ablage", DATA_UNAVAILABLE: "Datenquelle ist nicht vollständig erreichbar" };
  const reasonText = code => { const parts = code.split(":"); return parts.length > 1 ? `${parts[0]}: ${reasons[parts.slice(1).join(":")] || "Technische Prüfung erforderlich"}` : reasons[code] || "Technische Prüfung erforderlich"; };
  const shown = cases.filter(row => (filter === "all" || (filter === "active" ? row.state !== "COMPLETED" : row.state === filter)) && `${row.label} ${row.id}`.toLocaleLowerCase("de").includes(search.toLocaleLowerCase("de")));
  useEffect(() => {
    const controller = new AbortController();
    readErasureCycle(token, controller.signal).then(data => {
      if (!controller.signal.aborted) { setSettings(data.settings); setCases(data.cases || []); }
    }).catch(() => { if (!controller.signal.aborted) setMessage("Der Löschzyklus konnte nicht geladen werden."); });
    return () => controller.abort();
  }, [token]);
  const update = (key, value) => { setSettings(previous => ({ ...previous, [key]: value })); setMessage(""); };
  async function save(event) {
    event.preventDefault(); if (busy || !settings) return;
    setBusy(true); setMessage("");
    try { const data = await saveErasureCycle(token, settings); setSettings(data.settings); setMessage("Einstellungen gespeichert."); }
    catch { setMessage("Die Einstellungen konnten nicht gespeichert werden."); }
    finally { setBusy(false); }
  }
  return <details className="bonni-erasure__cycle">
    <summary>Löschfälle und Löschzyklus ({cases.filter(row => row.state !== "COMPLETED").length} offen)</summary>
    <p>Freigegebene Benutzer bleiben bis zur geprüften Löschung deaktiviert. Ein fehlendes Backup oder ungeklärte Daten halten den Vorgang an.</p>
    {settings ? <form onSubmit={save}>
      <label className="bonni-erasure__checkbox"><input type="checkbox" checked={settings.enabled} onChange={e => update("enabled", e.target.checked)}/> Löschzyklus aktiv</label>
      <div className="bonni-erasure__fields">
        <label>Abstand in Tagen<input type="number" min="1" max="365" value={settings.intervalDays} onChange={e => update("intervalDays", Number(e.target.value))} required/></label>
        <label>Sicherungen aufbewahren: Tage<input type="number" min="1" max="3650" value={settings.backupRetentionDays} onChange={e => update("backupRetentionDays", Number(e.target.value))} required/></label>
      </div>
      <p>Nächster Lauf: <strong>{new Date(settings.nextRunAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" })}</strong> · Europe/Berlin</p>
      <p>Die Sicherung vor der Löschung bleibt mindestens für diese Frist erhalten. Offene Vorgänge und eine fehlende geprüfte Folgesicherung verhindern ihre Entfernung.</p>
      <div className="bonni-erasure__actions"><button type="submit" disabled={busy}>Einstellungen speichern</button></div>
    </form> : null}
    {message ? <p role="status">{message}</p> : null}
    <div className="bonni-erasure__filters">
     <input aria-label="Löschfälle suchen" placeholder="Mitglied oder Vorgang suchen" value={search} onChange={e => setSearch(e.target.value)}/>
     <select aria-label="Löschfälle filtern" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Offene Fälle</option><option value="REQUESTED">Freigabe ausstehend</option><option value="BLOCKED">Klärung erforderlich</option><option value="WAITING_CYCLE">Nächster Löschlauf</option><option value="COMPLETED">Abgeschlossen</option><option value="all">Alle Fälle</option></select>
     <button type="button" disabled={busy} onClick={refresh}>Übersicht aktualisieren</button>
    </div>
    <div className="bonni-erasure__cases">{shown.map(row => <article className="bonni-erasure__case" key={row.id}>
     <h4>{row.label}</h4><strong>{labels[row.state] || "Stand prüfen"}</strong>
     <dl><dt>Beantragt</dt><dd>{new Date(row.requestedAt).toLocaleString("de-DE")}</dd><dt>Freigabe</dt><dd>{row.approvedAt ? new Date(row.approvedAt).toLocaleString("de-DE") : "Steht noch aus"}</dd><dt>Nächster Lauf</dt><dd>{row.nextRunAt ? new Date(row.nextRunAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : row.state === "COMPLETED" ? "Abgeschlossen" : "Löschlauf pausiert"}</dd></dl>
     {row.blockers.length ? <ul>{row.blockers.map((code, i) => <li key={i}>{reasonText(code)}</li>)}</ul> : null}
     {row.state !== "COMPLETED" ? <button type="button" disabled={busy} onClick={() => check(row)}>Vorgänge und Sperrgründe prüfen</button> : null}
     <button type="button" disabled={busy} onClick={() => setSelected(selected === row.id ? null : row.id)}>{selected === row.id ? "Details schließen" : "Fall bearbeiten"}</button>
     {report?.id === row.id ? <ul>{report.reports.map(module => <li key={module.module}><strong>{module.module}</strong> · {module.status === "clear" ? "Geprüft" : module.status === "blocked" ? "Klärung erforderlich" : "Nicht vollständig geprüft"}{module.reasons.length ? <ul>{module.reasons.map((code, i) => <li key={i}>{reasonText(code)}</li>)}</ul> : null}{module.details?.length ? <ul>{module.details.map((detail, i) => <li key={i}>{detail.model} · {detail.count} · {reasonText(detail.reason)}</li>)}</ul> : null}</li>)}</ul> : null}
     {selected === row.id && actorAccountId ? <>
      {row.state === "REQUESTED" ? <ErasureCaseApproval token={token} actorAccountId={actorAccountId} row={row} onChange={refresh}/> : null}
      <ErasureRetentionPanel key={`${row.id}:${row.state}`} token={token} actorAccountId={actorAccountId} requestId={row.id} completed={row.state === "COMPLETED"} onChange={refresh}/>
     </> : null}
    </article>)}</div>
    {!shown.length ? <p>Keine Löschfälle in dieser Auswahl.</p> : null}
  </details>;
}
