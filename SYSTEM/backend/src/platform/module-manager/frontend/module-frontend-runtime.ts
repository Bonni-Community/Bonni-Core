import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";

import { listModuleManifests } from "../manifests/index.js";
import { resolveBonniProjectRoot } from "../project-root.js";
import { findInstalledModule } from "../registry/index.js";

const MODULE_STATUS_CACHE_MS = 1_000;
const moduleStatusCache = new Map<string, { enabled: boolean; expiresAt: number }>();

async function isModuleEnabled(key: string) {
  const now = Date.now();
  const cached = moduleStatusCache.get(key);
  if (cached && cached.expiresAt > now) return cached.enabled;

  const installed = await findInstalledModule(key);
  const enabled = Boolean(installed?.enabled);
  moduleStatusCache.set(key, { enabled, expiresAt: now + MODULE_STATUS_CACHE_MS });
  return enabled;
}

function safeMountPath(value: unknown, moduleKey: string) {
  const configured = String(value || "").trim();
  if (/^\/[a-z0-9/_-]+$/i.test(configured) && !configured.includes("..")) {
    return configured.replace(/\/$/, "");
  }

  const slug = moduleKey
    .toLowerCase()
    .replace(/^app\./, "")
    .replace(/[^a-z0-9_-]+/g, "-");

  return `/feature-modules/${slug}`;
}

function resolvePublicRoot(packageRoot: string, configuredRoot: unknown) {
  const relativeRoot = String(configuredRoot || "frontend/dist").trim();
  if (!relativeRoot || path.isAbsolute(relativeRoot)) return null;

  const resolved = path.resolve(packageRoot, relativeRoot);
  const relative = path.relative(packageRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  return resolved;
}

/**
 * Serves every enabled app from its own build directory. The Core frontend
 * never imports app source code; an installed app is addressed exclusively
 * through its manifest and can therefore be added or removed independently.
 */
export async function registerModuleFrontends(app: Express) {
  const root = resolveBonniProjectRoot();
  const manifests = await listModuleManifests();

  for (const manifest of manifests) {
    const frontend = manifest?.frontend;
    const sourcePath = manifest?.sourcePath;

    if (!frontend || !sourcePath || frontend.integration !== "iframe") continue;

    const packageRoot = path.resolve(root, sourcePath);
    const relativePackageRoot = path.relative(root, packageRoot);
    if (relativePackageRoot.startsWith("..") || path.isAbsolute(relativePackageRoot)) continue;

    const publicRoot = resolvePublicRoot(packageRoot, frontend.publicRoot);
    if (!publicRoot) continue;

    const indexFile = path.join(publicRoot, "index.html");
    if (!existsSync(indexFile)) {
      console.warn("[module-manager] Frontend build missing", {
        module: manifest.key,
        expected: publicRoot,
      });
    }

    const mountPath = safeMountPath(frontend.mountPath, manifest.key);
    const serveStaticFrontend = express.static(publicRoot, { index: "index.html" });

    // Die Route wird für jedes entdeckte Manifest registriert. Ob die App
    // aktuell aktiviert ist und ob ihr Build inzwischen vorhanden ist, wird
    // pro Request geprüft. Dadurch funktionieren Aktivierung und ein späterer
    // lokaler Build ohne einen weiteren Backend-Neustart.
    app.use(mountPath, async (req, res, next) => {
      try {
        if (!await isModuleEnabled(manifest.key)) {
          next();
          return;
        }

        if (!existsSync(indexFile)) {
          res.status(503).json({
            error: "MODULE_FRONTEND_BUILD_MISSING",
            message: `Frontend build missing for ${manifest.key}`,
          });
          return;
        }

        serveStaticFrontend(req, res, next);
      } catch (error) {
        next(error);
      }
    });
  }
}
