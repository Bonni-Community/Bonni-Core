import { useEffect, useRef, useState } from "react";
import { createMatrixChallenge, getMatrixManager, getMatrixStatus, matrixCommand, saveMatrixManager, verifyMatrixChallenge } from "../../../../system/api/matrixManagerApi.js";
import { normalizeProofFields } from "../../../../core/modules/security/two-factor/api/twoFactorDto.js";
import ProviderProofForm from "../../../../core/modules/security/two-factor/components/ProviderProofForm.jsx";
import "./Matrix.css";

const EMPTY = { controllerUrl: "", installationId: "bonni-matrix", secretConfigured: false, version: 0,
  grants: { status: false, lifecycle: false, configure: false, update: false } };
const ERRORS = {
  GRANT_REQUIRED: "Für diesen Vorgang fehlt die Freigabe.", STATUS_GRANT_REQUIRED: "Bitte zuerst die Statusabfrage freigeben.",
  ORIGIN_NOT_APPROVED: "Diese Verwaltungsadresse ist auf dem Core-Server noch nicht zugelassen.",
  NOT_CONFIGURED: "Bitte Verwaltungsadresse, Kennung und Steuerungsschlüssel einrichten.",
  UNREACHABLE: "Der Verwaltungsdienst ist nicht erreichbar. Der Matrix-Server kann trotzdem weiterlaufen.",
  RESPONSE_SIGNATURE_INVALID: "Der Verwaltungsdienst konnte nicht bestätigt werden. Bitte Adresse und Steuerungsschlüssel prüfen.",
  CONFIGURATION_CHANGED: "Die Einstellungen wurden inzwischen geändert. Bitte den aktuellen Stand laden.",
  NOT_INSTALLED: "Matrix / Synapse wurde auf dem Verwaltungsrechner noch nicht eingerichtet.",
  BUSY: "Ein Vorgang läuft bereits oder benötigt eine Wiederherstellung.",
  UPDATE_SELECTION_EXPIRED: "Der Update-Stand ist nicht mehr aktuell. Bitte erneut nach Updates suchen.",
  ACTIVE_CORE_REQUIRED: "Nur die aktive Core-Instanz darf diesen Vorgang ausführen.",
};
function failure(error) {
  const code = String(error?.data?.error || error?.message || "").replace(/^MATRIX_MANAGER_/, "");
  return ERRORS[code] || "Die Matrix-Verwaltung konnte den Vorgang nicht abschließen. Bitte Verbindung und Freigaben prüfen.";
}
const STAGES = { queued: "Wird vorbereitet", "preparing-image": "Neue Version wird vorbereitet", backup: "Datenbank und Serverdaten werden gesichert",
  starting: "Server wird gestartet und geprüft", restoring: "Vorheriger Stand wird wiederhergestellt", done: "Abgeschlossen", interrupted: "Vorgang wurde unterbrochen" };
