import { useEffect, useState } from "react";
import { fetchSystemResources } from "../../../system/api/systemMonitoringApi.js";
import SystemResourceHistory from "./SystemResourceHistory.jsx";
import "./SystemResourcesPanel.css";

const numbers = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const byteUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const bitRateUnits = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s", "Tbit/s"];

function formatQuantity(value, step, units) {
  if (!Number.isFinite(value) || value < 0) return "—";
  let unit = 0;
  while (value >= step && unit < units.length - 1) {
    value /= step;
    unit++;
  }
  return `${numbers.format(value)} ${units[unit]}`;
}

function formatBytes(bytes) {
  return formatQuantity(bytes, 1024, byteUnits);
}

function formatNetworkRate(bytesPerSecond) {
  return Number.isFinite(bytesPerSecond) ? formatQuantity(bytesPerSecond * 8, 1000, bitRateUnits) : "—";
}

function UsageBar({ label, percent, warningAt = 85, criticalAt = 95 }) {
  if (!Number.isFinite(percent)) return null;
  const value = Math.max(0, Math.min(100, percent));
  const state = value >= criticalAt ? "critical" : value >= warningAt ? "warning" : "normal";
  return (
    <div
      className="bonni-resource-bar"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      data-state={state}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function CapacityCard({ title, capacity, drive = false }) {
  return (
    <article className="bonni-resource-card">
      <header>
        <h3>{title}</h3>
        {capacity.totalBytes > 0 && <strong>{numbers.format(capacity.percent)} %</strong>}
      </header>
      {capacity.totalBytes > 0 ? (
        <>
          <UsageBar
            label={drive ? `Belegung ${title}` : "Arbeitsspeicher-Auslastung"}
            percent={capacity.percent}
            warningAt={drive ? 80 : 85}
            criticalAt={drive ? 92 : 95}
          />
          <dl className="bonni-resource-capacity">
            <div><dt>Gesamt</dt><dd>{formatBytes(capacity.totalBytes)}</dd></div>
            <div><dt>Belegt</dt><dd>{formatBytes(capacity.usedBytes)}</dd></div>
            <div><dt>{drive ? "Frei" : "Verfügbar"}</dt><dd>{formatBytes(capacity.freeBytes)}</dd></div>
          </dl>
        </>
      ) : <p>Messwert derzeit nicht verfügbar.</p>}
    </article>
  );
}

function NetworkTraffic({ interfaces }) {
  const available = Array.isArray(interfaces) && interfaces.length > 0;
  const measuring = available && interfaces.every(adapter => (
    !Number.isFinite(adapter.downloadBytesPerSecond) && !Number.isFinite(adapter.uploadBytesPerSecond)
  ));
  return (
    <section className="bonni-resource-card bonni-monitor-network" aria-labelledby="bonni-monitor-network">
      <h2 id="bonni-monitor-network">Netzwerk</h2>
      {available ? interfaces.map(adapter => (
        <div className="bonni-monitor-network__adapter" key={adapter.id}>
          <h3>{adapter.name}</h3>
          <dl className="bonni-resource-capacity">
            <div><dt><span aria-hidden="true">↓ </span>Download</dt><dd>{formatNetworkRate(adapter.downloadBytesPerSecond)}</dd></div>
            <div><dt><span aria-hidden="true">↑ </span>Upload</dt><dd>{formatNetworkRate(adapter.uploadBytesPerSecond)}</dd></div>
          </dl>
        </div>
      )) : <p>Netzwerk-Messwerte derzeit nicht verfügbar.</p>}
      {measuring && <p>Upload und Download werden gemessen …</p>}
    </section>
  );
}

export default function SystemResourcesPanel({ token, onAccessDenied }) {
  const [snapshot, setSnapshot] = useState(null);
  const [connected, setConnected] = useState(null);

  useEffect(() => {
    let pending;
    let disposed = false;
    async function poll() {
      if (pending) return;
      pending = new AbortController();
      try {
        const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(6_000)]);
        const result = await fetchSystemResources(token, { signal });
        if (disposed) return;
        if (!result?.cpu || !result.memory || !Array.isArray(result.disks)) {
          setConnected(false);
          return;
        }
        setSnapshot(result);
        setConnected(true);
      } catch (error) {
        if (disposed) return;
        if (error?.status === 401 || error?.status === 403) onAccessDenied();
        else setConnected(false);
      } finally {
        pending = undefined;
      }
    }
    poll();
    const timer = window.setInterval(poll, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [token, onAccessDenied]);

  const status = connected === null ? "Verbinde …" : connected ? "Live" : "Verbindung wird erneut geprüft";
  const lastMeasurement = Date.parse(snapshot?.checkedAt);
  return (
    <section className="bonni-system-monitor" aria-label="Aktuelle Systemdaten">
      <div className="bonni-system-monitor__status">
        <strong role="status" data-live={connected === true}>{status}</strong>
        {snapshot?.hostname && <span>{snapshot.hostname}</span>}
        {Number.isFinite(lastMeasurement) && (
          <time dateTime={snapshot.checkedAt}>Letzte Abfrage {time.format(lastMeasurement)}</time>
        )}
      </div>
      {snapshot && (
        <>
          <section className="bonni-monitor-section" aria-label="CPU und Arbeitsspeicher">
            <div className="bonni-resource-grid">
              <article className="bonni-resource-card">
                <header>
                  <h3>CPU</h3>
                  {Number.isFinite(snapshot.cpu.percent) && <strong>{numbers.format(snapshot.cpu.percent)} %</strong>}
                </header>
                <UsageBar label="CPU-Auslastung" percent={snapshot.cpu.percent} />
                <p>{snapshot.cpu.model}{snapshot.cpu.cores > 0 && ` · ${snapshot.cpu.cores} logische Kerne`}</p>
                {!Number.isFinite(snapshot.cpu.percent) && <p>CPU-Auslastung wird gemessen …</p>}
              </article>
              <CapacityCard title="Arbeitsspeicher" capacity={snapshot.memory} />
            </div>
          </section>
          <section className="bonni-monitor-section" aria-labelledby="bonni-monitor-drives">
            <h2 id="bonni-monitor-drives">Laufwerke</h2>
            <div className="bonni-resource-grid">
              {snapshot.disks.length ? snapshot.disks.map(disk => (
                <CapacityCard key={disk.mount} title={disk.mount} capacity={disk} drive />
              )) : <p>Bonni kann derzeit keinen Laufwerksspeicher messen.</p>}
            </div>
          </section>
          <div className="bonni-monitor-details">
            <SystemResourceHistory history={snapshot.history} checkedAt={snapshot.checkedAt} />
            <NetworkTraffic interfaces={snapshot.network} />
          </div>
        </>
      )}
    </section>
  );
}
