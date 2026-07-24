export const NETWORK_ADDON_KEY = "addon.bonni-network";
export const NETWORK_NAVIGATION_KEY = "network";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function modulePackageKey(modulePackage) {
  const manifest = object(modulePackage?.manifest || modulePackage?.manifestJson);
  return String(modulePackage?.key || modulePackage?.id || manifest.key || manifest.id || "").trim();
}

export function modulePackageInstalled(modulePackage) {
  if (!modulePackage) return false;
  const installation = object(modulePackage.installation);
  const status = String(modulePackage.status || installation.status || "").trim().toLowerCase();
  return modulePackage.installed === true
    || installation.installed === true
    || modulePackage.enabled === true
    || installation.enabled === true
    || ["installed", "enabled", "disabled", "update_available", "update_failed", "error"].includes(status);
}

export function modulePackageEnabled(modulePackage) {
  if (!modulePackage) return false;
  const installation = object(modulePackage.installation);
  const status = String(modulePackage.status || installation.status || "").trim().toLowerCase();
  return modulePackage.enabled === true || installation.enabled === true || status === "enabled";
}

export function modulePackageFrontend(modulePackage) {
  const manifest = object(modulePackage?.manifest || modulePackage?.manifestJson);
  return {
    ...object(manifest.frontend),
    ...object(modulePackage?.frontend),
  };
}

export function findInstalledNetworkAddon(packages = []) {
  return (Array.isArray(packages) ? packages : []).find((modulePackage) => {
    const manifest = object(modulePackage?.manifest || modulePackage?.manifestJson);
    const kind = String(modulePackage?.kind || manifest.kind || "").trim().toLowerCase();
    return modulePackageKey(modulePackage) === NETWORK_ADDON_KEY
      && (!kind || kind === "addon" || kind === "add-on")
      && modulePackageInstalled(modulePackage);
  }) || null;
}
