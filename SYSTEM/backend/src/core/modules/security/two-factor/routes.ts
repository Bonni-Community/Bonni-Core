import { Router, type Response } from "express";

import { requireAuth } from "../../../http/middleware/requireAuth.js";
import { requirePermission } from "../../../http/middleware/requirePermission.js";
import { validate } from "../../../http/middleware/validate.js";
import type { AuthenticatedRequest } from "../../../../platform/auth/session/authContext.js";
import {
  adminCreateEnrollmentSchema,
  adminRotateEnrollmentSchema,
  confirmTotpSchema,
  createChallengeSchema,
  disableTwoFactorSchema,
  regenerateRecoveryCodesSchema,
  setupTotpSchema,
  verifyChallengeSchema,
} from "./schemas.js";
import * as service from "./service.js";

export const twoFactorRouter = Router();

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Vary", "Authorization");
}

function meta(req: AuthenticatedRequest) {
  return { ip: req.ip, userAgent: req.header("user-agent") ?? undefined };
}

function accountId(req: AuthenticatedRequest) {
  const value = req.auth?.accountId;
  if (!value) throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED", statusCode: 401 });
  return value;
}

twoFactorRouter.use((_req, res, next) => {
  noStore(res);
  next();
});

twoFactorRouter.get("/status", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try { res.json(await service.getStatus(accountId(req))); } catch (error) { next(error); }
});

twoFactorRouter.post("/totp/setup", requireAuth, validate(setupTotpSchema), async (req: AuthenticatedRequest, res, next) => {
  try { res.status(201).json(await service.setupTotp(accountId(req), req.body, meta(req))); } catch (error) { next(error); }
});

twoFactorRouter.post("/totp/confirm", requireAuth, validate(confirmTotpSchema), async (req: AuthenticatedRequest, res, next) => {
  try { res.json(await service.confirmTotp(accountId(req), req.body, meta(req))); } catch (error) { next(error); }
});

twoFactorRouter.post("/challenge", requireAuth, validate(createChallengeSchema), async (req: AuthenticatedRequest, res, next) => {
  try { res.status(201).json(await service.createChallenge(accountId(req), req.body, meta(req))); } catch (error) { next(error); }
});

twoFactorRouter.post("/challenge/:id/verify", requireAuth, validate(verifyChallengeSchema), async (req: AuthenticatedRequest, res, next) => {
  try { res.json(await service.verifyChallenge(accountId(req), String(req.params.id), req.body, meta(req))); } catch (error) { next(error); }
});

twoFactorRouter.post("/recovery-codes/regenerate", requireAuth, validate(regenerateRecoveryCodesSchema), async (req: AuthenticatedRequest, res, next) => {
  try { res.json(await service.regenerateRecoveryCodes(accountId(req), req.body, meta(req))); } catch (error) { next(error); }
});

twoFactorRouter.post("/disable", requireAuth, validate(disableTwoFactorSchema), async (req: AuthenticatedRequest, res, next) => {
  try { res.json(await service.disableTwoFactor(accountId(req), req.body, meta(req))); } catch (error) { next(error); }
});

twoFactorRouter.get(
  "/admin/enrollment-requests/:accountId",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  async (req: AuthenticatedRequest, res, next) => {
    try { res.json(await service.getAdminEnrollmentStatus(String(req.params.accountId))); } catch (error) { next(error); }
  },
);

twoFactorRouter.post(
  "/admin/enrollment-requests",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(adminCreateEnrollmentSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await service.adminCreateEnrollment(accountId(req), req.body, meta(req));
      res.status(result.enrollmentPasswordShownOnce ? 201 : 200).json(result);
    } catch (error) { next(error); }
  },
);

twoFactorRouter.post(
  "/admin/enrollment-requests/:requestId/rotate",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(adminRotateEnrollmentSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json(await service.adminRotateEnrollment(
        accountId(req),
        String(req.params.requestId),
        req.body,
        meta(req),
      ));
    } catch (error) { next(error); }
  },
);
