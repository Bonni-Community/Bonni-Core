import { useEffect, useState } from "react";

import { fetchSystemMonitoringStatus } from "../../../system/api/systemMonitoringApi.js";
import {
  fetchSystemNetworkPolicies,
  updateSystemNetworkPolicy,
} from "../../../system/api/systemNetworkPolicyApi.js";
import { formatBonniCoreVersion } from "../update/localUpdatePresentation.js";
import "./SystemPage.css";

const STATE_LABELS = {
  healthy: "Funktioniert",
  degraded: "Eingeschränkt",
  unhealthy: "Störung",
  unknown: "Unbekannt",
};

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUptime(value) {
  const seconds = Math.max(0, Number(value || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} T ${hours} Std`;
  if (hours) return `${hours} Std ${minutes} Min`;
  return `${minutes} Min`;
}

export default function SystemPage({ token, onNavigate }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [networkPolicies, setNetworkPolicies] = useState([]);
  const [networkObservations, setNetworkObservations] = useState([]);
  const [networkSaving, setNetworkSaving] = useState("");

  async function loadStatus({ quiet = false } = {}) {
    if (!token) return;
    if (!quiet) setLoading(true);
    try {
      setStatus(await fetchSystemMonitoringStatus(token));
      setError("");
    } catch (loadError) {
      setError(loadError?.message || "Systemstatus konnte nicht geladen werden.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  async function loadNetworkPolicies({ quiet = false } = {}) {
    if (!token) return;
    try {
      const payload = await fetchSystemNetworkPolicies(token);
      setNetworkPolicies(payload?.policies || []);
      setNetworkObservations(payload?.observations || []);
    } catch (loadError) {
      if (!quiet) setError(loadError?.message || "Netzwerkregeln konnten nicht geladen werden.");
    }
  }

  function updatePolicyDraft(moduleKey, change) {
    setNetworkPolicies((current) => current.map((policy) => (
      policy.key === moduleKey ? { ...policy, ...change } : policy
    )));
  }

  async function saveNetworkPolicy(policy) {
    setNetworkSaving(policy.key);
    try {
      await updateSystemNetworkPolicy(token, policy.key, {
        exposure: policy.exposure,
        outboundEnabled: Boolean(policy.outboundEnabled),
        requireTls: Boolean(policy.requireTls),
        allowedHosts: policy.allowedHosts || [],
        allowedProtocols: policy.allowedProtocols || [],
      });
      await loadNetworkPolicies();
      setError("");
    } catch (saveError) {
      setError(saveError?.message || "Netzwerkregel konnte nicht gespeichert werden.");
    } finally {
      setNetworkSaving("");
    }
  }

  useEffect(() => {
    let intervalId;
    loadStatus();
    loadNetworkPolicies();
    intervalId = window.setInterval(() => loadStatus({ quiet: true }), 10_000);
    return () => window.clearInterval(intervalId);
  }, [token]);

  const state = status?.state || "unknown";

  return (
    <section className="cc-menu-layout-page cc-system-monitoring-page">
      <header className="cc-user-page__header cc-menu-page-header cc-monitoring-header">
        <div>
          <p className="cc-monitoring-eyebrow">Bonni Core</p>
          <h1>Systemüberwachung</h1>
          <p>Systemstatus, Ressourcen sowie aktuelle Warnungen und Störungen.</p>
        </div>
        <button type="button" onClick={() => loadStatus()} disabled={loading}>
          {loading ? "Prüfe …" : "Jetzt prüfen"}
        </button>
      </header>

      {error ? <div className="cc-monitoring-alert is-critical">{error}</div> : null}

      <section className={`cc-monitoring-overall is-${state}`}>
        <div>
          <span className="cc-monitoring-state-dot" aria-hidden="true" />
          <div>
            <small>Systemstatus</small>
            <strong>{STATE_LABELS[state]}</strong>
          </div>
        </div>
        <dl>
          <div><dt>Version</dt><dd>{formatBonniCoreVersion(status?.version)}</dd></div>
          <div><dt>Betriebszeit</dt><dd>{formatUptime(status?.uptimeSeconds)}</dd></div>
          <div><dt>System</dt><dd>{status?.hostname || "—"}</dd></div>
        </dl>
      </section>

      <section className="cc-monitoring-section">
        <div className="cc-monitoring-section__heading">
          <div><span>Live</span><h2>Systemstatus</h2></div>
          <small>{status?.checkedAt ? `Geprüft ${new Date(status.checkedAt).toLocaleTimeString("de-DE")}` : "Wird geladen"}</small>
        </div>
        <div className="cc-monitoring-component-grid">
          {(status?.components || []).map((component) => (
            <article key={component.key} className={`cc-monitoring-card is-${component.state}`}>
              <div><span className="cc-monitoring-state-dot" aria-hidden="true" /><b>{STATE_LABELS[component.state]}</b></div>
              <h3>{component.label}</h3>
              <p>{component.message}</p>
              {component.target !== "system" ? (
                <button type="button" onClick={() => onNavigate?.(component.target)}>
                  {component.target === "store" ? "Im Store öffnen" : "Server öffnen"}
                </button>
              ) : <small>Systemüberwachung</small>}
            </article>
          ))}
        </div>
      </section>

      <section className="cc-monitoring-section">
        <div className="cc-monitoring-section__heading">
          <div><span>Mini-Firewall</span><h2>Netzwerkzugriff der Apps</h2></div>
          <small>Ohne gespeicherte Regel bleibt ein Modul vom Bonni-Netz getrennt.</small>
        </div>
        <div className="cc-network-policy-list">
          {networkPolicies.map((policy) => (
            <article className="cc-network-policy" key={policy.key}>
              <div className="cc-network-policy__title">
                <div><strong>{policy.name}</strong><small>{policy.key}</small></div>
                <span className={policy.configured ? "is-configured" : ""}>
                  {policy.configured ? "Regel aktiv" : "Abgetrennt"}
                </span>
              </div>
              <div className="cc-network-policy__fields">
                <label>
                  <span>Eingehend</span>
                  <select
                    value={policy.exposure}
                    onChange={(event) => updatePolicyDraft(policy.key, { exposure: event.target.value })}
                  >
                    <option value="DISABLED">Aus</option>
                    <option value="LOCAL">Nur eigene Organisation</option>
                    <option value="INTERNAL">Bonni-Netz</option>
                    <option value="PUBLIC">Öffentlich erreichbar</option>
                  </select>
                </label>
                <label>
                  <span>Erlaubte Gegenstellen</span>
                  <input
                    value={(policy.allowedHosts || []).join(", ")}
                    placeholder="leer = alle verifizierten Bonni-Gegenstellen"
                    onChange={(event) => updatePolicyDraft(policy.key, {
                      allowedHosts: event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                    })}
                  />
                </label>
                <label>
                  <span>Erlaubte Protokolle</span>
                  <input
                    value={(policy.allowedProtocols || []).join(", ")}
                    placeholder="leer = alle eigenen Protokolle"
                    onChange={(event) => updatePolicyDraft(policy.key, {
                      allowedProtocols: event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                    })}
                  />
                </label>
              </div>
              <div className="cc-network-policy__actions">
                <label><input type="checkbox" checked={Boolean(policy.outboundEnabled)} onChange={(event) => updatePolicyDraft(policy.key, { outboundEnabled: event.target.checked })} /> Ausgehend erlauben</label>
                <label><input type="checkbox" checked={Boolean(policy.requireTls)} onChange={(event) => updatePolicyDraft(policy.key, { requireTls: event.target.checked })} /> Verschlüsselung erzwingen</label>
                <button type="button" disabled={networkSaving === policy.key} onClick={() => saveNetworkPolicy(policy)}>
                  {networkSaving === policy.key ? "Speichere …" : "Regel speichern"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="cc-monitoring-section">
        <div className="cc-monitoring-section__heading">
          <div><span>Protokoll</span><h2>Letzte Netzwerkentscheidungen</h2></div>
          <b>{networkObservations.length}</b>
        </div>
        <div className="cc-network-observation-table-wrap">
          <table className="cc-network-observation-table">
            <thead><tr><th>Zeit</th><th>App</th><th>Richtung</th><th>Protokoll</th><th>Gegenstelle</th><th>Entscheidung</th><th>Grund</th></tr></thead>
            <tbody>
              {networkObservations.length ? networkObservations.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.observedAt).toLocaleString("de-DE")}</td>
                  <td>{entry.moduleKey}</td>
                  <td>{entry.direction === "INBOUND" ? "Eingehend" : "Ausgehend"}</td>
                  <td>{entry.protocol || "—"}</td>
                  <td>{entry.remoteHost || "—"}</td>
                  <td><span className={`cc-network-decision is-${String(entry.decision).toLowerCase()}`}>{entry.decision === "ALLOW" ? "Erlaubt" : "Blockiert"}</span></td>
                  <td>{entry.reason || "—"}</td>
                </tr>
              )) : <tr><td colSpan="7">Noch keine Netzwerkzugriffe protokolliert.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cc-monitoring-section">
        <div className="cc-monitoring-section__heading"><div><span>Auslastung</span><h2>Ressourcen</h2></div></div>
        <div className="cc-monitoring-resource-grid">
          {(status?.resources || []).map((resource) => (
            <article key={resource.key} className={`cc-monitoring-resource is-${resource.state}`}>
              <div><h3>{resource.label}</h3><strong>{Math.round(Number(resource.percent || 0))} %</strong></div>
              <div className="cc-monitoring-meter"><span style={{ width: `${Math.max(0, Math.min(100, Number(resource.percent || 0)))}%` }} /></div>
              <small>
                {resource.totalBytes
                  ? `${formatBytes(resource.usedBytes)} von ${formatBytes(resource.totalBytes)}`
                  : resource.detail || resource.path || "Live-Messung"}
              </small>
            </article>
          ))}
        </div>
      </section>

      <section className="cc-monitoring-section">
        <div className="cc-monitoring-section__heading">
          <div><span>Nur aktuell</span><h2>Warnungen und Störungen</h2></div>
          <b>{status?.warnings?.length || 0}</b>
        </div>
        {status?.warnings?.length ? (
          <div className="cc-monitoring-warning-list">
            {status.warnings.map((warning) => (
              <article key={warning.key} className={`cc-monitoring-alert is-${warning.severity}`}>
                <div><strong>{warning.title}</strong><p>{warning.message}</p></div>
                {warning.target !== "system" ? (
                  <button type="button" onClick={() => onNavigate?.(warning.target)}>{warning.target === "store" ? "Im Store prüfen" : "Unter Server prüfen"}</button>
                ) : <span>System prüfen</span>}
              </article>
            ))}
          </div>
        ) : (
          <div className="cc-monitoring-empty"><span>✓</span><div><strong>Keine aktuellen Störungen</strong><p>Bonni Core meldet momentan keine Warnung.</p></div></div>
        )}
      </section>
    </section>
  );
}
