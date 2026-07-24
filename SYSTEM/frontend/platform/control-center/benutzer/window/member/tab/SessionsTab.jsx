import { getSessionCount, getTerminalSessionCount } from "../memberWindowUtils.js";

export default function SessionsTab({ member }) {
  return (
    <section className="cc-member-window-card">
      <h3>Sessions</h3>
      <div className="cc-member-window-grid">
        <div className="cc-member-window-field">
          <span>Aktive Sessions</span>
          <strong>{getSessionCount(member)}</strong>
        </div>
        <div className="cc-member-window-field">
          <span>Terminal Sessions</span>
          <strong>{getTerminalSessionCount(member)}</strong>
        </div>
      </div>
      <p className="cc-member-window-note">Die Detailansicht kann später echte Session-Geräte, Terminal-Zuordnungen und Abmelden-Aktionen anzeigen.</p>
    </section>
  );
}
