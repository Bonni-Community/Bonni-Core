export const coreModules = [
  {
    key: "user",
    id: "user",
    label: "Benutzer",
    description: "Benutzer, Rollen, Rechte und Sessions.",
    icon: "user",
    route: "/control-center/user",
    permission: "control-center.user.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 10,
  },
  {
    key: "provider",
    id: "provider",
    label: "Provider",
    description: "Anmeldung und externe Identity Provider.",
    icon: "provider",
    route: "/control-center/provider",
    permission: "control-center.provider.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 20,
  },
  {
    key: "interfaces",
    id: "interfaces",
    label: "Schnittstellen",
    description: "FF-Agent, POS, Fiskaly API und Integrationsschnittstellen.",
    icon: "interfaces",
    route: "/control-center/interfaces",
    permission: "control-center.interfaces.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 30,
  },
  {
    key: "server",
    id: "server",
    label: "Server",
    description: "Backend, Redundanz, Datenbank und Server-Status.",
    icon: "server",
    route: "/control-center/server",
    permission: "control-center.server.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 40,
  },
  {
    key: "store",
    id: "store",
    label: "Store",
    description: "Apps, Add-ons und Plug-ins installieren und verwalten.",
    icon: "store",
    route: "/control-center/store",
    permission: "control-center.store.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 50,
  },
  {
    key: "backup",
    id: "backup",
    label: "Backup",
    description: "Backups vorbereiten, auslösen, wiederherstellen und prüfen.",
    icon: "backup",
    route: "/control-center/backup",
    permission: "control-center.backup.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 60,
  },
  {
    key: "system",
    id: "system",
    label: "Systemüberwachung",
    description: "Systemstatus, Ressourcen sowie aktuelle Warnungen und Störungen.",
    icon: "system",
    route: "/control-center/system",
    permission: "control-center.system.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 70,
  },
  {
    key: "explorer",
    id: "explorer",
    label: "Explorer",
    description: "Bereiche, Module und Quellen im Explorer verwalten.",
    icon: "explorer",
    route: "/control-center/explorer",
    permission: "control-center.explorer.read",
    source: "core",
    enabled: true,
    visible: true,
    sortOrder: 80,
  },
];

export const MODULE_REGISTRY = coreModules;

function normalizeModule(module = {}) {
  const key = module.key || module.id;

  return {
    ...module,
    key,
    id: module.id || key,
    label: module.label || key,
    description: module.description || "",
    icon: String(module.icon || key || "").toLowerCase(),
    route: module.route || `/control-center/${key}`,
    source: module.source || "database",
    enabled: module.enabled !== false,
    visible: module.visible !== false,
    sortOrder: Number.isFinite(Number(module.sortOrder))
      ? Number(module.sortOrder)
      : 999,
  };
}

export function mergeModuleRegistry(databaseModules = []) {
  const merged = new Map();

  for (const module of coreModules) {
    const normalized = normalizeModule(module);
    merged.set(normalized.key, normalized);
  }

  for (const module of databaseModules || []) {
    const normalized = normalizeModule(module);
    if (!normalized.key) continue;

    merged.set(normalized.key, {
      ...(merged.get(normalized.key) || {}),
      ...normalized,
    });
  }

  return Array.from(merged.values())
    .filter((module) => module.enabled !== false && module.visible !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

export function getVisibleModules(modules = coreModules) {
  return mergeModuleRegistry(modules);
}
