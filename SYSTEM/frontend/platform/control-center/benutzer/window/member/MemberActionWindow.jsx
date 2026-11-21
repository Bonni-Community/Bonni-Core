import { useCallback, useEffect, useMemo, useState } from "react";

import OverviewTab from "./tab/OverviewTab.jsx";
import AccessTab from "./tab/AccessTab.jsx";
import FunctionsTab from "./tab/FunctionsTab.jsx";
import SessionsTab from "./tab/SessionsTab.jsx";
import ProtocolTab from "./tab/ProtocolTab.jsx";
import AdminEnrollmentPanel from "../../../../../core/modules/security/two-factor/components/AdminEnrollmentPanel.jsx";
import NfcTagsPanel from "../../../../../core/modules/security/nfc/NfcTagsPanel.jsx";
import { updateControlCenterLocalMemberProfile } from "../../../../../system/api/controlCenterUsersApi.js";
import { isBootstrapAdminLoginName } from "../../../../../system/auth/systemAccountPolicy.js";
import {
  ADD_ON_SURFACE,
  APP_SURFACE,
  CONTROL_CENTER_SURFACE,
  LOCAL_USAGE,
  PLUG_IN_SURFACE,
  TECHNICAL_USAGE,
  asArray,
  buildNewMemberModuleAccess,
  getNewMemberDefaultPermissions,
  getNewMemberModule,
  getNewMemberModulePermissions,
  getNewMemberModulesForSurface,
  getNewMemberSelectedRoles,
  getSelectedNewMemberModules,
} from "../new-member/newMemberWindowUtils.js";
import {
  getAccounts,
  getLoginName,
  getSurfaceLabels,
  getSurfaceRoles,
  normalizeMemberRoleList,
} from "./memberWindowUtils.js";
import { getAccountModuleCatalog, getAccountPermissions, getAccountSurfaces, getFixedAccountUsage } from "./memberAccountPolicy.js";

const TABS = [
  { key: "uebersicht", label: "Übersicht" },
  { key: "verwendung", label: "Verwendung" },
  { key: "funktionen", label: "Funktion" },
  { key: "zugang", label: "Zugänge" },
  { key: "two-factor", label: "2FA" },
  { key: "nfc", label: "NFC-Tag" },
  { key: "sessions", label: "Sessions" },
  { key: "protokoll", label: "Protokolle" },
];

const MEMBER_SURFACES = [
  CONTROL_CENTER_SURFACE,
  APP_SURFACE,
  ADD_ON_SURFACE,
  PLUG_IN_SURFACE,
];

const SURFACE_TO_KIND = {
  [CONTROL_CENTER_SURFACE]: "control-center",
  [APP_SURFACE]: "app",
  [ADD_ON_SURFACE]: "add-on",
  [PLUG_IN_SURFACE]: "plug-in",
};

const KIND_TO_SURFACE = Object.fromEntries(
  Object.entries(SURFACE_TO_KIND).map(([surface, kind]) => [kind, surface]),
);

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isActiveStatus(value) {
  return ["aktiv", "active", "aktiviert", "enabled"].includes(normalizeStatus(value));
}

function getStatusTone(status) {
  return isActiveStatus(status) ? "active" : "inactive";
}

function getStatusActionLabel(status) {
  return isActiveStatus(status) ? "aktiviert" : "deaktiviert";
}

function normalizeKind(value) {
  const kind = String(value || "").trim().toLowerCase().replace(/_/g, "-");

  if (["control-center", "control center", "controlcenter", "control"].includes(kind)) return "control-center";
  if (kind === "app") return "app";
  if (["add-on", "addon"].includes(kind)) return "add-on";
  if (["plug-in", "plugin"].includes(kind)) return "plug-in";

  return "";
}

function identity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSelectableSurfaceLabels(member) {
  const surfaces = getSurfaceLabels(member).filter((surface) => MEMBER_SURFACES.includes(surface));
  const firstSurface = MEMBER_SURFACES.find((surface) => surfaces.includes(surface));

  return firstSurface ? [firstSurface] : [];
}

