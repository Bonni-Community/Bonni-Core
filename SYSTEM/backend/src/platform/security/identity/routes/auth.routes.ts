import { Router } from "express";
import { validate } from "../../../../core/core.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { loginSchema, loginTwoFactorSchema, logoutSchema, refreshSchema } from "../schemas/auth.schemas.js";
import * as authService from "../services/auth.service.js";
import * as accountService from "../services/account.service.js";

export const authRouter = Router();
authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

authRouter.post("/login", validate(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login(req.body, {
      ip: req.ip,
      headers: req.headers
    });
    res.status((result as any).requiresTwoFactor ? 202 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login/2fa", validate(loginTwoFactorSchema), async (req, res, next) => {
  try {
    const result = await authService.loginWithTwoFactor(req.body, {
      ip: req.ip,
      headers: req.headers
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post("/refresh", validate(refreshSchema), async (req, res, next) => {
  try {
    const result = await authService.refresh(req.body, {
      ip: req.ip,
      headers: req.headers
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", requireAuth, validate(logoutSchema), async (req, res, next) => {
  try {
    const result = await authService.logout(req.body, {
      accountId: req.auth?.accountId,
      ip: req.ip,
      headers: req.headers
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    if (!req.auth?.accountId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const result = await accountService.getMe(req.auth.accountId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
