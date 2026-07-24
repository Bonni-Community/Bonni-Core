import { controlCenterLabels as labels } from "../language/index.js";

const TILE_DEFINITIONS = [
  {
    key: "dashboard",
    label: "Dashboard",
    description: "Systemübersicht & Statistiken",
    icon: "▦",
  },
  {
    key: "create-user",
    label: "Benutzer erstellen",
    description: "Neuen Benutzer anlegen",
    icon: "+",
    targetModule: "user",
  },
  {
    key: "user",
    label: "Benutzer",
    description: "Benutzer verwalten",
    icon: "👤",
    targetModule: "user",
  },
  {
    key: "roles",
    label: "Rollen & Rechte",
    description: "Zugriffsrechte verwalten",
    icon: "🛡",
    targetModule: "user",
  },
  {
    key: "server",
    label: "Server",
    description: "Backend, Redundanz und Datenbank",
    icon: "◆",
    targetModule: "server",
  },
  {
    key: "provider",
    label: "Provider",
    description: "Anbieter konfigurieren",
    icon: "☁",
    targetModule: "provider",
  },
  {
    key: "interfaces",
    label: "Schnittstellen",
    description: "Schnittstellen konfigurieren",
    icon: "⇄",
    targetModule: "interfaces",
  },
  {
    key: "webhooks",
    label: "API / Webhooks",
    description: "Integrationen & Webhooks",
    icon: "⌁",
    targetModule: "system",
  },
  {
    key: "store",
    label: labels.navigation.store,
    description: labels.navigationDescriptions.store,
    icon: "🧩",
    targetModule: "store",
  },
  {
    key: "apps",
    label: "Apps",
    description: "Anwendungen verwalten",
    icon: "◫",
    targetModule: "store",
  },
  {
    key: "system",
    label: "System",
    description: "Systemeinstellungen",
    icon: "⌘",
    targetModule: "system",
  },
  {
    key: "registry",
    label: "Registry",
    description: "Container Registry",
    icon: "◰",
    targetModule: "system",
  },
  {
    key: "backup",
    label: "Backup",
    description: "Backups verwalten",
    icon: "⟲",
    targetModule: "backup",
  },
  {
    key: "diagnostics",
    label: "Diagnose",
    description: "Systemdiagnose & Tests",
    icon: "∿",
    targetModule: "diagnostics",
  },
  {
    key: "logs",
    label: "Logs",
    description: "Protokolle anzeigen",
    icon: "☰",
    targetModule: "logs",
  },
  {
    key: "license",
    label: "Lizenz",
    description: "Lizenzinformationen",
    icon: "◎",
    targetModule: "license",
  },
  {
    key: "settings",
    label: "Einstellungen",
    description: "Globale Einstellungen",
    icon: "⚙",
    targetModule: "system",
  },
];

const STATUS_CARDS = [
  {
    key: "cpu",
    title: "CPU",
    lineA: "12%",
    lineB: "Intel Xeon E-2278G",
    meter: 12,
  },
  {
    key: "ram",
    title: "RAM",
    lineA: "34%",
    lineB: "10.8 GB / 31.9 GB",
    meter: 34,
  },
  {
    key: "storage",
    title: "Storage",
    lineA: "2.31 TB / 7.27 TB",
    lineB: "31% verwendet",
    meter: 31,
  },
  {
    key: "network",
    title: "Netzwerk",
    lineA: "↑ 1.2 Gbit/s",
    lineB: "↓ 280 Mbit/s",
    meter: 46,
  },
  {
    key: "backend",
    title: "Backend",
    lineA: "Online",
    lineB: "Uptime: 12d 4h 18m",
    status: "online",
  },
  {
    key: "database",
    title: "Datenbank",
    lineA: "Online",
    lineB: "PostgreSQL 15.4",
    status: "online",
  },
];

const SHELL_LINES = [
  "control-center ~ # uname -a",
  "Linux control-center 6.6.15-arch1-1 x86_64 GNU/Linux",
  "control-center ~ # uptime",
  "10:42:17 up 12 days, 4:18, 2 users, load average: 0.15, 0.12, 0.10",
  "control-center ~ # df -h",
  "/dev/nvme0n1p2   50G   18G   29G  39% /",
  "/dev/nvme0n1p3  200G   73G  116G  39% /data",
  "/dev/nvme0n1p4  7.0T  2.3T  4.4T  34% /storage",
  "control-center ~ # systemctl status control-center",
  "● control-center.service - Control Center Backend",
  "   Loaded: loaded (/etc/systemd/system/control-center.service; enabled)",
  "   Active: active (running)",
  "control-center ~ # diagnostics --export",
  "Diagnosepaket wird erstellt ...",
  "Logs gesammelt, API geprüft, Datenbankverbindung OK",
  "Export gespeichert: diagnostics_2025_05_23.zip",
  "control-center ~ #",
];

function findModule(modules, key) {
  return (modules || []).find((module) => module.key === key);
}

export default function ControlCenterTileGrid({ modules, onOpenModule, onOpenPlaceholder }) {
  function handleTileClick(tile) {
    const target = tile.targetModule ? findModule(modules, tile.targetModule) : null;

    if (target) {
      onOpenModule(target);
      return;
    }

    onOpenPlaceholder?.(tile);
  }

  return (
    <div className="cc-dashboard">
      <section className="cc-tile-section" aria-label="Control Center Bereiche">
        <div className="cc-section-heading">Verwaltung</div>
        <div className="cc-tile-grid">
          {TILE_DEFINITIONS.map((tile) => (
            <button
              key={tile.key}
              type="button"
              className="cc-mini-tile"
              onClick={() => handleTileClick(tile)}
            >
              <div className="cc-mini-tile__icon" aria-hidden="true">{tile.icon}</div>
              <div className="cc-mini-tile__body">
                <div className="cc-mini-tile__title">{tile.label}</div>
                <div className="cc-mini-tile__description">{tile.description}</div>
              </div>
              <div className="cc-mini-tile__arrow" aria-hidden="true">›</div>
            </button>
          ))}
        </div>
      </section>

      <section className="cc-lower-grid" aria-label="Systemstatus und Diagnose">
        <div className="cc-status-cluster">
          {STATUS_CARDS.map((card) => (
            <article key={card.key} className="cc-status-card">
              <div className="cc-status-card__header">
                <span>{card.title}</span>
                {card.status ? <span className={`cc-status-badge cc-status-badge--${card.status}`}>●</span> : null}
              </div>
              <strong>{card.lineA}</strong>
              <span>{card.lineB}</span>
              {typeof card.meter === "number" ? (
                <div className="cc-meter">
                  <div className="cc-meter__fill" style={{ width: `${card.meter}%` }} />
                </div>
              ) : null}
            </article>
          ))}
        </div>

        <section className="cc-shell-card" aria-label="Diagnose und Shell">
          <div className="cc-shell-card__header">
            <div>
              <span className="cc-shell-card__eyebrow">Diagnose</span>
              <h2>Diagnose / Shell</h2>
            </div>
            <div className="cc-shell-card__actions">
              <button type="button">Shell</button>
              <button type="button">Export</button>
            </div>
          </div>
          <div className="cc-shell-output">
            {SHELL_LINES.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
