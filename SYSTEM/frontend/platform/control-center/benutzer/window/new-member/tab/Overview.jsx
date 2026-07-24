import {
  ADD_ON_SURFACE,
  APP_SURFACE,
  CONTROL_CENTER_SURFACE,
  LOCAL_USAGE,
  PLUG_IN_SURFACE,
  TECHNICAL_USAGE,
  getNewMemberModulesForSurface,
  isTechnicalOnlySurface,
} from "../newMemberWindowUtils.js";
import {
  NewMemberChoiceButton,
  NewMemberEditableField,
  NewMemberModuleRows,
} from "../components/NewMemberFormParts.jsx";

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
  draft,
  moduleCatalog,
  moduleCatalogError,
  moduleCatalogLoading,
  handleModuleToggle,
  handleSurfaceSelect,
  handleUsageSelect,
  updateDraft,
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
              value={draft.loginName}
              onChange={(loginName) => updateDraft({ loginName })}
              placeholder="Loginnamen eingeben"
            />
            <NewMemberEditableField
              label="Anzeigename"
              value={draft.displayName}
              onChange={(displayName) => updateDraft({ displayName })}
              placeholder="optional, sonst wie Benutzer"
            />
          </div>
        ) : null}

        <div className="cc-member-window-field cc-member-window-field--usage-select">
          <span>Verwendung</span>
          <div className="cc-member-window-usage-grid" role="group" aria-label="Verwendung auswählen">
            {[LOCAL_USAGE, TECHNICAL_USAGE].map((usage) => (
              <NewMemberChoiceButton
                key={usage}
                label={usage}
                name="new-member-usage"
                selected={draft.usage === usage}
                onSelect={handleUsageSelect}
                disabled={technicalOnly && usage === LOCAL_USAGE}
              />
            ))}
          </div>
          {technicalOnly ? (
            <small className="cc-member-window-field-hint">
              Add-ons und Plug-ins werden als technische Schnittstellen-Benutzer angelegt.
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
                name="new-member-surface"
                selected={draft.surface === surface}
                onSelect={handleSurfaceSelect}
              />
            ))}
          </div>
        </div>

        <div className="cc-member-window-field cc-member-window-field--modules">
          <span>{moduleSelectionLabel(draft.surface)}</span>
          <NewMemberModuleRows
            modules={modules}
            selectedModuleKeys={draft.selectedModuleKeys}
            onModuleToggle={handleModuleToggle}
            loading={moduleCatalogLoading}
            error={moduleCatalogError}
          />
          {draft.surface ? (
            <small className="cc-member-window-field-hint">
              Die Auswahl wird aus den Manifesten der installierten Module aufgebaut. Nach einer Installation
              erscheint der neue Zugang automatisch; die Berechtigungen werden unter „Funktionen“ festgelegt.
            </small>
          ) : null}
        </div>
      </section>
    </div>
  );
}
