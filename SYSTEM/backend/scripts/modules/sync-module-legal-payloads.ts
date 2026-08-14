import { installModuleLegalPayload } from "../../src/platform/module-manager/licensing/module-legal-payload.service.js";
import { listModuleManifests, validateModuleManifest } from "../../src/platform/module-manager/manifests/manifest.service.js";

const manifests = await listModuleManifests({ strict: true });
for (const manifest of manifests) {
  const validation = validateModuleManifest(manifest);
  if (!validation.ok) {
    throw new Error(`MODULE_MANIFEST_INVALID:${manifest.key}:${validation.errors.join("|")}`);
  }
  const result = await installModuleLegalPayload(manifest);
  if (result) {
    console.log(`[module-legal] ${manifest.key}@${manifest.version} -> ${result.targetRoot} (${result.created ? "created" : "verified"})`);
  }
}
