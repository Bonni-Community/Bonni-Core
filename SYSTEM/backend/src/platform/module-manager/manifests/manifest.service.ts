import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { resolveBonniProjectRoot } from "../project-root.js";
import type { ModuleKind, ModuleManifestSummary } from "../types.js";
import { parseStaticTypeScriptManifest } from "./static-manifest-parser.js";

const PACKAGE_ROOTS: Array<{ kind: ModuleKind; directories: string[] }> = [
  { kind: "app", directories: ["app", "apps"] },
  { kind: "addon", directories: ["addons", "add-on", "addon"] },
  { kind: "plugin", directories: ["plugins", "plug-in", "plugin"] },
  { kind: "bridge", directories: ["bridges", "bridge"] },
];

const MANIFEST_FILES = [
  "module.manifest.json",
  "app.manifest.json",
  "addon.manifest.json",
  "plugin.manifest.json",
  "bridge.manifest.json",
  "manifest.json",
  "manifest.ts",
] as const;

const SKIPPED_DIRECTORIES = new Set([".git", ".cache", "build", "coverage", "dist", "node_modules"]);

async function readJson(file: string) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function readManifest(file: string) {
  if (file.endsWith(".json")) return readJson(file);
  return parseStaticTypeScriptManifest(await fs.readFile(file, "utf8"));
}

function normalizeKind(value: unknown, fallback: ModuleKind): ModuleKind {
  const normalized = String(value || fallback).trim().toLowerCase().replaceAll("_", "-");
  if (["add-on", "addon"].includes(normalized)) return "addon";
  if (["plug-in", "plugin"].includes(normalized)) return "plugin";
  if (normalized === "bridge") return "bridge";
  return "app";
}

async function findManifestFiles(directory: string): Promise<string[]> {
  const manifests: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const manifestName = MANIFEST_FILES.find((candidate) => names.has(candidate));
  if (manifestName) manifests.push(path.join(directory, manifestName));

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    manifests.push(...await findManifestFiles(path.join(directory, entry.name)));
  }

  return manifests;
}

async function collectManifests(kind: ModuleKind, rootDirectory: string): Promise<ModuleManifestSummary[]> {
  const projectRoot = resolveBonniProjectRoot();
  const root = path.join(projectRoot, rootDirectory);
  if (!existsSync(root)) return [];

  const manifests: ModuleManifestSummary[] = [];
  const manifestFiles = await findManifestFiles(root);

  for (const manifestPath of manifestFiles) {
    try {
      const manifest = await readManifest(manifestPath);
      const packageRoot = path.dirname(manifestPath);
      const key = String(manifest.key || manifest.id || path.basename(packageRoot)).trim();
      if (!key) continue;

      manifests.push({
        ...manifest,
        key,
        kind: normalizeKind(manifest.kind || manifest.type, kind),
        name: manifest.name || manifest.label || key,
        version: manifest.version || "0.0.0",
        description: manifest.description,
        backend: manifest.backend,
        frontend: manifest.frontend,
        prisma: manifest.prisma,
        provides: manifest.provides,
        dependsOn: manifest.dependsOn,
        permissions: manifest.permissions,
        navigation: manifest.navigation,
        compatibility: manifest.compatibility,
        installation: manifest.installation,
        metadata: manifest.metadata,
        sourcePath: path.relative(projectRoot, packageRoot).replaceAll("\\", "/"),
        manifestPath: path.relative(projectRoot, manifestPath).replaceAll("\\", "/"),
      });
    } catch (error) {
      const relativePath = path.relative(projectRoot, manifestPath).replaceAll("\\", "/");
      console.warn(`[module-manager] Manifest ${relativePath} wurde ignoriert:`, error instanceof Error ? error.message : error);
    }
  }

  return manifests;
}

export async function listModuleManifests(): Promise<ModuleManifestSummary[]> {
  const groups = await Promise.all(
    PACKAGE_ROOTS.flatMap((root) => root.directories.map((directory) => collectManifests(root.kind, directory))),
  );
  const unique = new Map<string, ModuleManifestSummary>();
  for (const manifest of groups.flat()) {
    if (!unique.has(manifest.key)) unique.set(manifest.key, manifest);
  }
  return [...unique.values()].sort((left, right) => left.kind.localeCompare(right.kind, "de") || left.name.localeCompare(right.name, "de"));
}

export async function findModuleManifest(key: string): Promise<ModuleManifestSummary | null> {
  const manifests = await listModuleManifests();
  return manifests.find((manifest) => manifest.key === key) || null;
}

export function validateModuleManifest(manifest: any) {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") errors.push("Manifest muss ein Objekt sein.");
  if (!String(manifest?.key || manifest?.id || "").trim()) errors.push("Manifest braucht key oder id.");
  const kind = String(manifest?.kind || manifest?.type || "").trim();
  if (!kind || !["app", "add-on", "addon", "plug-in", "plugin", "bridge"].includes(kind)) {
    errors.push("Manifest kind muss app, addon, plugin oder bridge sein.");
  }
  if (!String(manifest?.version || "").trim()) errors.push("Manifest braucht version.");
  return { ok: errors.length === 0, errors };
}
