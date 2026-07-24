export const CONTROL_CENTER_SURFACE = "Control Center";
export const APP_SURFACE = "App";
export const ADD_ON_SURFACE = "Add-on";
export const PLUG_IN_SURFACE = "Plug-in";
export const LOCAL_USAGE = "Lokal";
export const TECHNICAL_USAGE = "Technischer Account";

const SURFACE_TO_KIND = {
  [CONTROL_CENTER_SURFACE]: "control-center",
  [APP_SURFACE]: "app",
  [ADD_ON_SURFACE]: "add-on",
  [PLUG_IN_SURFACE]: "plug-in",
};

const DEFAULT_PERMISSIONS = {
  "control-center": {
    [LOCAL_USAGE]: ["Administrator"],
    [TECHNICAL_USAGE]: ["Administrator"],
  },
  app: {
    [LOCAL_USAGE]: ["Member", "Manager", "Storeman", "Treasurer"],
    [TECHNICAL_USAGE]: ["Barkeeper", "Member", "Terminal", "Küche"],
  },
  "add-on": {
    [LOCAL_USAGE]: [],
    [TECHNICAL_USAGE]: ["Zugriff"],
  },
  "plug-in": {
    [LOCAL_USAGE]: [],
    [TECHNICAL_USAGE]: ["Zugriff"],
  },
};

const INSTALLED_MODULE_STATUSES = new Set([
  "installed",
  "enabled",
  "disabled",
  "update_available",
  "update_failed",
  "error",
]);

const STATIC_MODULES = [
  {
    key: "control-center",
    kind: "control-center",
    surface: CONTROL_CENTER_SURFACE,
    label: "Control Center",
    description: "Administration und Systemverwaltung",
    installed: true,
    enabled: true,
  },
];

function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function slug(value, fallback = "modul") {
  const normalized = cleanText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeModuleKind(value) {
  const normalized = cleanText(value).toLowerCase().replace(/_/g, "-");

  if (["control-center", "controlcenter", "control"].includes(normalized)) return "control-center";
  if (normalized === "app") return "app";
  if (["add-on", "addon"].includes(normalized)) return "add-on";
  if (["plug-in", "plugin"].includes(normalized)) return "plug-in";

  return null;
}

function surfaceForKind(kind) {
  return Object.entries(SURFACE_TO_KIND).find(([, value]) => value === kind)?.[0] || "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function permissionLabel(value) {
  if (typeof value === "string" || typeof value === "number") return cleanText(value);
  if (!value || typeof value !== "object") return "";
  return cleanText(value.label || value.name || value.key || value.id);
}

function permissionList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  return [...new Set(source.map(permissionLabel).filter(Boolean))];
}

function firstPermissionList(sources) {
  for (const source of sources) {
    const permissions = permissionList(source);
    if (permissions.length) return permissions;
  }
  return [];
}

function usagePermissions(modulePackage, kind, usage) {
  const manifest = {
    ...asObject(modulePackage?.manifest),
    ...asObject(modulePackage?.manifestJson),
  };
  const metadata = {
    ...asObject(manifest.metadata),
    ...asObject(modulePackage?.metadata),
  };
  const accessGroups = [
    asObject(metadata.accessPermissions),
    asObject(metadata.permissionsByUsage),
    asObject(metadata.functionsByUsage),
    asObject(metadata.rolesByUsage),
    asObject(metadata.surfacesByUsage),
    asObject(modulePackage?.accessPermissions),
    asObject(modulePackage?.permissionsByUsage),
    asObject(modulePackage?.functionsByUsage),
    asObject(modulePackage?.rolesByUsage),
    asObject(modulePackage?.surfacesByUsage),
  ];
  const usageKeys = usage === TECHNICAL_USAGE
    ? [TECHNICAL_USAGE, "technical", "service", "interface", "schnittstelle"]
    : [LOCAL_USAGE, "local", "member", "mitglied"];
  const groupedPermissions = firstPermissionList(
    accessGroups.flatMap((group) => usageKeys.map((key) => group[key])),
  );

  if (groupedPermissions.length) return groupedPermissions;

  const manifestFrontend = asObject(manifest.frontend);
  const usageSpecificPermissions = usage === TECHNICAL_USAGE
    ? firstPermissionList([
        modulePackage?.technicalSurfaces,
        metadata.technicalSurfaces,
        manifest.technicalSurfaces,
        modulePackage?.surfaces,
        metadata.surfaces,
        manifest.surfaces,
        manifestFrontend.surfaces,
      ])
    : firstPermissionList([
        modulePackage?.functions,
        metadata.functions,
        manifest.functions,
        modulePackage?.roles,
        metadata.roles,
        manifest.roles,
      ]);

  if (usageSpecificPermissions.length) return usageSpecificPermissions;

  const sharedPermissions = firstPermissionList([
    modulePackage?.permissions,
    manifest.permissions,
    metadata.permissions,
  ]);

  return sharedPermissions.length
    ? sharedPermissions
    : [...(DEFAULT_PERMISSIONS[kind]?.[usage] || [])];
}

