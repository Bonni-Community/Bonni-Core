import { formatDate } from "../memberWindowUtils.js";

export default function ProtocolTab({ member }) {
  return (
    <section className="cc-member-window-card">
      <h3>Protokoll</h3>
      <div className="cc-member-window-list">
        <article className="cc-member-window-list-row">
          <div>
            <strong>Letzte Anmeldung</strong>
            <span>{formatDate(member?.lastLoginAt)}</span>
          </div>
          <div>
            <small>Status</small>
            <b>{member?.status || "Unbekannt"}</b>
          </div>
        </article>
      </div>
      <p className="cc-member-window-note">Hier kann später das Änderungsprotokoll je Benutzer angebunden werden.</p>
    </section>
  );
}
