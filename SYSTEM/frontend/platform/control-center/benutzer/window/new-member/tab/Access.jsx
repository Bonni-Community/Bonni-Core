import { cleanNewMemberLoginName } from "../newMemberWindowUtils.js";
import { NewMemberEditableField } from "../components/NewMemberFormParts.jsx";

export default function AccessTab({ draft, onDraftChange, onGeneratePassword, onPrepareMail }) {
  const loginName = cleanNewMemberLoginName(draft.loginName);

  const updateDraft = (patch) => {
    onDraftChange((currentDraft) => ({
      ...currentDraft,
      ...patch,
    }));
  };

  return (
    <div className="cc-member-window-stack">
      <section className="cc-member-window-card">
        <h3>Zugänge</h3>
        <div className="cc-member-window-list">
          <article className="cc-member-window-list-row">
            <div>
              <strong>{loginName || "Neuer lokaler Zugang"}</strong>
              <span>Lokaler Zugang</span>
            </div>
            <div>
              <small>Oberfläche</small>
              <b>{draft.surface || "—"}</b>
            </div>
            <div>
              <small>Verwendung</small>
              <b>{draft.usage || "—"}</b>
            </div>
            <div>
              <small>Status</small>
              <b>Aktiv</b>
            </div>
          </article>
        </div>
      </section>

      <section className="cc-member-window-card cc-member-window-access-card">
        <h3>Zugangsdaten</h3>
        <div className="cc-member-window-grid cc-member-window-grid--single">
          <NewMemberEditableField
            label="E-Mail-Adresse"
            value={draft.email}
            type="email"
            onChange={(email) => updateDraft({ email })}
            placeholder="name@example.de"
          />
          <NewMemberEditableField
            label="Startpasswort"
            value={draft.password}
            type="password"
            onChange={(password) => updateDraft({ password })}
            placeholder="Passwort eingeben oder generieren"
          />
          <NewMemberEditableField
            label="Passwort wiederholen"
            value={draft.passwordRepeat}
            type="password"
            onChange={(passwordRepeat) => updateDraft({ passwordRepeat })}
            placeholder="Passwort erneut eingeben"
          />
        </div>

        <div className="cc-member-window-access-actions">
          <button type="button" className="cc-member-window__secondary" onClick={onGeneratePassword}>
            Passwort generieren
          </button>
          <button type="button" className="cc-member-window__secondary" onClick={onPrepareMail}>
            Zugangsdaten per E-Mail vorbereiten
          </button>
        </div>

        <p className="cc-member-window-note">
          Beim Speichern wird der Benutzer mit diesen Zugangsdaten erstellt. Die E-Mail öffnet dein lokales Mailprogramm zum Prüfen und Absenden.
        </p>
      </section>
    </div>
  );
}
