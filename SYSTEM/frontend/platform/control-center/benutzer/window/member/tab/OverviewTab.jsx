import {
  ADD_ON_SURFACE,
  APP_SURFACE,
  CONTROL_CENTER_SURFACE,
  PLUG_IN_SURFACE,
  TECHNICAL_USAGE,
  getNewMemberModulesForSurface,
} from "../../new-member/newMemberWindowUtils.js";
import {
  NewMemberChoiceButton,
  NewMemberEditableField,
  NewMemberModuleRows,
} from "../../new-member/components/NewMemberFormParts.jsx";
import { getLoginName } from "../memberWindowUtils.js";
import { getAccountSurfaces } from "../memberAccountPolicy.js";

function moduleSelectionLabel(surface) {
  if (surface === APP_SURFACE) return "Installierte App auswählen";
  if (surface === ADD_ON_SURFACE) return "Installiertes Add-on auswählen";
  if (surface === PLUG_IN_SURFACE) return "Installiertes Plug-in auswählen";
  if (surface === CONTROL_CENTER_SURFACE) return "Control Center auswählen";
  return "App / Add-on / Plug-in auswählen";
}

export default function OverviewTab({
  title = "Übersicht",
  showIdentityFields = true,
  member,
  draft,
  moduleCatalog,
  moduleCatalogError,
  moduleCatalogLoading,
  onDisplayNameChange,
  onLoginNameChange,
  onModuleToggle,
  onSurfaceSelect,
  bootstrapAdmin = false,
}) {
  const modules = getNewMemberModulesForSurface(moduleCatalog, draft.surface);

  return (
    <div className="cc-member-window-stack">
      <section className="cc-member-window-card">
        <h3>{title}</h3>
        {showIdentityFields ? (
          <div className="cc-member-window-grid cc-member-window-grid--single">
            <NewMemberEditableField
              label="Benutzer"
              value={getLoginName(member)}
              onChange={onLoginNameChange}
              placeholder="Benutzernamen eingeben"
              readOnly={bootstrapAdmin}
            />
            <NewMemberEditableField
              label="Anzeigename"
              value={member?.displayName || member?.name || ""}
              onChange={onDisplayNameChange}
              placeholder="optional, sonst wie Benutzer"
            />
          </div>
        ) : null}
        {bootstrapAdmin ? (
          <p className="cc-member-window-note">
            Der feste Systembenutzer admin bleibt aktiv und behält den Systemzugriff. Der Anzeigename und das Passwort dürfen geändert werden.
          </p>
        ) : null}

        <div className="cc-member-window-field cc-member-window-field--usage-select">
          <span>Verwendung</span>
          <strong>{draft.usage}</strong>
          <small className="cc-member-window-field-hint">
            Die Kontoart ist seit der Anlage festgelegt. Passende Funktionen und Zugänge kannst du weiterhin bearbeiten.
          </small>
        </div>

        <div className="cc-member-window-field cc-member-window-field--surface-select">
          <span>Oberfläche</span>
          <div className="cc-member-window-surface-grid" role="group" aria-label="Oberfläche auswählen">
            {getAccountSurfaces(draft.usage).map((surface) => (
              <NewMemberChoiceButton
                key={surface}
                label={surface}
                name="member-surface"
                selected={draft.surface === surface}
                onSelect={onSurfaceSelect}
                disabled={bootstrapAdmin}
              />
            ))}
          </div>
        </div>

        <div className="cc-member-window-field cc-member-window-field--modules">
          <span>{moduleSelectionLabel(draft.surface)}</span>
          <NewMemberModuleRows
            singleSelection={draft.usage === TECHNICAL_USAGE && draft.surface === APP_SURFACE}
            modules={modules}
            selectedModuleKeys={draft.selectedModuleKeys}
            onModuleToggle={onModuleToggle}
            loading={moduleCatalogLoading}
            error={moduleCatalogError}
          />
          {draft.surface ? (
            <small className="cc-member-window-field-hint">
              Angezeigt werden die installierten Module aus ihren Manifesten. Funktionen und technische
              Oberflächen werden im Reiter „Funktionen“ zugeordnet.
            </small>
          ) : null}
        </div>
      </section>
    </div>
  );
}
