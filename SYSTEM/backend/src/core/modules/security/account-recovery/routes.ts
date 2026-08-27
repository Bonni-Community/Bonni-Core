import { Router, type Request, type Response } from "express";

import { requireAuth } from "../../../http/middleware/requireAuth.js";
import { requirePermission } from "../../../http/middleware/requirePermission.js";
import { validate } from "../../../http/middleware/validate.js";
import type { AuthenticatedRequest } from "../../../../platform/auth/session/authContext.js";
import {
  initiateRecoverySchema,
  issueSupportCodeSchema,
  policyChallengeSchema,
  publicRecoveryCompleteSchema,
  publicRecoveryRequestSchema,
  publicRecoveryResumeSchema,
  recoveryDecisionChallengeSchema,
  recoveryDecisionSchema,
  recoveryOverviewSchema,
  supportCodeChallengeSchema,
  updateRecoveryPolicySchema,
} from "./schemas.js";
import * as service from "./service.js";

export const passwordRecoveryPublicRouter = Router();
export const accountRecoveryRouter = Router();

function noStore(res: Response, authenticated = false) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (authenticated) res.setHeader("Vary", "Authorization");
}

function requestMeta(req: Request) {
  return { ip: req.ip, userAgent: req.header("user-agent") ?? undefined };
}

function cookieSecure() {
  return process.env.NODE_ENV === "production";
}

function recoveryCookie(token: string, maxAge = service.ACCOUNT_RECOVERY_COOKIE_SECONDS) {
  return [
    `${service.ACCOUNT_RECOVERY_COOKIE}=${token}`,
    "Path=/api/auth/password-recovery",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(cookieSecure() ? ["Secure"] : []),
  ].join("; ");
}

function clearRecoveryCookie() {
  return recoveryCookie("", 0);
}

export function readRecoveryCookie(req: Request) {
  const raw = req.header("cookie");
  if (!raw || raw.length > 4096 || /[\r\n\0]/u.test(raw)) return null;
  const values = raw.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    const name = part.slice(0, separator).trim();
    if (name !== service.ACCOUNT_RECOVERY_COOKIE) return [];
    return [part.slice(separator + 1).trim()];
  });
  if (values.length !== 1 || values[0].length > 300 || !/^[A-Za-z0-9_.-]+$/u.test(values[0])) return null;
  return values[0];
}

function assertSameOrigin(req: Request) {
  const fetchSite = req.header("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return;
  if (fetchSite) {
    throw Object.assign(new Error("ACCOUNT_RECOVERY_CROSS_ORIGIN_FORBIDDEN"), {
      code: "ACCOUNT_RECOVERY_CROSS_ORIGIN_FORBIDDEN",
      statusCode: 403,
    });
  }
  const source = req.header("origin") || req.header("referer");
  if (!source) return;
  let parsed: URL;
  try { parsed = new URL(source); } catch { parsed = new URL("https://invalid.invalid"); }
  const expected = `${req.protocol}://${req.get("host")}`;
  if (parsed.origin !== expected) {
    throw Object.assign(new Error("ACCOUNT_RECOVERY_CROSS_ORIGIN_FORBIDDEN"), {
      code: "ACCOUNT_RECOVERY_CROSS_ORIGIN_FORBIDDEN",
      statusCode: 403,
    });
  }
}

function actorAccountId(req: AuthenticatedRequest) {
  if (!req.auth?.accountId) {
    throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED", statusCode: 401 });
  }
  return req.auth.accountId;
}

passwordRecoveryPublicRouter.use((_req, res, next) => {
  noStore(res);
  next();
});

passwordRecoveryPublicRouter.post(
  "/requests",
  validate(publicRecoveryRequestSchema),
  async (req, res, next) => {
    try {
      assertSameOrigin(req);
      const result = await service.requestPublicRecovery(
        req.body.loginName,
        readRecoveryCookie(req),
        requestMeta(req),
      );
      res.setHeader("Set-Cookie", recoveryCookie(result.browserToken));
      res.status(202).json(result.response);
    } catch (error) { next(error); }
  },
);

passwordRecoveryPublicRouter.get("/status", async (req, res, next) => {
  try {
    const result = await service.getPublicRecoveryStatus(readRecoveryCookie(req));
    if (result.status === "EXPIRED") res.setHeader("Set-Cookie", clearRecoveryCookie());
    res.json(result);
  } catch (error) { next(error); }
});

passwordRecoveryPublicRouter.post(
  "/resume",
  validate(publicRecoveryResumeSchema),
  async (req, res, next) => {
    try {
      assertSameOrigin(req);
      const result = await service.resumeWithSupportCode(req.body.supportCode, requestMeta(req));
      res.setHeader("Set-Cookie", recoveryCookie(result.browserToken));
      res.json(result.response);
    } catch (error) { next(error); }
  },
);

passwordRecoveryPublicRouter.post(
  "/complete",
  validate(publicRecoveryCompleteSchema),
  async (req, res, next) => {
    try {
      assertSameOrigin(req);
      const result = await service.completeRecovery(
        readRecoveryCookie(req),
        req.body.newPassword,
        req.body.newPasswordConfirmation,
        requestMeta(req),
      );
      res.setHeader("Set-Cookie", clearRecoveryCookie());
      res.json(result);
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.use((_req, res, next) => {
  noStore(res, true);
  next();
});

accountRecoveryRouter.get(
  "/overview",
  requireAuth,
  validate(recoveryOverviewSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json(await service.getOverview(
        actorAccountId(req),
        typeof req.query.reference === "string" ? req.query.reference : undefined,
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.post(
  "/requests",
  requireAuth,
  validate(initiateRecoverySchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json(await service.initiateSupportRecovery(
        actorAccountId(req),
        req.body.targetAccountId,
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.post(
  "/requests/:id/challenge",
  requireAuth,
  validate(recoveryDecisionChallengeSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json(await service.createDecisionChallenge(
        actorAccountId(req),
        String(req.params.id),
        req.body.decision,
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.post(
  "/requests/:id/decisions",
  requireAuth,
  validate(recoveryDecisionSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json(await service.decideRecovery(
        actorAccountId(req),
        String(req.params.id),
        req.body.decision,
        req.body.challengeId,
        req.body.proof,
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.post(
  "/requests/:id/support-code/challenge",
  requireAuth,
  validate(supportCodeChallengeSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json(await service.createSupportCodeChallenge(
        actorAccountId(req),
        String(req.params.id),
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.post(
  "/requests/:id/support-code",
  requireAuth,
  validate(issueSupportCodeSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json(await service.issueSupportCode(
        actorAccountId(req),
        String(req.params.id),
        req.body.challengeId,
        req.body.proof,
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.post(
  "/policy/challenge",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(policyChallengeSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json(await service.createPolicyChallenge(
        actorAccountId(req),
        req.body.reviewerAccountIds,
        req.body.threshold,
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);

accountRecoveryRouter.put(
  "/policy",
  requireAuth,
  requirePermission("SYSTEM_ADMIN"),
  validate(updateRecoveryPolicySchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json(await service.updatePolicy(
        actorAccountId(req),
        req.body.reviewerAccountIds,
        req.body.threshold,
        req.body.challengeId,
        req.body.proof,
        requestMeta(req),
      ));
    } catch (error) { next(error); }
  },
);
