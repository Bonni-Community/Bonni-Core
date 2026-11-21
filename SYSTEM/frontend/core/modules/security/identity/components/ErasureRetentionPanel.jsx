import { useEffect, useRef, useState } from "react";
import ProviderProofForm from "../../two-factor/components/ProviderProofForm.jsx";
import { erasureCaseRequest, startRetentionProof, verifyErasureProof, readErasureArchive, archiveErasureAccess } from "../api/erasureApi.js";
const date = value => value ? new Date(value?.$date || value).toLocaleDateString("de-DE") : "–";
const names = { FINANCE: "Finanznachweis", DOCUMENTS: "Dokument", AUDIT: "Nachweis im Verlauf" };
export default function ErasureRetentionPanel({ token, actorAccountId, requestId, completed, onChange }) {
 const [plan, setPlan] = useState(null), [archive, setArchive] = useState([]), [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
 const [reason, setReason] = useState(""), [until, setUntil] = useState(""), [choice, setChoice] = useState({}), [challenge, setChallenge] = useState(null), [readKey, setReadKey] = useState(null);
 const proofInput = useRef(null), scope = useRef(null);
 useEffect(() => { const c = new AbortController(); scope.current = c; load(c.signal); return () => c.abort(); }, [token, requestId]);
 async function load(signal) {
  setBusy(true); setError("");
  try {
   if (!completed) { const next = await erasureCaseRequest(token, requestId, "retention/preview", {}, signal); if (!signal?.aborted) setPlan(next); }
   const next = await readErasureArchive(token, requestId, signal); if (!signal?.aborted) setArchive(next.records || []);
  } catch (e) { if (!signal?.aborted) setError(e.code === "ERASURE_REVIEW_MFA_REQUIRED" ? "Bitte melde dich mit einem persönlichen 2FA-Verwaltungszugang an." : "Die Aufbewahrungsprüfung konnte nicht geladen werden."); }
  finally { if (!signal?.aborted) setBusy(false); }
 }
 async function run(fn) { if (busy) return; setBusy(true); setError(""); setMessage(""); try { await fn(); } catch (e) { setChallenge(null); setError(e.code === "ERASURE_RETENTION_SOURCE_CHANGED" ? "Die Daten haben sich geändert. Bitte die Prüfung erneut laden." : e.message || "Die Aktion konnte nicht bestätigt werden."); } finally { setBusy(false); } }
 function decisions() {
  const needsRetention = plan.candidates.some(row => row.required || choice[row.key] !== "delete");
  if (needsRetention && (!until || reason.trim().length < 8)) throw Error("Bitte eine Begründung mit mindestens 8 Zeichen und ein zukünftiges Enddatum eingeben.");
  const end = needsRetention ? new Date(until + "T23:59:59").toISOString() : undefined;
  return plan.candidates.map(row => ({ key: row.key, action: row.required ? "retain" : choice[row.key] || "retain", until: end, reason: reason.trim() })).map(row => row.action === "retain" ? row : { key: row.key, action: "delete" });
 }
 const start = () => run(async () => { const input = { revision: plan.revision, scopeHash: plan.scopeHash, decisions: decisions() }; proofInput.current = input; setReadKey(null); setChallenge(await startRetentionProof(token, requestId, input, scope.current.signal)); });
 const confirm = proof => run(async () => {
  const id = challenge.id;
  try { await verifyErasureProof(token, id, proof, actorAccountId, scope.current.signal); } finally { Object.keys(proof).forEach(key => { proof[key] = ""; }); }
  setChallenge(null);
  if (readKey) {
   const data = await archiveErasureAccess(token, requestId, readKey, { reason: proofInput.current.reason, challengeId: id }, scope.current.signal);
   const bytes = data.attachment?.bytesBase64 || data.original?.data?.$bytes;
   const raw = bytes ? Uint8Array.from(atob(bytes), character => character.charCodeAt(0)) : JSON.stringify(data, null, 2);
   const file = new Blob([raw], { type: bytes ? "application/octet-stream" : "application/json" }), url = URL.createObjectURL(file), a = document.createElement("a");
   a.href = url; a.download = bytes ? String(data.original?.originalName || data.original?.fileName || "Bonni-Aufbewahrungsnachweis.bin").split(/[\\/]/).pop() : "Bonni-Aufbewahrungsnachweis.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("Der geschützte Nachweis wurde zum Speichern bereitgestellt. Der Zugriff ist protokolliert.");
  } else {
   const data = await erasureCaseRequest(token, requestId, "retention/approve", { ...proofInput.current, challengeId: id }, scope.current.signal);
   setPlan(data.plan); setMessage("Aufbewahrungsentscheidung gespeichert. Die Löschung erfolgt erst im geplanten, geprüften Löschlauf."); onChange?.();
  }
 });
 const read = key => run(async () => {
  if (reason.trim().length < 8) throw Error("Bitte zuerst begründen, warum du den geschützten Nachweis öffnen möchtest.");
  proofInput.current = { reason: reason.trim() }; setReadKey(key); setChallenge(await archiveErasureAccess(token, requestId, key, proofInput.current, scope.current.signal));
 });
 return <section className="bonni-erasure__retention" aria-label="Aufbewahrung prüfen">
  <h4>Geschützte Aufbewahrung</h4>
  <p>Die Originale werden verschlüsselt getrennt abgelegt. Beträge und Buchungsbeziehungen bleiben für die Abrechnung erhalten; persönliche Inhalte werden aus den laufenden Datensätzen entfernt.</p>
  <label>Begründung für Aufbewahrung oder Zugriff<textarea value={reason} maxLength={500} disabled={busy || Boolean(challenge)} onChange={e => setReason(e.target.value)} placeholder="Welche Nachweise werden wofür benötigt?"/></label>
  {plan?.candidates?.length ? <>
   <label>Aufbewahren bis einschließlich<input type="date" value={until} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} disabled={busy || Boolean(challenge)} onChange={e => setUntil(e.target.value)}/></label>
   <p>Die Frist wird von der verantwortlichen Verwaltung festgelegt. Du kannst sie für die unten aufgeführten Nachweise gemeinsam freigeben.</p>
   <ul>{plan.candidates.map(row => <li key={row.key}>
    <strong>{names[row.category] || row.category}</strong> · {row.module} · {row.label} · {date(row.occurredAt)}
    {row.required ? <span> · Aufbewahrung erforderlich</span> : <select aria-label={`Entscheidung für ${row.label}`} value={choice[row.key] || "retain"} disabled={busy || Boolean(challenge)} onChange={e => setChoice(old => ({ ...old, [row.key]: e.target.value }))}><option value="retain">Geschützt aufbewahren</option><option value="delete">Im Löschlauf entfernen</option></select>}
   </li>)}</ul>
   {plan.state === "IN_REVIEW" && !challenge ? <button type="button" disabled={busy} onClick={start}>Aufbewahrung mit 2FA freigeben</button> : plan.state !== "IN_REVIEW" ? <p>Die Entscheidung kann nach der unabhängigen Freigabe des Löschantrags bestätigt werden.</p> : null}
  </> : plan ? <p>Keine weitere Aufbewahrungsentscheidung erforderlich.</p> : null}
  {plan?.unsupported?.length ? <div role="status"><strong>Diese Daten müssen gesondert geklärt werden:</strong><ul>{plan.unsupported.map((row, i) => <li key={i}>{row.module} · {row.model} · {row.count || ""} {row.reason === "SHARED_SUBJECT" ? "Gemeinsam genutzte Daten oder Daten anderer Personen" : "Datenquelle oder Dokumentzuordnung prüfen"}</li>)}</ul></div> : null}
  {archive.length ? <><h4>Abgelegte Nachweise</h4><ul>{archive.map(row => <li key={row.key}>{row.module} · {row.model} · {row.action === "delete" ? "Entfernung dokumentiert" : row.expiredAt ? "Aufbewahrungsfrist beendet" : `Aufbewahrt bis ${date(row.until)}`} {row.action === "retain" && !row.expiredAt ? <button type="button" disabled={busy || Boolean(challenge)} onClick={() => read(row.key)}>Geschützt öffnen</button> : null}</li>)}</ul></> : null}
  {challenge ? <ProviderProofForm key={challenge.id} provider={{ id: challenge.provider, label: challenge.providerLabel }} proofFields={challenge.proofFields} recoveryAllowed={challenge.provider === "local"} busy={busy} onVerify={confirm} onCancel={() => setChallenge(null)} submitLabel={readKey ? "Nachweis mit 2FA öffnen" : "Aufbewahrung mit 2FA bestätigen"}/> : null}
  {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
  <button type="button" disabled={busy || Boolean(challenge)} onClick={() => load(scope.current.signal)}>Prüfung neu laden</button>
 </section>;
}