export default function MatrixTab({ token }) {
  const [settings, setSettings] = useState(EMPTY), [status, setStatus] = useState(null), [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [challenge, setChallenge] = useState(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [available, setAvailable] = useState(null);
  const secret = useRef(null), pending = useRef(null), inFlight = useRef(null), latch = useRef(false), generation = useRef(0);
  const storedSettings = useRef(EMPTY), formGeneration = useRef(0), refreshSerial = useRef(0);
  const jobRunning = status?.job?.state === "running";
  function eraseStaged() {
    for (const operation of [pending.current, inFlight.current]) if (operation?.payload?.secret) operation.payload.secret = "";
    pending.current = null; inFlight.current = null;
    if (secret.current) secret.current.value = "";
  }
  async function refresh() {
    const current = ++refreshSerial.current, owner = generation.current;
    try {
      const result = await getMatrixStatus(token);
      if (owner !== generation.current || current !== refreshSerial.current) return;
      setStatus(result.status || null);
      setAvailable(result.status?.availableUpdate || null);
    } catch (caught) { if (owner === generation.current && current === refreshSerial.current) { setError(failure(caught)); setStatus((before) => before ? { ...before, connected: false } : null); } }
  }
  useEffect(() => {
    let active = true; generation.current++; eraseStaged(); latch.current = false; storedSettings.current = EMPTY; setSettings(EMPTY); setBusy(false); setNotice(""); setLoading(true); setError(""); setStatus(null); setAvailable(null); setConfig(null); setChallenge(null);
    getMatrixManager(token).then(async (result) => {
      if (!active) return;
      storedSettings.current = result.settings; setSettings(result.settings);
      if (result.settings.grants.status) await refresh();
    }, (caught) => { if (active) setError(failure(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current++; refreshSerial.current++; eraseStaged(); };
  }, [token]);
  useEffect(() => {
    const hide = () => { generation.current++; eraseStaged(); latch.current = false; setBusy(false); setChallenge(null); };
    window.addEventListener("pagehide", hide);
    return () => window.removeEventListener("pagehide", hide);
  }, []);
  useEffect(() => {
    if (!storedSettings.current.grants.status) return undefined;
    const interval = window.setInterval(refresh, jobRunning ? 2500 : 15_000);
    return () => window.clearInterval(interval);
  }, [token, jobRunning, settings.version]);
  useEffect(() => {
    if (!challenge) return undefined;
    const expires = Date.parse(challenge.expiresAt || ""), duration = Number.isFinite(expires) ? Math.max(0, Math.min(60_000, expires - Date.now())) : 60_000;
    const timeout = window.setTimeout(() => { eraseStaged(); setChallenge(null); setError("Die Bestätigung ist abgelaufen. Bitte den Vorgang erneut auswählen."); }, duration);
    return () => window.clearTimeout(timeout);
  }, [challenge]);
  function edit(change) { formGeneration.current++; setSettings((current) => ({ ...current, ...change })); }
  function grant(name, value) { edit({ grants: name === "status" && !value ? { status: false, lifecycle: false, configure: false, update: false }
    : { ...settings.grants, [name]: value } }); }
  async function requestApproval(action, payload) {
    if (latch.current || busy || jobRunning) return;
    latch.current = true; setBusy(true); setError(""); setNotice("");
    const owner = generation.current;
    const staged = { action, payload, form: formGeneration.current, owner };
    if (action === "save") {
      const value = secret.current?.value || "";
      if (value && !/^[A-Za-z0-9_-]{43,128}$/.test(value)) { setError("Bitte den vollständigen Steuerungsschlüssel aus der Einrichtung übernehmen."); setBusy(false); latch.current = false; return; }
      if (value) staged.payload = { ...payload, secret: value };
      if (secret.current) secret.current.value = "";
    }
    pending.current = staged;
    try {
      const result = await createMatrixChallenge(token), value = result.challenge || result;
      if (owner !== generation.current) return;
      const fields = normalizeProofFields(value.proofFields);
      if (!value.id || !fields.length || fields.some((field) => field.name === "recoveryCode")) throw new Error("2FA contract invalid");
      setChallenge({ ...value, proofFields: fields });
    } catch (caught) { if (owner === generation.current) { eraseStaged(); setError(caught?.message || "Die Bestätigung konnte nicht gestartet werden."); } }
    finally { if (owner === generation.current) { setBusy(false); latch.current = false; } }
  }
  async function confirm(proof) {
    if (latch.current) return;
    latch.current = true; setBusy(true); setError("");
    const staged = pending.current, id = challenge?.id, owner = generation.current;
    inFlight.current = staged;
    try {
      if (!staged || !id || staged.owner !== owner || staged.form !== formGeneration.current) throw new Error("Die Auswahl hat sich geändert. Bitte den Vorgang neu bestätigen.");
      await verifyMatrixChallenge(token, id, proof); proof = null;
      if (owner !== generation.current || staged.form !== formGeneration.current) return;
      pending.current = null; setChallenge(null);
      if (staged.action === "save") {
        const result = await saveMatrixManager(token, staged.payload, id);
        if (owner !== generation.current) return;
        storedSettings.current = result.settings; setSettings(result.settings); setStatus(null); setConfig(null);
        setNotice("Verbindung und Freigaben wurden gespeichert.");
        if (result.settings.grants.status) await refresh();
      } else {
        const result = await matrixCommand(token, staged.action, staged.payload, id);
        if (owner !== generation.current) return;
        if (staged.action === "configure") setConfig(null);
        setNotice(result.result?.job ? "Der Vorgang läuft im unabhängigen Verwaltungsdienst." : "Der Vorgang wurde ausgeführt."); await refresh();
      }
    } catch (caught) { if (owner === generation.current) { pending.current = null; setChallenge(null); setError(failure(caught)); } }
    finally { if (staged?.payload?.secret) staged.payload.secret = ""; if (inFlight.current === staged) inFlight.current = null; proof = null; if (owner === generation.current) { setBusy(false); latch.current = false; } }
  }
  async function read(action) {
    if (latch.current || jobRunning) return;
    latch.current = true; setBusy(true); setError(""); const owner = generation.current;
    try {
      const response = await matrixCommand(token, action);
      if (owner !== generation.current) return;
      if (action === "configuration") setConfig(response.result);
      else { setAvailable(response.result.available ? response.result : null); setNotice(response.result.available ? "Eine neue Synapse-Version ist verfügbar." : "Synapse ist auf dem geprüften aktuellen Stand."); }
    } catch (caught) { if (owner === generation.current) setError(failure(caught)); }
    finally { if (owner === generation.current) { setBusy(false); latch.current = false; } }
  }
  const grants = storedSettings.current.grants;
  const running = status?.services?.find((service) => service.service === "synapse")?.state === "running";
  const locked = busy || jobRunning || Boolean(challenge);
  return <div className="cc-system-tab-panel cc-matrix">
    {error ? <p className="cc-system-error" role="alert">{error}</p> : null}
    {notice ? <p className="cc-system-success" role="status">{notice}</p> : null}
    <section className="cc-system-card">
      <div className="cc-system-card__header"><div><h2>Matrix / Synapse</h2><p>Eigenständiger Messenger-Server mit optionaler Steuerung durch Bonni Core.</p></div>
        <span className={`cc-matrix-state${running ? " cc-matrix-state--online" : ""}`}>{loading ? "Wird geladen" : !grants.status ? "Nicht verbunden" : !status?.connected ? "Verwaltung nicht erreichbar" : running ? "Läuft" : "Gestoppt"}</span></div>
      <dl className="cc-matrix-summary"><div><dt>Server</dt><dd>{status?.serverName || "Noch nicht eingerichtet"}</dd></div><div><dt>Synapse-Version</dt><dd>{status?.version || "–"}</dd></div>
        <div><dt>Datenbank</dt><dd>{status?.services?.find((service) => service.service === "db")?.state === "running" ? "Läuft" : "–"}</dd></div></dl>
      {status && !status.installed ? <p>Bitte den eigenständigen Matrix-Dienst zuerst mit dem beiliegenden Einrichtungspaket auf dem vorgesehenen Rechner installieren.</p> : null}
      <div className="cc-matrix-actions"><button type="button" disabled={locked || !grants.lifecycle || !status?.installed || running} onClick={() => requestApproval("start", {})}>Starten</button>
        <button type="button" disabled={locked || !grants.lifecycle || !running} onClick={() => requestApproval("stop", {})}>Stoppen</button>
        <button type="button" disabled={locked || !grants.lifecycle || !running} onClick={() => requestApproval("restart", {})}>Neu starten</button>
        <button type="button" disabled={busy || !grants.status} onClick={refresh}>Status prüfen</button></div>
      {status?.job ? <div className="cc-matrix-job" role="status"><strong>{status.job.state === "running" ? STAGES[status.job.stage] || "Vorgang läuft" : status.job.state === "succeeded" ? "Letzter Vorgang abgeschlossen" : status.job.state === "restored" ? "Vorheriger Stand wurde wiederhergestellt" : status.job.state === "recovery-required" ? "Wiederherstellung durch Administration erforderlich" : "Letzter Vorgang fehlgeschlagen"}</strong>
        {status.job.backupId ? <small>Sicherung: {status.job.backupId}</small> : null}</div> : null}
    </section>
    <section className="cc-system-card"><div className="cc-system-card__header"><div><h2>Aktualisierung</h2><p>Synapse separat aktualisieren. Vor dem Wechsel werden Datenbank und Serverdaten gesichert.</p></div></div>
      {available ? <p>Verfügbar: <strong>{available.version}</strong> {available.releaseUrl?.startsWith("https://github.com/element-hq/synapse/releases/tag/") ? <a href={available.releaseUrl} target="_blank" rel="noreferrer">Versionshinweise</a> : null}</p> : null}
      <div className="cc-matrix-actions"><button type="button" disabled={locked || !grants.update} onClick={() => read("check-update")}>Nach Update suchen</button>
        <button type="button" disabled={locked || !grants.update || !available || !status?.installed} onClick={() => requestApproval("update", { version: available.version })}>Aktualisieren</button></div>
    </section>
    <details className="cc-system-card cc-matrix-details"><summary>Server konfigurieren</summary>
      {!config ? <button type="button" disabled={locked || !grants.status} onClick={() => read("configuration")}>Konfiguration öffnen</button> : <div className="cc-matrix-fields">
        <label>Servername<input readOnly value={config.serverName}/><small>Dieser Identitätsname bleibt nach der Einrichtung unverändert.</small></label>
        <label>Serveradresse<input type="url" disabled={locked || !grants.configure} value={config.publicBaseUrl} onChange={(event) => { formGeneration.current++; setConfig({ ...config, publicBaseUrl: event.target.value }); }}/></label>
        <label>Freigegebene Partner-Server<textarea rows="3" disabled={locked || !grants.configure} value={config.allowedServers.join("\n")} onChange={(event) => { formGeneration.current++; setConfig({ ...config, allowedServers: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) }); }}/><small>Ein Servername je Zeile. Leer bedeutet: keine Verbindung zu anderen Servern.</small></label>
        <label>Maximale Dateigröße in MiB<input type="number" min="1" max="100" disabled={locked || !grants.configure} value={config.maxUploadMiB} onChange={(event) => { formGeneration.current++; setConfig({ ...config, maxUploadMiB: Number(event.target.value) }); }}/></label>
        <button type="button" disabled={locked || !grants.configure} onClick={() => requestApproval("configure", config)}>Speichern und Server neu starten</button>
      </div>}
    </details>
    <details className="cc-system-card cc-matrix-details" open={!settings.secretConfigured}><summary>Verbindung und Freigaben</summary>
      <div className="cc-matrix-fields"><label>Verwaltungsadresse<input type="url" disabled={locked} placeholder="http://127.0.0.1:18090" value={settings.controllerUrl} onChange={(event) => edit({ controllerUrl: event.target.value })}/></label>
        <label>Installationskennung<input disabled={locked} value={settings.installationId} onChange={(event) => edit({ installationId: event.target.value })}/></label>
        <label>Steuerungsschlüssel<input ref={secret} type="password" autoComplete="off" disabled={locked} placeholder={settings.secretConfigured ? "Schlüssel hinterlegt – nur zum Ändern eingeben" : "Schlüssel aus der Einrichtung"}/></label>
        {[['status','Status anzeigen'],['lifecycle','Start, Stopp und Neustart erlauben'],['configure','Serverkonfiguration ändern erlauben'],['update','Nach Updates suchen und Updates ausführen erlauben']].map(([name,label]) => <label className="cc-matrix-check" key={name}><input type="checkbox" disabled={locked || (name !== "status" && !settings.grants.status)} checked={settings.grants[name]} onChange={(event) => grant(name,event.target.checked)}/>{label}</label>)}
        <p>Ohne gespeicherte Freigabe erfolgt kein Zugriff. Das Entziehen der Freigabe stoppt den Messenger nicht. Ein bereits bestätigter Vorgang wird vom Verwaltungsdienst zu Ende geführt.</p>
        <button type="button" disabled={locked || loading} onClick={() => requestApproval("save", {
          controllerUrl: settings.controllerUrl, installationId: settings.installationId, version: settings.version, grants: settings.grants,
        })}>Verbindung und Freigaben speichern</button>
      </div>
    </details>
    {challenge ? <section className="cc-system-card"><h2>Vorgang bestätigen</h2><p>Bestätige die ausgewählte Änderung mit deinem eingerichteten 2FA-Anbieter.</p>
      <ProviderProofForm provider={{ id: challenge.provider, label: challenge.providerLabel || "2FA-Anbieter" }} proofFields={challenge.proofFields}
        recoveryAllowed={challenge.provider === "local"} busy={busy} submitLabel="Bestätigen und ausführen" onVerify={confirm}
        onCancel={() => { eraseStaged(); setChallenge(null); }}/></section> : null}
  </div>;
}
