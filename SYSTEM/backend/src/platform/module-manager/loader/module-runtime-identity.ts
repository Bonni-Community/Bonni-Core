import type { InstalledModuleSummary, ModuleManifestSummary } from "../types.js";

// The registry records the last installation, while a Labor overlay may load
// newer files. Report the manifest version only when those files were selected.
export function runtimeModuleIdentity(
  installed: InstalledModuleSummary,
  manifest: ModuleManifestSummary | null,
  resolved: { installPath: string; backendEntry: string },
): InstalledModuleSummary {
  const usesManifest = Boolean(manifest
    && resolved.installPath === manifest.sourcePath
    && resolved.backendEntry === manifest.backend?.entry);
  return {
    ...installed,
    version: usesManifest ? manifest!.version : installed.version,
    name: usesManifest ? manifest!.name : installed.name,
    sourcePath: resolved.installPath,
    installPath: resolved.installPath,
    backendEntry: resolved.backendEntry,
  };
}
