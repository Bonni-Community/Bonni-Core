import { useEffect, useRef, useState } from "react";
import ProviderProofForm from "../../two-factor/components/ProviderProofForm.jsx";
import { readErasure, startErasureProof, submitErasure, verifyErasureProof } from "../api/erasureApi.js";
import "./SystemErasurePanel.css";
import ErasureCycleSettings from "./ErasureCycleSettings.jsx";

const CHECK = { blocked: "Offene Vorgänge", clear: "Geprüft", unverified: "Nicht abschließend geprüft" };
function date(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}
function message(error, fallback) {
  if (error?.code === "ERASURE_SELF_APPROVAL_FORBIDDEN") return "Deinen eigenen Antrag muss eine andere berechtigte Person freigeben.";
  if (/NOT_CONFIGURED|NOT_ENROLLED|ENROLLMENT_REQUIRED/.test(error?.code || "")) return "Für diese Aktion muss eine persönliche Zwei-Faktor-Authentifizierung eingerichtet sein.";
  if (error?.status === 403) return "Für diese Aktion fehlt die Berechtigung.";
  if (error?.status === 401 || /TWO_FACTOR/.test(error?.code || "")) return "Die Sicherheitsabfrage ist abgelaufen oder der Nachweis wurde nicht akzeptiert. Bitte starte eine neue Abfrage.";
  return error?.status ? fallback : (error?.message || fallback);
}
function Checks({ checks }) {
  const stamp = date(checks?.checkedAt || checks?.generatedAt);
  return <div className="bonni-erasure__checks">
    <h4>Vorprüfung</h4><p>{CHECK[checks?.status] || CHECK.unverified}{stamp ? ` · ${stamp}` : ""}</p>
    {checks?.reason ? <p>{checks.reason}</p> : null}
    {checks?.modules?.length ? <ul>{checks.modules.map(m => <li key={m.key}>
      <strong>{typeof m.label === "string" && m.label ? m.label : m.key}: </strong>{CHECK[m.status]}
      {m.reasons.length ? <ul>{m.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}
    </li>)}</ul> : null}
  </div>;
}
function CasePanel({ token, actorAccountId, targetAccountId, targetLabel, isOwnRecord }) {
  const review = Boolean(targetAccountId), selfApproval = review && (isOwnRecord || actorAccountId === targetAccountId);
  const [snapshot, setSnapshot] = useState(null), [challenge, setChallenge] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [devicesCleared, setDevicesCleared] = useState(false);
  const scope = useRef(null), running = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); scope.current = controller;
    running.current = false; setBusy(true); setChallenge(null); setError(""); setSnapshot(null);
    readErasure(token, targetAccountId, controller.signal).then(result => {
      if (!controller.signal.aborted) setSnapshot(result);
    }).catch(e => {
      if (!controller.signal.aborted) setError(message(e, "Der Antragsstand konnte nicht geladen werden."));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [token, actorAccountId, targetAccountId]);

  async function run(fn) {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    running.current = true; setBusy(true); setError("");
    try { await fn(signal); }
    catch (e) { if (!signal.aborted) { setChallenge(null); setError(message(e, "Die Aktion konnte nicht bestätigt werden. Bitte den Status erneut laden.")); } }
    finally { if (!signal.aborted) { running.current = false; setBusy(false); } }
  }
  const refresh = () => run(async signal => {
    const next = await readErasure(token, targetAccountId, signal);
    if (!signal.aborted) setSnapshot(next);
  });
  const r = snapshot?.request;
  const eligible = Boolean(snapshot && !selfApproval && (review ? r?.state === "REQUESTED" && devicesCleared : !r));
  const start = () => eligible && run(async signal => {
    const next = await startErasureProof(token, review ? "approve" : "request", r?.id, signal);
    if (!signal.aborted) setChallenge(next);
  });
  const confirm = proof => eligible && challenge && run(async signal => {
    const id = challenge.id;
    try { await verifyErasureProof(token, id, proof, actorAccountId, signal); }
    finally { Object.keys(proof).forEach(key => { proof[key] = ""; }); }
    if (signal.aborted) return;
    setChallenge(null);
    // The previous state no longer authorizes a retry after an ambiguous write.
    setSnapshot(null);
    const next = await submitErasure(token, review ? "approve" : "request", r?.id, id, signal, devicesCleared);
    if (signal.aborted) return;
    setSnapshot(next);
    if (review && !next.checks) {
      const current = await readErasure(token, targetAccountId, signal);
      if (!signal.aborted) setSnapshot(current);
    }
  });
  return <section className="bonni-erasure" aria-label={review ? "Löschantrag prüfen" : "Löschantrag"}>
    <h3>{review ? "Löschantrag prüfen" : "Löschung meiner Daten beantragen"}</h3>
    <p>{review ? `Löschantrag für ${targetLabel || "das ausgewählte Konto"}. Nach der Freigabe wird der Zugang deaktiviert und für den Löschzyklus vorgemerkt.` :
      "Dein Antrag betrifft dein persönliches Konto in Bonni Core und deine Daten in allen Bonni-Apps. Du kannst ihn auch stellen, wenn du noch Guthaben oder Schulden hast."}</p>
    <p>Vor dem Abschluss müssen Guthaben und Schulden ausgeglichen und offene Vorgänge geklärt sein. Belege, die aufbewahrt werden müssen, bleiben erhalten.</p>
    <div className="bonni-erasure__state" role="status">
      {snapshot ? !r ? "Es liegt kein Löschantrag vor." : <>
        <strong>{{ REQUESTED: "Antrag eingegangen – Freigabe ausstehend", APPROVED_PENDING_CHECKS: "Freigegeben – Vorbereitung ausstehend",
          DEACTIVATED: "Zugang deaktiviert", WAITING_CYCLE: "Deaktiviert – wartet auf Löschzyklus", BLOCKED: "Deaktiviert – weitere Prüfung erforderlich",
          ERASING: "Löschung läuft" }[r.state] || "Bearbeitungsstand prüfen"}</strong>
        <span>Beantragt am {date(r.requestedAt)}{r.approvedAt ? ` · Freigegeben am ${date(r.approvedAt)}` : ""}</span>
      </> : busy ? "Antragsstand wird geprüft …" : "Antragsstand derzeit unbekannt."}
    </div>
    {!review && snapshot?.acknowledgement ? <div className="bonni-erasure__state" role="status">
      <strong>{snapshot.acknowledgement.title}</strong><p>{snapshot.acknowledgement.message}</p>
      {snapshot.acknowledgement.statusPath?.startsWith("/#erasure-status=") ? <>
       <p>Speichere diesen persönlichen Link, bevor dein Zugang deaktiviert wird. Dort erhältst du auch Mitteilungen zu Verzögerungen und zum Abschluss.</p>
       <a href={snapshot.acknowledgement.statusPath} target="_blank" rel="noreferrer">Persönlichen Löschstatus öffnen</a>
       <button type="button" onClick={() => {
        const link = new URL(snapshot.acknowledgement.statusPath, window.location.origin).href;
        const file = new Blob(["Dein persönlicher Löschstatus\n\n" + link + "\n\nDiesen Link privat aufbewahren. Er funktioniert auch nach der Deaktivierung.\n"], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(file), anchor = document.createElement("a"); anchor.href = url; anchor.download = "Bonni-Loeschstatus.txt"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
       }}>Statuslink speichern</button>
      </> : null}
    </div> : null}
    {review && r ? <Checks checks={snapshot.checks}/> : null}
    {review && r?.state === "REQUESTED" && !selfApproval ? <label className="bonni-erasure__checkbox">
      <input type="checkbox" checked={devicesCleared} disabled={busy || Boolean(challenge)} onChange={e => setDevicesCleared(e.target.checked)}/>
      Alle betroffenen Geräte sind synchronisiert oder ihre lokalen Warteschlangen wurden bereinigt.
    </label> : null}
    {selfApproval && r?.state === "REQUESTED" ? <p>Deinen eigenen Antrag muss eine andere berechtigte Person freigeben.</p> : null}
    {error ? <p className="bonni-erasure__error" role="alert">{error}</p> : null}
    {challenge ? <ProviderProofForm key={challenge.id} provider={{ id: challenge.provider, label: challenge.providerLabel }}
      proofFields={challenge.proofFields} recoveryAllowed={challenge.provider === "local"} busy={busy}
      onVerify={confirm} onCancel={() => { setChallenge(null); setError(""); }}
      submitLabel={review ? "Mit 2FA zur Bearbeitung freigeben" : "Mit 2FA Antrag stellen"}/>
    : <div className="bonni-erasure__actions">
      {eligible ? <button type="button" className="is-primary" onClick={start} disabled={busy}>
        {review ? "Freigabe mit 2FA starten" : "Löschantrag mit 2FA starten"}</button> : null}
      <button type="button" disabled={busy} onClick={refresh}>Status aktualisieren</button>
    </div>}
    {review && !selfApproval ? <ErasureCycleSettings token={token} actorAccountId={actorAccountId}/> : null}
  </section>;
}
export default function SystemErasurePanel(props) {
  if (!props.actorAccountId || !props.token) return <p role="alert">Dein persönliches Konto konnte nicht sicher zugeordnet werden.</p>;
  return <CasePanel key={`${props.actorAccountId}:${props.targetAccountId || "me"}`} {...props}/>;
}
