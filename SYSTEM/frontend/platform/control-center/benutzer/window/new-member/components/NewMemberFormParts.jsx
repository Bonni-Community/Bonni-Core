import {
  getNewMemberModulePermissions,
  getSelectedModulePermissions,
  getSelectedNewMemberModules,
} from "../newMemberWindowUtils.js";
import ExactSecretInput from "../../../../../../core/modules/security/two-factor/components/ExactSecretInput.jsx";

export function NewMemberEditableField({
  label,
  value,
  onChange,
  type = "text",
  placeholder = "",
  readOnly = false,
  disabled = false,
  exactSecret = false,
}) {
  if (exactSecret) {
    return (
      <ExactSecretInput
        className="cc-member-window-field cc-member-window-field--editable"
        inputClassName="cc-member-window-input"
        label={label}
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
        autoComplete="new-password"
        disabled={disabled || readOnly}
        placeholder={placeholder}
      />
    );
  }
  return (
    <label className="cc-member-window-field cc-member-window-field--editable">
      <span>{label}</span>
      <input
        className="cc-member-window-input"
        value={value || ""}
        type={type}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function NewMemberChoiceButton({ label, selected, onSelect, disabled = false, name }) {
  const className = [
    "cc-member-window-surface-choice",
    selected ? "is-selected" : "",
    disabled ? "is-disabled" : "",
  ].filter(Boolean).join(" ");

  return (
    <label
      className={className}
      aria-disabled={disabled || undefined}
    >
      <input
        className="cc-member-window-choice-input"
        type="radio"
        name={name}
        value={label}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(label)}
      />
      <span>{label}</span>
    </label>
  );
}

function moduleStatusLabel(module) {
  if (module.enabled) return "Aktiv";
  if (module.installed) return "Installiert";
  return "Verfügbar";
}

export function NewMemberModuleRows({ modules, selectedModuleKeys, onModuleToggle, loading = false, error = "" }) {
  const selectedKeys = Array.isArray(selectedModuleKeys) ? selectedModuleKeys : [];

  if (loading) return <div className="cc-member-window-empty">Module werden geladen...</div>;
  if (!modules.length) {
    return (
      <div className="cc-member-window-empty">
        {error || "Für diesen Bereich wurde noch kein Modul registriert."}
      </div>
    );
  }

  return (
    <div className="cc-member-window-module-list">
      {modules.map((module) => {
        const selected = selectedKeys.includes(module.key);

        return (
          <label
            key={module.key}
            className={selected ? "cc-member-window-module is-selected" : "cc-member-window-module"}
          >
            <input
              className="cc-member-window-choice-input"
              type="checkbox"
              checked={selected}
              onChange={() => onModuleToggle(module.key)}
              aria-label={`${module.label} auswählen`}
            />
            <span className="cc-member-window-module__check" aria-hidden="true">{selected ? "✓" : "+"}</span>
            <span className="cc-member-window-module__copy">
              <strong>{module.label}</strong>
              <small>{module.description || `${module.surface}-Zugang`}</small>
            </span>
            <span className={`cc-member-window-module__status${module.enabled ? " is-active" : ""}`}>
              {moduleStatusLabel(module)}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function NewMemberPermissionGroups({ draft, moduleCatalog, onPermissionToggle }) {
  const modules = getSelectedNewMemberModules(draft, moduleCatalog);

  if (!draft.surface) {
    return <div className="cc-member-window-empty">Bitte zuerst in der Übersicht einen Bereich auswählen.</div>;
  }
  if (!modules.length) {
    return <div className="cc-member-window-empty">Bitte zuerst in der Übersicht mindestens ein Modul auswählen.</div>;
  }

  return (
    <div className="cc-member-window-permission-groups">
      {modules.map((module) => {
        const selectedPermissions = getSelectedModulePermissions(draft, module.key);
        const options = [...new Set([
          ...getNewMemberModulePermissions(module, draft.usage),
          ...selectedPermissions,
        ])];

        return (
          <article key={module.key} className="cc-member-window-permission-group">
            <header>
              <div>
                <span>{module.surface}</span>
                <h4>{module.label}</h4>
              </div>
              <small>{selectedPermissions.length} ausgewählt</small>
            </header>

            {options.length ? (
              <div className="cc-member-window-role-options" aria-label={`${module.label} Berechtigungen`}>
                {options.map((permission) => {
                  const selected = selectedPermissions.includes(permission);

                  return (
                    <button
                      key={permission}
                      type="button"
                      className={selected ? "cc-member-window-role-option is-selected" : "cc-member-window-role-option"}
                      onClick={() => onPermissionToggle(module.key, permission)}
                      aria-pressed={selected}
                    >
                      {permission}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="cc-member-window-role-empty">
                Für dieses Modul wurden keine Berechtigungen veröffentlicht.
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
