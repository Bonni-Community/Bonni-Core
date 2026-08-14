import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { resolveBonniProjectRoot } from "../project-root.js";
import type { ModuleManifestSummary } from "../types.js";

type PrismaAssemblyResult = {
  assembled: true;
  source: string;
  target: string;
  files: number;
  requiresPrismaGenerate: true;
  requiresDatabaseSync: true;
  requiresRestart: true;
};

function assertInside(parent: string, candidate: string, code: string) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(code), {
      statusCode: 400,
      details: { parent, candidate },
    });
  }
}

function assertInsideOrEqual(parent: string, candidate: string, code: string) {
  const relative = path.relative(parent, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(code), {
      statusCode: 400,
      details: { parent, candidate },
    });
  }
}

function normalizedPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function defaultAssemblySetting(manifest: ModuleManifestSummary) {
  const kindDirectory = manifest.kind === "addon"
    ? "add-on"
    : manifest.kind === "plugin"
      ? "plug-in"
      : manifest.kind;
  const prefix = `${manifest.kind}.`;
  const suffix = manifest.key.startsWith(prefix)
    ? manifest.key.slice(prefix.length)
    : manifest.key;
  const segments = suffix.split(".").filter(Boolean);
  if (!segments.length || segments.some((segment) => !/^[a-z0-9][a-z0-9-]{0,99}$/.test(segment))) {
    throw Object.assign(new Error("MODULE_PRISMA_DEFAULT_TARGET_INVALID"), {
      statusCode: 400,
      details: { key: manifest.key },
    });
  }
  return `backend/prisma/domains/assembled/${kindDirectory}/${segments.join("/")}`;
}

function isExcluded(relativePath: string, patterns: string[]) {
  const candidate = normalizedPath(relativePath);

  return patterns.some((patternValue) => {
    const pattern = normalizedPath(patternValue);
    if (!pattern) return false;

    if (pattern.endsWith("/**")) {
      const directory = pattern.slice(0, -3).replace(/\/$/, "");
      return candidate === directory || candidate.startsWith(`${directory}/`);
    }

    return candidate === pattern;
  });
}

async function inspectSourceEntry(entryPath: string, realPackageRoot: string) {
  const stats = await fs.lstat(entryPath).catch(() => null);
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    throw Object.assign(new Error("MODULE_PRISMA_SOURCE_SYMLINK_DENIED"), {
      statusCode: 400,
      details: { source: entryPath },
    });
  }
  if (!stats.isDirectory() && !stats.isFile()) {
    throw Object.assign(new Error("MODULE_PRISMA_SOURCE_ENTRY_INVALID"), {
      statusCode: 400,
      details: { source: entryPath },
    });
  }

  const realEntryPath = await fs.realpath(entryPath);
  assertInsideOrEqual(
    realPackageRoot,
    realEntryPath,
    "MODULE_PRISMA_SOURCE_OUTSIDE_PACKAGE",
  );
  return stats;
}

async function copySourceFile(source: string, target: string) {
  const handle = await fs.open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw Object.assign(new Error("MODULE_PRISMA_SOURCE_ENTRY_INVALID"), {
        statusCode: 400,
        details: { source },
      });
    }
    await fs.writeFile(target, await handle.readFile(), { flag: "wx" });
  } finally {
    await handle.close();
  }
}

async function copyPrismaDirectory(
  source: string,
  target: string,
  sourceRoot: string,
  realPackageRoot: string,
  excludes: string[],
): Promise<number> {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  let prismaFiles = 0;

  for (const entry of entries) {
    const entryPath = path.join(source, entry.name);
    const relative = path.relative(sourceRoot, entryPath);
    if (
      entry.name.startsWith(".")
      || isExcluded(relative, excludes)
    ) {
      continue;
    }

    const stats = await inspectSourceEntry(entryPath, realPackageRoot);
    if (!stats) {
      throw Object.assign(new Error("MODULE_PRISMA_SOURCE_CHANGED"), {
        statusCode: 400,
        details: { source: entryPath },
      });
    }

    const targetPath = path.join(target, entry.name);
    if (stats.isDirectory()) {
      prismaFiles += await copyPrismaDirectory(
        entryPath,
        targetPath,
        sourceRoot,
        realPackageRoot,
        excludes,
      );
    } else {
      await copySourceFile(entryPath, targetPath);
      if (entry.name.endsWith(".prisma")) prismaFiles += 1;
    }
  }

  return prismaFiles;
}

