import type { Server } from "node:http";

import { createLocalSystemApp, createPlatformApp } from "../routes/create-system-app.js";
import { env } from "../../core/config/config.js";
import {
  disconnectPrismaClients,
  getDatabaseOperationStatus,
  initializeDatabaseRouting,
} from "../../core/database/database.js";
import { logger } from "../../core/logger/logger.js";
import { getSystemRuntimeConfig } from "../runtime/index.js";
import { preloadPersonalDataMasterKeyIfConfigured } from "../../platform/security/crypto/index.js";
import { scheduleEmergencyAutoStart } from "../../platform/security/control/emergency-backend/index.js";
import { startCoreUpdateScheduler } from "../routes/control-api/update-center/index.js";
import { seedSystemDatabase } from "../database/seed-system.js";

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

const runtime = getSystemRuntimeConfig();
const servers: Server[] = [];
let shuttingDown = false;

await initializeDatabaseRouting();

function registerServer(server: Server) {
  servers.push(server);
  return server;
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  const metadata = {
    signal,
    runtime: {
      slotName: runtime.slotName,
      slotRole: runtime.slotRole,
      version: runtime.version,
    },
    openServers: servers.length,
  };

  logger.info("Backend graceful shutdown requested", {
    module: "server",
    ...metadata,
  });

  await Promise.allSettled(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );

  await disconnectPrismaClients();

  logger.info("Backend graceful shutdown completed", {
    module: "server",
    runtime: metadata.runtime,
  });

  process.exit(0);
}

process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});

process.once("SIGINT", (signal) => {
  void shutdown(signal);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    module: "server",
    runtime,
    error: errorDetails(error),
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    module: "server",
    runtime,
    error: errorDetails(reason),
  });
});

const localSystemApp = await createLocalSystemApp();

registerServer(
  localSystemApp.listen(env.LOCAL_AUTH_PORT, env.LOCAL_AUTH_BIND, () => {
    const metadata = {
      surface: "local-system",
      bind: env.LOCAL_AUTH_BIND,
      port: env.LOCAL_AUTH_PORT,
      localAlwaysAvailable: true,
      runtime,
      database: getDatabaseOperationStatus(),
    };

    logger.info("Local System started", {
      module: "server",
      ...metadata,
    });
  }),
);

try {
  const personalDataMasterKey = preloadPersonalDataMasterKeyIfConfigured();
  if (personalDataMasterKey.loaded) {
    logger.info("Personal-data master key loaded into process memory", {
      module: "security.crypto",
      source: personalDataMasterKey.source,
      sourceHint: personalDataMasterKey.sourceHint,
      fingerprint: personalDataMasterKey.fingerprint,
      runtime,
    });
  }

  // `npm start` must never expose the platform login before the central Core
  // database is actually ready. This idempotent bootstrap uses the very same
  // routed Core client as /api/identity/auth/login: it creates a missing
  // `admin` account, repairs its technical role/provider links and verifies
  // that the login path can read it. Existing passwords and business data are
  // deliberately preserved.
  logger.info("Central login bootstrap started", {
    module: "auth.bootstrap",
    loginName: "admin",
    runtime,
  });
  await seedSystemDatabase();
  logger.info("Central login bootstrap completed", {
    module: "auth.bootstrap",
    loginName: "admin",
    runtime,
  });

  const app = await createPlatformApp();

  registerServer(
    app.listen(env.PORT, () => {
      const metadata = {
        surface: "platform",
        port: env.PORT,
        authMode: env.AUTH_MODE,
        oidcEnabled: env.OIDC_ENABLED,
        runtime,
        database: getDatabaseOperationStatus(),
      };

      logger.info("Backend started", {
        module: "server",
        ...metadata,
      });

      if (runtime.slotRole === "active") {
        const updateScheduler = startCoreUpdateScheduler();
        logger.info("Bonni-Core-Updateprüfung geplant", {
          module: "core-update",
          updateScheduler,
        });
        void scheduleEmergencyAutoStart("active-platform-started")
          .then((schedule) => {
            if (schedule.scheduled || schedule.reason !== "EMERGENCY_DISABLED") {
              logger.info("Emergency-Backend Autostart geprüft", {
                module: "emergency-control",
                schedule,
              });
            }
          })
          .catch((error) => {
            logger.warn("Emergency-Backend Autostart konnte nicht geplant werden", {
              module: "emergency-control",
              error: errorDetails(error),
            });
          });
      }
    }),
  );
} catch (error) {
  const metadata = {
    surface: "platform",
    localSystem: {
      available: true,
      bind: env.LOCAL_AUTH_BIND,
      port: env.LOCAL_AUTH_PORT,
    },
    runtime,
    error: errorDetails(error),
    database: getDatabaseOperationStatus(),
  };

  logger.error("Platform startup failed; local System remains available", {
    module: "server",
    ...metadata,
  });
}
