import express from "express";
import cors from "cors";
import helmet from "helmet";

import { systemModulesRouter } from "../routes/index.js";

const port = Number(process.env.MODULE_MANAGER_PORT || 4201);

export function createModuleManagerServer() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "25mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "module-manager" }));
  app.use("/api/module-manager/modules", systemModulesRouter);

  return app;
}

if (process.argv[1]?.endsWith("module-manager-server.ts") || process.argv[1]?.endsWith("module-manager-server.js")) {
  createModuleManagerServer().listen(port, () => {
    console.log(`[module-manager] listening on ${port}`);
  });
}
