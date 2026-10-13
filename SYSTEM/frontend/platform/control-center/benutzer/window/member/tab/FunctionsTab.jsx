import { NewMemberPermissionGroups } from "../../new-member/components/NewMemberFormParts.jsx";
import { APP_SURFACE, TECHNICAL_USAGE } from "../../new-member/newMemberWindowUtils.js";

export default function FunctionsTab({ draft, moduleCatalog, onPermissionToggle }) {
  const technicalApp = draft.usage === TECHNICAL_USAGE && draft.surface === APP_SURFACE;

  return (
    <section className="cc-member-window-card cc-member-window-functions-card">
      <div className="cc-member-window-card__intro">
        <div>
          <h3>{technicalApp ? "Technische Oberflächen" : "Funktionen und Berechtigungen"}</h3>
          <p>
            {technicalApp
              ? "Für diesen Terminal-Zugang kann genau eine technische Oberfläche freigegeben werden."
              : "Lege für jede ausgewählte App, jedes Add-on oder Plug-in die erlaubten Funktionen fest."}
          </p>
        </div>
      </div>

      <NewMemberPermissionGroups
        declaredOnly
        draft={draft}
        moduleCatalog={moduleCatalog}
        onPermissionToggle={onPermissionToggle}
      />
    </section>
  );
}
