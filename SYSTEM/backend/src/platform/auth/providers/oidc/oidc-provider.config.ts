import { authConfig } from "../../../../core/config/auth.config.js";
import type { AuthProviderStatus } from "../../auth-provider.types.js";

export function getOidcAuthProviderStatus(): AuthProviderStatus {
  const configured = Boolean(
    authConfig.oidc.issuerUrl &&
      authConfig.oidc.clientId &&
      authConfig.oidc.redirectUri
  );

  return {
    id: "oidc",
    enabled: authConfig.oidc.enabled && configured,
    port: authConfig.oidc.port,
    reason: authConfig.oidc.enabled
      ? configured
        ? undefined
        : "OIDC_NOT_CONFIGURED"
      : "OIDC_DISABLED"
  };
}
