export type AuthProviderId = "local" | "oidc";

export type AuthProviderStatus = {
  id: AuthProviderId;
  enabled: boolean;
  alwaysAvailable?: boolean;
  purpose?: string[];
  port?: number;
  bind?: string;
  reason?: string;
};
