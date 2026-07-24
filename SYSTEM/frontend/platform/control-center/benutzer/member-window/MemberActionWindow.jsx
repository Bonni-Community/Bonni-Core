import { useCallback, useEffect, useMemo, useState } from "react";

import OverviewTab from "./tabs/OverviewTab.jsx";
import AccessTab from "./tabs/AccessTab.jsx";
import FunctionsTab from "./tabs/FunctionsTab.jsx";
import SessionsTab from "./tabs/SessionsTab.jsx";
import ProtocolTab from "./tabs/ProtocolTab.jsx";
import { updateControlCenterLocalMemberProfile } from "../../../../system/api/controlCenterUsersApi.js";
import {
  AVAILABLE_MEMBER_SURFACES,
  AVAILABLE_MEMBER_USAGES,
  getAccounts,
  getDefaultRolesForSurface,
  getLoginName,
  getRoleOptionsForSurface,
  getSurfaceLabels,
  getSurfaceRoles,
  getUsageLabels,
  LOCAL_USAGE,
  APP_SURFACE,
  normalizeMemberRoleList,
  TECHNICAL_USAGE,
  usesSingleRoleSelection,
} from "./memberWindowUtils.js";

const TABS = [
  { key: "uebersicht", label: "Übersicht" },
  { key: "zugang", label: "Zugänge" },
  { key: "funktionen", label: "Funktionen" },
  { key: "sessions", label: "Sessions" },
  { key: "protokoll", label: "Protokoll" },
];

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isActiveStatus(value) {
  return ["aktiv", "active"].includes(normalizeStatus(value));
}

function getStatusTone(status) {
  return isActiveStatus(status) ? "active" : "inactive";
}

function getStatusActionLabel(status) {
  return isActiveStatus(status) ? "aktiviert" : "deaktiviert";
}

function getSelectableSurfaceLabels(member) {
  const surfaces = getSurfaceLabels(member).filter((surface) => AVAILABLE_MEMBER_SURFACES.includes(surface));
  const firstSurface = AVAILABLE_MEMBER_SURFACES.find((surface) => surfaces.includes(surface));

  return firstSurface ? [firstSurface] : [];
}

function getSelectableUsageLabels(member) {
  const usages = getUsageLabels(member).filter((usage) => AVAILABLE_MEMBER_USAGES.includes(usage));

  if (usages.includes(TECHNICAL_USAGE)) return [TECHNICAL_USAGE];
  if (usages.includes(LOCAL_USAGE)) return [LOCAL_USAGE];

  return [];
}

function getPrimaryUsage(usages) {
  if (usages.includes(TECHNICAL_USAGE)) return TECHNICAL_USAGE;
  if (usages.includes(LOCAL_USAGE)) return LOCAL_USAGE;

  return usages[0] || "";
}

function sanitizeSurfaceRoles(surfaces, rolesBySurface, usages) {
  const usage = getPrimaryUsage(usages);

  return Object.fromEntries(
    surfaces.map((surface) => {
      const options = getRoleOptionsForSurface(surface, usage);
      const currentRoles = normalizeMemberRoleList(rolesBySurface?.[surface]);
      const defaultRoles = getDefaultRolesForSurface(surface, usage);
      const selectedRoles = options.filter((role) => currentRoles.includes(role) || defaultRoles.includes(role));

      return [surface, selectedRoles];
    }),
  );
}

function isTechnicalAppSelection(surface, usage) {
  return surface === APP_SURFACE && usage === TECHNICAL_USAGE;
}

function buildSurfaceRoleLabels(surfaces, rolesBySurface, usages = []) {
  const usage = getPrimaryUsage(usages);

  return surfaces.flatMap((surface) => {
    if (isTechnicalAppSelection(surface, usage)) return [];

    const roles = normalizeMemberRoleList(rolesBySurface?.[surface]);
    return roles.length ? [`${surface}: ${roles.join(", ")}`] : [];
  });
}

