import "dotenv/config";

import type { Server } from "node:http";
import { beginBoundedServerDrain } from "./local-supervisor-shutdown.js";
import { applyHttpServerPolicy } from "./http-server-policy.js";

process.env.SYSTEM_SLOT_NAME ||= "backend-redundant";
process.env.SYSTEM_SLOT_ROLE ||= "redundant";
process.env.SYSTEM_RUNTIME_SOURCE ||= "json";
process.env.PORT ||= process.env.BACKEND_REDUNDANT_PORT || "4001";
process.env.LOCAL_AUTH_BIND ||= "127.0.0.1";

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  return { message: String(error) };
}

async function main() {
  const [appModule, envModule, dbModule, loggerModule, runtimeModule] = await Promise.all([
    import("../routes/create-system-app.js"),
    import("../../core/config/env.js"),
    import("../../core/database/database.js"),
    import("../../core/logger/logger.js"),
    import("../runtime/index.js"),
  ]);

  const { createRedundantSystemApp } = appModule;
  const { env } = envModule;
  const {
    disconnectPrismaClients,
    getDatabaseOperationStatus,
    initializeDatabaseRouting,
  } = dbModule;
  const { logger } = loggerModule;
  const { getSystemRuntimeConfig, getRuntimeJsonFallbackStatus } = runtimeModule;

  await initializeDatabaseRouting();
  const runtime = getSystemRuntimeConfig();
  const app = await createRedundantSystemApp();
  const bind = env.LOCAL_AUTH_BIND;
  const port = env.PORT;
  let shuttingDown = false;

  const server: Server = applyHttpServerPolicy(app.listen(port, bind, async () => {
    const notlauf = await getRuntimeJsonFallbackStatus();
    const metadata = {
      surface: "redundant",
      bind,
      port,
      runtime,
      notlauf,
      database: getDatabaseOperationStatus(),
    };

    logger.info("Redundant backend started", {
      module: "redundant-server",
      ...metadata,
    });
  }));

  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) return;

    shuttingDown = true;
    logger.info("Redundant backend graceful shutdown requested", {
      module: "redundant-server",
      signal,
      runtime,
    });

    await beginBoundedServerDrain([server]);

    await disconnectPrismaClients();
    process.exit(0);
  }

  function requestShutdown(signal: NodeJS.Signals) {
    void shutdown(signal).catch(error => {
      logger.error("Redundant backend shutdown failed", { module: "redundant-server", error: errorDetails(error) });
      process.exitCode = 1;
    });
  }
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  process.on("uncaughtException", (error) => {
    logger.error("Redundant backend uncaught exception", {
      module: "redundant-server",
      runtime,
      error: errorDetails(error),
    });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Redundant backend unhandled promise rejection", {
      module: "redundant-server",
      runtime,
      error: errorDetails(reason),
    });
  });
}

void main().catch((error) => {
  console.error("Redundant backend startup failed", errorDetails(error));
  process.exit(1);
});
