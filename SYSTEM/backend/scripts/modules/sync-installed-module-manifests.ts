import { listModuleManifests } from "../../src/platform/module-manager/manifests/index.js";
import {
  listInstalledModules,
  syncInstalledModuleFromManifest,
} from "../../src/platform/module-manager/registry/index.js";

const [manifests, installedModules] = await Promise.all([
  listModuleManifests(),
  listInstalledModules(),
]);

const installedKeys = new Set(installedModules.map((module) => module.key));
let synchronized = 0;

for (const manifest of manifests) {
  if (!installedKeys.has(manifest.key)) continue;
  const module = await syncInstalledModuleFromManifest(manifest, manifest.sourcePath);
  if (!module) continue;
  synchronized += 1;
  console.log(`[module-sync] ${module.key} -> ${module.version}`);
}

console.log(`[module-sync] ${synchronized} installierte Modulpaket(e) aktualisiert.`);
