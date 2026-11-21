import express, { type Express, type Response, type NextFunction } from "express";
import path from "node:path";
import { existsSync } from "node:fs";

function sendIndexIfExists(res: Response, indexFile: string, next: NextFunction) {
  if (!existsSync(indexFile)) {
    next();
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.sendFile(indexFile);
}

export function registerClosedSystemFrontend(app: Express) {
  const frontendRoot = process.env.FRONTEND_DIST_ROOT ?? path.resolve(process.cwd(), "public");
  const systemFrontend = path.join(frontendRoot, "system");
  if (existsSync(systemFrontend)) {
    app.use(express.static(systemFrontend, { index: false }));
    // Missing app entries/build assets must never receive the Core HTML.
    // In an opaque iframe that HTML loads /assets from the wrong application
    // and leaves a white frame when the origin guard rejects those requests.
    app.get(/^\/(?!api(?:\/|$)|assets(?:\/|$)|feature-modules(?:\/|$)).*$/i, (req, res, next) => {
      const moduleMounts: Set<string> | undefined = app.locals.bonniPublicModuleAssetMounts;
      if (moduleMounts && [...moduleMounts].some(mount => req.path === mount || req.path.startsWith(`${mount}/`))) {
        next();
        return;
      }
      sendIndexIfExists(res, path.join(systemFrontend, "index.html"), next);
    });
  }
}

