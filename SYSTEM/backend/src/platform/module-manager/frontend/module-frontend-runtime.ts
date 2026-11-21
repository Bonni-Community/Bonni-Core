import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";

import { listModuleManifests } from "../manifests/index.js";
import { resolveBonniProjectRoot } from "../project-root.js";
import { findInstalledModule } from "../registry/index.js";
import { registerPublicModuleAssetMount } from "../../../core/http/browser-origin.js";

async function isModuleEnabled(key: string) {
  const installed = await findInstalledModule(key);
  return Boolean(installed?.enabled);
}

function isHashedBuildAssetRequest(requestPath: string) {
  const normalized = path.posix.normalize(`/${String(requestPath || "")}`);
  return (
    normalized.startsWith("/assets/")
    && !normalized.includes("..")
    && /^\/assets\/[a-z0-9/_.-]+$/i.test(normalized)
  );
}

function setFrontendResourceHeaders(res: express.Response, opaqueExtension = false, localProcessing = false) {
  // Das Modul-iframe besitzt absichtlich eine undurchsichtige Origin. Seine
  // unveraenderlichen Build-Dateien muessen deshalb explizit als oeffentliche
  // Ressourcen markiert werden. API-, Auth- und Nutzdaten sind davon nicht
  // betroffen und bleiben durch Core geschuetzt.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  // Gourmet is nested inside the opaque Stüberl frame. CSP 'self' cannot
  // describe that opaque ancestor. Keep the remaining policy and all API
  // guards; only this declared extension's static UI needs the exception.
  if (opaqueExtension || localProcessing) {
    const policy = res.getHeader("Content-Security-Policy");
    if (typeof policy === "string") {
      res.setHeader("Content-Security-Policy", policy.split(";")
        .filter(directive => !/^\s*(?:worker-src|connect-src)(?:\s|$)/i.test(directive) && !(opaqueExtension && /^\s*frame-ancestors(?:\s|$)/i.test(directive)))
        .map(directive=>/^\s*script-src\s/i.test(directive)?directive+" 'wasm-unsafe-eval'":directive)
        .concat(["worker-src 'self' blob:","connect-src 'self' blob:"]).join(";"));
    }
  }
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

function safePublicEntry(value: unknown) {
  const configured = String(value || "").trim().replace(/\/$/, "");
  if (!configured || !/^\/[a-z0-9/_-]+$/i.test(configured) || configured.includes("..")) {
    return null;
  }
  if (configured === "/api" || configured.startsWith("/api/")) return null;
  return configured;
}

function safeModuleRoute(value: unknown) {
  const configured = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(configured)) return null;
  return configured;
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
    const extensionTarget = manifest.metadata?.extensionTarget as Record<string, unknown> | undefined;
    const opaqueExtension = manifest.key === "addon.gourmet" && manifest.kind === "addon"
      && extensionTarget?.moduleKey === "app.stueberlapp"
      && frontend?.transport === "opaque-rpc-v1";

    if (!frontend || !sourcePath || frontend.integration !== "iframe") continue;

    const packageRoot = path.resolve(root, sourcePath);
    const relativePackageRoot = path.relative(root, packageRoot);
    if (relativePackageRoot.startsWith("..") || path.isAbsolute(relativePackageRoot)) continue;

    const publicRoot = resolvePublicRoot(packageRoot, frontend.publicRoot);
    if (!publicRoot) continue;

    const assetsOnly = !frontend.entry && !frontend.runtimeEntry && !frontend.route;
    const indexFile = path.join(publicRoot, "index.html");
    if (!assetsOnly && !existsSync(indexFile)) {
      console.warn("[module-manager] Frontend build missing", {
        module: manifest.key,
        expected: publicRoot,
      });
    }

    const mountPath = safeMountPath(frontend.mountPath, manifest.key);
    if (!/^\/api(?:\/|$)/i.test(mountPath)) registerPublicModuleAssetMount(app, mountPath);
    const serveStaticFrontend = express.static(publicRoot, {
      index: assetsOnly ? false : "index.html",
      // App-Builds werden separat aktualisiert. Nach einer frueheren
      // JSON-Fehlantwort darf der Browser diese URL nicht mit 304 weiter aus
      // seinem fehlerhaften Cache bedienen.
      etag: false,
      lastModified: false,
      cacheControl: false,
      setHeaders(response) {
        response.setHeader("Cache-Control", "no-store");
        setFrontendResourceHeaders(response, opaqueExtension, frontend.localProcessing === true);
      },
    });

    // Die Route wird für jedes entdeckte Manifest registriert. Ob die App
    // aktuell aktiviert ist und ob ihr Build inzwischen vorhanden ist, wird
    // pro Request geprüft. Dadurch funktionieren Aktivierung und ein späterer
    // lokaler Build ohne einen weiteren Backend-Neustart.
    app.use(mountPath, async (req, res, next) => {
      try {
        const buildAsset = isHashedBuildAssetRequest(req.path);

        // index.html und sonstige App-Einstiege bleiben an den aktivierten
        // Modulstatus gebunden. Gehashte JS-/CSS-/Bilddateien enthalten keine
        // Sitzung oder Benutzerdaten und duerfen unmittelbar nach der
        // Aktivierung geladen werden. So kann ein kurz zuvor gelesener Status
        // niemals JSON an eine JavaScript-URL liefern.
        if (!buildAsset && !await isModuleEnabled(manifest.key)) {
          next();
          return;
        }

        if (!assetsOnly && !existsSync(indexFile)) {
          res.status(503).json({
            error: "MODULE_FRONTEND_BUILD_MISSING",
            message: `Frontend build missing for ${manifest.key}`,
          });
          return;
        }

        setFrontendResourceHeaders(res, opaqueExtension, frontend.localProcessing === true);
        serveStaticFrontend(req, res, next);
      } catch (error) {
        next(error);
      }
    });

    const publicEntry = safePublicEntry(frontend.publicEntry);
    if (publicEntry) {
      const sendPublicEntry = async (
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        try {
          if (!await isModuleEnabled(manifest.key)) {
            next();
            return;
          }
          if (!assetsOnly && !existsSync(indexFile)) {
            res.status(503).json({
              error: "MODULE_FRONTEND_BUILD_MISSING",
              message: `Frontend build missing for ${manifest.key}`,
            });
            return;
          }
          setFrontendResourceHeaders(res);
          res.sendFile(indexFile);
        } catch (error) {
          next(error);
        }
      };
      app.get(publicEntry, sendPublicEntry);
      app.get(`${publicEntry}/join/:inviteCode`, sendPublicEntry);
      app.get(`${publicEntry}/poll/:inviteCode`, sendPublicEntry);
    }

    const memberEntry = safePublicEntry(frontend.memberEntry);
    const memberRoute = safeModuleRoute(frontend.route);
    if (memberEntry && memberRoute && memberEntry !== publicEntry) {
      app.get(memberEntry, async (_req, res, next) => {
        try {
          if (!await isModuleEnabled(manifest.key)) {
            next();
            return;
          }

          // Die lesbare Member-Adresse ist nur ein sicherer Einstieg in den
          // Core. Login, Rechteprüfung und App-Transport verbleiben dadurch
          // vollständig in Bonni Core; das App-Frontend wird hier nie direkt
          // als angemeldete Oberfläche ausgeliefert.
          res.redirect(302, `/#${encodeURIComponent(memberRoute)}`);
        } catch (error) {
          next(error);
        }
      });
    }
  }
}
