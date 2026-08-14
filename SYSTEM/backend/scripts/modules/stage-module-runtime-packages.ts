import fs from "node:fs/promises";
import path from "node:path";

import { listModuleManifests, validateModuleManifest } from "../../src/platform/module-manager/manifests/manifest.service.js";
import { resolveBonniProjectRoot } from "../../src/platform/module-manager/project-root.js";

const projectRoot = resolveBonniProjectRoot();
const outputRoot = path.resolve(process.argv[2] || path.join(projectRoot, "runtime-packages"));
if (outputRoot === projectRoot || outputRoot === path.parse(outputRoot).root) throw new Error("MODULE_RUNTIME_STAGE_ROOT_INVALID");

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function copyExact(sourceRoot: string, relative: string, targetRoot: string, excluded: Set<string>) {
  if ([...excluded].some((entry) => relative === entry || relative.startsWith(`${entry}/`))) return;
  const source = path.resolve(sourceRoot, relative);
  const target = path.resolve(targetRoot, relative);
  if (!inside(sourceRoot, source) || !inside(targetRoot, target)) throw new Error(`MODULE_RUNTIME_STAGE_PATH_INVALID:${relative}`);
  const state = await fs.lstat(source);
  if (state.isSymbolicLink()) throw new Error(`MODULE_RUNTIME_STAGE_SYMLINK_DENIED:${relative}`);
  if (state.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return;
  }
  if (!state.isDirectory()) throw new Error(`MODULE_RUNTIME_STAGE_TYPE_INVALID:${relative}`);
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (entry.isSymbolicLink()) throw new Error(`MODULE_RUNTIME_STAGE_SYMLINK_DENIED:${relative}/${entry.name}`);
    await copyExact(sourceRoot, `${relative}/${entry.name}`, targetRoot, excluded);
  }
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });
for (const directory of ["app", "apps", "addons", "plugins", "bridges"]) {
  await fs.mkdir(path.join(outputRoot, directory), { recursive: true });
}

const manifests = await listModuleManifests({ strict: true });
for (const manifest of manifests) {
  const validation = validateModuleManifest(manifest);
  if (!validation.ok) throw new Error(`MODULE_RUNTIME_STAGE_MANIFEST_INVALID:${manifest.key}:${validation.errors.join("|")}`);
  if (!manifest.sourcePath || !manifest.manifestPath) throw new Error(`MODULE_RUNTIME_STAGE_SOURCE_MISSING:${manifest.key}`);
  const packageRoot = path.resolve(projectRoot, manifest.sourcePath);
  const stageRoot = path.resolve(outputRoot, manifest.sourcePath);
  if (!inside(projectRoot, packageRoot) || !inside(outputRoot, stageRoot)) throw new Error(`MODULE_RUNTIME_STAGE_ROOT_ESCAPE:${manifest.key}`);
  const required = new Set<string>([
    path.relative(packageRoot, path.resolve(projectRoot, manifest.manifestPath)).replaceAll("\\", "/"),
  ]);
  for (const optional of ["README.md", "BAUPLAN.md"]) {
    if ((await fs.lstat(path.join(packageRoot, optional)).catch(() => null))?.isFile()) required.add(optional);
  }
  if (manifest.backend?.entry) required.add(path.posix.dirname(manifest.backend.entry));
  if (manifest.frontend?.publicRoot) required.add(manifest.frontend.publicRoot);
  if (manifest.frontend?.rpcContractPath) required.add(manifest.frontend.rpcContractPath);
  if (manifest.prisma?.source) required.add(manifest.prisma.source);
  const excluded = new Set<string>(manifest.legal
    ? [manifest.legal.notices, ...manifest.legal.payloadRoots]
    : []);
  for (const relative of [...required].sort()) await copyExact(packageRoot, relative, stageRoot, excluded);

  await fs.writeFile(path.join(stageRoot, "package.json"), `${JSON.stringify({
    name: `bonni-${manifest.key.replaceAll(".", "-")}-core-module`,
    version: manifest.version,
    private: true,
    type: "module",
    engines: { node: ">=22" },
    bonniCoreModule: true,
  }, null, 2)}\n`);
}

console.log(`[module-runtime-stage] ${manifests.length} Core-gesteuerte Laufzeitpaket(e) nach ${outputRoot} geschrieben.`);
