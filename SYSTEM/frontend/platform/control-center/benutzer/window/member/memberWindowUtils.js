export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function getAccounts(member) {
  return asArray(member?.accounts);
}

export function getPrimaryAccount(member) {
  const accounts = getAccounts(member);
  return accounts.find((account) => account.isActive) || accounts[0] || null;
}

export function getLoginName(member) {
  const primary = getPrimaryAccount(member);
  return primary?.loginName || member?.loginName || member?.name || member?.displayName || "—";
}

export function formatDate(value) {
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

export const CONTROL_CENTER_SURFACE = "Control Center";
export const APP_SURFACE = "App";
export const ADD_ON_SURFACE = "Add-on";
export const PLUG_IN_SURFACE = "Plug-in";
export const LOCAL_USAGE = "Lokal";
export const TECHNICAL_USAGE = "Technischer Account";

export const AVAILABLE_MEMBER_SURFACES = [
  CONTROL_CENTER_SURFACE,
  APP_SURFACE,
  ADD_ON_SURFACE,
  PLUG_IN_SURFACE,
];

export const AVAILABLE_MEMBER_USAGES = [
  LOCAL_USAGE,
  TECHNICAL_USAGE,
];

const SURFACE_ROLE_OPTIONS = {
  [CONTROL_CENTER_SURFACE]: ["Administrator"],
  [APP_SURFACE]: [],
  [ADD_ON_SURFACE]: [],
  [PLUG_IN_SURFACE]: [],
};

const DEFAULT_SURFACE_ROLES = {
  [CONTROL_CENTER_SURFACE]: ["Administrator"],
  [APP_SURFACE]: [],
  [ADD_ON_SURFACE]: [],
  [PLUG_IN_SURFACE]: [],
};

const ROLE_LABELS = {
  admin: "Administrator",
  administrator: "Administrator",
};

const ROLE_ORDER = ["Administrator"];

export function formatMemberRoleLabel(label) {
  const value = String(label || "").trim();
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return ROLE_LABELS[normalized] || value;
}

function orderMemberRoles(labels) {
  return [...new Set(labels.map(formatMemberRoleLabel).filter(Boolean))].sort((left, right) => {
    const leftIndex = ROLE_ORDER.indexOf(left);
    const rightIndex = ROLE_ORDER.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
    }

    return left.localeCompare(right, "de");
  });
}

export function normalizeMemberRoleList(value) {
  const values = Array.isArray(value) ? value : [value];

  return orderMemberRoles(
    values
      .flatMap((entry) => (
        Array.isArray(entry) ? entry : [entry]
      ))
      .map((role) => String(role || "").trim())
      .filter(Boolean),
  );
}

export function getRoleOptionsForSurface(surface, usage) {
  const options = SURFACE_ROLE_OPTIONS[surface];

  if (Array.isArray(options)) return options;
  if (options && usage && Array.isArray(options[usage])) return options[usage];
  if (options && Array.isArray(options[LOCAL_USAGE])) return options[LOCAL_USAGE];

  return [];
}

export function getDefaultRolesForSurface(surface, usage) {
  const defaults = DEFAULT_SURFACE_ROLES[surface];

  if (Array.isArray(defaults)) return defaults;
  if (defaults && usage && Array.isArray(defaults[usage])) return defaults[usage];
  if (defaults && Array.isArray(defaults[LOCAL_USAGE])) return defaults[LOCAL_USAGE];

  return [];
}

export function usesSingleRoleSelection(surface, usage) {
  return surface === APP_SURFACE && usage === TECHNICAL_USAGE;
}

export function normalizeSurfaceName(label) {
  const value = String(label || "").trim();
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!normalized) return null;
  if (normalized.includes("control") || normalized.includes("adminbereich") || normalized === "admin" || normalized.includes("administrator")) return CONTROL_CENTER_SURFACE;
  if (normalized.includes("add-on") || normalized.includes("addon")) return ADD_ON_SURFACE;
  if (normalized.includes("plug-in") || normalized.includes("plugin")) return PLUG_IN_SURFACE;
  if (
    normalized === "app"
    || normalized.startsWith("app:")
    || normalized.startsWith("access:app:")
  ) return APP_SURFACE;

  return null;
}

function isSurfaceOnlyLabel(label) {
  const text = String(label || "").trim();
  return AVAILABLE_MEMBER_SURFACES.includes(text);
}

