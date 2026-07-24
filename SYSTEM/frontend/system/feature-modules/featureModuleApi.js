import { apiRequest } from "../api/apiClient.js";

const MODULE_PACKAGES_ENDPOINT = "/api/system/modules/packages";

function normalizeManifest(module) {
  return module?.manifest && typeof module.manifest === "object" ? module.manifest : {};
}

export function modulePackageId(module) {
  return String(module?.key || module?.id || "").trim();
}

export function modulePackageDisplayName(module) {
  const manifest = normalizeManifest(module);
  return module?.displayName || module?.name || module?.label || manifest.name || manifest.label || modulePackageId(module) || "Modulpaket";
}

export async function fetchModulePackages(token) {
  const data = await apiRequest(MODULE_PACKAGES_ENDPOINT, { token });
  return Array.isArray(data?.packages) ? data.packages : Array.isArray(data?.modules) ? data.modules : [];
}

export async function fetchModulePackage(token, moduleId) {
  const modules = await fetchModulePackages(token);
  return modules.find((module) => modulePackageId(module) === moduleId) || null;
}

export const featureModuleId = modulePackageId;
export const featureModuleDisplayName = modulePackageDisplayName;
export const fetchFeatureModules = fetchModulePackages;
export const fetchFeatureModule = fetchModulePackage;
export function isFeatureModuleInstalled(module) { return Boolean(module?.installed || module?.enabled); }
export function isFeatureModuleActive(module) { return Boolean(module?.enabled); }
export function featureModuleFrontend(module) { return module?.frontend || module?.manifest?.frontend || {}; }
export function featureModuleRuntimeEntry(module) {
  const frontend = featureModuleFrontend(module);
  return String(frontend?.runtimeEntry || frontend?.runtimeUrl || "").trim();
}
export function featureModuleIntegration(module) {
  return String(featureModuleFrontend(module)?.integration || "module").trim().toLowerCase();
}
export function featureModuleTransport(module) {
  return String(featureModuleFrontend(module)?.transport || "").trim().toLowerCase();
}
