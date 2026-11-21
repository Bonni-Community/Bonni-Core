import { useState } from "react";

const outcomeLabels = {
  LOGIN_SUCCESS: "Anmeldung erfolgreich",
  INVALID_PASSWORD: "Falsches Passwort eingegeben",
  ACCOUNT_NOT_FOUND: "Konto wurde nicht gefunden",
  ACCOUNT_DISABLED: "Konto deaktiviert",
  PASSWORD_NOT_CONFIGURED: "Kein lokales Passwort hinterlegt",
  PASSWORD_RECOVERY_LOCKED: "Konto während der Passwortwiederherstellung gesperrt",
  SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN: "Interaktive Anmeldung für dieses Dienstkonto gesperrt",
};

function accountLabel(event) {
  return event.account || (event.outcome === "ACCOUNT_NOT_FOUND" ? "Unbekanntes Konto" : "Konto ohne Zuordnung");
}

export default function UserLoginDiagnostics({ snapshot, loading }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const term = query.trim().toLocaleLowerCase("de");
  const events = snapshot?.events || [];
  const visible = events.filter(event => (
    (filter === "all" || event.outcome !== "LOGIN_SUCCESS")
    && accountLabel(event).toLocaleLowerCase("de").includes(term)
  ));

  return (
    <section className="cc-core-diagnostics-surface cc-journal" aria-label="Anmeldeprotokoll">
      <div className="cc-journal-filters">
        <label>
          Benutzer suchen
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Anmeldename" />
        </label>
        <label>
          Anmeldungen
          <select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">Alle Anmeldungen</option>
            <option value="failed">Nur Fehlversuche</option>
          </select>
        </label>
      </div>
      {snapshot?.truncated && (
        <p className="cc-journal-note">Die Suche umfasst die neuesten {events.length} Einträge.</p>
      )}
      {loading && <p className="cc-core-diagnostics-empty" role="status">Anmeldungen werden geladen …</p>}
      {snapshot && !visible.length && <p className="cc-core-diagnostics-empty">Keine passenden Anmeldungen in den letzten 72 Stunden.</p>}
      {visible.length > 0 && (
        <ul className="cc-journal-list cc-login-events" role="list" aria-label="Anmeldeversuche">
          {visible.map(event => {
            const success = event.outcome === "LOGIN_SUCCESS";
            return (
              <li className={`cc-journal-item cc-login-event ${success ? "" : "is-failed"}`} key={event.id}>
                <time className="cc-journal-time" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString("de-DE")}</time>
                <div className="cc-journal-main">
                  <strong>{accountLabel(event)}</strong>
                  <span>{outcomeLabels[event.outcome] || "Anmeldung fehlgeschlagen"}</span>
                </div>
                <span className={`cc-journal-status ${success ? "is-succeeded" : "is-failed"}`}>
                  {success ? "Erfolgreich" : "Abgewiesen"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
