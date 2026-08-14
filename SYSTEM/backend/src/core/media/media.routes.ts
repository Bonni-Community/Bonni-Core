import { Router, type NextFunction, type Request, type Response } from "express";

import {
  getCoreMediaStore,
  type ModuleMediaStore,
  type StoredModuleMedia,
} from "./module-media-runtime.js";

function safeDownloadName(value: string) {
  const fallback = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 120) || "download";
  const encoded = encodeURIComponent(value)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function applyMediaHeaders(req: Request, res: Response, media: StoredModuleMedia) {
  const etag = `"sha256-${media.sha256}"`;
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", new Date(media.createdAt).toUTCString());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Type", media.mimeType);
  res.setHeader("Content-Length", String(media.sizeBytes));
  res.setHeader(
    "Content-Disposition",
    `${media.kind === "image" ? "inline" : "attachment"}; ${safeDownloadName(media.originalFileName)}`,
  );
  if (media.kind === "image") {
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  }
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return false;
  }
  return true;
}

type VerifiedCoreMediaUser = {
  accountId?: unknown;
  id?: unknown;
  type?: unknown;
  allowedApps?: unknown;
};

function normalizedStringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))]
    : [];
}

function verifiedCoreIdentity(req: Request): VerifiedCoreMediaUser | null {
  const request = req as Request & {
    bonniIdentityVerified?: boolean;
    user?: VerifiedCoreMediaUser;
  };
  if (
    request.bonniIdentityVerified !== true
    || !String(request.user?.accountId || request.user?.id || "").trim()
  ) {
    return null;
  }
  return request.user || null;
}

function mayReadProtectedMedia(user: VerifiedCoreMediaUser, moduleKey: string) {
  if (String(user.type || "").trim().toUpperCase() === "ADMIN") return true;
  return normalizedStringList(user.allowedApps).includes(moduleKey.toLowerCase());
}

export function createMediaFilesRouter(store?: ModuleMediaStore) {
  const router = Router();
  router.get("/:mediaId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mediaId = Array.isArray(req.params.mediaId)
        ? req.params.mediaId[0]
        : req.params.mediaId;
      // Resolve the default store lazily. This keeps .env loading authoritative
      // even though the route module itself is imported during ESM bootstrap.
      const media = await (store || getCoreMediaStore()).read(mediaId);
      // Browser-native <img>-Elemente können keinen Authorization-Header
      // mitsenden. Sichere Bildformate bleiben deshalb über ihre 192-Bit
      // Capability-ID direkt darstellbar. Dokumente und sonstige Binärdaten
      // brauchen dagegen immer eine vom Core verifizierte Identität.
      if (media.kind !== "image") {
        const identity = verifiedCoreIdentity(req);
        if (!identity) {
          throw Object.assign(new Error("CORE_MEDIA_AUTH_REQUIRED"), {
            code: "CORE_MEDIA_AUTH_REQUIRED",
            statusCode: 401,
          });
        }
        if (!mayReadProtectedMedia(identity, media.moduleKey)) {
          throw Object.assign(new Error("CORE_MEDIA_MODULE_ACCESS_FORBIDDEN"), {
            code: "CORE_MEDIA_MODULE_ACCESS_FORBIDDEN",
            statusCode: 403,
          });
        }
      }
      if (!applyMediaHeaders(req, res, media)) return;
      res.end(media.bytes);
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export const mediaFilesRouter = createMediaFilesRouter();
