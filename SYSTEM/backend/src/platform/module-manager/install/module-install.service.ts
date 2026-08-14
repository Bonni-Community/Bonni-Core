import { evaluateModuleCompatibility } from "../compatibility/index.js";
import { findModuleManifest, listModuleManifests, validateModuleManifest } from "../manifests/index.js";
import {
  findInstalledModule,
  listInstalledModules,
  syncInstalledModuleFromManifest,
  updateInstalledModuleStatus,
  upsertInstalledModuleFromManifest,
} from "../registry/index.js";
import { assembleModulePrisma } from "./prisma-assembly.service.js";
import { deactivateRuntimeModule, refreshRuntimeModule } from "../loader/index.js";
import { isRuntimeActivationReady } from "./runtime-activation-policy.js";
import { installModuleLegalPayload } from "./module-legal-storage.service.js";

export async function getModuleInstallPlan(key: string) {
  const [manifest, installed, installedModules, manifests] = await Promise.all([
    findModuleManifest(key),
    findInstalledModule(key),
    listInstalledModules(),
    listModuleManifests(),
  ]);
  const validation = manifest ? validateModuleManifest(manifest) : { ok: false, errors: ["Manifest nicht gefunden."] };
  const compatibility = manifest
    ? evaluateModuleCompatibility(manifest, { installedModules, manifests })
    : null;
  const activationCompatibility = manifest
    ? evaluateModuleCompatibility(manifest, { installedModules, manifests, requireDependenciesEnabled: true })
    : null;
  const canInstall = Boolean(manifest && validation.ok && compatibility?.ok && manifest.installation?.installable !== false);

  return {
    ok: Boolean(manifest),
    key,
    available: Boolean(manifest),
    installed: Boolean(installed),
    manifest,
    current: installed,
    validation,
    compatibility,
    activationCompatibility,
    blockedReasons: [
      ...validation.errors,
      ...(compatibility?.reasons || []),
      ...(manifest?.installation?.installable === false ? ["Dieses Paket ist nicht installierbar."] : []),
    ],
    actions: {
      install: canInstall,
      activate: Boolean(installed && !installed.enabled && activationCompatibility?.ok),
      deactivate: Boolean(installed && installed.enabled),
      uninstall: Boolean(installed),
      delete: Boolean(installed),
    },
  };
}

export async function installModulePackage(key: string) {
  const manifest = await findModuleManifest(key);
  if (!manifest) {
    return { ok: false, error: "MODULE_MANIFEST_NOT_FOUND", key };
  }

  const validation = validateModuleManifest(manifest);
  if (!validation.ok) {
    return { ok: false, error: "MODULE_MANIFEST_INVALID", key, validation };
  }

  if (manifest.installation?.installable === false) {
    return { ok: false, error: "MODULE_NOT_INSTALLABLE", key };
  }

  const [installedModules, manifests] = await Promise.all([
    listInstalledModules(),
    listModuleManifests(),
  ]);
  const compatibility = evaluateModuleCompatibility(manifest, { installedModules, manifests });
  if (!compatibility.ok) {
    return { ok: false, error: "MODULE_INCOMPATIBLE", key, compatibility };
  }

  const prismaAssembly = await assembleModulePrisma(manifest);
  const legalPayload = await installModuleLegalPayload(manifest);
  const module = await upsertInstalledModuleFromManifest(manifest, manifest.sourcePath);
  return { ok: true, module, prismaAssembly, legalPayload, compatibility };
}

