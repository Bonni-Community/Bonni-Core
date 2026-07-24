import { controlCenterLabels as labels } from "../language/index.js";

export const CONTROL_CENTER_NAV_ITEMS = [
  {
    key: "user",
    label: labels.navigation.user,
    targetModule: "user",
    description: labels.navigationDescriptions.user,
  },
  {
    key: "provider",
    label: labels.navigation.provider,
    targetModule: "provider",
    description: labels.navigationDescriptions.provider,
  },
  {
    key: "interfaces",
    label: labels.navigation.interfaces,
    targetModule: "interfaces",
    description: labels.navigationDescriptions.interfaces,
  },
  {
    key: "server",
    label: labels.navigation.server,
    targetModule: "server",
    description: labels.navigationDescriptions.server,
  },
  {
    key: "store",
    label: labels.navigation.store,
    targetModule: "store",
    description: labels.navigationDescriptions.store,
  },
  {
    key: "system",
    label: labels.navigation.system,
    targetModule: "system",
    description: labels.navigationDescriptions.system,
  },
  {
    key: "explorer",
    label: labels.navigation.explorer,
    targetModule: "explorer",
    description: labels.navigationDescriptions.explorer,
  },
  {
    key: "license",
    label: labels.navigation.license,
    targetModule: "license",
    description: labels.navigationDescriptions.license,
  },
  {
    key: "logs",
    label: labels.navigation.logs,
    targetModule: "logs",
    description: labels.navigationDescriptions.logs,
  },
];

function area(key, icon) {
  const item = CONTROL_CENTER_NAV_ITEMS.find((candidate) => candidate.key === key);
  return { ...item, icon };
}

export const CONTROL_CENTER_MAIN_AREAS = [
  area("user", "👤"),
  area("server", "◆"),
  area("store", "🧩"),
  area("system", "⌘"),
];

export const CONTROL_CENTER_SECONDARY_AREAS = [
  area("provider", "☁"),
  area("interfaces", "⇄"),
  area("explorer", "▤"),
  area("license", "◎"),
  area("logs", "☰"),
];

export const NETWORK_CONTROL_CENTER_NAV_ITEM = {
  key: "network",
  label: labels.navigation.network,
  description: labels.navigationDescriptions.network,
};

export function buildControlCenterNavigation(networkAddonInstalled = false) {
  const items = [...CONTROL_CENTER_NAV_ITEMS];
  if (!networkAddonInstalled) return items;

  const logsIndex = items.findIndex((item) => item.key === "logs");
  items.splice(logsIndex < 0 ? items.length : logsIndex + 1, 0, NETWORK_CONTROL_CENTER_NAV_ITEM);
  return items;
}