function mergeModuleAccess(assignments) {
  const grouped = new Map();

  assignments.forEach((assignment) => {
    const kind = normalizeKind(assignment?.kind);
    const moduleKey = String(assignment?.moduleKey || "").trim();
    const moduleName = String(assignment?.moduleName || moduleKey).trim();
    const permissions = asArray(assignment?.permissions).map((permission) => String(permission || "").trim()).filter(Boolean);
    if (!kind || !moduleKey || !moduleName) return;

    const key = `${kind}:${identity(moduleKey)}:${identity(moduleName)}`;
    const current = grouped.get(key);
    if (current) {
      current.permissions = [...new Set([...current.permissions, ...permissions])];
      return;
    }

    grouped.set(key, { kind, moduleKey, moduleName, permissions: [...new Set(permissions)] });
  });

  return [...grouped.values()];
}

function parseModuleAccessLabel(label) {
  const text = String(label || "").trim();
  if (text.toLowerCase() === "administrator") {
    return {
      kind: "control-center",
      moduleKey: "control-center",
      moduleName: "Control Center",
      permissions: ["Administrator"],
    };
  }

  const match = text.match(/^(Control Center|App|Add-on|Plug-in)\s*:\s*(.*?)\s*·\s*(.+)$/i);
  const kind = normalizeKind(match?.[1]);
  const moduleName = String(match?.[2] || "").trim();
  const permission = String(match?.[3] || "").trim();
  if (!kind || !moduleName || !permission) return null;

  return {
    kind,
    moduleKey: identity(moduleName),
    moduleName,
    permissions: [permission],
  };
}

function getMemberModuleAccess(member) {
  const structuredAccess = mergeModuleAccess([
    ...asArray(member?.moduleAccess),
    ...getAccounts(member).flatMap((account) => asArray(account?.moduleAccess)),
  ]);

  if (structuredAccess.length) return structuredAccess;

  const labels = [
    ...asArray(member?.accessLabels),
    ...asArray(member?.roles),
    member?.role,
    ...getAccounts(member).flatMap((account) => [
      ...asArray(account?.accessLabels),
      ...asArray(account?.roles),
      account?.role,
    ]),
  ];

  return mergeModuleAccess(labels.map(parseModuleAccessLabel).filter(Boolean));
}

function findCatalogModule(moduleCatalog, assignment) {
  const candidates = asArray(moduleCatalog).filter((module) => module.kind === assignment.kind);
  const assignmentKey = identity(assignment.moduleKey);
  const assignmentName = identity(assignment.moduleName);

  return candidates.find((module) => module.key === assignment.moduleKey)
    || candidates.find((module) => identity(module.key) === assignmentKey)
    || candidates.find((module) => identity(module.label) === assignmentName)
    || null;
}

function createAccessDraft(member, moduleCatalog) {
  const assignments = getMemberModuleAccess(member);
  let surface = getSelectableSurfaceLabels(member)[0] || "";
  const usage = getFixedAccountUsage(member);

  if (assignments.length) {
    const assignmentsForSurface = assignments.filter((assignment) => SURFACE_TO_KIND[surface] === assignment.kind);
    if (!surface || !assignmentsForSurface.length) surface = KIND_TO_SURFACE[assignments[0].kind] || surface;
  }

  if (!getAccountSurfaces(usage).includes(surface)) {
    surface = usage === TECHNICAL_USAGE ? APP_SURFACE : CONTROL_CENTER_SURFACE;
  }

  const selectedModuleKeys = [];
  const permissionsByModule = {};
  assignments
    .filter((assignment) => assignment.kind === SURFACE_TO_KIND[surface])
    .forEach((assignment) => {
      const module = findCatalogModule(moduleCatalog, assignment);
      if (!module) return;
      if (!selectedModuleKeys.includes(module.key)) selectedModuleKeys.push(module.key);
      permissionsByModule[module.key] = [
        ...new Set([
          ...asArray(permissionsByModule[module.key]),
          ...asArray(assignment.permissions),
        ]),
      ];
    });

  const availableModules = getNewMemberModulesForSurface(moduleCatalog, surface);
  if (!selectedModuleKeys.length && (surface === CONTROL_CENTER_SURFACE || availableModules.length === 1)) {
    const module = availableModules[0];
    if (module) {
      const legacyPermissions = normalizeMemberRoleList(getSurfaceRoles(member)?.[surface]);
      selectedModuleKeys.push(module.key);
      permissionsByModule[module.key] = legacyPermissions.length
        ? legacyPermissions
        : getNewMemberDefaultPermissions(module, usage);
    }
  }

  for (const key of selectedModuleKeys) {
    permissionsByModule[key] = getAccountPermissions(getNewMemberModule(moduleCatalog, key), usage, permissionsByModule[key]);
  }

  return {
    usage,
    surface,
    selectedModuleKeys,
    permissionsByModule,
    roles: Object.values(permissionsByModule).flat(),
  };
}

