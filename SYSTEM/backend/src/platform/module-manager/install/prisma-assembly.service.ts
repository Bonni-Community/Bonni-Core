import { promises as fs } from "node:fs";
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

function normalizedPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
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

async function countPrismaFiles(directory: string, root: string, excludes: string[]): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(root, entryPath);
    if (isExcluded(relative, excludes)) continue;

    if (entry.isDirectory()) {
      count += await countPrismaFiles(entryPath, root, excludes);
    } else if (entry.isFile() && entry.name.endsWith(".prisma")) {
      count += 1;
    }
  }

  return count;
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
  const targetSetting = manifest.prisma?.assembled?.trim();
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

  const sourceStats = await fs.stat(source).catch(() => null);
  if (!sourceStats?.isDirectory()) {
    throw Object.assign(new Error("MODULE_PRISMA_SOURCE_NOT_FOUND"), {
      statusCode: 400,
      details: { key: manifest.key, source: path.relative(root, source) },
    });
  }

  const files = await countPrismaFiles(source, source, excludes);
  if (!files) {
    throw Object.assign(new Error("MODULE_PRISMA_SOURCE_EMPTY"), {
      statusCode: 400,
      details: { key: manifest.key, source: path.relative(root, source) },
    });
  }

  const temporaryTarget = `${target}.installing-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });

  try {
    await fs.cp(source, temporaryTarget, {
      recursive: true,
      force: true,
      filter: (entry) => {
        const relative = path.relative(source, entry);
        return !relative || (
          !path.basename(entry).startsWith(".")
          && !isExcluded(relative, excludes)
        );
      },
    });
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
