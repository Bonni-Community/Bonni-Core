import express from "express";
import helmet from "helmet";
import { systemModulesRouter } from "../routes/index.js";
import { browserCors, createBrowserOriginGuard } from "../../../core/http/browser-origin.js";
import { applyHttpServerPolicy } from "../../../system/server/http-server-policy.js";
const port = Number(process.env.MODULE_MANAGER_PORT || 4201);
export function createModuleManagerServer() {
    const app = express();
    app.use(helmet({ frameguard: false }));
    app.use(createBrowserOriginGuard());
    app.use(browserCors);
    app.use(express.json({ limit: "25mb" }));
    app.get("/health", (_req, res) => res.json({ ok: true, service: "module-manager" }));
    app.use("/api/module-manager/modules", systemModulesRouter);
    return app;
}
if (process.argv[1]?.endsWith("module-manager-server.ts") || process.argv[1]?.endsWith("module-manager-server.js")) {
    applyHttpServerPolicy(createModuleManagerServer().listen(port, () => {
        console.log(`[module-manager] listening on ${port}`);
    }));
}