function normalizeModulePackage(modulePackage, index) {
  const manifest = {
    ...asObject(modulePackage?.manifest),
    ...asObject(modulePackage?.manifestJson),
  };
  const kind = normalizeModuleKind(modulePackage?.kind || manifest.kind || modulePackage?.type || manifest.type);
  if (!kind || kind === "control-center") return null;

  const installation = asObject(modulePackage?.installation);
  const status = cleanText(installation.status || modulePackage?.status || "discovered").toLowerCase();
  if (["deleted", "uninstalled"].includes(status)) return null;

  const installed = modulePackage?.installed === true
    || installation.installed === true
    || INSTALLED_MODULE_STATUSES.has(status);
  const enabled = modulePackage?.enabled === true
    || installation.enabled === true
    || status === "enabled";

  const label = cleanText(
    modulePackage?.name || modulePackage?.label || manifest.name || manifest.label,
    `${surfaceForKind(kind)} ${index + 1}`,
  );
  const key = cleanText(modulePackage?.key || modulePackage?.id || manifest.key || manifest.id, slug(label));

  return {
    key,
    kind,
    surface: surfaceForKind(kind),
    label,
    description: cleanText(modulePackage?.description || manifest.description),
    version: cleanText(modulePackage?.version || manifest.version),
    status,
    installed,
    enabled,
    permissionsByUsage: {
      [LOCAL_USAGE]: usagePermissions(modulePackage, kind, LOCAL_USAGE),
      [TECHNICAL_USAGE]: usagePermissions(modulePackage, kind, TECHNICAL_USAGE),
    },
  };
}

function withPermissionDefaults(module) {
  const kind = module.kind;
  const provided = asObject(module.permissionsByUsage);

  return {
    ...module,
    permissionsByUsage: {
      [LOCAL_USAGE]: permissionList(provided[LOCAL_USAGE]).length
        ? permissionList(provided[LOCAL_USAGE])
        : [...(DEFAULT_PERMISSIONS[kind]?.[LOCAL_USAGE] || [])],
      [TECHNICAL_USAGE]: permissionList(provided[TECHNICAL_USAGE]).length
        ? permissionList(provided[TECHNICAL_USAGE])
        : [...(DEFAULT_PERMISSIONS[kind]?.[TECHNICAL_USAGE] || [])],
    },
  };
}

export function buildNewMemberModuleCatalog(modulePackages = []) {
  const dynamicModules = (Array.isArray(modulePackages) ? modulePackages : [])
    .map(normalizeModulePackage)
    .filter((module) => module?.installed);
  const modules = [
    ...STATIC_MODULES,
    ...dynamicModules,
  ].map(withPermissionDefaults);
  const uniqueModules = new Map();

  modules.forEach((module) => {
    const uniqueKey = `${module.kind}:${module.key}`;
    if (!uniqueModules.has(uniqueKey)) uniqueModules.set(uniqueKey, module);
  });

  const kindOrder = ["control-center", "app", "add-on", "plug-in"];
  return [...uniqueModules.values()].sort((left, right) => (
    kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind)
    || Number(right.enabled) - Number(left.enabled)
    || Number(right.installed) - Number(left.installed)
    || left.label.localeCompare(right.label, "de")
  ));
}