function accessLabelsFromModuleAccess(moduleAccess) {
  return moduleAccess.flatMap((assignment) => assignment.permissions.map((permission) => {
    if (assignment.kind === "control-center" && identity(permission) === "administrator") return "Administrator";
    const surface = KIND_TO_SURFACE[assignment.kind] || assignment.kind;
    return `${surface}: ${assignment.moduleName} · ${permission}`;
  }));
}

function applyAccessDraftToMember(member, accessDraft, moduleCatalog) {
  const moduleAccess = buildNewMemberModuleAccess(accessDraft, moduleCatalog);
  const accessLabels = accessLabelsFromModuleAccess(moduleAccess);
  const selectedRoles = getNewMemberSelectedRoles(accessDraft);
  const surfaceLabels = accessDraft.surface ? [accessDraft.surface] : [];
  const usageLabels = accessDraft.usage ? [accessDraft.usage] : [];
  const terminalLabels = accessDraft.usage === TECHNICAL_USAGE && accessDraft.surface === APP_SURFACE
    ? selectedRoles
    : surfaceLabels;
  const rolesBySurface = accessDraft.surface ? { [accessDraft.surface]: selectedRoles } : {};
  const accounts = getAccounts(member);
  const primaryAccountIndex = Math.max(0, accounts.findIndex((account) => account.isActive));
  const nextAccounts = accounts.map((account, index) => (
    index === primaryAccountIndex
      ? {
          ...account,
          moduleAccess,
          accessLabels,
          roles: accessLabels,
          role: accessLabels[0] || "",
          surfaceLabels,
          terminalLabels,
          usageLabels,
          usageLabel: accessDraft.usage || account.usageLabel,
        }
      : account
  ));

  return {
    ...member,
    accessDraft,
    moduleAccess,
    accessLabels,
    roles: accessLabels,
    role: accessLabels[0] || "",
    surfaceLabels,
    terminalLabels,
    usageLabels,
    technicalOnly: accessDraft.usage === TECHNICAL_USAGE,
    surfaceRoles: rolesBySurface,
    rolesBySurface,
    accounts: nextAccounts,
  };
}

function normalizeDraftMember(member, moduleCatalog) {
  return applyAccessDraftToMember(member, createAccessDraft(member, moduleCatalog), moduleCatalog);
}

function createSnapshot(member) {
  const accessDraft = member?.accessDraft || {};
  const selectedKeys = [...asArray(accessDraft.selectedModuleKeys)].sort();
  const permissionsByModule = Object.fromEntries(selectedKeys.map((moduleKey) => [
    moduleKey,
    [...asArray(accessDraft.permissionsByModule?.[moduleKey])].sort(),
  ]));

  return {
    loginName: getLoginName(member),
    displayName: String(member?.displayName || member?.name || "").trim(),
    isActive: isActiveStatus(member?.status),
    usage: accessDraft.usage || "",
    surface: accessDraft.surface || "",
    selectedModuleKeys: selectedKeys.join("||"),
    permissionsByModule: JSON.stringify(permissionsByModule),
  };
}

function hasSnapshotChanges(left, right) {
  return Object.keys(left).some((key) => left[key] !== right[key]);
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
    accounts: nextAccounts,
  };
}

