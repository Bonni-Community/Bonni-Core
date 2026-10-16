import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORIES = [
  "app",
  "apps",
  "add-on",
  "addon",
  "addons",
  "plug-in",
  "plugin",
  "plugins",
  "bridge",
  "bridges",
] as const;

const moduleManagerDirectory = path.dirname(fileURLToPath(import.meta.url));

// Gilt im tsx-Betrieb unter src/... und nach tsc unter dist/... gleichermaßen.
const systemRootFromModuleLocation = path.resolve(moduleManagerDirectory, "../../../..");

function candidateVariants(value: string | null | undefined) {
  if (!value?.trim()) return [];

  const candidate = path.resolve(value.trim());
  return [candidate, path.join(candidate, "System")];
}

function containsModulePackages(candidate: string) {
  return (
    existsSync(path.join(candidate, "backend")) &&
    PACKAGE_DIRECTORIES.some((directory) =>
      existsSync(path.join(candidate, directory)),
    )
  );
}

/**
 * Liefert immer den Ordner, in dem backend/ und app/ nebeneinander liegen.
 *
 * VS Code kann npm-Skripte aus dem Projektstamm, aus System/ oder direkt aus
 * System/backend starten. Docker setzt dagegen BONNI_PROJECT_ROOT. Alle diese
 * Startvarianten müssen zu derselben Modulstruktur führen.
 */
export function resolveBonniProjectRoot() {
  const modulePackageRoot = process.env.BONNI_MODULE_PACKAGE_ROOT?.trim();
  if (modulePackageRoot) {
    if (!path.isAbsolute(modulePackageRoot)) throw new Error("BONNI_MODULE_PACKAGE_ROOT_ABSOLUTE_REQUIRED");
    return path.resolve(modulePackageRoot);
  }
  const configuredRoot = process.env.BONNI_PROJECT_ROOT?.trim();
  const cwd = process.cwd();
  const candidates = [
    // RUN_SYSTEM/RUN_INSTALL enthalten absichtlich nur den Core. Installierte
    // Apps und Module werden unabhaengig davon aus dem stabilen SYSTEM gelesen.
    ...candidateVariants(modulePackageRoot),
    ...candidateVariants(configuredRoot),
    ...candidateVariants(cwd),
    ...candidateVariants(path.dirname(cwd)),
    systemRootFromModuleLocation,
  ];

  const uniqueCandidates = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  const detected = uniqueCandidates.find(containsModulePackages);
  if (detected) return detected;

  // Ohne installierte Pakete bleibt ein ausdrücklich konfigurierter Pfad die
  // maßgebliche Basis. Andernfalls ist der Ort des Backend-Moduls stabiler als
  // ein zufälliger VS-Code-Arbeitsordner.
  if (modulePackageRoot) return path.resolve(modulePackageRoot);
  if (configuredRoot) return path.resolve(configuredRoot);
  return systemRootFromModuleLocation;
}
