import express, { Router, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";

import {
  BRANDING_MAX_PNG_BYTES,
  brandingEtag,
  brandingService,
  type PublicBrandingDto,
} from "./branding.service.js";
import { createSnapshotBrandingReadService } from "./branding-snapshot.js";
import {
  authorizeSnapshotCoreBrandingMedia,
  CORE_BRANDING_MEDIA_OWNER,
} from "./branding-media-reference.js";
import { getCoreMediaStore, type ModuleMediaStore } from "../media/index.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type BrandingService = Pick<
  typeof brandingService,
  "getPublicBranding" | "updateBranding" | "updateLogo" | "resetLogo"
>;

function accountId(req: Request) {
  return String((req as Request & { auth?: { accountId?: unknown }; user?: { accountId?: unknown } })
    .auth?.accountId || (req as any).user?.accountId || "").trim();
}

function expectedRevision(req: Request) {
  return Array.isArray(req.query.expectedRevision)
    ? req.query.expectedRevision[0]
    : req.query.expectedRevision;
}

function sendPublicBranding(req: Request, res: Response, branding: PublicBrandingDto) {
  const etag = brandingEtag(branding);
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.setHeader("ETag", etag);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.json(branding);
}

export function createPublicBrandingRouter(
  service: BrandingService = brandingService,
  mediaStore?: ModuleMediaStore,
  authorizeLogo = authorizeSnapshotCoreBrandingMedia,
) {
  const router = Router();
  router.get("/", async (req, res) => {
    // getPublicBranding is deliberately fail-open to the bundled fallback.
    sendPublicBranding(req, res, await service.getPublicBranding());
  });
  router.get("/logo/:mediaId", async (req, res, next) => {
    try {
      const media = await (mediaStore || getCoreMediaStore()).read(String(req.params.mediaId || ""));
      const bytes = Buffer.from(media.bytes);
      if (
        media.moduleKey !== CORE_BRANDING_MEDIA_OWNER
        || media.kind !== "image"
        || media.mimeType !== "image/png"
        || createHash("sha256").update(bytes).digest("hex") !== media.sha256
        || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
        || !await authorizeLogo(media)
      ) throw Object.assign(new Error("CORE_MEDIA_NOT_FOUND"), { code: "CORE_MEDIA_NOT_FOUND", statusCode: 404 });
      const etag = `"sha256-${media.sha256}"`;
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", etag);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", String(media.sizeBytes));
      if (req.headers["if-none-match"] === etag) return void res.status(304).end();
      res.end(bytes);
    } catch (error) {
      next(Object.assign(new Error("CORE_MEDIA_NOT_FOUND"), {
        code: "CORE_MEDIA_NOT_FOUND",
        statusCode: 404,
        cause: error,
      }));
    }
  });
  return router;
}

export function createBrandingAdminRouter(service: BrandingService = brandingService) {
  const router = Router();

  router.put("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.updateBranding({
        displayName: req.body?.displayName,
        logoAltText: req.body?.logoAltText,
        expectedRevision: req.body?.expectedRevision,
        accountId: accountId(req),
      });
      sendPublicBranding(req, res, result);
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/logo",
    express.raw({ type: "image/png", limit: BRANDING_MAX_PNG_BYTES }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.is("image/png")) {
          throw Object.assign(new Error("BRANDING_PNG_CONTENT_TYPE_REQUIRED"), {
            code: "BRANDING_PNG_CONTENT_TYPE_REQUIRED",
            statusCode: 415,
          });
        }
        const result = await service.updateLogo({
          png: req.body,
          expectedRevision: expectedRevision(req),
          accountId: accountId(req),
        });
        sendPublicBranding(req, res, result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/logo", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.resetLogo({
        expectedRevision: expectedRevision(req),
        accountId: accountId(req),
      });
      sendPublicBranding(req, res, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const publicBrandingRouter = createPublicBrandingRouter();
export const publicBrandingSnapshotRouter = createPublicBrandingRouter(
  createSnapshotBrandingReadService() as BrandingService,
);
export const brandingAdminRouter = createBrandingAdminRouter();
