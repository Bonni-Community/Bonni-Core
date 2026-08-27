import { useCallback, useMemo } from "react";

import AccessTab from "./tab/Access.jsx";
import FunctionsTab from "./tab/Functions.jsx";
import OverviewTab from "./tab/Overview.jsx";
import ProtocolTab from "./tab/Protocol.jsx";
import SessionsTab from "./tab/Sessions.jsx";
import {
  CONTROL_CENTER_SURFACE,
  LOCAL_USAGE,
  TECHNICAL_USAGE,
  asArray,
  cleanNewMemberLoginName,
  createAccessMailto,
  generateAccessPassword,
  getNewMemberDefaultPermissions,
  getNewMemberModule,
  getNewMemberModulesForSurface,
  getNewMemberSelectedRoles,
  getSelectedNewMemberModules,
  isTechnicalOnlySurface,
  isValidEmail,
} from "./newMemberWindowUtils.js";
import {
  countUnicodeCodePoints,
  validateExactSecret,
} from "../../../../../core/modules/security/two-factor/model/exactSecretPolicy.js";

const NEW_MEMBER_TABS = [
  { key: "uebersicht", label: "Übersicht" },
  { key: "verwendung", label: "Verwendung" },
  { key: "funktionen", label: "Funktion" },
  { key: "zugang", label: "Zugänge" },
  { key: "sessions", label: "Sessions" },
  { key: "protokoll", label: "Protokolle" },
];

