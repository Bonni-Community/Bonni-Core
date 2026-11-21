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

export async function fetchModulePackages(token, { signal } = {}) {
  const data = await apiRequest(MODULE_PACKAGES_ENDPOINT, { token, signal });
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

export async function verifyFeatureModuleEntry(module, { signal } = {}) {
  if (!isFeatureModuleActive(module) || featureModuleIntegration(module) !== "iframe") return;
  const entry = featureModuleRuntimeEntry(module);
  if (!entry) return;
  const url = new URL(entry, window.location.href);
  if (url.origin !== window.location.origin) return;
  // Probe the exact versioned entry before hiding the Core shell behind an
  // iframe. A failed HTTP navigation otherwise still fires iframe onLoad.
  const response = await fetch(url.href, { method: "HEAD", cache: "no-store", credentials: "omit", signal });
  if (!response.ok || !/\btext\/html\b/i.test(response.headers.get("content-type") || "")) {
    throw new Error(`Die Oberfläche von ${featureModuleDisplayName(module)} ist nicht verfügbar (HTTP ${response.status}). Bitte das Serverprotokoll prüfen.`);
  }
}

export function featureModuleTransport(module) {
  return String(featureModuleFrontend(module)?.transport || "").trim().toLowerCase();
}
export function featureModuleRpcContract(module) {
  const frontend = featureModuleFrontend(module);
  const contract = frontend?.rpcContract;
  if (contract && typeof contract === "object" && !Array.isArray(contract)) return contract;
  const hydrated = module?.rpcContract || module?.manifest?.rpcContract;
  return hydrated && typeof hydrated === "object" && !Array.isArray(hydrated)
    ? hydrated
    : null;
}

const SANDBOX_CAPABILITY_FLAGS = Object.freeze({
  downloads: "allow-downloads",
  forms: "allow-forms",
  popups: "allow-popups",
});

const SAFE_SANDBOX_CAPABILITIES = new Set(Object.keys(SANDBOX_CAPABILITY_FLAGS));

function normalizeSandboxCapabilities(configured) {
  if (!Array.isArray(configured)) return [];
  return [...new Set(
    configured
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter((entry) => SAFE_SANDBOX_CAPABILITIES.has(entry)),
  )];
}

export function featureModuleSandboxCapabilities(module) {
  const configured = featureModuleFrontend(module)?.sandboxCapabilities;
  return normalizeSandboxCapabilities(configured);
}

export function featureModuleOpaqueSandbox(capabilities) {
  const optionalFlags = normalizeSandboxCapabilities(capabilities)
    .map((capability) => SANDBOX_CAPABILITY_FLAGS[capability]);
  return ["allow-scripts", ...optionalFlags].join(" ");
}
