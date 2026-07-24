import { NewMemberPermissionGroups } from "../components/NewMemberFormParts.jsx";

export default function FunctionsTab({ draft, moduleCatalog, onPermissionToggle }) {
  return (
    <section className="cc-member-window-card cc-member-window-functions-card">
      <div className="cc-member-window-card__intro">
        <div>
          <h3>Funktionen und Berechtigungen</h3>
          <p>Lege hier für jede zuvor ausgewählte App, jedes Add-on oder Plug-in die erlaubten Funktionen fest.</p>
        </div>
      </div>

      <NewMemberPermissionGroups
        draft={draft}
        moduleCatalog={moduleCatalog}
        onPermissionToggle={onPermissionToggle}
      />
    </section>
  );
}
