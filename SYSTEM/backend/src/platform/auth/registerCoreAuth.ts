import type { Express } from "express";
import { currentUserMiddleware } from "./middleware/current-user.middleware.js";
import { authRoutes } from "./routes/index.js";
import { passwordRecoveryPublicRouter } from "../../core/modules/security/account-recovery/index.js";

export function registerCoreAuth(app: Express) {
  app.use(currentUserMiddleware);
  // Deliberately mounted only on the canonical public surface. The legacy
  // /api/identity/auth alias must never duplicate capability-cookie routes.
  app.use("/api/auth/password-recovery", passwordRecoveryPublicRouter);
  // Neue technische Auth-API
  app.use("/api/auth", authRoutes);

  // Kompatibilität für bestehendes Frontend / alte Identity-Route
  app.use("/api/identity/auth", authRoutes);
}
