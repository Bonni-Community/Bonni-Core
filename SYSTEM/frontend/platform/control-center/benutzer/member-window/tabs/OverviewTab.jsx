import {
  AVAILABLE_MEMBER_SURFACES,
  AVAILABLE_MEMBER_USAGES,
  APP_SURFACE,
  TECHNICAL_USAGE,
  getDefaultRolesForSurface,
  getLoginName,
  getRoleOptionsForSurface,
  normalizeMemberRoleList,
} from "../memberWindowUtils.js";

function EditableField({ label, value, onChange }) {
  return (
    <label className="cc-member-window-field cc-member-window-field--editable">
      <span>{label}</span>
      <input
        className="cc-member-window-input"
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Benutzernamen eingeben"
      />
    </label>
  );
}

function ChoiceButton({ label, selected, onSelect }) {
  return (
    <button
      type="button"
      className={selected ? "cc-member-window-surface-choice is-selected" : "cc-member-window-surface-choice"}
      onClick={() => onSelect(label)}
      aria-pressed={selected}
    >
      {label}
    </button>
  );
}

function isLockedRole(surface, usage, role) {
  return getDefaultRolesForSurface(surface, usage).includes(role);
}

function getPermissionLabel(selectedSurfaces, selectedUsage) {
  if (selectedUsage === TECHNICAL_USAGE && selectedSurfaces.includes(APP_SURFACE)) {
    return "Technische Oberfläche";
  }

  return "Berechtigung";
}

function getRoleOptionsLabel(surface, selectedUsage) {
  if (selectedUsage === TECHNICAL_USAGE && surface === APP_SURFACE) {
    return `${surface} technische Oberfläche auswählen`;
  }

  return `${surface} Berechtigungen auswählen`;
}

function getEmptyRoleText(surface, selectedUsage) {
  if (selectedUsage === TECHNICAL_USAGE && surface === APP_SURFACE) {
    return "Keine technische Oberfläche vorhanden.";
  }

  return "Noch keine Berechtigungen vorhanden.";
}

function FunctionRows({ selectedSurfaces, selectedUsage, rolesBySurface, onRoleChange }) {
  if (!selectedSurfaces.length) {
    return <div className="cc-member-window-empty">Keine Oberfläche ausgewählt.</div>;
  }

  return (
    <div className="cc-member-window-function-list">
      {selectedSurfaces.map((surface) => {
        const selectedRoles = normalizeMemberRoleList(rolesBySurface?.[surface]);
        const roleOptions = getRoleOptionsForSurface(surface, selectedUsage);

        return (
          <article key={surface} className="cc-member-window-function-row">
            <strong>{surface}</strong>
            <div className="cc-member-window-role-editor">
              {roleOptions.length ? (
                <div className="cc-member-window-role-options" aria-label={getRoleOptionsLabel(surface, selectedUsage)}>
                  {roleOptions.map((role) => {
                    const locked = isLockedRole(surface, selectedUsage, role);
                    const selected = selectedRoles.includes(role);

                    return (
                      <button
                        key={role}
                        type="button"
                        className={selected ? "cc-member-window-role-option is-selected" : "cc-member-window-role-option"}
                        onClick={() => onRoleChange(surface, role)}
                        aria-pressed={selected}
                        disabled={locked}
                      >
                        {role}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="cc-member-window-role-empty">{getEmptyRoleText(surface, selectedUsage)}</div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default function OverviewTab({
  member,
  selectedSurfaces = [],
  selectedUsages = [],
  rolesBySurface = {},
  onLoginNameChange,
  onSurfaceToggle,
  onUsageToggle,
  onSurfaceRoleChange,
}) {
  const selectedUsage = selectedUsages[0] || "";

  return (
    <div className="cc-member-window-stack">
      <section className="cc-member-window-card">
        <h3>Übersicht</h3>
        <div className="cc-member-window-grid cc-member-window-grid--single">
          <EditableField label="Benutzer" value={getLoginName(member)} onChange={onLoginNameChange} />
        </div>

        <div className="cc-member-window-field cc-member-window-field--usage-select">
          <span>Verwendung</span>
          <div className="cc-member-window-usage-grid" role="group" aria-label="Verwendung auswählen">
            {AVAILABLE_MEMBER_USAGES.map((usage) => (
              <ChoiceButton
                key={usage}
                label={usage}
                selected={selectedUsages.includes(usage)}
                onSelect={onUsageToggle}
              />
            ))}
          </div>
        </div>

        <div className="cc-member-window-field cc-member-window-field--surface-select">
          <span>Oberfläche</span>
          <div className="cc-member-window-surface-grid" role="group" aria-label="Oberfläche auswählen">
            {AVAILABLE_MEMBER_SURFACES.map((surface) => (
              <ChoiceButton
                key={surface}
                label={surface}
                selected={selectedSurfaces.includes(surface)}
                onSelect={onSurfaceToggle}
              />
            ))}
          </div>
        </div>

        <div className="cc-member-window-field cc-member-window-field--functions">
          <span>{getPermissionLabel(selectedSurfaces, selectedUsage)}</span>
          <FunctionRows
            selectedSurfaces={selectedSurfaces}
            selectedUsage={selectedUsage}
            rolesBySurface={rolesBySurface}
            onRoleChange={onSurfaceRoleChange}
          />
        </div>
      </section>
    </div>
  );
}
