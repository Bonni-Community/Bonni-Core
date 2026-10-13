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
import {
  scheduleEmergencyAutoStart,
  stopEmergencyBackend,
} from "../../platform/security/control/emergency-backend/index.js";
import { startCoreUpdateScheduler } from "../routes/control-api/update-center/index.js";
import { startWebBridgeWorker, stopWebBridgeWorker } from "../../core/web-bridge/service.js";
import { seedSystemDatabase } from "../database/seed-system.js";
import { applyHttpServerPolicy } from "./http-server-policy.js";
import {
  beginBoundedServerDrain,
  completeLocalSupervisorShutdown,
  isLocalUpdateSupervisorProcess,
  sendIpcMessageAndWait,
} from "./local-supervisor-shutdown.js";

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
const localUpdateSupervisorChild = isLocalUpdateSupervisorProcess({
  nodeEnv: env.NODE_ENV,
  slotRole: runtime.slotRole,
  supervisorFlag: process.env.BONNI_LOCAL_UPDATE_SUPERVISOR,
  connected: Boolean(process.connected),
});

function registerServer(server: Server) {
  applyHttpServerPolicy(server);
  servers.push(server);
  return server;
}

type ShutdownTrigger = NodeJS.Signals | "SUPERVISOR_UPDATE" | "SUPERVISOR_DISCONNECT";

function requiresLocalProcessTreeShutdown(signal: ShutdownTrigger) {
  return localUpdateSupervisorChild
    && (signal === "SUPERVISOR_UPDATE" || signal === "SUPERVISOR_DISCONNECT");
}

async function sendSupervisorShutdownMessage(
  type: "BONNI_BACKEND_SHUTDOWN_ACCEPTED" | "BONNI_BACKEND_SHUTDOWN_COMPLETE",
  requestId?: string,
) {
  if (!process.connected || typeof process.send !== "function") {
    throw new Error(`SUPERVISOR_IPC_UNAVAILABLE:${type}`);
  }
  await sendIpcMessageAndWait(
    (message, callback) => process.send!(message, callback),
    { type, requestId },
  );
}

async function shutdown(signal: ShutdownTrigger, requestId?: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await stopWebBridgeWorker();

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

  let serverDrain;
  if (requiresLocalProcessTreeShutdown(signal)) {
    const completed = await completeLocalSupervisorShutdown({
      servers,
      stopEmergency: () => stopEmergencyBackend(
        signal === "SUPERVISOR_UPDATE"
          ? "local-source-update"
          : "local-source-supervisor-disconnected",
      ),
      verifyEmergency: (result) => {
        const emergency = result as Awaited<ReturnType<typeof stopEmergencyBackend>>;
        if (emergency.health?.reachable !== false) {
          throw new Error("LOCAL_EMERGENCY_BACKEND_STOP_NOT_VERIFIED");
        }
      },
      disconnectPrisma: disconnectPrismaClients,
    });
    serverDrain = completed.serverDrain;
    const emergency = completed.emergencyResult as Awaited<ReturnType<typeof stopEmergencyBackend>>;
    logger.info("Lokal verwaltetes Emergency-Backend vor Core-Stopp beendet", {
      module: "emergency-control",
      signal,
      stopped: emergency.stopped,
      reason: emergency.reason,
    });
  } else {
    serverDrain = await beginBoundedServerDrain(servers);
    await disconnectPrismaClients();
  }

  logger.info("Backend graceful shutdown completed", {
    module: "server",
    runtime: metadata.runtime,
    serverDrain,
  });

  if (signal === "SUPERVISOR_UPDATE") {
    // ACK und COMPLETE werden erst nach Listener-Drain, nachgewiesenem Ende
    // des Emergency-Prozessbaums und Prisma-Disconnect bestätigt versendet.
    // Der send-Callback ist die letzte Barriere vor process.exit(), damit die
    // Supervisor-Nachricht nicht im IPC-Puffer verloren geht.
    await sendSupervisorShutdownMessage("BONNI_BACKEND_SHUTDOWN_ACCEPTED", requestId);
    await sendSupervisorShutdownMessage("BONNI_BACKEND_SHUTDOWN_COMPLETE", requestId);
  }

  process.exit(0);
}

function requestShutdown(signal: ShutdownTrigger, requestId?: string) {
  void shutdown(signal, requestId).catch((error) => {
    logger.error("Backend graceful shutdown failed; process remains fail-closed", {
      module: "server",
      signal,
      requestId,
      error: errorDetails(error),
    });
    // Insbesondere bei einem fehlgeschlagenen Emergency-Stopp werden weder
    // Prisma/npm-ci freigegeben noch COMPLETE oder ein erfolgreicher Exit
    // signalisiert. Der Supervisor muss den Auftrag damit sicher abbrechen.
    process.exitCode = 1;
  });
}

process.on("message", (message: unknown) => {
  if (
    !message
    || typeof message !== "object"
    || !("type" in message)
    || message.type !== "BONNI_SUPERVISOR_SHUTDOWN"
    || !("reason" in message)
    || message.reason !== "local-source-update"
  ) {
    return;
  }

  const requestId = "requestId" in message && typeof message.requestId === "string"
    ? message.requestId
    : undefined;
  requestShutdown("SUPERVISOR_UPDATE", requestId);
});

process.once("SIGTERM", (signal) => {
  requestShutdown(signal);
});

process.once("SIGINT", (signal) => {
  requestShutdown(signal);
});

if (localUpdateSupervisorChild) {
  process.once("disconnect", () => {
    logger.warn("Supervisor-Verbindung unerwartet getrennt; Core wird kontrolliert beendet", {
      module: "server",
      runtime,
    });
    requestShutdown("SUPERVISOR_DISCONNECT");
  });
}

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

await initializeDatabaseRouting();

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

  const onPlatformStarted = () => {
    const metadata = {
      surface: "platform",
      bind: env.SYSTEM_SERVER_BIND || null,
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

    if (process.connected && typeof process.send === "function") {
      process.send({
        type: "BONNI_BACKEND_READY",
        runtime: metadata.runtime,
        port: metadata.port,
      });
    }

    if (runtime.slotRole === "active") {
      startWebBridgeWorker();
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
  };

  registerServer(
    env.SYSTEM_SERVER_BIND
      ? app.listen(env.PORT, env.SYSTEM_SERVER_BIND, onPlatformStarted)
      : app.listen(env.PORT, onPlatformStarted),
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
