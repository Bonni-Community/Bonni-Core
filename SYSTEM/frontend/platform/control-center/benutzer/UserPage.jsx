import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createControlCenterLocalMember,
  fetchControlCenterUsers,
} from "../../../system/api/controlCenterUsersApi.js";
import { fetchControlCenterModules } from "../../../system/api/moduleControlApi.js";
import MemberActionWindow from "./window/member/MemberActionWindow.jsx";
import NewMemberWindow from "./window/new-member/NewMemberWindow.jsx";
import {
  buildNewMemberModuleAccess,
  buildNewMemberModuleCatalog,
  cleanNewMemberLoginName,
  createEmptyNewMemberDraft,
  getSelectedModulePermissions,
  getSelectedNewMemberModules,
  isTechnicalOnlySurface,
  isValidEmail,
} from "./window/new-member/newMemberWindowUtils.js";

const EMPTY_DATA = {
  ok: false,
  stats: {
    members: 0,
    activeMembers: 0,
    accounts: 0,
    activeAccounts: 0,
    activeSessions: 0,
    terminalSessions: 0,
    roles: 0,
    invitations: 0,
    technicalAccounts: 0,
    localAccounts: 0,
    oidcAccounts: 0,
    oidcActive: false,
    oidcLastUpdatedAt: null,
  },
  filters: {
    roles: [],
    statuses: ["Aktiviert", "Deaktiviert"],
  },
  members: [],
  users: [],
};

function percent(active, total) {
  if (!total) return "0 %";
  return `${Math.round((active / total) * 100)} %`;
}

function countAccountsByUsage(data, usageName) {
  const normalizedUsageName = String(usageName || "").toLowerCase();
  return getRows(data).reduce((sum, member) => (
    sum + getAccountList(member).filter((account) => {
      const usageLabels = [
        account.usageLabel,
        ...asArray(account.usageLabels),
      ].filter(Boolean).map((label) => String(label).toLowerCase());

      return usageLabels.some((label) => label.includes(normalizedUsageName));
    }).length
  ), 0);
}

function countTechnicalRows(data) {
  return getRows(data).filter((member) => {
    const usageLabels = getUsageLabels(member).map((label) => String(label).toLowerCase());
    return member.technicalOnly || usageLabels.some((label) => label.includes("techn"));
  }).length;
}

function formatShortDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function buildStats(data) {
  const stats = data?.stats || EMPTY_DATA.stats;
  const members = stats.members ?? stats.total ?? 0;
  const technicalAccounts = stats.technicalAccounts ?? countTechnicalRows(data);
  const localAccounts = stats.localAccounts ?? countAccountsByUsage(data, "lokal");
  const oidcAccounts = stats.oidcAccounts ?? countAccountsByUsage(data, "oidc");
  const oidcActive = oidcAccounts > 0 || Boolean(stats.oidcActive);
  const oidcUpdatedAt = stats.oidcLastUpdatedAt || stats.oidcLastSyncAt || data?.checkedAt;

  return [
    {
      key: "members",
      icon: "👥",
      label: "Mitglieder gesamt",
      value: String(members),
      helper: "Gesamt",
      tone: "orange",
    },
    {
      key: "technical-members",
      icon: "⚙",
      label: "Technische Mitglieder",
      value: String(technicalAccounts || 0),
      helper: "technisch",
      tone: "green",
    },
    {
      key: "local-accounts",
      icon: "▣",
      label: "Lokale Zugänge",
      value: String(localAccounts || 0),
      helper: "Lokal",
      tone: "purple",
    },
    {
      key: "oidc-accounts",
      icon: "⌁",
      label: "OIDC-Zugänge",
      value: String(oidcAccounts || 0),
      helper: oidcActive ? "aktiv" : "inaktiv",
      tone: "blue",
    },
    {
      key: "oidc-refresh",
      icon: "↻",
      label: "OIDC-Aktualisierung",
      value: oidcActive ? formatShortDateTime(oidcUpdatedAt) : "Inaktiv",
      helper: oidcActive ? "letzte Prüfung" : "nicht aktiv",
      tone: "amber",
    },
  ];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getRows(data) {
  if (Array.isArray(data?.members)) return data.members;
  if (Array.isArray(data?.users)) return data.users;
  return [];
}

function getAccountList(member) {
  return asArray(member.accounts);
}

function getPrimaryAccount(member) {
  const accounts = getAccountList(member);
  return accounts.find((account) => account.isActive) || accounts[0] || null;
}

function normalizeUserAccountStatus(member) {
  const account = getPrimaryAccount(member);
  const legacyStatus = String(member?.status || "").trim().toLowerCase();
  const isActive = account
    ? Boolean(account.isActive)
    : ["aktiv", "active", "aktiviert", "enabled"].includes(legacyStatus);

  return {
    ...member,
    status: isActive ? "Aktiviert" : "Deaktiviert",
    statusTone: isActive ? "active" : "inactive",
  };
}

function getMemberIdentity(member) {
  return member?.id || member?.memberId || member?.personId || member?.email || getLoginName(member);
}

function getLoginName(member) {
  const primary = getPrimaryAccount(member);
  return primary?.loginName || member.loginName || member.name || member.displayName || "—";
}


const CONTROL_CENTER_SURFACE = "Control Center";
const APP_SURFACE = "App";
const ADD_ON_SURFACE = "Add-on";
const PLUG_IN_SURFACE = "Plug-in";
const LOCAL_USAGE = "Lokal";
const TECHNICAL_USAGE = "Technischer Account";

function normalizeSurfaceName(label) {
  const value = String(label || "").trim();
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!normalized) return null;

  if (
    normalized.includes("control") ||
    normalized.includes("adminbereich") ||
    normalized === "admin" ||
    normalized.includes("administrator")
  ) {
    return CONTROL_CENTER_SURFACE;
  }

  if (
    normalized.includes("add-on") ||
    normalized.includes("addon") ||
    normalized.includes("hocket") ||
    normalized.includes("hock")
  ) {
    return ADD_ON_SURFACE;
  }

  if (
    normalized.includes("plug-in") ||
    normalized.includes("plugin") ||
    normalized.includes("verein") ||
    normalized.includes("mitgliedsbereich")
  ) {
    return PLUG_IN_SURFACE;
  }

  if (
    normalized.includes("stubel") ||
    normalized.includes("stuebel") ||
    normalized.includes("app") ||
    normalized.includes("stüberl") ||
    normalized.includes("member") ||
    normalized.includes("manager") ||
    normalized.includes("storeman") ||
    normalized.includes("treasurer") ||
    normalized.includes("bar") ||
    normalized.includes("kuche") ||
    normalized.includes("kueche") ||
    normalized.includes("kuch") ||
    normalized.includes("tisch") ||
    normalized.includes("finanz") ||
    normalized.includes("lager") ||
    normalized.includes("store") ||
    normalized.includes("treasurer") ||
    normalized.includes("barkeeper") ||
    normalized.includes("koch")
  ) {
    return APP_SURFACE;
  }

  return null;
}

function getSurfaceLabels(member) {
  const rawLabels = [
    ...asArray(member.terminalLabels),
    ...asArray(member.surfaceLabels),
    ...asArray(member.accessLabels),
    ...asArray(member.roles),
    member.role,
    ...getAccountList(member).flatMap((account) => [
      ...asArray(account.terminalLabels),
      ...asArray(account.surfaceLabels),
      ...asArray(account.accessLabels),
      ...asArray(account.roles),
      ...asArray(account.capabilities),
      account.type,
      account.providerType,
      account.providerKey,
      account.usageLabel,
    ]),
  ].filter(Boolean);

  const normalizedLabels = rawLabels.map(normalizeSurfaceName).filter(Boolean);

  return [...new Set(normalizedLabels)];
}

function getRoleFromSurfacePrefix(label) {
  const text = String(label || "").trim();
  if (!text.includes(":")) return null;

  const matchingSurface = [
    CONTROL_CENTER_SURFACE,
    APP_SURFACE,
    ADD_ON_SURFACE,
    PLUG_IN_SURFACE,
  ].find((surface) => text.startsWith(`${surface}:`));

  if (!matchingSurface) return null;

  return {
    surface: matchingSurface,
    role: text.slice(matchingSurface.length + 1).trim(),
  };
}