function buildTerminalLabels(surfaces, rolesBySurface, usages = []) {
  const usage = getPrimaryUsage(usages);

  if (usage === TECHNICAL_USAGE && surfaces.includes(APP_SURFACE)) {
    return normalizeMemberRoleList(rolesBySurface?.[APP_SURFACE]).slice(0, 1);
  }

  return surfaces;
}

function getTechnicalSurfaceLabel(surfaces, rolesBySurface, usages = []) {
  const usage = getPrimaryUsage(usages);

  if (usage !== TECHNICAL_USAGE || !surfaces.includes(APP_SURFACE)) return "";

  return normalizeMemberRoleList(rolesBySurface?.[APP_SURFACE])[0] || "";
}

function getPermissionSummaryLabel(surfaces, rolesBySurface, usages = []) {
  const usage = getPrimaryUsage(usages);

  if (usage === TECHNICAL_USAGE && surfaces.includes(APP_SURFACE)) {
    return getTechnicalSurfaceLabel(surfaces, rolesBySurface, usages) || "—";
  }

  return buildSurfaceRoleLabels(surfaces, rolesBySurface, usages).join(", ") || "—";
}

function createSurfaceSnapshot(member) {
  const surfaces = getSelectableSurfaceLabels(member);
  const usages = getSelectableUsageLabels(member);
  const rolesBySurface = sanitizeSurfaceRoles(surfaces, getSurfaceRoles(member), usages);

  return {
    surfaces,
    rolesBySurface,
  };
}

function createSnapshot(member) {
  const surfaceSnapshot = createSurfaceSnapshot(member);

  return {
    loginName: getLoginName(member),
    status: member?.status || "Unbekannt",
    usageLabels: getSelectableUsageLabels(member).join("||"),
    surfaces: surfaceSnapshot.surfaces.join("||"),
    rolesBySurface: JSON.stringify(surfaceSnapshot.rolesBySurface),
  };
}

function hasSnapshotChanges(left, right) {
  return (
    left.loginName !== right.loginName ||
    left.status !== right.status ||
    left.usageLabels !== right.usageLabels ||
    left.surfaces !== right.surfaces ||
    left.rolesBySurface !== right.rolesBySurface
  );
}

function updatePrimaryLoginName(member, nextLoginName) {
  const accounts = getAccounts(member);
  const hasActiveAccount = accounts.some((account) => account.isActive);
  const nextAccounts = accounts.map((account, index) => {
    const isPrimaryAccount = account.isActive || (!hasActiveAccount && index === 0);
    return isPrimaryAccount ? { ...account, loginName: nextLoginName } : account;
  });

  return {
    ...member,
    loginName: nextLoginName,
    name: nextLoginName,
    displayName: nextLoginName,
    accounts: nextAccounts,
  };
}

function updateSurfaceData(member, surfaces, rolesBySurface, usages = getSelectableUsageLabels(member)) {
  const nextSurfaceRoles = sanitizeSurfaceRoles(surfaces, rolesBySurface, usages);
  const nextRoleLabels = buildSurfaceRoleLabels(surfaces, nextSurfaceRoles, usages);
  const nextTerminalLabels = buildTerminalLabels(surfaces, nextSurfaceRoles, usages);

  return {
    ...member,
    surfaceLabels: surfaces,
    terminalLabels: nextTerminalLabels,
    accessLabels: nextRoleLabels,
    roles: nextRoleLabels,
    role: nextRoleLabels[0] || "",
    surfaceRoles: nextSurfaceRoles,
    rolesBySurface: nextSurfaceRoles,
  };
}

function updateUsageData(member, usages) {
  return {
    ...member,
    usageLabels: usages,
    technicalOnly: usages.includes(TECHNICAL_USAGE),
  };
}