export async function activateModulePackage(key: string) {
  const module = await findInstalledModule(key);
  if (!module) return { ok: false, error: "MODULE_NOT_INSTALLED", key };

  const manifest = await findModuleManifest(key);
  if (!manifest) return { ok: false, error: "MODULE_MANIFEST_NOT_FOUND", key };

  const [installedModules, manifests] = await Promise.all([
    listInstalledModules(),
    listModuleManifests(),
  ]);
  const compatibility = evaluateModuleCompatibility(manifest, {
    installedModules,
    manifests,
    requireDependenciesEnabled: true,
  });
  if (!compatibility.ok) {
    return { ok: false, error: "MODULE_INCOMPATIBLE", key, compatibility };
  }
  await syncInstalledModuleFromManifest(manifest, manifest.sourcePath);
  const prismaAssembly = manifest ? await assembleModulePrisma(manifest) : null;
  const legalPayload = await installModuleLegalPayload(manifest);

  const enabledModule = await updateInstalledModuleStatus(key, "enabled");
  const runtime = await refreshRuntimeModule(enabledModule);
  const expectedBackendEntry = manifest.backend?.entry || enabledModule.backendEntry;
  if (!isRuntimeActivationReady(expectedBackendEntry, runtime.status)) {
    await deactivateRuntimeModule(key);
    const rolledBackModule = await updateInstalledModuleStatus(key, "disabled");
    return {
      ok: false,
      error: "MODULE_RUNTIME_LOAD_FAILED",
      message: `Modul konnte nicht gestartet werden: ${runtime.error || "unbekannter Laufzeitfehler"}`,
      module: rolledBackModule,
      runtime,
      prismaAssembly,
      legalPayload,
      compatibility,
    };
  }

  return { ok: true, module: enabledModule, runtime, prismaAssembly, legalPayload, compatibility };
}

export async function deactivateModulePackage(key: string) {
  const module = await findInstalledModule(key);
  if (!module) return { ok: false, error: "MODULE_NOT_INSTALLED", key };
  const disabledModule = await updateInstalledModuleStatus(key, "disabled");
  await deactivateRuntimeModule(key);
  return { ok: true, module: disabledModule };
}

export async function uninstallModulePackage(key: string) {
  const module = await findInstalledModule(key);
  if (!module) return { ok: false, error: "MODULE_NOT_INSTALLED", key };
  const uninstalledModule = await updateInstalledModuleStatus(key, "uninstalled");
  await deactivateRuntimeModule(key);
  return { ok: true, module: uninstalledModule };
}

export async function deleteModulePackage(key: string) {
  const module = await findInstalledModule(key);
  if (!module) return { ok: false, error: "MODULE_NOT_INSTALLED", key };
  const deletedModule = await updateInstalledModuleStatus(key, "deleted");
  await deactivateRuntimeModule(key);
  return { ok: true, module: deletedModule };
}

const REPLACED_PACKAGE_KEYS = new Map([
  ["app.vereinsapp", "app.kontorapp"],
]);

function isReplacedPackage(key: string, manifestKeys: Set<string>) {
  const replacement = REPLACED_PACKAGE_KEYS.get(key);
  return Boolean(replacement && manifestKeys.has(replacement));
}

export function mergeModulePackages(manifests: any[], installed: any[]) {
  const allManifestKeys = new Set(manifests.map((manifest) => manifest.key));
  const visibleManifests = manifests.filter((manifest) => !isReplacedPackage(manifest.key, allManifestKeys));

  const installedByKey = new Map(installed.map((module) => [module.key, module]));
  const discovered = visibleManifests.map((manifest) => {
    const installation = installedByKey.get(manifest.key) as any;
    const compatibility = evaluateModuleCompatibility(manifest, { installedModules: installed, manifests: visibleManifests });
    return {
      ...manifest,
      installation: installation || manifest.installation || null,
      installationPolicy: manifest.installation || null,
      installed: Boolean(installation?.installed),
      enabled: Boolean(installation?.enabled),
      status: installation?.status || "discovered",
      compatibility,
      compatible: compatibility.ok,
    };
  });

  const manifestKeys = new Set(visibleManifests.map((manifest) => manifest.key));
  const installedOnly = installed
    .filter((module) => !manifestKeys.has(module.key))
    .filter((module) => module.installed)
    .filter((module) => !isReplacedPackage(module.key, allManifestKeys))
    .map((module) => ({
      ...module,
      compatibility: {
        ok: false,
        key: module.key,
        reasons: ["Installiertes Paket besitzt kein auffindbares Manifest."],
      },
      compatible: false,
    }));

  return [...discovered, ...installedOnly];
}

export async function listModulePackages() {
  const [manifests, installed] = await Promise.all([
    listModuleManifests(),
    listInstalledModules(),
  ]);
  return mergeModulePackages(manifests, installed);
}
