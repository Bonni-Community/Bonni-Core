import { useState } from "react";
import ProviderProofForm from "../../two-factor/components/ProviderProofForm.jsx";
import { startErasureProof, verifyErasureProof, submitErasure } from "../api/erasureApi.js";
export default function ErasureCaseApproval({ token, actorAccountId, row, onChange }) {
 const [cleared, setCleared] = useState(false), [challenge, setChallenge] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
 async function run(work) { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (e) { setChallenge(null); setError(e.code === "ERASURE_FINANCIAL_NOT_CLEAR" ? "Kontostände und offene Vorgänge müssen zuerst geklärt werden. Öffne die Vorprüfung für Einzelheiten." : e.message || "Die Freigabe konnte nicht bestätigt werden."); } finally { setBusy(false); } }
 if (actorAccountId === row.accountId) return <p>Deinen eigenen Antrag muss eine andere berechtigte Person freigeben.</p>;
 return <div>
  <label className="bonni-erasure__checkbox"><input type="checkbox" checked={cleared} disabled={busy || Boolean(challenge)} onChange={e => setCleared(e.target.checked)}/> Alle betroffenen Geräte sind synchronisiert oder ihre lokalen Warteschlangen wurden bereinigt.</label>
  {challenge ? <ProviderProofForm key={challenge.id} provider={{ id: challenge.provider, label: challenge.providerLabel }} proofFields={challenge.proofFields} recoveryAllowed={challenge.provider === "local"} busy={busy} onCancel={() => setChallenge(null)} onVerify={proof => run(async () => {
   const id = challenge.id; try { await verifyErasureProof(token, id, proof, actorAccountId); } finally { Object.keys(proof).forEach(key => { proof[key] = ""; }); }
   setChallenge(null); await submitErasure(token, "approve", row.id, id, undefined, true); onChange();
  })} submitLabel="Antrag mit 2FA freigeben"/> : <button type="button" disabled={!cleared || busy} onClick={() => run(async () => setChallenge(await startErasureProof(token, "approve", row.id)))}>Freigabe mit 2FA starten</button>}
  {error ? <p role="alert">{error}</p> : null}
 </div>;
}