export function getSurfaceLabels(member) {
  const rawLabels = [
    ...asArray(member?.terminalLabels),
    ...asArray(member?.surfaceLabels),
    ...asArray(member?.accessLabels),
    ...asArray(member?.roles),
    member?.role,
    ...getAccounts(member).flatMap((account) => [
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

  const labels = rawLabels.map(normalizeSurfaceName).filter(Boolean);
  return [...new Set(labels)];
}

export function normalizeUsageName(label) {
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

export function getUsageLabels(member) {
  const hasMemberUsageLabels = Array.isArray(member?.usageLabels);
  const memberUsageLabels = asArray(member?.usageLabels).map(normalizeUsageName).filter(Boolean);
  const accountUsageLabels = getAccounts(member)
    .flatMap((account) => [account.usageLabel, ...asArray(account.usageLabels)])
    .map(normalizeUsageName)
    .filter(Boolean);
  const labels = hasMemberUsageLabels ? memberUsageLabels : accountUsageLabels;

  if (member?.technicalOnly && !labels.includes(TECHNICAL_USAGE)) labels.unshift(TECHNICAL_USAGE);
  return [...new Set(labels)];
}

function readSurfaceRoleMap(member) {
  const rawMap = member?.surfaceRoles || member?.rolesBySurface;
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return {};

  return Object.fromEntries(
    Object.entries(rawMap)
      .map(([surface, roles]) => [normalizeSurfaceName(surface) || surface, normalizeMemberRoleList(roles)])
      .filter(([surface]) => AVAILABLE_MEMBER_SURFACES.includes(surface)),
  );
}

function getRoleFromSurfacePrefix(label) {
  const text = String(label || "").trim();
  if (!text.includes(":")) return null;

  const matchingSurface = AVAILABLE_MEMBER_SURFACES.find((surface) => text.startsWith(`${surface}:`));
  if (!matchingSurface) return null;

  return {
    surface: matchingSurface,
    role: text.slice(matchingSurface.length + 1).trim(),
  };
}

function addSurfaceRole(surfaceRoles, surface, role) {
  const cleanRole = String(role || "").trim();
  if (!surface || !cleanRole) return;

  const currentRoles = normalizeMemberRoleList(surfaceRoles[surface]);
  if (!currentRoles.includes(cleanRole)) currentRoles.push(cleanRole);
  surfaceRoles[surface] = currentRoles;
}

export function getSurfaceRoles(member) {
  const surfaceRoles = readSurfaceRoleMap(member);
  const selectedSurfaces = getSurfaceLabels(member).filter((surface) => AVAILABLE_MEMBER_SURFACES.includes(surface));
  const labels = [
    ...asArray(member?.accessLabels),
    ...asArray(member?.roles),
    member?.role,
  ].filter(Boolean);
  const fallbackRoles = [];

  labels.forEach((label) => {
    const text = String(label || "").trim();
    if (!text || isSurfaceOnlyLabel(text)) return;

    const prefixedRole = getRoleFromSurfacePrefix(text);
    if (prefixedRole) {
      addSurfaceRole(surfaceRoles, prefixedRole.surface, prefixedRole.role);
      return;
    }

    const inferredSurface = normalizeSurfaceName(text);
    if (inferredSurface && selectedSurfaces.includes(inferredSurface)) {
      addSurfaceRole(surfaceRoles, inferredSurface, text);
      return;
    }

    fallbackRoles.push(text);
  });

  if (selectedSurfaces.length === 1) {
    fallbackRoles.forEach((role) => addSurfaceRole(surfaceRoles, selectedSurfaces[0], role));
  }

  selectedSurfaces.forEach((surface) => {
    if (surfaceRoles[surface] === undefined) surfaceRoles[surface] = [];
  });

  return surfaceRoles;
}

export function getRoleLabels(member) {
  const surfaceRoles = readSurfaceRoleMap(member);
  const labels = [
    ...asArray(member?.accessLabels),
    ...asArray(member?.roles),
    member?.role,
    ...Object.entries(surfaceRoles).flatMap(([surface, roles]) => (
      normalizeMemberRoleList(roles).map((role) => `${surface}: ${role}`)
    )),
    ...getAccounts(member).flatMap((account) => [
      ...asArray(account.roles),
      ...asArray(account.accessLabels),
      ...asArray(account.capabilities),
    ]),
  ].filter(Boolean);

  return orderMemberRoles(
    labels
      .map((label) => String(label || "").trim())
      .filter((label) => label && !isSurfaceOnlyLabel(label)),
  );
}

export function getSessionCount(member) {
  return Number(member?.activeSessionCount ?? member?.sessionsCount ?? member?.sessions ?? 0) || 0;
}

export function getTerminalSessionCount(member) {
  return Number(member?.terminalSessionCount ?? member?.terminalSessions ?? 0) || 0;
}
