import { promises as fs } from "node:fs";
import path from "node:path";

import { assembleModulePrisma } from "../../src/platform/module-manager/install/prisma-assembly.service.js";
import {
  listModuleManifests,
  validateModuleManifest,
} from "../../src/platform/module-manager/manifests/manifest.service.js";
import { resolveBonniProjectRoot } from "../../src/platform/module-manager/project-root.js";

const manifests = await listModuleManifests({ strict: true });
const relevantManifests = manifests.filter((manifest) => (
  manifest.kind === "app" || Boolean(manifest.prisma?.source)
));

for (const manifest of relevantManifests) {
  const validation = validateModuleManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      `MODULE_MANIFEST_VALIDATION_FAILED:${manifest.key}:${validation.errors.join("|")}`,
    );
  }
}

// `assembled/**` is a derived build tree. Rebuild it from the complete,
// validated manifest set so removed/renamed modules can never leave stale
// Prisma models active in the generated Core client.
const assemblyRoot = path.join(
  resolveBonniProjectRoot(),
  "backend",
  "prisma",
  "domains",
  "assembled",
);
await fs.rm(assemblyRoot, { recursive: true, force: true });
await fs.mkdir(assemblyRoot, { recursive: true });

let assembledModules = 0;
let assembledFiles = 0;
for (const manifest of relevantManifests) {
  const result = await assembleModulePrisma(manifest);
  if (!result) continue;
  assembledModules += 1;
  assembledFiles += result.files;
  console.info(`[prisma-assembly] ${manifest.key}: ${result.files} Prisma-Datei(en) -> ${result.target}`);
}

console.info(
  `[prisma-assembly] ${assembledModules} Modul(e), ${assembledFiles} Prisma-Datei(en) assembliert.`,
);
