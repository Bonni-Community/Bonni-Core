import {
  ADD_ON_SURFACE,
  APP_SURFACE,
  CONTROL_CENTER_SURFACE,
  LOCAL_USAGE,
  PLUG_IN_SURFACE,
  TECHNICAL_USAGE,
  getNewMemberModulesForSurface,
  isTechnicalOnlySurface,
} from "../../new-member/newMemberWindowUtils.js";
import {
  NewMemberChoiceButton,
  NewMemberEditableField,
  NewMemberModuleRows,
} from "../../new-member/components/NewMemberFormParts.jsx";
import { getLoginName } from "../memberWindowUtils.js";

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
  onUsageSelect,
  bootstrapAdmin = false,
}) {
  const modules = getNewMemberModulesForSurface(moduleCatalog, draft.surface);
  const technicalOnly = isTechnicalOnlySurface(draft.surface);

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
          <div className="cc-member-window-usage-grid" role="group" aria-label="Verwendung auswählen">
            {[LOCAL_USAGE, TECHNICAL_USAGE].map((usage) => (
              <NewMemberChoiceButton
                key={usage}
                label={usage}
                name="member-usage"
                selected={draft.usage === usage}
                onSelect={onUsageSelect}
                disabled={bootstrapAdmin || (technicalOnly && usage === LOCAL_USAGE)}
              />
            ))}
          </div>
          {technicalOnly ? (
            <small className="cc-member-window-field-hint">
              Add-ons und Plug-ins verwenden einen technischen Schnittstellen-Account.
            </small>
          ) : null}
        </div>

        <div className="cc-member-window-field cc-member-window-field--surface-select">
          <span>Oberfläche</span>
          <div className="cc-member-window-surface-grid" role="group" aria-label="Oberfläche auswählen">
            {[CONTROL_CENTER_SURFACE, APP_SURFACE, ADD_ON_SURFACE, PLUG_IN_SURFACE].map((surface) => (
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
