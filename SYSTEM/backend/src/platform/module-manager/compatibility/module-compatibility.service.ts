import { hubInstallationPolicy, usesHubProducts } from "../../../core/hub/hub-installation-policy.js";
import { getSystemRuntimeConfig } from "../../../system/runtime/runtime.config.js";
import { listModuleManifests } from "../manifests/index.js";
import { listInstalledModules } from "../registry/index.js";
import type { InstalledModuleSummary, ModuleManifestSummary } from "../types.js";
import {
  compareModuleVersions,
  isValidModuleVersion,
  validateCoreVersionCompatibility,
  type VersionComparison,
} from "./module-version.js";

export type { VersionComparison } from "./module-version.js";

export type ModuleDependencyStatus = {
  key: string;
  source: "core" | "module" | "capability" | "missing";
  installed: boolean;
  enabled: boolean;
  satisfied: boolean;
  providerKey?: string;
};

export type ModuleCompatibilityResult = {
  ok: boolean;
  key: string;
  coreVersion: string;
  minimumCoreVersion: string | null;
  maximumCoreVersion: string | null;
  coreVersionDeclared: boolean;
  coreVersionCompatible: boolean;
  dependenciesCompatible: boolean;
  dependencies: ModuleDependencyStatus[];
  reasons: string[];
};

const CORE_CAPABILITIES = new Set([
  "core.auth",
  "core.hub-products",
  "core.hub-tree",
  "core.hub-tree-provider",
  "core.hub-inventory",
  "core.hub-inventory-management",
  "core.hub-inventory-provider",
  "core.hub-provider",
  "core.permissions",
  "core.event-bus",
  "core.archive",
  "core.media",
  "core.files",
  "core.module-services",
  "core.public-web",
  "core.members",
  "core.module-settings",
  "core.two-factor",
  "core.nfc",
  "core.two-factor-provider",
  "core.private-data",
  "core.paypal-payments",
  "core.domain-messages",
  "core.protected-people",
  "core.protected-organization",
  "core.request-identity",
  "core.service-accounts",
  "core.terminal-accounts",
  "core.data-adapters",
  "core.network-requests",
  "core.health-checks",
  "core.instance-identity",
  "core.system-monitoring",
  "core.video-conferencing",
]);

function cleanVersion(value: unknown): string | null {
  const normalized = String(value || "").trim().replace(/^v/i, "");
  return normalized || null;
}

export function compareVersions(leftValue: string, rightValue: string): VersionComparison {
  return compareModuleVersions(leftValue, rightValue);
}

function firstVersion(...values: unknown[]) {
  for (const value of values) {
    const version = cleanVersion(value);
    if (version) return version;
  }
  return null;
}

export function coreVersionRange(manifest: ModuleManifestSummary | Record<string, any>) {
  const source = manifest as Record<string, any>;
  const compatibility = source?.compatibility || source?.metadata?.compatibility || {};
  const bonniCore = compatibility?.bonniCore || {};

  return {
    minimumCoreVersion: firstVersion(
      source?.minimumCoreVersion,
      source?.metadata?.minimumCoreVersion,
      compatibility?.minimumCoreVersion,
      compatibility?.minCoreVersion,
      bonniCore?.minimumVersion,
      bonniCore?.min,
    ),
    maximumCoreVersion: firstVersion(
      source?.maximumCoreVersion,
      source?.metadata?.maximumCoreVersion,
      compatibility?.maximumCoreVersion,
      compatibility?.maxCoreVersion,
      bonniCore?.maximumVersion,
      bonniCore?.max,
    ),
  };
}

function providedCapabilities(manifest: ModuleManifestSummary | Record<string, any>) {
  return Array.isArray(manifest?.provides)
    ? manifest.provides.map((entry: unknown) => String(entry).trim()).filter(Boolean)
    : [];
}

function requiredDependencies(manifest: ModuleManifestSummary | Record<string, any>) {
  return Array.isArray(manifest?.dependsOn)
    ? [...new Set(manifest.dependsOn.map((entry: unknown) => String(entry).trim()).filter(Boolean))]
    : [];
}

function moduleStatus(module: InstalledModuleSummary | undefined) {
  return {
    installed: Boolean(module?.installed),
    enabled: Boolean(module?.enabled),
  };
}

