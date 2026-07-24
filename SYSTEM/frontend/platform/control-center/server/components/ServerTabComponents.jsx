function StatusPill({ children, variant = "neutral" }) {
  return <span className={`security-pill security-pill--${variant}`}>{children}</span>;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("de-DE");
}

function BackendActionButtons({
  disabled,
  bootDisabled,
  restartDisabled,
  shutdownDisabled,
  onBoot,
  onRestart,
  onShutdown,
}) {
  return (
    <div className="security-backend-card__actions" aria-label="Backend Aktionen">
      <button type="button" className="security-backend-action security-backend-action--boot" onClick={onBoot} disabled={disabled || bootDisabled || !onBoot}>Booten</button>
      <button type="button" className="security-backend-action security-backend-action--restart" onClick={onRestart} disabled={disabled || restartDisabled || !onRestart}>Neustart</button>
      <button type="button" className="security-backend-action security-backend-action--shutdown" onClick={onShutdown} disabled={disabled || shutdownDisabled || !onShutdown}>Herunterfahren</button>
    </div>
  );
}

function BackendTargetCard({
  title,
  eyebrow = "Backend",
  target,
  stateLabel,
  stateVariant = "idle",
  selected,
  disabled,
  onSelect,
  ariaLabel,
  actionsDisabled,
  bootDisabled,
  restartDisabled,
  shutdownDisabled,
  onBoot,
  onRestart,
  onShutdown,
}) {
  return (
    <article className={`security-backend-card ${selected ? "security-backend-card--selected" : ""}`}>
      <button
        type="button"
        className="security-backend-card__select"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={ariaLabel || `${title} Status anzeigen`}
      >
        <span className={`security-backend-card__badge security-backend-card__badge--${stateVariant}`}>{stateLabel}</span>
        <span className="security-backend-card__label">{eyebrow}</span>
        <strong>{title}</strong>
        <dl className="security-backend-card__details">
          <div>
            <dt>IP / Host</dt>
            <dd>{target.host}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd>{target.port}</dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>{target.origin || "—"}</dd>
          </div>
        </dl>
      </button>
      <BackendActionButtons
        disabled={actionsDisabled}
        bootDisabled={bootDisabled}
        restartDisabled={restartDisabled}
        shutdownDisabled={shutdownDisabled}
        onBoot={onBoot}
        onRestart={onRestart}
        onShutdown={onShutdown}
      />
    </article>
  );
}

function DatabaseTargetCard({
  title,
  eyebrow = "Datenbank",
  target,
  stateLabel,
  stateVariant = "idle",
  selected,
  disabled,
  onSelect,
  ariaLabel,
}) {
  return (
    <article className={`security-database-card ${selected ? "security-database-card--selected" : ""}`}>
      <button
        type="button"
        className="security-database-card__select"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={ariaLabel || `${title} als einziges Schreibziel verwenden`}
      >
        <span className={`security-backend-card__badge security-backend-card__badge--${stateVariant}`}>{stateLabel}</span>
        <span className="security-backend-card__label">{eyebrow}</span>
        <strong>{title}</strong>
        <dl className="security-backend-card__details">
          <div>
            <dt>Host</dt>
            <dd>{target.host}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd>{target.port}</dd>
          </div>
          <div>
            <dt>Name</dt>
            <dd>{target.database}</dd>
          </div>
        </dl>
      </button>
    </article>
  );
}

function BackendConfigCard({ title, eyebrow = "Backend", target, stateLabel, stateVariant = "idle", selected, onSelect }) {
  return (
    <button
      type="button"
      className={`security-config-backend-card ${selected ? "security-config-backend-card--selected" : ""}`}
      onClick={onSelect}
    >
      <span className={`security-backend-card__badge security-backend-card__badge--${stateVariant}`}>{stateLabel}</span>
      <span className="security-backend-card__label">{eyebrow}</span>
      <strong>{title}</strong>
      <dl className="security-backend-card__details">
        <div>
          <dt>IP / Host</dt>
          <dd>{target.host}</dd>
        </div>
        <div>
          <dt>Port</dt>
          <dd>{target.port}</dd>
        </div>
        <div>
          <dt>Origin</dt>
          <dd>{target.origin || "—"}</dd>
        </div>
      </dl>
    </button>
  );
}

function DatabaseConfigCard({ title, target, stateLabel, stateVariant = "idle", selected, onSelect }) {
  return (
    <button
      type="button"
      className={`security-config-backend-card ${selected ? "security-config-backend-card--selected" : ""}`}
      onClick={onSelect}
    >
      <span className={`security-backend-card__badge security-backend-card__badge--${stateVariant}`}>{stateLabel}</span>
      <span className="security-backend-card__label">Datenbank</span>
      <strong>{title}</strong>
      <dl className="security-backend-card__details">
        <div>
          <dt>Host</dt>
          <dd>{target.host}</dd>
        </div>
        <div>
          <dt>Port</dt>
          <dd>{target.port}</dd>
        </div>
        <div>
          <dt>Name</dt>
          <dd>{target.database}</dd>
        </div>
      </dl>
    </button>
  );
}

function ConfigStatusCard({ diagnostics, title = "Aktueller Zustand" }) {
  return (
    <aside className="security-config-status-card" aria-label="Status">
      <span className="security-card__eyebrow">Status</span>
      <h3>{title}</h3>
      <dl>
        {diagnostics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function SecurityField({ label, value, onChange, placeholder, type = "text", help, readOnly = false }) {
  return (
    <label className="security-system-field">
      <span>{label}</span>
      <input
        type={type}
        value={value || ""}
        placeholder={placeholder || ""}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
      />
      {help ? <small>{help}</small> : null}
    </label>
  );
}

function SecurityToggleRow({ title, description, checked, onChange }) {
  return (
    <label className="security-switch-row">
      <span className="security-switch-row__text">
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="security-switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="security-switch__slider" />
      </span>
    </label>
  );
}

export {
  BackendConfigCard,
  BackendTargetCard,
  ConfigStatusCard,
  DatabaseConfigCard,
  DatabaseTargetCard,
  SecurityField,
  SecurityToggleRow,
  StatusPill,
  formatDateTime,
};