/**
 * Kopiert die Prisma-Quellen eines installierten Moduls in Bonni Cores
 * technischen Assembly-Bereich. Fachliche Quellen bleiben ausschließlich im
 * Modul; das Ziel darf bei jeder Installation vollständig neu aufgebaut werden.
 */
export async function assembleModulePrisma(
  manifest: ModuleManifestSummary,
): Promise<PrismaAssemblyResult | null> {
  const sourceSetting = manifest.prisma?.source?.trim();
  const targetSetting = manifest.prisma?.assembled?.trim()
    || (sourceSetting ? defaultAssemblySetting(manifest) : "");
  const excludes = Array.isArray(manifest.prisma?.exclude)
    ? manifest.prisma.exclude.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (!sourceSetting && !targetSetting) return null;

  if (!sourceSetting || !targetSetting) {
    throw Object.assign(new Error("MODULE_PRISMA_CONFIG_INCOMPLETE"), {
      statusCode: 400,
      details: { key: manifest.key },
    });
  }

  const root = resolveBonniProjectRoot();
  const packageRoot = path.resolve(root, manifest.sourcePath || "");
  const source = path.resolve(packageRoot, sourceSetting);
  const assemblyRoot = path.resolve(root, "backend", "prisma", "domains", "assembled");
  const target = path.resolve(root, targetSetting);

  assertInside(packageRoot, source, "MODULE_PRISMA_SOURCE_OUTSIDE_PACKAGE");
  assertInside(assemblyRoot, target, "MODULE_PRISMA_TARGET_OUTSIDE_ASSEMBLY");

  const [realProjectRoot, packageRootStats] = await Promise.all([
    fs.realpath(root),
    fs.lstat(packageRoot).catch(() => null),
  ]);
  if (!packageRootStats?.isDirectory() || packageRootStats.isSymbolicLink()) {
    throw Object.assign(new Error("MODULE_PRISMA_PACKAGE_ROOT_INVALID"), {
      statusCode: 400,
      details: { key: manifest.key },
    });
  }
  const realPackageRoot = await fs.realpath(packageRoot);
  assertInside(realProjectRoot, realPackageRoot, "MODULE_PRISMA_PACKAGE_OUTSIDE_PROJECT");

  const sourceStats = await inspectSourceEntry(source, realPackageRoot);
  if (!sourceStats || (!sourceStats.isDirectory() && !(sourceStats.isFile() && source.endsWith(".prisma")))) {
    throw Object.assign(new Error("MODULE_PRISMA_SOURCE_NOT_FOUND"), {
      statusCode: 400,
      details: { key: manifest.key, source: path.relative(root, source) },
    });
  }

  const temporaryTarget = `${target}.installing-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });

  let files = 0;
  try {
    if (sourceStats.isFile()) {
      await fs.mkdir(temporaryTarget, { recursive: true });
      if (!isExcluded(path.basename(source), excludes)) {
        await copySourceFile(source, path.join(temporaryTarget, path.basename(source)));
        files = 1;
      }
    } else {
      files = await copyPrismaDirectory(
        source,
        temporaryTarget,
        source,
        realPackageRoot,
        excludes,
      );
    }
    if (!files) {
      throw Object.assign(new Error("MODULE_PRISMA_SOURCE_EMPTY"), {
        statusCode: 400,
        details: { key: manifest.key, source: path.relative(root, source) },
      });
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(temporaryTarget, target);
  } catch (error) {
    await fs.rm(temporaryTarget, { recursive: true, force: true });
    throw error;
  }

  return {
    assembled: true,
    source: path.relative(root, source).replaceAll("\\", "/"),
    target: path.relative(root, target).replaceAll("\\", "/"),
    files,
    requiresPrismaGenerate: true,
    requiresDatabaseSync: true,
    requiresRestart: true,
  };
}
