import { useState } from "react";

import { ConfigStatusCard, DatabaseConfigCard, StatusPill } from "../components/ServerTabComponents.jsx";

function connectionHost(value) {
  const host = String(value || "localhost").trim() || "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildPostgresqlUrl(config, { revealPassword = false, template = false } = {}) {
  const user = encodeURIComponent(String(config.user || "postgres").trim() || "postgres");
  const enteredPassword = String(config.password || "");
  const password = template && !enteredPassword
    ? "<PASSWORT>"
    : revealPassword && enteredPassword
      ? encodeURIComponent(enteredPassword)
      : "••••••••";
  const host = connectionHost(config.host);
  const port = String(config.port || "5432").trim() || "5432";
  const database = encodeURIComponent(String(config.database || "postgres").trim() || "postgres");
  const query = new URLSearchParams({
    schema: String(config.schema || "public").trim() || "public",
    sslmode: config.sslMode || "prefer",
  });

  return `postgresql://${user}:${password}@${host}:${port}/${database}?${query.toString()}`;
}

export default function DatabaseConfigTab({
  activeDatabase,
  databaseCardStates,
  databaseConfigTarget,
  databaseDiagnostics,
  databaseTargets,
  pingDatabase,
  reloadDatabaseSettings,
  saveDatabaseSettings,
  saving,
  selectedDatabaseForm,
  setDatabaseConfigTarget,
  setDatabaseField,
  setMessage,
}) {
  const [showPassword, setShowPassword] = useState(false);
  const previewUrl = buildPostgresqlUrl(selectedDatabaseForm, { revealPassword: showPassword });
  const copyUrl = buildPostgresqlUrl(selectedDatabaseForm, {
    revealPassword: true,
    template: true,
  });

  async function copyConnectionUrl() {
    try {
      await navigator.clipboard.writeText(copyUrl);
      setMessage(selectedDatabaseForm.password
        ? "Vollständige PostgreSQL-Verbindungs-URL wurde kopiert."
        : "PostgreSQL-Verbindungs-URL mit <PASSWORT>-Platzhalter wurde kopiert.");
    } catch {
      setMessage("Die Verbindungs-URL konnte nicht automatisch kopiert werden. Bitte im Feld markieren.");
    }
  }

  return (
    <div className="security-tab-panel" role="tabpanel">
      <div className="security-config-overview-grid" aria-label="Datenbank zur Konfiguration auswählen">
        <DatabaseConfigCard
          title="Normale Datenbank"
          target={databaseTargets.normal}
          stateLabel={databaseCardStates.normal.label}
          stateVariant={databaseCardStates.normal.variant}
          selected={databaseConfigTarget === "normal"}
          onSelect={() => setDatabaseConfigTarget("normal")}
        />
        <DatabaseConfigCard
          title="Redundante Datenbank"
          target={databaseTargets.redundant}
          stateLabel={databaseCardStates.redundant.label}
          stateVariant={databaseCardStates.redundant.variant}
          selected={databaseConfigTarget === "redundant"}
          onSelect={() => setDatabaseConfigTarget("redundant")}
        />
        <ConfigStatusCard diagnostics={databaseDiagnostics} title="Datenbank Status" />
      </div>

      <div className="security-config-editor">
        <div className="security-config-editor__header">
          <div>
            <span className="security-card__eyebrow">Datenbank konfigurieren</span>
            <h3>{databaseConfigTarget === "normal" ? "Normale Datenbank" : "Redundante Datenbank"}</h3>
          </div>
          <StatusPill variant={activeDatabase === databaseConfigTarget ? "ok" : "neutral"}>
            {activeDatabase === databaseConfigTarget ? "Aktiv" : "Offline"}
          </StatusPill>
        </div>

        <div className="security-redundancy-form security-database-form">
          <label>
            <span>Host</span>
            <input
              value={selectedDatabaseForm.host}
              onChange={(event) => setDatabaseField(databaseConfigTarget, "host", event.target.value)}
            />
          </label>
          <label>
            <span>Port</span>
            <input
              type="number"
              min="1"
              max="65535"
              value={selectedDatabaseForm.port}
              onChange={(event) => setDatabaseField(databaseConfigTarget, "port", event.target.value)}
            />
          </label>
          <label>
            <span>Datenbankname</span>
            <input
              value={selectedDatabaseForm.database}
              onChange={(event) => setDatabaseField(databaseConfigTarget, "database", event.target.value)}
            />
          </label>
          <label>
            <span>Benutzer</span>
            <input
              value={selectedDatabaseForm.user}
              onChange={(event) => setDatabaseField(databaseConfigTarget, "user", event.target.value)}
            />
          </label>
          <label>
            <span>Passwort</span>
            <span className="security-password-control">
              <input
                type={showPassword ? "text" : "password"}
                placeholder={selectedDatabaseForm.passwordConfigured ? "Gespeichert – leer lassen zum Beibehalten" : "Passwort eingeben"}
                value={selectedDatabaseForm.password}
                onChange={(event) => setDatabaseField(databaseConfigTarget, "password", event.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                disabled={!selectedDatabaseForm.password}
              >
                {showPassword ? "Verbergen" : "Anzeigen"}
              </button>
            </span>
            <small>{selectedDatabaseForm.passwordConfigured && !selectedDatabaseForm.password
              ? "Ein Passwort ist gespeichert und wird beim Prüfen automatisch verwendet."
              : "Das Passwort wird sicher URL-kodiert."}</small>
          </label>
          <label>
            <span>Schema</span>
            <input
              value={selectedDatabaseForm.schema}
              onChange={(event) => setDatabaseField(databaseConfigTarget, "schema", event.target.value)}
            />
          </label>
          <label>
            <span>Verbindungsmodus</span>
            <select
              value={selectedDatabaseForm.sslMode}
              onChange={(event) => setDatabaseField(databaseConfigTarget, "sslMode", event.target.value)}
            >
              <option value="disable">SSL aus</option>
              <option value="prefer">Bevorzugen</option>
              <option value="require">SSL erforderlich</option>
            </select>
          </label>
          <label className="security-switch-row security-switch-row--inline">
            <span className="security-switch-row__text">
              <strong>Beim Boot automatisch verbinden</strong>
              <small>Verbindung beim Systemstart vorbereiten.</small>
            </span>
            <span className="security-switch">
              <input
                type="checkbox"
                checked={Boolean(selectedDatabaseForm.autoConnect)}
                onChange={(event) => setDatabaseField(databaseConfigTarget, "autoConnect", event.target.checked)}
              />
              <span className="security-switch__slider" />
            </span>
          </label>
        </div>

        <section className="security-connection-url" aria-label="PostgreSQL Verbindungs-URL">
          <div className="security-connection-url__header">
            <div>
              <span>PostgreSQL-Verbindungs-URL</span>
              <small>Wird automatisch aus den Feldern oben zusammengesetzt.</small>
            </div>
            <button type="button" className="security-action-button" onClick={copyConnectionUrl}>
              {selectedDatabaseForm.password ? "URL kopieren" : "Vorlage kopieren"}
            </button>
          </div>
          <code>{previewUrl}</code>
          <small>Format: postgresql://BENUTZER:PASSWORT@SERVER:PORT/DATENBANK?schema=SCHEMA&amp;sslmode=MODUS</small>
        </section>

        <div className="security-redundancy-actions security-redundancy-actions--visible">
          <span className="security-redundancy-actions__spacer" />
          <button type="button" className="security-action-button" onClick={() => pingDatabase(databaseConfigTarget)} disabled={saving}>Verbindung prüfen</button>
          <button type="button" className="security-action-button" onClick={reloadDatabaseSettings} disabled={saving}>Neu laden</button>
          <button type="button" className="security-action-button security-action-button--primary" onClick={saveDatabaseSettings} disabled={saving}>
            {saving ? "Speichert …" : "Konfiguration speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}
