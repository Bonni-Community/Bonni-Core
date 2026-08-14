import type { Express } from "express";

import { clientLogRouter } from "../../core/logger/clientLog.routes.js";
import {
  mediaFilesRouter,
  resolveMediaPublicBasePath,
} from "../../core/media/index.js";
import { notificationRouter } from "../../platform/notifications/index.js";
import { terminalRouter } from "../../platform/terminals/index.js";
import { timecapsuleRouter } from "../../platform/timecapsule/index.js";
import { systemUsersRouter } from "../../platform/auth/users/index.js";
import { updateRouter } from "../../platform/module-manager/update/index.js";
import { twoFactorRouter } from "../../platform/security/index.js";
import { runtimeControlRouter } from "../runtime/runtime-control.routes.js";
import { runContainerRouter } from "../runtime/run-container/index.js";
import { healthRouter } from "./health.routes.js";
import { lazySystemRouter } from "./lazySystemRouter.js";
import { oidcRouter } from "./oidc.routes.js";
import { runtimeRouter } from "./runtime.routes.js";
import { systemRouter } from "./system.routes.js";

/**
 * Bonni-Core-only route registration.
 *
 * Konkrete Apps, Add-ons und Plug-ins werden nicht hart importiert. Sie kommen
 * später über module-manager Manifest, Installation und Registry dazu.
 */
export function registerCoreRoutes(app: Express) {
  app.use("/api/health", healthRouter);
  app.use(resolveMediaPublicBasePath(), mediaFilesRouter);
  app.use("/api/terminals", terminalRouter);
  app.use("/api/notifications", notificationRouter);
  app.use("/api/security/2fa", twoFactorRouter);
  app.use("/api/timecapsule", timecapsuleRouter);
  app.use("/api/system", systemRouter);
  app.use("/api/runtime", runtimeRouter);
  app.use("/api/run-container", runContainerRouter);
  app.use("/api/oidc", oidcRouter);
  app.use("/api/debug", clientLogRouter);
  app.use("/api/update", updateRouter);
  app.use("/api/internal/runtime", runtimeControlRouter);
  app.use("/api/system/user", systemUsersRouter);
  app.use("/api/system", lazySystemRouter);
}