export default function NewMemberWindow({
  draft,
  activeTab,
  creating,
  error,
  moduleCatalog,
  moduleCatalogError,
  moduleCatalogLoading,
  onTabChange,
  onDraftChange,
  onCreate,
  onClose,
}) {
  const tab = activeTab || "uebersicht";
  const loginName = cleanNewMemberLoginName(draft.loginName);
  const title = loginName || "Neuer Benutzer";
  const initials = loginName ? loginName.slice(0, 2).toUpperCase() : "+";
  const selectedRoles = getNewMemberSelectedRoles(draft);
  const selectedModules = useMemo(
    () => getSelectedNewMemberModules(draft, moduleCatalog),
    [draft, moduleCatalog],
  );
  const moduleSummaryLabel = selectedModules.map((module) => module.label).join(", ") || "—";
  const roleSummaryLabel = selectedRoles.length
    ? `${selectedRoles.length} ${selectedRoles.length === 1 ? "Berechtigung" : "Berechtigungen"}`
    : "—";

  const updateDraft = useCallback((patch) => {
    onDraftChange((currentDraft) => ({
      ...currentDraft,
      ...patch,
    }));
  }, [onDraftChange]);

  const handleUsageSelect = useCallback((usage) => {
    onDraftChange((currentDraft) => {
      if (isTechnicalOnlySurface(currentDraft.surface) && usage !== TECHNICAL_USAGE) {
        return currentDraft;
      }

      const selectedKeys = asArray(currentDraft.selectedModuleKeys);
      const permissionsByModule = Object.fromEntries(selectedKeys.map((moduleKey) => {
        const module = getNewMemberModule(moduleCatalog, moduleKey);
        return [moduleKey, getNewMemberDefaultPermissions(module, usage)];
      }));

      return {
        ...currentDraft,
        usage,
        permissionsByModule,
        roles: Object.values(permissionsByModule).flat(),
      };
    });
  }, [moduleCatalog, onDraftChange]);

  const handleSurfaceSelect = useCallback((surface) => {
    onDraftChange((currentDraft) => {
      const usage = isTechnicalOnlySurface(surface)
        ? TECHNICAL_USAGE
        : currentDraft.usage;
      const availableModules = getNewMemberModulesForSurface(moduleCatalog, surface);
      const selectedModuleKeys = surface === CONTROL_CENTER_SURFACE && availableModules[0]
        ? [availableModules[0].key]
        : [];
      const permissionsByModule = Object.fromEntries(selectedModuleKeys.map((moduleKey) => {
        const module = getNewMemberModule(moduleCatalog, moduleKey);
        return [moduleKey, getNewMemberDefaultPermissions(module, usage || LOCAL_USAGE)];
      }));

      return {
        ...currentDraft,
        usage,
        surface,
        selectedModuleKeys,
        permissionsByModule,
        roles: Object.values(permissionsByModule).flat(),
      };
    });
  }, [moduleCatalog, onDraftChange]);

  const handleModuleToggle = useCallback((moduleKey) => {
    onDraftChange((currentDraft) => {
      const module = getNewMemberModule(moduleCatalog, moduleKey);
      if (!module) return currentDraft;

      const selectedKeys = asArray(currentDraft.selectedModuleKeys);
      const selected = selectedKeys.includes(moduleKey);
      if (selected && module.kind === "control-center") return currentDraft;

      const nextSelectedKeys = selected
        ? selectedKeys.filter((key) => key !== moduleKey)
        : [...selectedKeys, moduleKey];
      const nextPermissionsByModule = { ...(currentDraft.permissionsByModule || {}) };

      if (selected) {
        delete nextPermissionsByModule[moduleKey];
      } else {
        nextPermissionsByModule[moduleKey] = getNewMemberDefaultPermissions(
          module,
          currentDraft.usage || (isTechnicalOnlySurface(currentDraft.surface) ? TECHNICAL_USAGE : LOCAL_USAGE),
        );
      }

      return {
        ...currentDraft,
        selectedModuleKeys: nextSelectedKeys,
        permissionsByModule: nextPermissionsByModule,
        roles: Object.values(nextPermissionsByModule).flat(),
      };
    });
  }, [moduleCatalog, onDraftChange]);

  const handlePermissionToggle = useCallback((moduleKey, permission) => {
    onDraftChange((currentDraft) => {
      const currentPermissions = asArray(currentDraft.permissionsByModule?.[moduleKey]);
      const nextPermissions = currentPermissions.includes(permission)
        ? currentPermissions.filter((item) => item !== permission)
        : [...currentPermissions, permission];
      const permissionsByModule = {
        ...(currentDraft.permissionsByModule || {}),
        [moduleKey]: nextPermissions,
      };

      return {
        ...currentDraft,
        permissionsByModule,
        roles: Object.values(permissionsByModule).flat(),
      };
    });
  }, [onDraftChange]);

  const handleGeneratePassword = useCallback(() => {
    const nextPassword = generateAccessPassword();
    updateDraft({
      password: nextPassword,
      passwordRepeat: nextPassword,
    });
  }, [updateDraft]);

  const handlePrepareMail = useCallback(() => {
    const email = String(draft.email || "").trim();
    const password = draft.password;

    if (!email) {
      alert("Bitte zuerst eine E-Mail-Adresse eingeben.");
      return;
    }

    if (!isValidEmail(email)) {
      alert("Bitte eine gültige E-Mail-Adresse eingeben.");
      return;
    }

    if (!password) {
      alert("Bitte zuerst ein Passwort eingeben oder generieren.");
      return;
    }

    const passwordError = validateExactSecret(password, { label: "Das Passwort" });
    if (passwordError || countUnicodeCodePoints(password) < 6) {
      alert(passwordError || "Das Passwort muss mindestens 6 Zeichen haben.");
      return;
    }

    if (password !== draft.passwordRepeat) {
      alert("Die Passwort-Wiederholung stimmt nicht überein.");
      return;
    }

    window.location.href = createAccessMailto({
      email,
      loginName: loginName || "neuer-benutzer",
      password,
    });
  }, [draft.email, draft.password, draft.passwordRepeat, loginName]);

  return (
    <div className="cc-member-window-backdrop" onClick={onClose}>
      <section
        className="cc-member-window"
        aria-modal="true"
        role="dialog"
        aria-label="Neues Mitglied erstellen"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cc-member-window__titlebar">
          <div>
            <p>Mitglied / Benutzer</p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="cc-member-window__close" onClick={onClose} aria-label="Schließen">×</button>
        </header>

        <div className="cc-member-window__body">
          <aside className="cc-member-window__sidebar">
            <div className="cc-member-window__avatar" aria-hidden="true">{initials}</div>
            <strong>{title}</strong>
            <span>{draft.displayName || "—"}</span>
            <div className="cc-member-window__quickfacts">
              <small>Status</small>
              <button
                type="button"
                className="cc-member-window__status-toggle cc-member-window__status-toggle--active"
                disabled
                aria-label="Neuer Benutzer wird aktiv erstellt"
              >
                aktiviert
              </button>
              <small>Oberfläche</small>
              <b>{draft.surface || "—"}</b>
              <small>Verwendung</small>
              <b>{draft.usage || "—"}</b>
              <small>Module</small>
              <b>{moduleSummaryLabel}</b>
              <small>Funktionen</small>
              <b>{roleSummaryLabel}</b>
            </div>
          </aside>

          <main className="cc-member-window__context">
            <nav className="cc-member-window__tabs" aria-label="Benutzer Aktionen">
              {NEW_MEMBER_TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={tab === item.key ? "is-active" : ""}
                  onClick={() => onTabChange(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            <div className="cc-member-window__content">
              {error ? <div className="cc-member-error" role="status">{error}</div> : null}

              {tab === "uebersicht" || tab === "verwendung" ? (
                <OverviewTab
                  title={tab === "verwendung" ? "Verwendung" : "Übersicht"}
                  showIdentityFields={tab !== "verwendung"}
                  draft={draft}
                  moduleCatalog={moduleCatalog}
                  moduleCatalogError={moduleCatalogError}
                  moduleCatalogLoading={moduleCatalogLoading}
                  handleModuleToggle={handleModuleToggle}
                  handleSurfaceSelect={handleSurfaceSelect}
                  handleUsageSelect={handleUsageSelect}
                  updateDraft={updateDraft}
                />
              ) : null}
              {tab === "zugang" ? (
                <AccessTab
                  draft={draft}
                  onDraftChange={onDraftChange}
                  onGeneratePassword={handleGeneratePassword}
                  onPrepareMail={handlePrepareMail}
                />
              ) : null}
              {tab === "funktionen" ? (
                <FunctionsTab
                  draft={draft}
                  moduleCatalog={moduleCatalog}
                  onPermissionToggle={handlePermissionToggle}
                />
              ) : null}
              {tab === "sessions" ? <SessionsTab /> : null}
              {tab === "protokoll" ? <ProtocolTab /> : null}
            </div>
          </main>
        </div>

        <footer className="cc-member-window__footer">
          <button type="button" className="cc-member-window__secondary" onClick={onClose} disabled={creating}>
            Abbrechen
          </button>
          <button type="button" className="cc-member-window__primary" onClick={onCreate} disabled={creating}>
            {creating ? "Erstelle..." : "Mitglied erstellen"}
          </button>
        </footer>
      </section>
    </div>
  );
}