function isSurfaceOnlyLabel(label) {
  const text = String(label || "").trim();
  return Boolean(text && normalizeSurfaceName(text) === text);
}

function addRoleOption(roleMap, surface, role) {
  const normalizedSurface = normalizeSurfaceName(surface) || surface;
  const roles = Array.isArray(role) ? role : [role];

  if (!roleMap[normalizedSurface]) return;

  roles
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .forEach((cleanRole) => roleMap[normalizedSurface].add(cleanRole));
}

function addRoleLabel(roleMap, label, targetSurfaces = []) {
  const text = String(label || "").trim();
  if (!text) return;

  const prefixedRole = getRoleFromSurfacePrefix(text);
  if (prefixedRole) {
    addRoleOption(roleMap, prefixedRole.surface, prefixedRole.role);
    return;
  }

  if (isSurfaceOnlyLabel(text)) return;

  const surfaces = targetSurfaces.length
    ? targetSurfaces
    : [CONTROL_CENTER_SURFACE, APP_SURFACE, ADD_ON_SURFACE, PLUG_IN_SURFACE];

  surfaces.forEach((surface) => addRoleOption(roleMap, surface, text));
}

function buildAvailableSurfaceRoles(rows, globalRoles) {
  const roleMap = {
    [CONTROL_CENTER_SURFACE]: new Set(),
    [APP_SURFACE]: new Set(),
    [ADD_ON_SURFACE]: new Set(),
    [PLUG_IN_SURFACE]: new Set(),
  };

  asArray(globalRoles).forEach((role) => addRoleLabel(roleMap, role));

  rows.forEach((member) => {
    const memberSurfaces = getSurfaceLabels(member);
    const rawSurfaceRoles = member.surfaceRoles || member.rolesBySurface || {};

    if (rawSurfaceRoles && typeof rawSurfaceRoles === "object" && !Array.isArray(rawSurfaceRoles)) {
      Object.entries(rawSurfaceRoles).forEach(([surface, role]) => addRoleOption(roleMap, surface, role));
    }

    [
      ...asArray(member.accessLabels),
      ...asArray(member.roles),
      member.role,
      ...getAccountList(member).flatMap((account) => [
        ...asArray(account.roles),
        ...asArray(account.accessLabels),
        ...asArray(account.capabilities),
      ]),
    ].forEach((role) => addRoleLabel(roleMap, role, memberSurfaces));
  });

  return Object.fromEntries(
    Object.entries(roleMap).map(([surface, roles]) => [
      surface,
      [...roles].sort((left, right) => left.localeCompare(right, "de")),
    ]),
  );
}

function normalizeUsageName(label) {
  const value = String(label || "").trim();
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!normalized) return null;
  if (normalized.includes("lokal") || normalized.includes("local")) return LOCAL_USAGE;
  if (normalized.includes("techn") || normalized.includes("technical")) return TECHNICAL_USAGE;

  return value;
}

function getUsageLabels(member) {
  const hasMemberUsageLabels = Array.isArray(member.usageLabels);
  const memberUsageLabels = asArray(member.usageLabels).map(normalizeUsageName).filter(Boolean);
  const accountUsageLabels = getAccountList(member)
    .flatMap((account) => [account.usageLabel, ...asArray(account.usageLabels)])
    .map(normalizeUsageName)
    .filter(Boolean);
  const labels = hasMemberUsageLabels ? memberUsageLabels : accountUsageLabels;

  if (member.technicalOnly && !labels.includes(TECHNICAL_USAGE)) {
    labels.unshift(TECHNICAL_USAGE);
  }

  return [...new Set(labels)];
}

