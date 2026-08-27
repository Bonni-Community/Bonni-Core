import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERATED_ENTRY_ASSET = /^index-[A-Za-z0-9_-]+\.(?:js|css)(?:\.map)?$/;
const MODULE_CONTAINER_DIRECTORIES = [
  "app",
  "apps",
  "addons",
  "add-on",
  "addon",
  "plugins",
  "plug-in",
  "plugin",
  "bridges",
  "bridge",
];
const KONTOR_CANONICAL_FILES = [
  "app/kontorapp/manifest.ts",
  "app/kontorapp/contracts/kontorapp-rpc.v1.json",
  "app/kontorapp/prisma/domains/kontorapp/kontorapp.prisma",
];
const KONTOR_LEGACY_PATHS = [
  "app/kontorapp/prisma/domains/kontorapp/meetings.prisma",
  "app/kontorapp/frontend/.env.example",
  "app/kontorapp/frontend/src/kontorapp/auth",
  "app/kontorapp/frontend/src/kontorapp/core/api/apiConfig.js",
  "app/kontorapp/frontend/src/kontorapp/core/api/authApi.js",
  "app/kontorapp/frontend/src/kontorapp/entry.jsx",
  "app/kontorapp/frontend/src/kontorapp/index.js",
  "app/kontorapp/frontend/src/kontorapp/manifest.js",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Member",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/pages/MemberBierdeckelPage.jsx",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/pages/MemberKontoPage.jsx",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/pages/MemberRechnungPage.jsx",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/views/bierdeckel",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/views/konto",
  "app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/views/rechnung",
];
const KONTOR_REPLACED_PACKAGE_PATHS = [
  "app/vereinsapp",
  "apps/vereinsapp",
];
const FAILED_INSTALL_DIRECTORIES = [
  "backend/node_modules.failed",
  "frontend/node_modules.failed",
];
const MANIFEST_NAMES = [
  "manifest.ts",
  "manifest.json",
  "app.manifest.json",
  "module.manifest.json",
];

function assetReferences(html) {
  const references = new Set();
  const expression = /(?:src|href)=["']([^"'?#]+)(?:[?#][^"']*)?["']/g;

  for (const match of html.matchAll(expression)) {
    const url = String(match[1] || "").replaceAll("\\", "/");
    const markerIndex = url.lastIndexOf("/assets/");
    const reference = markerIndex >= 0
      ? url.slice(markerIndex + "/assets/".length)
      : url.startsWith("assets/")
        ? url.slice("assets/".length)
        : null;
    if (reference && !reference.includes("/")) references.add(reference);
  }
  return references;
}

async function directoryExists(directory) {
  try {
    const state = await fs.lstat(directory);
    return state.isDirectory() && !state.isSymbolicLink();
  } catch {
    return false;
  }
}

async function regularFileExists(file) {
  try {
    const state = await fs.lstat(file);
    return state.isFile() && !state.isSymbolicLink();
  } catch {
    return false;
  }
}

async function safeStateInside(rootDirectory, targetPath) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;

  const relative = path.relative(root, target);
  let cursor = root;
  const segments = relative ? relative.split(path.sep) : [];
  const rootState = await fs.lstat(root).catch(() => null);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) return null;

  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const state = await fs.lstat(cursor).catch(() => null);
    if (!state || state.isSymbolicLink()) return null;
    if (index < segments.length - 1 && !state.isDirectory()) return null;
    if (index === segments.length - 1) return state;
  }
  return rootState;
}

async function safeDirectoryInside(systemRoot, directory) {
  const state = await safeStateInside(systemRoot, directory);
  return Boolean(state?.isDirectory());
}

async function safeRegularFileInside(systemRoot, file) {
  const state = await safeStateInside(systemRoot, file);
  return Boolean(state?.isFile());
}

async function removeGeneratedDirectory(systemRoot, directory) {
  const root = path.resolve(systemRoot);
  const target = path.resolve(directory);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  if (!await safeDirectoryInside(root, target)) return null;
  await fs.rm(target, { recursive: true, force: true });
  return target;
}

