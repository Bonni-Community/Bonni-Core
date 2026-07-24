import {
  canOpenControlCenter,
  getAssignedTargets,
  normalizeLaunchTarget,
} from "./accessPolicy.js";
import "./AppLauncher.css";

const FIXED_TILES = [
  {
    key: "app.kontorapp",
    label: "KontorApp",
    eyebrow: "Verein",
    icon: "🏛️",
    description: "Mitglieder und Vereinsverwaltung",
    position: "top",
  },
  {
    key: "app.hocketapp",
    label: "HocketApp",
    eyebrow: "Veranstaltungen",
    icon: "🎟️",
    description: "Events und Veranstaltungen",
    position: "left",
  },
  {
    key: "app.stueberlapp",
    label: "StüberlApp",
    eyebrow: "Betrieb",
    icon: "🍺",
    description: "Bar, Küche, Lager und Verkauf",
    position: "right",
  },
  {
    key: "control-center",
    label: "Control Center",
    eyebrow: "Verwaltung",
    icon: "⚙️",
    description: "Benutzer, Rechte und Einstellungen",
    position: "bottom",
  },
];

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function navigationEntries(shell) {
  return [
    ...asList(shell?.permissions?.navigation),
    ...asList(shell?.navigation),
  ];
}

function targetLabel(target, shell, fallback) {
  const entry = navigationEntries(shell).find((item) => (
    normalizeLaunchTarget(item?.appRoute || item?.route || item?.key) === target
  ));

  return entry?.label || entry?.name || fallback || target.replace(/^app\./, "");
}

function displayName(user, shell) {
  return user?.displayName
    || user?.name
    || shell?.identity?.displayName
    || user?.loginName
    || shell?.identity?.loginName
    || "";
}

function initials(value) {
  const parts = String(value || "Bonni Core").trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0] || "BC").slice(0, 2).toUpperCase();
}

export default function AppLauncher({ user, shell, onOpenTarget, onOpenControlCenter, onLogout }) {
  const assignedApps = getAssignedTargets(user, shell).filter((target) => target.startsWith("app."));
  const controlCenterAllowed = canOpenControlCenter(user, shell);
  const allowedTargets = new Set([
    ...assignedApps,
    ...(controlCenterAllowed ? ["control-center"] : []),
  ]);
  const fixedKeys = new Set(FIXED_TILES.map((tile) => tile.key));
  const additionalApps = assignedApps.filter((target) => !fixedKeys.has(target));
  const name = displayName(user, shell);

  return (
    <main className="bonni-launcher" aria-label="Bonni Core Hauptmenü">
      <header className="bonni-launcher__header">
        <div>
          <p className="bonni-launcher__brand">Bonni Core</p>
          <h1>Meine Apps</h1>
          {name ? <p className="bonni-launcher__welcome">Angemeldet als {name}</p> : null}
        </div>
        <button className="bonni-launcher__logout" type="button" onClick={onLogout}>
          Abmelden
        </button>
      </header>

      <section className="bonni-launcher__stage" aria-label="Freigeschaltete Bereiche">
        <div className="bonni-launcher__wheel" role="list" aria-label="App-Auswahl">
          {FIXED_TILES.filter((tile) => allowedTargets.has(tile.key)).map((tile) => {
            const label = targetLabel(tile.key, shell, tile.label);
            const open = tile.key === "control-center" ? onOpenControlCenter : onOpenTarget;

            return (
              <button
                key={tile.key}
                className={`bonni-launcher__segment bonni-launcher__segment--${tile.position}`}
                type="button"
                onClick={() => open(tile.key)}
                role="listitem"
                aria-label={`${label} öffnen`}
              >
                <span className="bonni-launcher__segment-content">
                  <span className="bonni-launcher__eyebrow">{tile.eyebrow}</span>
                  <span className="bonni-launcher__title">
                    <span className="bonni-launcher__icon" aria-hidden="true">{tile.icon}</span>
                    <strong>{label}</strong>
                  </span>
                  <span className="bonni-launcher__description">{tile.description}</span>
                </span>
              </button>
            );
          })}

          <span className="bonni-launcher__divider bonni-launcher__divider--vertical" aria-hidden="true" />
          <span className="bonni-launcher__divider bonni-launcher__divider--horizontal" aria-hidden="true" />
          <div className="bonni-launcher__center" aria-label="Bonni Core">
            <strong>{initials(name)}</strong>
            <span>Bonni</span>
          </div>
        </div>

        {!allowedTargets.size ? (
          <p className="bonni-launcher__empty">
            Für diesen Benutzer ist noch keine installierte App freigeschaltet.
          </p>
        ) : null}

        {additionalApps.length ? (
          <div className="bonni-launcher__additional" aria-label="Weitere Apps">
            <h2>Weitere Apps</h2>
            <div>
              {additionalApps.map((target) => (
                <button key={target} type="button" onClick={() => onOpenTarget(target)}>
                  {targetLabel(target, shell)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
