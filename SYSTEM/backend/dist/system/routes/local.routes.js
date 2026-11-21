import { Router } from "express";
import { clientLogRouter } from "../../core/logger/clientLog.routes.js";
import { getDatabaseOperationStatus } from "../../core/database/database.js";
import { authRoutes } from "../../platform/auth/routes/index.js";
import { getLocalAuthProviderStatus } from "../../platform/auth/providers/local/index.js";
import { systemUsersRouter } from "../../platform/auth/users/index.js";
import { healthRouter } from "./health.routes.js";
import { lazySystemRouter } from "./lazySystemRouter.js";
import { oidcRouter } from "./oidc.routes.js";
import { runtimeRouter } from "./runtime.routes.js";
import { systemRouter } from "./system.routes.js";
export const localRouter = Router();
localRouter.get("/local/status", (_req, res) => {
    res.json({
        ok: true,
        surface: "local",
        provider: getLocalAuthProviderStatus(),
        database: getDatabaseOperationStatus(),
        system: {
            available: true,
            route: "/api/system",
        },
    });
});
// Local/Sandbox/Notlauf surface for Bonni Core only.
localRouter.use("/health", healthRouter);
localRouter.use("/system", systemRouter);
localRouter.use("/runtime", runtimeRouter);
localRouter.use("/oidc", oidcRouter);
localRouter.use("/debug", clientLogRouter);
localRouter.use("/auth", authRoutes);
localRouter.use("/identity/auth", authRoutes);
localRouter.use("/system/user", systemUsersRouter);
localRouter.use("/system/users", systemUsersRouter);
localRouter.use("/system", lazySystemRouter);
export default localRouter;
