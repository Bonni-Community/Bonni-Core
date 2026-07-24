import { getLocalAuthProviderStatus } from "../../../../platform/auth/providers/local/index.js";
import { getOidcAuthProviderStatus } from "../../../../platform/auth/providers/oidc/index.js";
import { env } from "../../../../core/config/env.js";

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
  };
}
