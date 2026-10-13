import {
  CONTROL_CENTER_MAIN_AREAS,
  CONTROL_CENTER_SECONDARY_AREAS,
} from "./controlCenterNavigation.js";
import { formatBonniCoreVersion } from "../update/localUpdatePresentation.js";

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function formatBytes(bytes) {
  const value = toNumber(bytes, 0);
  if (value <= 0) return "n/v";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(toNumber(seconds, 0)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getLoadState(percent) {
  const value = toNumber(percent, 0);
  if (value >= 90) return "critical";
  if (value >= 75) return "warning";
  return "ok";
}

function statusLabel(state) {
  if (state === "critical") return "Kritisch";
  if (state === "warning") return "Hoch";
  return "OK";
}

function findModule(modules, key) {
  return (modules || []).find((module) => module.key === key);
}

function AreaTile({ tile, onClick }) {
  return (
    <button type="button" className="cc-area-tile" onClick={onClick}>
      <span className="cc-area-tile__icon" aria-hidden="true">{tile.icon}</span>
      <span className="cc-area-tile__body">
        <span className="cc-area-tile__title">{tile.label}</span>
        <span className="cc-area-tile__description">{tile.description}</span>
      </span>
      <span className="cc-area-tile__arrow" aria-hidden="true">›</span>
    </button>
  );
}

function AreaGroup({ title, areas, onTileClick, variant = "primary" }) {
  return (
    <section className={`cc-area-group cc-area-group--${variant}`} aria-label={title}>
      <div className="cc-section-heading">{title}</div>
      <div className="cc-area-grid">
        {areas.map((tile) => (
          <AreaTile key={tile.key} tile={tile} onClick={() => onTileClick(tile)} />
        ))}
      </div>
    </section>
  );
}

function MetricCard({ title, value, detail, percent, state = "ok", status, footer }) {
  return (
    <article className={`cc-status-card cc-status-card--${state}`}>
      <div className="cc-status-card__header">
        <span>{title}</span>
        <span className={`cc-status-pill cc-status-pill--${state}`}>{status || statusLabel(state)}</span>
      </div>
      <strong>{value}</strong>
      <span>{detail}</span>
      {typeof percent === "number" ? (
        <div className="cc-meter" aria-label={`${title}: ${Math.round(percent)} Prozent`}>
          <div className="cc-meter__fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
        </div>
      ) : null}
      {footer ? <small>{footer}</small> : null}
    </article>
  );
}

function buildStatusCards(overview) {
  const members = overview?.members || {};
  const database = overview?.database || {};
  const cpu = overview?.system?.cpu || {};
  const memory = overview?.system?.memory || {};
  const storage = overview?.system?.storage || {};
  const backend = overview?.backend || {};

  const cpuPercent = toNumber(cpu.percent, 0);
  const ramPercent = toNumber(memory.percent, 0);
  const storagePercent = toNumber(storage.percent, 0);
  const memberSource = members.source && members.source !== "none" ? `Quelle: ${members.source}` : "Live aus der Datenbank";

  return [
    {
      key: "members",
      title: "Member",
      value: `${toNumber(members.created, 0)} erstellt`,
      detail: `${toNumber(members.active, 0)} aktiv · ${toNumber(members.inactive, 0)} inaktiv`,
      state: members.available === false ? "warning" : "ok",
      status: members.available === false ? "Prüfen" : "Live",
      footer: memberSource,
    },
    {
      key: "database",
      title: "Datenbank",
      value: database.online ? "Online" : "Offline",
      detail: database.label || "Version nicht verfügbar",
      state: database.online ? "ok" : "critical",
      status: database.online ? "OK" : "Fehler",
      footer: database.message,
    },
    {
      key: "cpu",
      title: "CPU",
      value: `${Math.round(cpuPercent)}%`,
      detail: cpu.model || `${toNumber(cpu.cores, 0)} Kerne`,
      percent: cpuPercent,
      state: getLoadState(cpuPercent),
      footer: cpu.cores ? `${cpu.cores} Kerne · ${cpu.source === "proc-stat" ? "Live-Messung" : "Load-Average"}` : "Wird vom Backend gemessen",
    },
    {
      key: "ram",
      title: "RAM",
      value: `${Math.round(ramPercent)}%`,
      detail: `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
      percent: ramPercent,
      state: getLoadState(ramPercent),
      footer: `${formatBytes(memory.freeBytes)} frei`,
    },
    {
      key: "storage",
      title: "Storage",
      value: `${Math.round(storagePercent)}%`,
      detail: `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)}`,
      percent: storagePercent,
      state: getLoadState(storagePercent),
      footer: storage.available === false ? storage.message : storage.path,
    },
    {
      key: "backend",
      title: "Backend",
      value: backend.online === false ? "Offline" : "Online",
      detail: `Uptime: ${formatUptime(backend.uptimeSeconds)}`,
      state: backend.online === false ? "critical" : "ok",
      status: backend.online === false ? "Fehler" : "OK",
      footer: backend.version ? `Version ${formatBonniCoreVersion(backend.version)}` : backend.node,
    },
  ];
}

const FALLBACK_SHELL_LINES = [
  "control-center ~ # status --summary",
  "Backend: wartet auf Live-Daten",
  "Datenbank: wartet auf Version",
  "Member: wartet auf Statistik",
  "CPU/RAM: wartet auf Backend-Messung",
  "control-center ~ #",
];

export default function ControlCenterStyle({ modules, overview, onOpenModule, onOpenDiagnostics }) {
  function handleTileClick(tile) {
    const target = tile.targetModule ? findModule(modules, tile.targetModule) : null;

    if (target) {
      onOpenModule(target);
      return;
    }

  }

  const statusCards = buildStatusCards(overview);
  const shellLines = Array.isArray(overview?.shell) && overview.shell.length > 0
    ? overview.shell
    : FALLBACK_SHELL_LINES;

  return (
    <div className="cc-dashboard" aria-label="Control Center Übersicht">
      <AreaGroup title="Hauptbereiche" areas={CONTROL_CENTER_MAIN_AREAS} onTileClick={handleTileClick} />
      <AreaGroup title="Weitere Bereiche" areas={CONTROL_CENTER_SECONDARY_AREAS} onTileClick={handleTileClick} variant="secondary" />

      <section className="cc-lower-grid" aria-label="Systemstatus und Shell">
        <div className="cc-status-cluster" aria-label="Status">
          {statusCards.map(({ key, ...cardProps }) => (
            <MetricCard key={key} {...cardProps} />
          ))}
        </div>

        <section className="cc-shell-card" aria-label="Diagnose und Shell">
          <div className="cc-shell-card__header">
            <div>
              <span className="cc-shell-card__eyebrow">Diagnose</span>
              <h2>Shell</h2>
            </div>
            <div className="cc-shell-card__actions">
              <button type="button" onClick={() => onOpenDiagnostics?.("terminal")}>Shell</button>
              <button type="button" onClick={() => onOpenDiagnostics?.("log")}>Export</button>
            </div>
          </div>
          <div className="cc-shell-output">
            {shellLines.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
