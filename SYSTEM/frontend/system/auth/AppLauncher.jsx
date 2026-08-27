import {
  canOpenControlCenter,
  getAssignedTargets,
  normalizeLaunchTarget,
} from "./accessPolicy.js";
import "./AppLauncher.css";

const APP_POSITIONS = ["top", "left", "right"];
const CONTROL_CENTER_TILE = {
  key: "control-center",
  label: "Control Center",
  eyebrow: "Plattform",
  icon: "⚙️",
  description: "Benutzer, Rechte und Einstellungen",
  position: "bottom",
};

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
  const entry = navigationEntry(target, shell);

  return entry?.label || entry?.name || fallback || target.replace(/^app\./, "");
}

function navigationEntry(target, shell) {
  return navigationEntries(shell).find((item) => (
    normalizeLaunchTarget(item?.appRoute || item?.route || item?.key) === target
  ));
}

function appTile(target, shell, position) {
  const entry = navigationEntry(target, shell) || {};
  return {
    key: target,
    label: targetLabel(target, shell),
    eyebrow: entry.eyebrow || entry.category || entry.kind || "App",
    icon: entry.icon || "◆",
    description: entry.description || "Installierte Anwendung",
    position,
  };
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

export default function AppLauncher({ user, shell, onOpenTarget, onOpenControlCenter, onOpenMySettings, onLogout }) {
  const assignedApps = getAssignedTargets(user, shell).filter((target) => target.startsWith("app."));
  const controlCenterAllowed = canOpenControlCenter(user, shell);
  const primaryApps = assignedApps.slice(0, APP_POSITIONS.length);
  const primaryTiles = primaryApps.map((target, index) => appTile(target, shell, APP_POSITIONS[index]));
  const tiles = [
    ...primaryTiles,
    ...(controlCenterAllowed ? [CONTROL_CENTER_TILE] : []),
  ];
  const additionalApps = assignedApps.slice(primaryApps.length);
  const hasTargets = assignedApps.length > 0 || controlCenterAllowed;
  const name = displayName(user, shell);

  return (
    <main className="bonni-launcher" aria-label="Bonni Core Hauptmenü">
      <header className="bonni-launcher__header">
        <div>
          <p className="bonni-launcher__brand">Bonni Core</p>
          <h1>Meine Apps</h1>
          {name ? <p className="bonni-launcher__welcome">Angemeldet als {name}</p> : null}
        </div>
        <div className="bonni-launcher__account-actions">
          <button className="bonni-launcher__settings" type="button" onClick={onOpenMySettings}>Meine Einstellungen</button>
          <button className="bonni-launcher__logout" type="button" onClick={onLogout}>Abmelden</button>
        </div>
      </header>

      <section className="bonni-launcher__stage" aria-label="Freigeschaltete Bereiche">
        <div className="bonni-launcher__wheel" role="list" aria-label="App-Auswahl">
          {tiles.map((tile) => {
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

        {!hasTargets ? (
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