export function createEmptyNewMemberDraft() {
  return {
    loginName: "",
    displayName: "",
    email: "",
    password: "",
    passwordRepeat: "",
    usage: "",
    surface: "",
    selectedModuleKeys: [],
    permissionsByModule: {},
    roles: [],
  };
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function cleanNewMemberLoginName(value) {
  return cleanText(value).toLowerCase();
}

export function isTechnicalOnlySurface(surface) {
  return surface === ADD_ON_SURFACE || surface === PLUG_IN_SURFACE;
}

export function getNewMemberModulesForSurface(moduleCatalog, surface) {
  const kind = SURFACE_TO_KIND[surface];
  return asArray(moduleCatalog).filter((module) => module.kind === kind);
}

export function getNewMemberModule(moduleCatalog, moduleKey) {
  return asArray(moduleCatalog).find((module) => module.key === moduleKey) || null;
}

export function getNewMemberModulePermissions(module, usage) {
  if (!module) return [];
  const effectiveUsage = usage || (isTechnicalOnlySurface(module.surface) ? TECHNICAL_USAGE : LOCAL_USAGE);
  return permissionList(module.permissionsByUsage?.[effectiveUsage]);
}

// Kompatibilität für ältere, einzeln ausgetauschte Fensterdateien. Die aktuelle
// Oberfläche verwendet die manifestbasierten Modul-Funktionen darunter.
export function getNewMemberRoleOptions(surface, usage) {
  const kind = SURFACE_TO_KIND[surface];
  const effectiveUsage = usage || (isTechnicalOnlySurface(surface) ? TECHNICAL_USAGE : LOCAL_USAGE);
  return [...(DEFAULT_PERMISSIONS[kind]?.[effectiveUsage] || [])];
}

export function getNewMemberDefaultRoles(surface, usage) {
  const kind = SURFACE_TO_KIND[surface];
  if (!kind) return [];

  return getNewMemberDefaultPermissions({
    kind,
    surface,
    permissionsByUsage: {
      [LOCAL_USAGE]: DEFAULT_PERMISSIONS[kind]?.[LOCAL_USAGE] || [],
      [TECHNICAL_USAGE]: DEFAULT_PERMISSIONS[kind]?.[TECHNICAL_USAGE] || [],
    },
  }, usage);
}

export function getNewMemberDefaultPermissions(module, usage) {
  const options = getNewMemberModulePermissions(module, usage);
  if (module?.kind === "control-center") return options.includes("Administrator") ? ["Administrator"] : options.slice(0, 1);
  if (module?.kind === "app" && usage === LOCAL_USAGE) return options.includes("Member") ? ["Member"] : options.slice(0, 1);
  if (["add-on", "plug-in"].includes(module?.kind) && options.length === 1) return options;
  return [];
}

export function getSelectedNewMemberModules(draft, moduleCatalog) {
  const selectedKeys = asArray(draft?.selectedModuleKeys);
  return selectedKeys
    .map((moduleKey) => getNewMemberModule(moduleCatalog, moduleKey))
    .filter(Boolean);
}

export function getSelectedModulePermissions(draft, moduleKey) {
  return permissionList(draft?.permissionsByModule?.[moduleKey]);
}

export function getNewMemberSelectedRoles(draft) {
  const selectedKeys = asArray(draft?.selectedModuleKeys);
  if (!selectedKeys.length) return permissionList(draft?.roles);

  const permissions = selectedKeys.flatMap((moduleKey) => getSelectedModulePermissions(draft, moduleKey));
  return [...new Set(permissions)];
}

export function buildNewMemberModuleAccess(draft, moduleCatalog) {
  return getSelectedNewMemberModules(draft, moduleCatalog).map((module) => ({
    kind: module.kind,
    moduleKey: module.key,
    moduleName: module.label,
    permissions: getSelectedModulePermissions(draft, module.key),
  }));
}

export function isValidEmail(value) {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function generateAccessPassword(length = 14) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const numbers = "23456789";
  const symbols = "!?#%+-";
  const all = `${letters}${numbers}${symbols}`;
  const required = [letters, numbers, symbols].map((pool) => pool[Math.floor(Math.random() * pool.length)]);
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => all[Math.floor(Math.random() * all.length)]);

  return [...required, ...rest].sort(() => Math.random() - 0.5).join("");
}

function encodeMailtoValue(value) {
  return encodeURIComponent(value || "").replace(/%20/g, "+");
}

export function createAccessMailto({ email, loginName, password }) {
  const subject = "Deine Zugangsdaten";
  const body = [
    "Hallo,",
    "",
    "hier sind deine Zugangsdaten:",
    "",
    `Benutzer: ${loginName}`,
    `Passwort: ${password}`,
    "",
    "Bitte ändere das Passwort nach der ersten Anmeldung, falls das System diese Funktion anbietet.",
  ].join("\n");

  return `mailto:${encodeMailtoValue(email)}?subject=${encodeMailtoValue(subject)}&body=${encodeMailtoValue(body)}`;
}