function memberMatches(member, search, roleFilter, statusFilter) {
  const query = search.trim().toLowerCase();
  const roles = asArray(member.roles).length ? member.roles : asArray(member.accessLabels);
  const accounts = getAccountList(member);
  const roleMatches = roleFilter === "all" || roles.includes(roleFilter) || member.role === roleFilter;
  const statusMatches = statusFilter === "all" || member.status === statusFilter;

  if (!roleMatches || !statusMatches) return false;
  if (!query) return true;

  return [
    member.memberId,
    member.memberNumber,
    member.personId,
    member.name,
    member.displayName,
    member.email,
    member.status,
    member.role,
    ...roles,
    ...getSurfaceLabels(member),
    ...getUsageLabels(member),
    ...accounts.flatMap((account) => [
      account.accountId,
      account.loginName,
      account.email,
      account.type,
      account.providerType,
      account.providerKey,
      account.usageLabel,
      ...asArray(account.roles),
      ...asArray(account.capabilities),
      ...asArray(account.accessLabels),
      ...asArray(account.surfaceLabels),
      ...asArray(account.terminalLabels),
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function normaliseData(payload) {
  if (!payload || typeof payload !== "object") return EMPTY_DATA;

  const rows = (Array.isArray(payload.members)
    ? payload.members
    : Array.isArray(payload.users)
      ? payload.users
      : []).map(normalizeUserAccountStatus);

  return {
    ...EMPTY_DATA,
    ...payload,
    stats: {
      ...EMPTY_DATA.stats,
      ...(payload.stats || {}),
    },
    filters: {
      ...EMPTY_DATA.filters,
      ...(payload.filters || {}),
      statuses: ["Aktiviert", "Deaktiviert"],
    },
    members: rows,
    users: rows,
  };
}

function getCreateMemberErrorMessage(error) {
  const code = error?.code || error?.data?.code;

  if (code === "LOCAL_MEMBER_ALREADY_EXISTS") {
    return "Dieser Loginname existiert bereits.";
  }

  if (code === "LOCAL_MEMBER_PASSWORD_TOO_SHORT") {
    return "Das Passwort muss mindestens 6 Zeichen haben.";
  }

  if (code === "LOCAL_MEMBER_EMAIL_INVALID") {
    return "Bitte eine gültige E-Mail-Adresse eingeben.";
  }

  if (code === "LOCAL_MEMBER_LOGIN_REQUIRED") {
    return "Bitte einen Loginnamen eingeben.";
  }

  if (code === "LOCAL_MEMBER_DISPLAY_NAME_REQUIRED") {
    return "Bitte einen Anzeigenamen eingeben.";
  }

  if (code === "LOCAL_MEMBER_LOGIN_INVALID") {
    return "Der Loginname darf nur Kleinbuchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.";
  }

  if (code === "LOCAL_MEMBER_ACCESS_REQUIRED") {
    return "Bitte mindestens ein Modul und eine Berechtigung auswählen.";
  }

  if (code === "USER_MANAGEMENT_FORBIDDEN") {
    return "Für die Benutzerverwaltung fehlt die Berechtigung.";
  }

  return error?.message || "Mitglied konnte nicht erstellt werden.";
}

const ROLE_LABELS = {
  admin: "Administrator",
  administrator: "Administrator",
  member: "Member",
  manager: "Manager",
  storeman: "Storeman",
  treasurer: "Treasurer",
  helper: "Helper",
  bar: "Bar",
  barkeeper: "Bar",
  kitchen: "Küche",
  kueche: "Küche",
  kuche: "Küche",
  koch: "Küche",
  table: "Tisch",
  tablebs: "Tisch",
  tisch: "Tisch",
  terminal: "Tisch",
  fenster: "Tisch",
};

const ROLE_ORDER = ["Administrator", "Member", "Manager", "Storeman", "Treasurer", "Helper", "Bar", "Küche", "Tisch"];

function formatRoleLabel(label) {
  const value = String(label || "").trim();
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return ROLE_LABELS[normalized] || value;
}

function orderRoleLabels(labels) {
  return [...new Set(asArray(labels).map(formatRoleLabel).filter(Boolean))].sort((left, right) => {
    const leftIndex = ROLE_ORDER.indexOf(left);
    const rightIndex = ROLE_ORDER.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
    }

    return left.localeCompare(right, "de");
  });
}

function ChipList({ labels, empty = "—", variant = "gray" }) {
  const formattedLabels = orderRoleLabels(labels);
  const visibleLabels = formattedLabels.slice(0, 4);
  const hiddenCount = Math.max(0, formattedLabels.length - visibleLabels.length);

  if (!visibleLabels.length) {
    return <span className="cc-member-muted">{empty}</span>;
  }

  return (
    <div className="cc-member-chip-list">
      {visibleLabels.map((label) => (
        <span key={label} className={`cc-member-role cc-member-role--${variant}`}>{label}</span>
      ))}
      {hiddenCount ? <span className="cc-member-role cc-member-role--gray">+{hiddenCount}</span> : null}
    </div>
  );
}

function UsageLabels({ labels }) {
  const visibleLabels = asArray(labels).slice(0, 3);
  const hiddenCount = Math.max(0, asArray(labels).length - visibleLabels.length);

  if (!visibleLabels.length) {
    return <span className="cc-member-muted">—</span>;
  }

  return (
    <div className="cc-member-usage-list">
      {visibleLabels.map((label) => {
        const normalized = String(label).toLowerCase();
        const tone = normalized.includes("oidc")
          ? "purple"
          : normalized.includes("lokal")
            ? "green"
            : normalized.includes("techn")
              ? "orange"
              : "gray";

        return <span key={label} className={`cc-member-usage-chip cc-member-usage-chip--${tone}`}>{label}</span>;
      })}
      {hiddenCount ? <span className="cc-member-usage-chip cc-member-usage-chip--gray">+{hiddenCount}</span> : null}
    </div>
  );
}

function SurfaceLabels({ labels }) {
  const visibleLabels = asArray(labels).slice(0, 4);
  const hiddenCount = Math.max(0, asArray(labels).length - visibleLabels.length);

  if (!visibleLabels.length) {
    return <span className="cc-member-muted">Keine Oberfläche</span>;
  }

  return (
    <div className="cc-member-surface-list">
      {visibleLabels.map((label) => <span key={label} className="cc-member-surface-chip">{label}</span>)}
      {hiddenCount ? <span className="cc-member-surface-chip cc-member-surface-chip--more">+{hiddenCount}</span> : null}
    </div>
  );
}

function LoginCell({ member }) {
  const loginName = getLoginName(member);

  return (
    <div className="cc-member-login-cell cc-member-login-cell--plain">
      <strong>{loginName}</strong>
      <small>{member.name && member.name !== loginName ? member.name : member.email || "—"}</small>
    </div>
  );
}


function buildCreateMemberPayloadFromDraft(draft, moduleCatalog) {
  const loginName = cleanNewMemberLoginName(draft.loginName);
  const displayName = String(draft.displayName || "").trim() || loginName;
  const moduleAccess = buildNewMemberModuleAccess(draft, moduleCatalog);
  const roles = [...new Set(moduleAccess.flatMap((assignment) => assignment.permissions))];

  return {
    loginName,
    displayName,
    email: String(draft.email || "").trim().toLowerCase() || null,
    password: String(draft.password || ""),
    usage: draft.usage,
    surface: draft.surface,
    moduleAccess,
    roles,
    isEmergencyUser: false,
  };
}

function validateNewMemberDraft(draft, moduleCatalog) {
  const loginName = cleanNewMemberLoginName(draft.loginName);

  if (!loginName) return "Bitte einen Loginnamen eingeben.";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(loginName)) return "Der Loginname enthält ungültige Zeichen.";
  if (!isValidEmail(String(draft.email || "").trim())) return "Bitte eine gültige E-Mail-Adresse eingeben.";
  if (!String(draft.password || "")) return "Bitte ein Startpasswort eingeben.";
  if (String(draft.password || "").length < 6) return "Das Passwort muss mindestens 6 Zeichen haben.";
  if (String(draft.password || "") !== String(draft.passwordRepeat || "")) return "Die Passwort-Wiederholung stimmt nicht überein.";
  if (!draft.usage) return "Bitte eine Verwendung auswählen.";
  if (!draft.surface) return "Bitte eine Oberfläche auswählen.";
  if (isTechnicalOnlySurface(draft.surface) && draft.usage !== TECHNICAL_USAGE) {
    return "Add-on- und Plug-in-Zugänge müssen technische Accounts sein.";
  }

  const selectedModules = getSelectedNewMemberModules(draft, moduleCatalog);
  if (!selectedModules.length) {
    return `Bitte mindestens ${draft.surface === APP_SURFACE ? "eine App" : "ein Modul"} auswählen.`;
  }

  const moduleWithoutPermission = selectedModules.find((module) => (
    !getSelectedModulePermissions(draft, module.key).length
  ));
  if (moduleWithoutPermission) {
    return `Bitte unter Funktionen eine Berechtigung für „${moduleWithoutPermission.label}“ auswählen.`;
  }

  return "";
}


function getNewMemberValidationTab(message) {
  if (!message) return "uebersicht";
  if (message.includes("Passwort") || message.includes("E-Mail")) return "zugang";
  if (message.includes("Funktionen") || message.includes("Berechtigung")) return "funktionen";
  return "uebersicht";
}

export default function UserPage({ token }) {
  const [data, setData] = useState(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedMember, setSelectedMember] = useState(null);
  const [actionTab, setActionTab] = useState("uebersicht");
  const [creatingMember, setCreatingMember] = useState(false);
  const [newMemberOpen, setNewMemberOpen] = useState(false);
  const [newMemberTab, setNewMemberTab] = useState("uebersicht");
  const [newMemberDraft, setNewMemberDraft] = useState(() => createEmptyNewMemberDraft());
  const [newMemberError, setNewMemberError] = useState("");
  const [moduleCatalog, setModuleCatalog] = useState(() => buildNewMemberModuleCatalog([]));
  const [moduleCatalogLoading, setModuleCatalogLoading] = useState(false);
  const [moduleCatalogError, setModuleCatalogError] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const payload = await fetchControlCenterUsers(token);
      const nextData = normaliseData(payload);
      setData(nextData);

      if (!nextData.ok) {
        setError(nextData.message || "Mitglieder- und Accountdaten konnten nicht geladen werden.");
      }
    } catch (loadError) {
      console.error("Control Center Mitglieder konnten nicht geladen werden", loadError);
      setData(EMPTY_DATA);
      setError(loadError?.message || "Mitglieder- und Accountdaten konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadModuleCatalog = useCallback(async () => {
    setModuleCatalogLoading(true);
    setModuleCatalogError("");

    try {
      const modulePackages = await fetchControlCenterModules(token);
      setModuleCatalog(buildNewMemberModuleCatalog(modulePackages));
    } catch (loadError) {
      console.error("Modulkatalog für Benutzerzugänge konnte nicht geladen werden", loadError);
      setModuleCatalog(buildNewMemberModuleCatalog([]));
      setModuleCatalogError("Die Manifeste der installierten Apps konnten nicht geladen werden.");
    } finally {
      setModuleCatalogLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadUsers();
    const refresh = window.setInterval(loadUsers, 30_000);

    return () => window.clearInterval(refresh);
  }, [loadUsers]);

  useEffect(() => {
    loadModuleCatalog();
  }, [loadModuleCatalog]);

  const rows = useMemo(() => getRows(data), [data]);
  const stats = useMemo(() => buildStats(data), [data]);
  const availableRoles = useMemo(() => {
    const rolesFromApi = Array.isArray(data.filters?.roles) ? data.filters.roles : [];
    const rolesFromRows = rows.flatMap((member) =>
      asArray(member.roles).length ? member.roles : asArray(member.accessLabels)
    );

    return [...new Set([...rolesFromApi, ...rolesFromRows].filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "de"));
  }, [data, rows]);

  const availableSurfaceRoles = useMemo(
    () => buildAvailableSurfaceRoles(rows, availableRoles),
    [availableRoles, rows],
  );

  const availableStatuses = useMemo(() => {
    const statusesFromApi = Array.isArray(data.filters?.statuses) ? data.filters.statuses : [];
    const statusesFromRows = rows.map((member) => member.status);

    return [...new Set([...statusesFromApi, ...statusesFromRows].filter(Boolean))];
  }, [data, rows]);

  const visibleRows = useMemo(
    () => rows.filter((member) => memberMatches(member, search, roleFilter, statusFilter)),
    [rows, roleFilter, search, statusFilter],
  );

  const handleAddMember = useCallback(() => {
    setNewMemberDraft(createEmptyNewMemberDraft());
    setNewMemberTab("uebersicht");
    setNewMemberError("");
    setError("");
    setNewMemberOpen(true);
    loadModuleCatalog();
  }, [loadModuleCatalog]);

  const handleCloseNewMember = useCallback(() => {
    if (creatingMember) return;

    setNewMemberOpen(false);
    setNewMemberError("");
  }, [creatingMember]);

  const handleCreateMember = useCallback(async () => {
    if (creatingMember) return;

    const validationMessage = validateNewMemberDraft(newMemberDraft, moduleCatalog);
    if (validationMessage) {
      setNewMemberError(validationMessage);
      setNewMemberTab(getNewMemberValidationTab(validationMessage));
      return;
    }

    const payload = buildCreateMemberPayloadFromDraft(newMemberDraft, moduleCatalog);

    setCreatingMember(true);
    setNewMemberError("");
    setError("");

    try {
      await createControlCenterLocalMember(token, payload);
      await loadUsers();
      setSearch(payload.loginName);
      setNewMemberOpen(false);
      setNewMemberDraft(createEmptyNewMemberDraft());
    } catch (createError) {
      console.error("Mitglied konnte nicht erstellt werden", createError);
      const message = getCreateMemberErrorMessage(createError);
      setNewMemberError(message);
      setNewMemberTab(getNewMemberValidationTab(message));
    } finally {
      setCreatingMember(false);
    }
  }, [creatingMember, loadUsers, moduleCatalog, newMemberDraft, token]);

  const openMemberAction = useCallback((member, nextTab = "uebersicht") => {
    setSelectedMember(member);
    setActionTab(nextTab);
  }, []);

  const closeMemberAction = useCallback(() => {
    setSelectedMember(null);
  }, []);

  const handleMemberChange = useCallback((nextMember) => {
    const selectedKey = getMemberIdentity(selectedMember);

    setData((currentData) => {
      const nextRows = getRows(currentData).map((row) => (
        getMemberIdentity(row) === selectedKey ? nextMember : row
      ));

      return {
        ...currentData,
        members: nextRows,
        users: nextRows,
      };
    });

    setSelectedMember(nextMember);
  }, [selectedMember]);


  const handleMemberDelete = useCallback((deletedMember) => {
    const deletedKey = getMemberIdentity(deletedMember || selectedMember);

    setData((currentData) => {
      const nextRows = getRows(currentData).filter((row) => getMemberIdentity(row) !== deletedKey);

      return {
        ...currentData,
        members: nextRows,
        users: nextRows,
      };
    });

    setSelectedMember(null);
    loadUsers();
  }, [loadUsers, selectedMember]);

  return (
    <section className="cc-user-page">
      <div className="cc-user-page__header cc-user-page__header--with-action">
        <div>
          <h1>Benutzer</h1>
          <p>Live-Übersicht aller Mitglieder und Zugänge. Vorne steht der Benutzer.</p>
        </div>
        <button
          type="button"
          className="cc-user-primary-button"
          onClick={handleAddMember}
          disabled={creatingMember || loading}
        >
          {creatingMember ? "Erstelle..." : "+ Mitglied hinzufügen"}
        </button>
      </div>

      <div className="cc-user-stats" aria-label="Benutzer Status">
        {stats.map((stat) => (
          <article key={stat.key} className={`cc-user-stat cc-user-stat--${stat.tone}`}>
            <div className="cc-user-stat__icon" aria-hidden="true">{stat.icon}</div>
            <div>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.helper}</small>
            </div>
          </article>
        ))}
      </div>

      <section className="cc-user-panel cc-member-panel" aria-label="Mitgliederverwaltung">
        <div className="cc-user-panel__header cc-member-panel__header">
          <div>
            <h2>Mitgliederverwaltung</h2>
            <p>Status · Benutzer · letzte Anmeldung · Oberfläche · Verwendung · Funktion · Aktion.</p>
          </div>
          <div className="cc-member-toolbar" aria-label="Mitglieder filtern">
            <label className="cc-member-search">
              <span className="sr-only">Suche</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Suche Benutzer, Rolle, Oberfläche..."
              />
            </label>

            <label>
              <span className="sr-only">Rolle auswählen</span>
              <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                <option value="all">Alle Rollen</option>
                {availableRoles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>

            <label>
              <span className="sr-only">Status auswählen</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="all">Alle Status</option>
                {availableStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>

            <button type="button" onClick={loadUsers} disabled={loading}>
              {loading ? "Lädt..." : "↻ Aktualisieren"}
            </button>
          </div>
        </div>

        {error ? <div className="cc-member-error" role="status">{error}</div> : null}

        <div className="cc-member-table-wrap">
          <table className="cc-member-table cc-member-table--member-account cc-member-table--login-first">
            <thead>
              <tr>
                <th>Status</th>
                <th>Benutzer</th>
                <th>Letzte Anmeldung</th>
                <th>Oberfläche</th>
                <th>Verwendung</th>
                <th>Funktion</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((member, index) => (
                <tr
                  key={member.id || member.memberId || `${member.name}-${index}`}
                  className="cc-member-row--clickable"
                  tabIndex={0}
                  title="Doppelklick öffnet die Aktionen"
                  onDoubleClick={() => openMemberAction(member)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openMemberAction(member);
                  }}
                >
                  <td>
                    <span className={`cc-member-status cc-member-status--${member.statusTone || "inactive"}`}>
                      {member.status || "Unbekannt"}
                    </span>
                  </td>
                  <td><LoginCell member={member} /></td>
                  <td>{formatDate(member.lastLoginAt)}</td>
                  <td><SurfaceLabels labels={getSurfaceLabels(member)} /></td>
                  <td><UsageLabels labels={getUsageLabels(member)} /></td>
                  <td><ChipList labels={member.accessLabels || member.roles} empty="Ohne Funktion" /></td>
                  <td>
                    <button
                      type="button"
                      className="cc-member-action"
                      aria-label={`${getLoginName(member)} Aktionen öffnen`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openMemberAction(member);
                      }}
                    >
                      •••
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && visibleRows.length === 0 ? (
                <tr>
                  <td colSpan="7" className="cc-member-empty">Keine Mitglieder gefunden.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="cc-member-footer">
          <span>
            Zeige {visibleRows.length ? `1 bis ${visibleRows.length}` : "0"} von {rows.length} Mitgliedern
          </span>
          <span>Live-Aktualisierung alle 30 Sekunden</span>
          <label className="cc-member-page-size">
            <span>Zeige</span>
            <select defaultValue="10" disabled>
              <option>10</option>
              <option>25</option>
              <option>50</option>
            </select>
            <span>pro Seite</span>
          </label>
        </div>
      </section>

      {newMemberOpen ? (
        <NewMemberWindow
          draft={newMemberDraft}
          activeTab={newMemberTab}
          creating={creatingMember}
          error={newMemberError}
          moduleCatalog={moduleCatalog}
          moduleCatalogError={moduleCatalogError}
          moduleCatalogLoading={moduleCatalogLoading}
          onTabChange={setNewMemberTab}
          onDraftChange={setNewMemberDraft}
          onCreate={handleCreateMember}
          onClose={handleCloseNewMember}
        />
      ) : null}

      {selectedMember ? (
        <MemberActionWindow
          member={selectedMember}
          activeTab={actionTab}
          availableSurfaceRoles={availableSurfaceRoles}
          moduleCatalog={moduleCatalog}
          moduleCatalogError={moduleCatalogError}
          moduleCatalogLoading={moduleCatalogLoading}
          token={token}
          onTabChange={setActionTab}
          onClose={closeMemberAction}
          onMemberChange={handleMemberChange}
          onMemberDelete={handleMemberDelete}
        />
      ) : null}
    </section>
  );
}
