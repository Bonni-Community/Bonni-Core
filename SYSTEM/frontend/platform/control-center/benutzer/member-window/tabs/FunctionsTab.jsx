import { getRoleLabels } from "../memberWindowUtils.js";

export default function FunctionsTab({ member }) {
  const roles = getRoleLabels(member);

  return (
    <section className="cc-member-window-card">
      <h3>Funktionen</h3>
      {roles.length ? (
        <div className="cc-member-window-pill-grid">
          {roles.map((role) => <span key={role}>{role}</span>)}
        </div>
      ) : (
        <div className="cc-member-window-empty">Keine Funktion hinterlegt.</div>
      )}
    </section>
  );
}
