import { promises as fs } from "node:fs";
import path from "node:path";

import {
  listModuleManifests,
  validateModuleManifest,
} from "../../src/platform/module-manager/manifests/manifest.service.js";
import { resolveBonniProjectRoot } from "../../src/platform/module-manager/project-root.js";

function resolveInside(packageRoot: string, configuredPath: string, code: string) {
  const candidate = path.resolve(packageRoot, configuredPath);
  const relative = path.relative(packageRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(code);
  }
  return candidate;
}

const projectRoot = resolveBonniProjectRoot();
const manifests = await listModuleManifests({ strict: true });
const runtimeManifests = manifests.filter((manifest) => (
  manifest.kind === "app"
  || Boolean(manifest.backend)
  || Boolean(manifest.frontend)
  || Boolean(manifest.prisma?.source)
));

for (const manifest of runtimeManifests) {
  const validation = validateModuleManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      `MODULE_MANIFEST_VALIDATION_FAILED:${manifest.key}:${validation.errors.join("|")}`,
    );
  }

  const packageRoot = path.resolve(projectRoot, manifest.sourcePath || "");
  if (manifest.backend?.entry) {
    const backendEntry = resolveInside(
      packageRoot,
      manifest.backend.entry,
      `MODULE_BACKEND_ENTRY_OUTSIDE_PACKAGE:${manifest.key}`,
    );
    if (!(await fs.stat(backendEntry).catch(() => null))?.isFile()) {
      throw new Error(`MODULE_BACKEND_ENTRY_NOT_BUILT:${manifest.key}:${manifest.backend.entry}`);
    }
  }

  if (manifest.frontend?.publicRoot) {
    const publicRoot = resolveInside(
      packageRoot,
      manifest.frontend.publicRoot,
      `MODULE_FRONTEND_ROOT_OUTSIDE_PACKAGE:${manifest.key}`,
    );
    if (!(await fs.stat(publicRoot).catch(() => null))?.isDirectory()) {
      throw new Error(`MODULE_FRONTEND_NOT_BUILT:${manifest.key}:${manifest.frontend.publicRoot}`);
    }
    if (manifest.frontend.runtimeEntry) {
      const runtimeFile = path.join(publicRoot, path.posix.basename(manifest.frontend.runtimeEntry));
      if (!(await fs.stat(runtimeFile).catch(() => null))?.isFile()) {
        throw new Error(`MODULE_FRONTEND_ENTRY_NOT_BUILT:${manifest.key}:${runtimeFile}`);
      }
    }
  }

  if (manifest.prisma?.assembled) {
    const assembled = path.resolve(projectRoot, manifest.prisma.assembled);
    if (!(await fs.stat(assembled).catch(() => null))?.isDirectory()) {
      throw new Error(`MODULE_PRISMA_NOT_ASSEMBLED:${manifest.key}:${manifest.prisma.assembled}`);
    }
  }
}

console.info(`[module-verify] ${runtimeManifests.length} Laufzeitpaket(e) geprüft.`);
