import type { Express } from "express";
import { currentUserMiddleware } from "./middleware/current-user.middleware.js";
import { authRoutes } from "./routes/index.js";

export function registerCoreAuth(app: Express) {
  app.use(currentUserMiddleware);
  // Neue technische Auth-API
  app.use("/api/auth", authRoutes);

  // Kompatibilität für bestehendes Frontend / alte Identity-Route
  app.use("/api/identity/auth", authRoutes);
}