function buildProfilePayload(member, moduleCatalog) {
  const accessDraft = member?.accessDraft || {};
  const moduleAccess = buildNewMemberModuleAccess(accessDraft, moduleCatalog);
  const roles = getNewMemberSelectedRoles(accessDraft);

  return {
    loginName: getLoginName(member),
    displayName: String(member?.displayName || member?.name || "").trim(),
    isActive: isActiveStatus(member?.status),
    usageLabels: accessDraft.usage ? [accessDraft.usage] : [],
    surfaceLabels: accessDraft.surface ? [accessDraft.surface] : [],
    rolesBySurface: accessDraft.surface ? { [accessDraft.surface]: roles } : {},
    moduleAccess,
  };
}

export default function MemberActionWindow({
  member,
  erasureReviewerAccountId = null,
  activeTab,
  token,
  moduleCatalog: availableModuleCatalog = [],
  moduleCatalogError = "",
  moduleCatalogLoading = false,
  onTabChange,
  onClose,
  onMemberChange,
  onMemberDelete,
}) {
  const fixedUsage = getFixedAccountUsage(member);
  const moduleCatalog = useMemo(
    () => getAccountModuleCatalog(availableModuleCatalog, fixedUsage),
    [availableModuleCatalog, fixedUsage],
  );
  const [draftMember, setDraftMember] = useState(() => normalizeDraftMember(member, moduleCatalog));
  const [savedSnapshot, setSavedSnapshot] = useState(() => createSnapshot(normalizeDraftMember(member, moduleCatalog)));
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [accessFooterAction, setAccessFooterAction] = useState(null);

  useEffect(() => {
    const nextDraftMember = normalizeDraftMember(member, moduleCatalog);

    setDraftMember(nextDraftMember);
    setSavedSnapshot(createSnapshot(nextDraftMember));
    setAccessFooterAction(null);
    setActionError("");
  }, [member, moduleCatalog]);

  useEffect(() => {
    if ((activeTab || "uebersicht") !== "zugang") setAccessFooterAction(null);
  }, [activeTab]);

  const loginName = getLoginName(draftMember);
  const bootstrapAdmin = isBootstrapAdminLoginName(loginName);
  const accessDraft = draftMember?.accessDraft || {};
  const selectedSurfaces = accessDraft.surface ? [accessDraft.surface] : [];
  const selectedUsages = accessDraft.usage ? [accessDraft.usage] : [];
  const selectedModules = useMemo(
    () => getSelectedNewMemberModules(accessDraft, moduleCatalog),
    [accessDraft, moduleCatalog],
  );
  const selectedRoles = getNewMemberSelectedRoles(accessDraft);
  const moduleSummaryLabel = selectedModules.map((module) => module.label).join(", ") || "—";
  const technicalApp = accessDraft.usage === TECHNICAL_USAGE && accessDraft.surface === APP_SURFACE;
  const roleSummaryTitle = technicalApp ? "Technische Oberfläche" : "Berechtigungen";
  const roleSummaryLabel = selectedRoles.join(", ") || "—";
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

  const updateAccessDraft = useCallback((updater) => {
    if (bootstrapAdmin) return;
    setActionError("");
    setDraftMember((currentMember) => {
      const currentAccessDraft = currentMember?.accessDraft || createAccessDraft(currentMember, moduleCatalog);
      const nextAccessDraft = typeof updater === "function" ? updater(currentAccessDraft) : updater;
      if (nextAccessDraft.usage !== fixedUsage || !getAccountSurfaces(fixedUsage).includes(nextAccessDraft.surface)) return currentMember;
      return applyAccessDraftToMember(currentMember, nextAccessDraft, moduleCatalog);
    });
  }, [bootstrapAdmin, fixedUsage, moduleCatalog]);

  const handleLoginNameChange = useCallback((nextLoginName) => {
    if (bootstrapAdmin) return;
    setDraftMember((currentMember) => updatePrimaryLoginName(currentMember, nextLoginName));
  }, [bootstrapAdmin]);

  const handleDisplayNameChange = useCallback((nextDisplayName) => {
    setDraftMember((currentMember) => ({
      ...currentMember,
      displayName: nextDisplayName,
      name: nextDisplayName || getLoginName(currentMember),
    }));
  }, []);

  const handleStatusToggle = useCallback(() => {
    if (bootstrapAdmin) return;
    setDraftMember((currentMember) => {
      const nextStatus = isActiveStatus(currentMember?.status) ? "Deaktiviert" : "Aktiviert";
      return { ...currentMember, status: nextStatus, statusTone: getStatusTone(nextStatus) };
    });
  }, [bootstrapAdmin]);

  const handleSurfaceSelect = useCallback((surface) => {
    if (!getAccountSurfaces(fixedUsage).includes(surface)) return;
    updateAccessDraft((currentDraft) => {
      const usage = fixedUsage;
      const availableModules = getNewMemberModulesForSurface(moduleCatalog, surface);
      const selectedModuleKeys = surface === CONTROL_CENTER_SURFACE && availableModules[0]
        ? [availableModules[0].key]
        : [];
      const permissionsByModule = Object.fromEntries(selectedModuleKeys.map((moduleKey) => {
        const module = getNewMemberModule(moduleCatalog, moduleKey);
        return [moduleKey, getNewMemberDefaultPermissions(module, usage)];
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
  }, [fixedUsage, moduleCatalog, updateAccessDraft]);

  const handleModuleToggle = useCallback((moduleKey) => {
    updateAccessDraft((currentDraft) => {
      const module = getNewMemberModule(moduleCatalog, moduleKey);
      if (!module) return currentDraft;

      const selectedKeys = asArray(currentDraft.selectedModuleKeys);
      const selected = selectedKeys.includes(moduleKey);
      if (selected && module.kind === "control-center") return currentDraft;
      if (currentDraft.usage === TECHNICAL_USAGE && currentDraft.surface === APP_SURFACE) {
        if (selected && selectedKeys.length === 1) return currentDraft;
        const permissions = asArray(currentDraft.permissionsByModule?.[moduleKey]);
        return { ...currentDraft, selectedModuleKeys: [moduleKey], permissionsByModule: { [moduleKey]: permissions }, roles: permissions };
      }

      const selectedModuleKeys = selected
        ? selectedKeys.filter((key) => key !== moduleKey)
        : [...selectedKeys, moduleKey];
      const permissionsByModule = { ...(currentDraft.permissionsByModule || {}) };

      if (selected) delete permissionsByModule[moduleKey];
      else permissionsByModule[moduleKey] = getNewMemberDefaultPermissions(module, currentDraft.usage || LOCAL_USAGE);

      return {
        ...currentDraft,
        selectedModuleKeys,
        permissionsByModule,
        roles: Object.values(permissionsByModule).flat(),
      };
    });
  }, [moduleCatalog, updateAccessDraft]);

  const handlePermissionToggle = useCallback((moduleKey, permission) => {
    updateAccessDraft((currentDraft) => {
      if (!getNewMemberModulePermissions(getNewMemberModule(moduleCatalog, moduleKey), fixedUsage).includes(permission)) return currentDraft;
      if (fixedUsage === TECHNICAL_USAGE && currentDraft.surface === APP_SURFACE) {
        return { ...currentDraft, selectedModuleKeys: [moduleKey], permissionsByModule: { [moduleKey]: [permission] }, roles: [permission] };
      }
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
  }, [fixedUsage, moduleCatalog, updateAccessDraft]);

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

    const profilePayload = buildProfilePayload(draftMember, moduleCatalog);
    const accessChanged = ["usage", "surface", "selectedModuleKeys", "permissionsByModule"]
      .some((key) => savedSnapshot[key] !== currentSnapshot[key]);
    if (accessChanged && !profilePayload.moduleAccess.length) {
      setActionError("Bitte zuerst eine installierte App, ein Add-on oder Plug-in auswählen.");
      onTabChange("uebersicht");
      return;
    }

    const assignmentWithoutPermission = profilePayload.moduleAccess.find((assignment) => !assignment.permissions.length);
    if (accessChanged && assignmentWithoutPermission) {
      setActionError(`Bitte unter Funktionen eine Berechtigung für „${assignmentWithoutPermission.moduleName}“ auswählen.`);
      onTabChange("funktionen");
      return;
    }
    if (!accessChanged) {
      delete profilePayload.moduleAccess;
      delete profilePayload.usageLabels;
      delete profilePayload.surfaceLabels;
      delete profilePayload.rolesBySurface;
    }

    const nextMember = { ...draftMember, statusTone: getStatusTone(draftMember?.status) };
    setActionBusy(true);
    setActionError("");

    try {
      await updateControlCenterLocalMemberProfile(token, accountId, profilePayload);
      onMemberChange?.(nextMember);
      setDraftMember(nextMember);
      setSavedSnapshot(createSnapshot(nextMember));
    } catch (error) {
      setActionError(error?.message || "Benutzer konnte nicht gespeichert werden.");
    } finally {
      setActionBusy(false);
    }
  }, [currentSnapshot, draftMember, getPrimaryAccountId, hasChanges, moduleCatalog, onClose, onMemberChange, onTabChange, savedSnapshot, token]);

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
      const nextMember = { ...currentMember, email: nextAccount.email || currentMember.email, accounts: nextAccounts };
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
            <span>{draftMember?.displayName || draftMember?.name || draftMember?.email || "—"}</span>
            <div className="cc-member-window__quickfacts">
              <small>Status</small>
              <button
                type="button"
                className={`cc-member-window__status-toggle cc-member-window__status-toggle--${getStatusTone(draftMember?.status)}`}
                onClick={handleStatusToggle}
                disabled={bootstrapAdmin}
                title={bootstrapAdmin ? "Der feste Systembenutzer admin muss aktiv bleiben." : undefined}
                aria-label={isActiveStatus(draftMember?.status) ? "Benutzer deaktivieren" : "Benutzer aktivieren"}
              >
                {getStatusActionLabel(draftMember?.status)}
              </button>
              <small>Oberfläche</small>
              <b>{selectedSurfaces.join(", ") || "—"}</b>
              <small>Verwendung</small>
              <b>{selectedUsages.join(", ") || "—"}</b>
              <small>Modul</small>
              <b>{moduleSummaryLabel}</b>
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
              {tab === "uebersicht" || tab === "verwendung" ? (
                <OverviewTab
                  title={tab === "verwendung" ? "Verwendung" : "Übersicht"}
                  showIdentityFields={tab !== "verwendung"}
                  member={draftMember}
                  draft={accessDraft}
                  moduleCatalog={moduleCatalog}
                  moduleCatalogError={moduleCatalogError}
                  moduleCatalogLoading={moduleCatalogLoading}
                  onDisplayNameChange={handleDisplayNameChange}
                  onLoginNameChange={handleLoginNameChange}
                  onModuleToggle={handleModuleToggle}
                  onSurfaceSelect={handleSurfaceSelect}
                  bootstrapAdmin={bootstrapAdmin}
                />
              ) : null}
              {tab === "zugang" ? (
                <AccessTab
                  member={draftMember}
                  erasureReviewerAccountId={erasureReviewerAccountId}
                  token={token}
                  onAccountChange={handleAccountChange}
                  onDeleted={handleMemberDeleted}
                  onBusyChange={setActionBusy}
                  onFooterActionChange={setAccessFooterAction}
                  bootstrapAdmin={bootstrapAdmin}
                />
              ) : null}
              {tab === "funktionen" ? (
                <FunctionsTab
                  draft={accessDraft}
                  moduleCatalog={moduleCatalog}
                  onPermissionToggle={handlePermissionToggle}
                />
              ) : null}
              {tab === "sessions" ? <SessionsTab member={draftMember} /> : null}
              {tab === "two-factor" ? <AdminEnrollmentPanel token={token} member={draftMember} /> : null}
              {tab === "nfc" ? <NfcTagsPanel key={draftMember.memberId || draftMember.id} token={token} member={draftMember} /> : null}
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
