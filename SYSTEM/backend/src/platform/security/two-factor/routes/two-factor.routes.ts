import { Router } from "express";

import { requireAuth, validate } from "../../../../core/core.js";
import type { AuthenticatedRequest } from "../../../auth/session/authContext.js";
import {
  confirmTotpSchema,
  createChallengeSchema,
  disableTwoFactorSchema,
  regenerateRecoveryCodesSchema,
  setupTotpSchema,
  verifyChallengeSchema,
} from "../schemas/two-factor.schemas.js";
import * as twoFactorService from "../services/two-factor.service.js";

export const twoFactorRouter = Router();

function meta(req: AuthenticatedRequest) {
  return {
    ip: req.ip,
    userAgent: req.header("user-agent") ?? undefined,
  };
}

function accountId(req: AuthenticatedRequest) {
  const id = req.auth?.accountId;

  if (!id) {
    throw Object.assign(new Error("AUTH_REQUIRED"), { statusCode: 401 });
  }

  return id;
}

twoFactorRouter.get("/status", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await twoFactorService.getStatus(accountId(req)));
  } catch (error) {
    next(error);
  }
});

twoFactorRouter.post("/totp/setup", requireAuth, validate(setupTotpSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.status(201).json(await twoFactorService.setupTotp(accountId(req), req.body, meta(req)));
  } catch (error) {
    next(error);
  }
});

twoFactorRouter.post("/totp/confirm", requireAuth, validate(confirmTotpSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await twoFactorService.confirmTotp(accountId(req), req.body, meta(req)));
  } catch (error) {
    next(error);
  }
});

twoFactorRouter.post("/challenge", requireAuth, validate(createChallengeSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.status(201).json(await twoFactorService.createChallenge(accountId(req), req.body, meta(req)));
  } catch (error) {
    next(error);
  }
});

twoFactorRouter.post("/challenge/:id/verify", requireAuth, validate(verifyChallengeSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await twoFactorService.verifyChallenge(accountId(req), String(req.params.id), req.body, meta(req)));
  } catch (error) {
    next(error);
  }
});

twoFactorRouter.post("/recovery-codes/regenerate", requireAuth, validate(regenerateRecoveryCodesSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await twoFactorService.regenerateRecoveryCodes(accountId(req), req.body, meta(req)));
  } catch (error) {
    next(error);
  }
});

twoFactorRouter.post("/disable", requireAuth, validate(disableTwoFactorSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await twoFactorService.disableTwoFactor(accountId(req), req.body, meta(req)));
  } catch (error) {
    next(error);
  }
});