async function cleanupGeneratedBuildArtifacts(systemRoot) {
  const removed = [];
  const coreBackendRoot = path.join(systemRoot, "backend");
  if (
    await safeRegularFileInside(systemRoot, path.join(coreBackendRoot, "package.json"))
    && await safeDirectoryInside(systemRoot, path.join(coreBackendRoot, "src"))
  ) {
    const coreBackendDist = await removeGeneratedDirectory(
      systemRoot,
      path.join(coreBackendRoot, "dist"),
    );
    if (coreBackendDist) removed.push(coreBackendDist);
  }

  const coreFrontendRoot = path.join(systemRoot, "frontend");
  if (
    await safeRegularFileInside(systemRoot, path.join(coreFrontendRoot, "package.json"))
    && await safeDirectoryInside(systemRoot, path.join(coreFrontendRoot, "src"))
  ) {
    const coreFrontendDist = await removeGeneratedDirectory(
      systemRoot,
      path.join(coreFrontendRoot, "dist"),
    );
    if (coreFrontendDist) removed.push(coreFrontendDist);
  }

  for (const containerName of MODULE_CONTAINER_DIRECTORIES) {
    const containerRoot = path.join(systemRoot, containerName);
    if (!await safeDirectoryInside(systemRoot, containerRoot)) continue;
    let modules = [];
    try {
      modules = await fs.readdir(containerRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const moduleEntry of modules) {
      if (!moduleEntry.isDirectory() || moduleEntry.isSymbolicLink()) continue;
      const moduleRoot = path.join(containerRoot, moduleEntry.name);
      for (const packageDirectory of ["backend", "frontend"]) {
        const packageRoot = path.join(moduleRoot, packageDirectory);
        const sourcePackage = await safeRegularFileInside(systemRoot, path.join(packageRoot, "package.json"));
        const sourceDirectory = await safeDirectoryInside(systemRoot, path.join(packageRoot, "src"));
        if (!sourcePackage || !sourceDirectory) continue;
        const generatedDist = await removeGeneratedDirectory(
          systemRoot,
          path.join(packageRoot, "dist"),
        );
        if (generatedDist) removed.push(generatedDist);
      }
    }
  }

  return removed;
}

async function canonicalKontorLayoutExists(systemRoot) {
  const filesExist = await Promise.all(KONTOR_CANONICAL_FILES.map((relativePath) => (
    safeRegularFileInside(systemRoot, path.join(systemRoot, ...relativePath.split("/")))
  )));
  if (filesExist.some((exists) => !exists)) return false;

  const manifest = await fs.readFile(path.join(systemRoot, "app", "kontorapp", "manifest.ts"), "utf8");
  const versionMatch = /version:\s*["'](\d+)\.(\d+)\.(\d+)["']/.exec(manifest);
  const canonicalVersion = Boolean(
    versionMatch
    && (Number(versionMatch[1]) > 0 || Number(versionMatch[2]) >= 11),
  );
  return (
    canonicalVersion
    && /transport:\s*["']opaque-rpc-v1["']/.test(manifest)
  );
}

async function cleanupLegacyKontorSources(systemRoot) {
  if (!await canonicalKontorLayoutExists(systemRoot)) return [];
  const removed = [];
  for (const relativePath of KONTOR_LEGACY_PATHS) {
    const target = path.resolve(systemRoot, ...relativePath.split("/"));
    if (!target.startsWith(`${path.resolve(systemRoot)}${path.sep}`)) continue;
    if (!await safeStateInside(systemRoot, target)) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

async function isLegacyVereinsAppPackage(systemRoot, packageRoot) {
  for (const manifestName of MANIFEST_NAMES) {
    const manifestPath = path.join(packageRoot, manifestName);
    if (!await safeRegularFileInside(systemRoot, manifestPath)) continue;
    const source = await fs.readFile(manifestPath, "utf8");
    if (manifestName.endsWith(".json")) {
      try {
        return JSON.parse(source)?.key === "app.vereinsapp";
      } catch {
        return false;
      }
    }
    return /\bkey\s*:\s*["']app\.vereinsapp["']/.test(source);
  }
  return false;
}

async function cleanupReplacedKontorPackage(systemRoot) {
  if (!await canonicalKontorLayoutExists(systemRoot)) return [];
  const removed = [];
  for (const relativePath of KONTOR_REPLACED_PACKAGE_PATHS) {
    const target = path.resolve(systemRoot, ...relativePath.split("/"));
    if (!target.startsWith(`${path.resolve(systemRoot)}${path.sep}`)) continue;
    if (!await safeDirectoryInside(systemRoot, target) || !await isLegacyVereinsAppPackage(systemRoot, target)) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

async function cleanupFailedInstallDirectories(systemRoot) {
  const removed = [];
  for (const relativePath of FAILED_INSTALL_DIRECTORIES) {
    const target = path.resolve(systemRoot, ...relativePath.split("/"));
    if (!target.startsWith(`${path.resolve(systemRoot)}${path.sep}`)) continue;
    if (!await safeDirectoryInside(systemRoot, target)) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

async function frontendDistDirectories(systemRoot) {
  const directories = [];
  const sourceCoreFrontend = await safeRegularFileInside(systemRoot, path.join(systemRoot, "frontend", "package.json"));
  const coreDist = path.join(systemRoot, "frontend", "dist");
  if (sourceCoreFrontend && await safeDirectoryInside(systemRoot, coreDist)) directories.push(coreDist);
  const publishedCoreDist = path.join(systemRoot, "backend", "public", "system");
  if (sourceCoreFrontend && await safeDirectoryInside(systemRoot, publishedCoreDist)) directories.push(publishedCoreDist);

  for (const containerName of MODULE_CONTAINER_DIRECTORIES) {
    const containerRoot = path.join(systemRoot, containerName);
    if (!await safeDirectoryInside(systemRoot, containerRoot)) continue;
    let modules = [];
    try {
      modules = await fs.readdir(containerRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const moduleEntry of modules) {
      if (!moduleEntry.isDirectory() || moduleEntry.isSymbolicLink()) continue;
      const dist = path.join(containerRoot, moduleEntry.name, "frontend", "dist");
      if (await safeDirectoryInside(systemRoot, dist)) directories.push(dist);
    }
  }

  return directories;
}

async function cleanupObsoleteModuleEntries(distRoot) {
  const moduleRoot = path.dirname(path.dirname(distRoot));
  const manifestPath = path.join(moduleRoot, "manifest.ts");
  if (!await regularFileExists(manifestPath)) return [];
  const manifest = await fs.readFile(manifestPath, "utf8");
  const runtimeEntry = /runtimeEntry:\s*["'][^"']*\/(index-\d+\.\d+\.\d+\.html)["']/.exec(manifest)?.[1];
  if (!runtimeEntry) return [];
  const removed = [];
  for (const entry of await fs.readdir(distRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^index-\d+\.\d+\.\d+\.html$/.test(entry.name) || entry.name === runtimeEntry) continue;
    const target = path.join(distRoot, entry.name);
    await fs.rm(target, { force: true });
    removed.push(target);
  }
  return removed;
}

export async function cleanupFrontendDist(distDirectory) {
  const distRoot = path.resolve(distDirectory);
  const realDistRoot = await fs.realpath(distRoot).catch(() => null);
  if (!realDistRoot || path.resolve(realDistRoot) !== distRoot) return [];
  const assetsRoot = path.join(distRoot, "assets");
  if (!await directoryExists(assetsRoot)) return [];

  const removed = await cleanupObsoleteModuleEntries(distRoot);

  const rootEntries = await fs.readdir(distRoot, { withFileTypes: true });
  const htmlFiles = rootEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".html"));
  if (!htmlFiles.length) return [];

  const referencedAssets = new Set();
  for (const htmlFile of htmlFiles) {
    const html = await fs.readFile(path.join(distRoot, htmlFile.name), "utf8");
    for (const reference of assetReferences(html)) referencedAssets.add(reference);
  }

  const assetEntries = await fs.readdir(assetsRoot, { withFileTypes: true });
  for (const entry of assetEntries) {
    if (
      !entry.isFile()
      || !GENERATED_ENTRY_ASSET.test(entry.name)
      || referencedAssets.has(entry.name)
    ) continue;

    const target = path.join(assetsRoot, entry.name);
    if (!target.startsWith(`${assetsRoot}${path.sep}`)) continue;
    await fs.rm(target, { force: true });
    removed.push(target);
  }

  return removed;
}

export async function cleanupStaleTechnicalData(systemRoot, options = {}) {
  const resolvedSystemRoot = path.resolve(systemRoot);
  const removed = options.beforeBuild === true
    ? await cleanupGeneratedBuildArtifacts(resolvedSystemRoot)
    : [];
  const distDirectories = await frontendDistDirectories(resolvedSystemRoot);

  for (const distDirectory of distDirectories) {
    removed.push(...await cleanupFrontendDist(distDirectory));
  }

  removed.push(...await cleanupLegacyKontorSources(resolvedSystemRoot));
  removed.push(...await cleanupReplacedKontorPackage(resolvedSystemRoot));
  removed.push(...await cleanupFailedInstallDirectories(resolvedSystemRoot));

  return removed;
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const systemRoot = path.resolve(scriptDirectory, "../../..");
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => argument !== "--before-build")) {
    throw new Error(`TECHNICAL_CLEANUP_ARGUMENT_INVALID:${argumentsList.join(",")}`);
  }
  const removed = await cleanupStaleTechnicalData(systemRoot, {
    beforeBuild: argumentsList.includes("--before-build"),
  });

  if (!removed.length) {
    console.info("[technical-cleanup] Keine alten technischen Build-Dateien gefunden.");
    return;
  }

  for (const file of removed) {
    console.info(`[technical-cleanup] entfernt: ${path.relative(systemRoot, file)}`);
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error("[technical-cleanup] fehlgeschlagen", error);
    process.exitCode = 1;
  });
}
