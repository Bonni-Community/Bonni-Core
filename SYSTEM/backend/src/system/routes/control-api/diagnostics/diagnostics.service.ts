import { getLocalAuthProviderStatus } from "../../../../platform/auth/providers/local/index.js";
import { getOidcAuthProviderStatus } from "../../../../platform/auth/providers/oidc/index.js";
import { env } from "../../../../core/config/env.js";
import {
  CORE_ERROR_FILE_NAME,
  CORE_LOG_FILE_NAME,
  CORE_LOG_RETENTION_COUNT,
  CORE_LOG_ROTATION_INTERVAL_MS,
  readCoreLogFile,
  readCoreLogSnapshot,
  resolveCoreLogPaths,
} from "../../../../core/logger/coreLogStorage.js";

export function getSystemDiagnostics() {
  return {
    ok: true,
    area: "diagnostics",
    runtime: {
      nodeEnv: env.NODE_ENV,
      platformPort: env.PORT,
      localSystem: {
        bind: env.LOCAL_AUTH_BIND,
        port: env.LOCAL_AUTH_PORT,
        alwaysAvailable: true,
      },
    },
    auth: {
      local: getLocalAuthProviderStatus(),
      oidc: getOidcAuthProviderStatus(),
    },
    boundaries: {
      localSurfaceLoadsApplicationModules: false,
      systemDependsOnOidc: false,
    },
    coreLogging: {
      root: resolveCoreLogPaths().displayRoot,
      logFile: CORE_LOG_FILE_NAME,
      errorFile: CORE_ERROR_FILE_NAME,
      rotationHours: CORE_LOG_ROTATION_INTERVAL_MS / (60 * 60 * 1000),
      retainedFilesPerStream: CORE_LOG_RETENTION_COUNT,
    },
  };
}

export function getSystemDiagnosticsLogs(limit?: number) {
  return readCoreLogSnapshot({ limit });
}

export async function getSystemDiagnosticsLogFile(stream: "log" | "error") {
  return readCoreLogFile(stream);
}