export function evaluateModuleCompatibility(
  manifest: ModuleManifestSummary | Record<string, any>,
  options: {
    coreVersion?: string;
    installedModules?: InstalledModuleSummary[];
    manifests?: ModuleManifestSummary[];
    requireDependenciesEnabled?: boolean;
  } = {},
): ModuleCompatibilityResult {
  const source = manifest as Record<string, any>;
  const coreVersion = cleanVersion(options.coreVersion) || getSystemRuntimeConfig().version;
  const installedModules = options.installedModules || [];
  const manifests = options.manifests || [];
  const installedByKey = new Map(installedModules.map((module) => [module.key, module]));
  const manifestByKey = new Map(manifests.map((entry) => [entry.key, entry]));
  const { minimumCoreVersion, maximumCoreVersion } = coreVersionRange(manifest);
  const reasons: string[] = [];

  const canonicalCompatibility = validateCoreVersionCompatibility(source?.compatibility);
  let coreVersionCompatible = canonicalCompatibility.ok && isValidModuleVersion(coreVersion.replace(/^v/i, ""));
  if (!canonicalCompatibility.ok) {
    reasons.push(...canonicalCompatibility.errors);
  }
  if (!isValidModuleVersion(coreVersion.replace(/^v/i, ""))) {
    reasons.push("Die laufende Bonni-Core-Version ist ungültig und kann nicht sicher verglichen werden.");
  }
  if (coreVersionCompatible && minimumCoreVersion && compareVersions(coreVersion, minimumCoreVersion) < 0) {
    coreVersionCompatible = false;
    reasons.push(`Bonni Core ${minimumCoreVersion} oder neuer wird benötigt.`);
  }
  if (coreVersionCompatible && maximumCoreVersion && compareVersions(coreVersion, maximumCoreVersion) > 0) {
    coreVersionCompatible = false;
    reasons.push(`Bonni Core ${coreVersion} ist neuer als die unterstützte Version ${maximumCoreVersion}.`);
  }

  const required = requiredDependencies(manifest);
  const hubCandidate = {
    key: source.key, kind: source.kind, installed: true,
    enabled: Boolean(options.requireDependenciesEnabled || installedByKey.get(source.key)?.enabled),
    manifestJson: source,
  };
  const hubPolicy = hubInstallationPolicy(installedModules, hubCandidate, manifests);
  const requiresHub = usesHubProducts(hubCandidate) && hubPolicy.required;
  if (requiresHub && !required.includes("addon.hub")) required.push("addon.hub");
  const dependencies = required.map<ModuleDependencyStatus>((key) => {
    if (CORE_CAPABILITIES.has(key)) {
      return { key, source: "core", installed: true, enabled: true, satisfied: true };
    }

    const direct = installedByKey.get(key);
    if (direct) {
      const status = moduleStatus(direct);
      return {
        key,
        source: "module",
        ...status,
        satisfied: options.requireDependenciesEnabled ? status.enabled : status.installed,
        providerKey: direct.key,
      };
    }

    const providerManifest = manifests.find((candidate) => providedCapabilities(candidate).includes(key));
    if (providerManifest) {
      const provider = installedByKey.get(providerManifest.key);
      const status = moduleStatus(provider);
      return {
        key,
        source: "capability",
        ...status,
        satisfied: options.requireDependenciesEnabled ? status.enabled : status.installed,
        providerKey: providerManifest.key,
      };
    }

    const discovered = manifestByKey.get(key);
    return {
      key,
      source: discovered ? "module" : "missing",
      installed: false,
      enabled: false,
      satisfied: false,
      providerKey: discovered?.key,
    };
  });

  if (requiresHub && (!hubPolicy.installed || (options.requireDependenciesEnabled && !hubPolicy.enabled))) {
    reasons.push("Ab zwei installierten Lager-Apps mit Hub-Schnittstelle ist Hub erforderlich. Bitte Hub installieren und aktivieren.");
  }
  const dependenciesCompatible = dependencies.every((dependency) => dependency.satisfied);
  for (const dependency of dependencies.filter((entry) => !entry.satisfied)) {
    reasons.push(
      dependency.installed
        ? `Abhängigkeit ${dependency.key} ist nicht aktiviert.`
        : `Abhängigkeit ${dependency.key} ist nicht installiert.`,
    );
  }

  return {
    ok: coreVersionCompatible && dependenciesCompatible,
    key: String(source?.key || source?.id || "unknown"),
    coreVersion,
    minimumCoreVersion,
    maximumCoreVersion,
    coreVersionDeclared: Boolean(minimumCoreVersion || maximumCoreVersion),
    coreVersionCompatible,
    dependenciesCompatible,
    dependencies,
    reasons,
  };
}

export async function getModuleCompatibility(
  manifest: ModuleManifestSummary | Record<string, any>,
  options: { coreVersion?: string; requireDependenciesEnabled?: boolean } = {},
) {
  const [installedModules, manifests] = await Promise.all([
    listInstalledModules(),
    listModuleManifests(),
  ]);

  return evaluateModuleCompatibility(manifest, {
    ...options,
    installedModules,
    manifests,
  });
}

export async function getInstalledModulesCompatibilityForCoreVersion(targetCoreVersion: string) {
  const [installedModules, manifests] = await Promise.all([
    listInstalledModules(),
    listModuleManifests(),
  ]);
  const manifestByKey = new Map(manifests.map((manifest) => [manifest.key, manifest]));

  const modules = installedModules.map((installed) => {
    const manifest = manifestByKey.get(installed.key)
      || (installed.manifestJson as Record<string, any> | undefined)
      || (installed.manifest as Record<string, any> | undefined);

    if (!manifest) {
      return {
        key: installed.key,
        name: installed.name,
        version: installed.version,
        ok: false,
        reasons: ["Installiertes Paket besitzt kein prüfbares Manifest."],
        compatibility: null,
      };
    }

    const compatibility = evaluateModuleCompatibility(manifest, {
      coreVersion: targetCoreVersion,
      installedModules,
      manifests,
      requireDependenciesEnabled: Boolean(installed.enabled),
    });

    return {
      key: installed.key,
      name: installed.name,
      version: installed.version,
      enabled: installed.enabled,
      ok: compatibility.ok,
      reasons: compatibility.reasons,
      compatibility,
    };
  });

  return {
    ok: modules.every((module) => module.ok),
    targetCoreVersion,
    checkedAt: new Date().toISOString(),
    modules,
    incompatible: modules.filter((module) => !module.ok),
  };
}