function normalizeDraftMember(member) {
  const usages = getSelectableUsageLabels(member);
  const surfaces = getSelectableSurfaceLabels(member);
  const rolesBySurface = getSurfaceRoles(member);
  const withUsage = updateUsageData(member, usages);

  return updateSurfaceData(withUsage, surfaces, rolesBySurface, usages);
}

export default function MemberActionWindow({
  member,
  activeTab,
  token,
  onTabChange,
  onClose,
  onMemberChange,
  onMemberDelete,
}) {
  const [draftMember, setDraftMember] = useState(() => normalizeDraftMember(member));
  const [savedSnapshot, setSavedSnapshot] = useState(() => createSnapshot(normalizeDraftMember(member)));
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [accessFooterAction, setAccessFooterAction] = useState(null);

  useEffect(() => {
    const nextDraftMember = normalizeDraftMember(member);

    setDraftMember(nextDraftMember);
    setSavedSnapshot(createSnapshot(nextDraftMember));
    setAccessFooterAction(null);
    setActionError("");
  }, [member]);

  useEffect(() => {
    if ((activeTab || "uebersicht") !== "zugang") {
      setAccessFooterAction(null);
    }
  }, [activeTab]);

  const loginName = getLoginName(draftMember);
  const selectedSurfaces = useMemo(() => getSelectableSurfaceLabels(draftMember), [draftMember]);
  const selectedUsages = useMemo(() => getSelectableUsageLabels(draftMember), [draftMember]);
  const rolesBySurface = useMemo(
    () => sanitizeSurfaceRoles(selectedSurfaces, getSurfaceRoles(draftMember), selectedUsages),
    [draftMember, selectedSurfaces, selectedUsages],
  );
  const isTechnicalAppAccount = selectedUsages.includes(TECHNICAL_USAGE) && selectedSurfaces.includes(APP_SURFACE);
  const roleSummaryLabel = getPermissionSummaryLabel(selectedSurfaces, rolesBySurface, selectedUsages);
  const roleSummaryTitle = isTechnicalAppAccount ? "Technische Oberfläche" : "Berechtigung";
  const currentSnapshot = useMemo(() => createSnapshot(draftMember), [draftMember]);
  const hasChanges = hasSnapshotChanges(savedSnapshot, currentSnapshot);
  const tab = activeTab || "uebersicht";
  const isAccessFooterActionActive = tab === "zugang" && Boolean(accessFooterAction);
  const footerButtonClass = isAccessFooterActionActive
    ? (accessFooterAction?.className || "cc-member-window__primary")
    : (hasChanges ? "cc-member-window__primary" : "cc-member-window__secondary");
  const footerButtonLabel = isAccessFooterActionActive
    ? (accessFooterAction?.label || "Speichern")
    : (hasChanges ? "Speichern" : "Schließen");
  const footerButtonDisabled = actionBusy || Boolean(isAccessFooterActionActive && accessFooterAction?.disabled);

  const handleLoginNameChange = useCallback((nextLoginName) => {
    setDraftMember((currentMember) => updatePrimaryLoginName(currentMember, nextLoginName));
  }, []);

  const handleStatusToggle = useCallback(() => {
    setDraftMember((currentMember) => {
      const nextStatus = isActiveStatus(currentMember?.status) ? "Inaktiv" : "Aktiv";
      return {
        ...currentMember,
        status: nextStatus,
        statusTone: getStatusTone(nextStatus),
      };
    });
  }, []);

  const handleSurfaceToggle = useCallback((surface) => {
    setDraftMember((currentMember) => {
      const nextSurfaces = [surface];
      const currentRoles = getSurfaceRoles(currentMember);
      const currentUsages = getSelectableUsageLabels(currentMember);

      return updateSurfaceData(currentMember, nextSurfaces, currentRoles, currentUsages);
    });
  }, []);

  const handleUsageToggle = useCallback((usage) => {
    setDraftMember((currentMember) => {
      const nextUsages = [usage];
      const currentSurfaces = getSelectableSurfaceLabels(currentMember);
      const withUsage = updateUsageData(currentMember, nextUsages);

      return updateSurfaceData(withUsage, currentSurfaces, {}, nextUsages);
    });
  }, []);

  const handleSurfaceRoleChange = useCallback((surface, role) => {
    setDraftMember((currentMember) => {
      const currentUsages = getSelectableUsageLabels(currentMember);
      const usage = getPrimaryUsage(currentUsages);
      const options = getRoleOptionsForSurface(surface, usage);
      const lockedRoles = getDefaultRolesForSurface(surface, usage);

      if (!options.includes(role) || lockedRoles.includes(role)) {
        return updateSurfaceData(currentMember, getSelectableSurfaceLabels(currentMember), getSurfaceRoles(currentMember), currentUsages);
      }

      const currentSurfaces = getSelectableSurfaceLabels(currentMember);
      const nextSurfaces = currentSurfaces.includes(surface) ? currentSurfaces : [surface];
      const currentRoles = getSurfaceRoles(currentMember);
      const selectedRoles = normalizeMemberRoleList(currentRoles[surface]);
      const isSingleRoleSelection = usesSingleRoleSelection(surface, usage);
      const nextSelectedRoles = isSingleRoleSelection
        ? (selectedRoles.includes(role) ? [] : [role])
        : (selectedRoles.includes(role)
          ? selectedRoles.filter((item) => item !== role)
          : [...selectedRoles, role]);
      const nextRoles = {
        ...currentRoles,
        [surface]: nextSelectedRoles,
      };

      return updateSurfaceData(currentMember, nextSurfaces, nextRoles, currentUsages);
    });
  }, []);

  const buildProfilePayload = useCallback((memberDraft) => ({
    loginName: getLoginName(memberDraft),
    status: memberDraft?.status || "Aktiv",
    isActive: isActiveStatus(memberDraft?.status),
    usageLabels: getSelectableUsageLabels(memberDraft),
    surfaceLabels: getSelectableSurfaceLabels(memberDraft),
    rolesBySurface: sanitizeSurfaceRoles(
      getSelectableSurfaceLabels(memberDraft),
      getSurfaceRoles(memberDraft),
      getSelectableUsageLabels(memberDraft),
    ),
  }), []);

  const getPrimaryAccountId = useCallback((memberDraft) => {
    const accounts = getAccounts(memberDraft);
    const primaryAccount = accounts.find((account) => account.isActive) || accounts[0];
    return primaryAccount?.accountId || primaryAccount?.id || null;
  }, []);

  const handleApplyChanges = useCallback(async () => {
    if (!hasChanges) {
      onClose();
      return;
    }

    const accountId = getPrimaryAccountId(draftMember);

    if (!accountId) {
      setActionError("Dieser Benutzer hat keinen speicherbaren Zugang.");
      return;
    }

    const nextMember = {
      ...draftMember,
      statusTone: getStatusTone(draftMember?.status),
    };

    setActionBusy(true);
    setActionError("");

    try {
      await updateControlCenterLocalMemberProfile(token, accountId, buildProfilePayload(nextMember));
      onMemberChange?.(nextMember);
      setDraftMember(nextMember);
      setSavedSnapshot(createSnapshot(nextMember));
    } catch (error) {
      setActionError(error?.message || "Benutzer konnte nicht gespeichert werden.");
    } finally {
      setActionBusy(false);
    }
  }, [buildProfilePayload, draftMember, getPrimaryAccountId, hasChanges, onClose, onMemberChange, token]);

  const handleFooterButtonClick = useCallback(() => {
    if (isAccessFooterActionActive) {
      accessFooterAction?.onClick?.();
      return;
    }

    if (hasChanges) {
      handleApplyChanges();
      return;
    }

    onClose();
  }, [accessFooterAction, handleApplyChanges, hasChanges, isAccessFooterActionActive, onClose]);

  const handleAccountChange = useCallback((nextAccount) => {
    if (!nextAccount) return;

    setDraftMember((currentMember) => {
      const nextAccounts = getAccounts(currentMember).map((account) => {
        const accountId = account.accountId || account.id;
        const nextAccountId = nextAccount.accountId || nextAccount.id;

        return accountId === nextAccountId ? { ...account, ...nextAccount } : account;
      });
      const nextMember = {
        ...currentMember,
        email: nextAccount.email || currentMember.email,
        accounts: nextAccounts,
      };

      onMemberChange?.(nextMember);
      return nextMember;
    });
  }, [onMemberChange]);

  const handleMemberDeleted = useCallback((deletedMember) => {
    onMemberDelete?.(deletedMember || draftMember);
    onClose();
  }, [draftMember, onClose, onMemberDelete]);

  return (
    <div className="cc-member-window-backdrop" onClick={onClose}>
      <section
        className="cc-member-window"
        aria-modal="true"
        role="dialog"
        aria-label={`${loginName} Aktionen`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cc-member-window__titlebar">
          <div>
            <p>Mitglied / Benutzer</p>
            <h2>{loginName}</h2>
          </div>
          <button type="button" className="cc-member-window__close" onClick={onClose} aria-label="Schließen">×</button>
        </header>

        <div className="cc-member-window__body">
          <aside className="cc-member-window__sidebar">
            <div className="cc-member-window__avatar" aria-hidden="true">{loginName.slice(0, 2).toUpperCase()}</div>
            <strong>{loginName}</strong>
            <span>{draftMember?.email || draftMember?.name || "—"}</span>
            <div className="cc-member-window__quickfacts">
              <small>Status</small>
              <button
                type="button"
                className={`cc-member-window__status-toggle cc-member-window__status-toggle--${getStatusTone(draftMember?.status)}`}
                onClick={handleStatusToggle}
                aria-label={isActiveStatus(draftMember?.status) ? "Benutzer deaktivieren" : "Benutzer aktivieren"}
              >
                {getStatusActionLabel(draftMember?.status)}
              </button>
              <small>Oberfläche</small>
              <b>{selectedSurfaces.join(", ") || "—"}</b>
              <small>Verwendung</small>
              <b>{selectedUsages.join(", ") || "—"}</b>
              <small>{roleSummaryTitle}</small>
              <b>{roleSummaryLabel}</b>
            </div>
          </aside>

          <main className="cc-member-window__context">
            <nav className="cc-member-window__tabs" aria-label="Benutzer Aktionen">
              {TABS.map((item) => (
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
              {actionError ? <div className="cc-member-error" role="status">{actionError}</div> : null}
              {tab === "uebersicht" ? (
                <OverviewTab
                  member={draftMember}
                  selectedSurfaces={selectedSurfaces}
                  selectedUsages={selectedUsages}
                  rolesBySurface={rolesBySurface}
                  onLoginNameChange={handleLoginNameChange}
                  onSurfaceToggle={handleSurfaceToggle}
                  onUsageToggle={handleUsageToggle}
                  onSurfaceRoleChange={handleSurfaceRoleChange}
                />
              ) : null}
              {tab === "zugang" ? (
                <AccessTab
                  member={draftMember}
                  token={token}
                  onAccountChange={handleAccountChange}
                  onDeleted={handleMemberDeleted}
                  onBusyChange={setActionBusy}
                  onFooterActionChange={setAccessFooterAction}
                />
              ) : null}
              {tab === "funktionen" ? <FunctionsTab member={draftMember} /> : null}
              {tab === "sessions" ? <SessionsTab member={draftMember} /> : null}
              {tab === "protokoll" ? <ProtocolTab member={draftMember} /> : null}
            </div>
          </main>
        </div>

        <footer className="cc-member-window__footer">
          <button
            type="button"
            className={footerButtonClass}
            onClick={handleFooterButtonClick}
            disabled={footerButtonDisabled}
          >
            {footerButtonLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
