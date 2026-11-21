import cors from "cors";
import type { Express, Request, RequestHandler } from "express";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function registerPublicModuleAssetMount(app: Express, mountPath: string) {
  if (!/^\/[a-z0-9/_-]+$/i.test(mountPath) || /^\/api(?:\/|$)/i.test(mountPath)) throw new Error("PUBLIC_MODULE_ASSET_MOUNT_INVALID");
  const mounts: Set<string> = app.locals.bonniPublicModuleAssetMounts ??= new Set<string>();
  mounts.add(mountPath.replace(/\/$/, ""));
}

function publicModuleAsset(req: Request): boolean {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) || /^\/api(?:\/|$)/i.test(req.path)) return false;
  const mounts: Set<string> | undefined = req.app.locals.bonniPublicModuleAssetMounts;
  if (!mounts) return false;
  for (const mount of mounts) {
    if (!req.path.startsWith(`${mount}/`)) continue;
    const relative = req.path.slice(mount.length + 1);
    // Local OCR/PDF binaries are public build assets of Gourmet only. This
    // grants no opaque-origin access to APIs, documents or user media.
    if((mount==='/feature-modules/gourmet' || mount==='/feature-modules/capture') && /^assets\/(?:import|capture)\/[a-z0-9/_-]+\/[a-z0-9/_.-]+\.(?:wasm|gz|bcmap|ttf|pfb)$/i.test(relative)
      && !relative.split('/').some(segment=>segment==='.'||segment==='..'))return true;
    if (/^[a-z0-9/_-][a-z0-9/_.-]*\.(?:m?js|css|woff2?|png|jpe?g|webp|gif|svg|ico)$/i.test(relative)
      && !relative.split("/").some(segment => segment === "." || segment === "..")) return true;
  }
  return false;
}

function originUrl(value: string, exact = true): URL | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || (exact && url.origin !== value)) return null;
    return url;
  } catch { return null; }
}

export function parseAllowedBrowserOrigins(value = ""): Set<string> {
  if (value.length > 8192) throw new Error("BONNI_ALLOWED_BROWSER_ORIGINS_INVALID");
  const origins = new Set<string>();
  for (const entry of value.split(",").map(item => item.trim()).filter(Boolean)) {
    if (!originUrl(entry)) throw new Error("BONNI_ALLOWED_BROWSER_ORIGINS_INVALID");
    origins.add(entry);
  }
  return origins;
}

export function isBrowserOriginAllowed(req: Request, allowed: ReadonlySet<string>): boolean {
  // Opaque app iframes must load their declared public build files. The
  // exception never grants access to API routes, JSON data or write methods.
  if (publicModuleAsset(req)) return true;
  const origin = req.get("origin");
  // Native clients and server-to-server calls still cross the normal auth guards.
  if (origin === undefined) return true;
  const source = originUrl(origin);
  if (!source) return false;
  if (allowed.has(source.origin)) return true;
  const authority = req.get("host");
  if (!authority || !/^[A-Za-z0-9.\[\]:-]+$/.test(authority)) return false;
  const target = originUrl(`${req.protocol}://${authority}`, false);
  if (!target) return false;
  // Vite, local recovery and the stable proxy use separate local ports.
  if (loopbackHosts.has(source.hostname) && loopbackHosts.has(target.hostname)) return true;
  return source.protocol === target.protocol && source.hostname === target.hostname;
}

export function createBrowserOriginGuard(value = process.env.BONNI_ALLOWED_BROWSER_ORIGINS): RequestHandler {
  const allowed = parseAllowedBrowserOrigins(value);
  return (req, res, next) => {
    res.vary("Origin");
    if (!isBrowserOriginAllowed(req, allowed)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(403).json({ code: "BROWSER_ORIGIN_FORBIDDEN", message: "Diese Website darf nicht auf Bonni Core zugreifen." });
      return;
    }
    next();
  };
}

// Only origins which passed the guard reach this middleware. One CORS owner
// handles preflight and normal requests consistently, without wildcard access.
export const browserCors = cors({ origin: true, credentials: false, optionsSuccessStatus: 204, maxAge: 600 });
