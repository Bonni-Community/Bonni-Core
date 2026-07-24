import { authConfig } from "../../../../core/config/auth.config.js";
import type { AuthProviderStatus } from "../../auth-provider.types.js";

export function getLocalAuthProviderStatus(): AuthProviderStatus {
  return {
    id: "local",
    enabled: true,
    alwaysAvailable: true,
    purpose: authConfig.local.purpose,
    bind: authConfig.local.bind,
    port: authConfig.local.port
  };
}
