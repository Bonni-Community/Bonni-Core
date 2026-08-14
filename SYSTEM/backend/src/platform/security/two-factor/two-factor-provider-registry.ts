export const TWO_FACTOR_PROVIDER_CONTRACT_VERSION = "bonni.two-factor-provider/v1" as const;

export type TwoFactorProof = {
  code?: string;
  recoveryCode?: string;
  token?: string;
  password?: string;
};

export type TwoFactorProofField = {
  name: "code" | "token" | "password";
  label: string;
  type: "text" | "password";
  autocomplete?: "one-time-code" | "current-password" | "off";
  help?: string;
};

export type TwoFactorProviderPolicy = {
  challengeExpiresSeconds: number;
  maxAttempts: number;
  proofFields: TwoFactorProofField[];
};

export type TwoFactorAdminField = {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "checkbox";
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
};

export type TwoFactorProviderAdminConfiguration = {
  values: Record<string, unknown>;
  sections: Array<{
    title: string;
    description?: string;
    fields: TwoFactorAdminField[];
  }>;
};

export type ExternalTwoFactorProvider = {
  id: string;
  label: string;
  getState(): Promise<{
    enabled: boolean;
    configured: boolean;
    policy: TwoFactorProviderPolicy;
    details?: Record<string, unknown>;
  }>;
  verify(input: {
    accountId: string;
    loginName: string;
    purpose: string;
    proof: TwoFactorProof;
  }): Promise<{ ok: boolean }>;
  getAdminConfiguration(): Promise<TwoFactorProviderAdminConfiguration>;
  updateAdminConfiguration(values: Record<string, unknown>): Promise<TwoFactorProviderAdminConfiguration>;
};

type RegisteredProvider = {
  moduleKey: string;
  token: symbol;
  provider: Readonly<ExternalTwoFactorProvider>;
};

const registeredProviders = new Map<string, RegisteredProvider>();

function fail(code: string, statusCode = 500): never {
  throw Object.assign(new Error(code), { code, statusCode });
}

function normalizeModuleKey(value: unknown) {
  const moduleKey = String(value || "").trim().toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(moduleKey)) {
    fail("TWO_FACTOR_PROVIDER_MODULE_KEY_INVALID");
  }
  return moduleKey;
}

function normalizeProviderId(value: unknown) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(id) || id === "local") {
    fail("TWO_FACTOR_PROVIDER_ID_INVALID");
  }
  return id;
}

function validateProvider(provider: ExternalTwoFactorProvider) {
  if (!provider || typeof provider !== "object") fail("TWO_FACTOR_PROVIDER_INVALID");
  normalizeProviderId(provider.id);
  if (!String(provider.label || "").trim()) fail("TWO_FACTOR_PROVIDER_LABEL_REQUIRED");
  for (const method of ["getState", "verify", "getAdminConfiguration", "updateAdminConfiguration"] as const) {
    if (typeof provider[method] !== "function") fail(`TWO_FACTOR_PROVIDER_METHOD_REQUIRED:${method}`);
  }
}

export function getRegisteredExternalTwoFactorProvider() {
  return getRegisteredExternalTwoFactorProviders()[0] || null;
}

export function getRegisteredExternalTwoFactorProviders() {
  return [...registeredProviders.values()]
    .map((entry) => entry.provider)
    .sort((left, right) => left.label.localeCompare(right.label, "de"));
}

export function getRegisteredExternalTwoFactorProviderById(providerId: unknown) {
  const id = String(providerId || "").trim().toLowerCase();
  return registeredProviders.get(id)?.provider || null;
}

export async function getActiveExternalTwoFactorProvider() {
  const providers = getRegisteredExternalTwoFactorProviders();
  const states = await Promise.all(providers.map(async (provider) => ({
    provider,
    state: await provider.getState(),
  })));
  const active = states.filter((entry) => entry.state.enabled);
  if (active.length > 1) fail("TWO_FACTOR_MULTIPLE_ACTIVE_PROVIDERS", 409);
  return active[0] || null;
}

export async function getExternalTwoFactorProviderAdminState() {
  return (await getExternalTwoFactorProviderAdminStates())[0] || null;
}

async function buildExternalTwoFactorProviderAdminState(provider: Readonly<ExternalTwoFactorProvider>) {
  const [state, configuration] = await Promise.all([
    provider.getState(),
    provider.getAdminConfiguration(),
  ]);
  return {
    id: provider.id,
    label: provider.label,
    enabled: state.enabled,
    configured: state.configured,
    details: state.details || {},
    policy: state.policy,
    configuration,
  };
}

export async function getExternalTwoFactorProviderAdminStates() {
  return Promise.all(
    getRegisteredExternalTwoFactorProviders().map(buildExternalTwoFactorProviderAdminState),
  );
}

export async function updateExternalTwoFactorProviderAdminState(
  providerId: unknown,
  values: Record<string, unknown>,
) {
  const provider = getRegisteredExternalTwoFactorProviderById(providerId);
  if (!provider) fail("TWO_FACTOR_PROVIDER_NOT_INSTALLED", 409);
  await provider.updateAdminConfiguration(values);
  return buildExternalTwoFactorProviderAdminState(provider);
}

export function createStagedModuleTwoFactorProviderRuntime(moduleKeyValue: string) {
  const moduleKey = normalizeModuleKey(moduleKeyValue);
  const token = Symbol(moduleKey);
  let pending: Readonly<ExternalTwoFactorProvider> | null = null;
  let active = false;
  let disposed = false;

  function unregister() {
    if (!pending) return;
    const current = registeredProviders.get(pending.id);
    if (current?.token === token) registeredProviders.delete(pending.id);
  }

  function activatePending() {
    if (!pending) return;
    const current = registeredProviders.get(pending.id);
    if (current && current.token !== token) {
      fail("TWO_FACTOR_PROVIDER_ID_OCCUPIED", 409);
    }
    registeredProviders.set(pending.id, { moduleKey, token, provider: pending });
  }

  const runtime = Object.freeze({
    contractVersion: TWO_FACTOR_PROVIDER_CONTRACT_VERSION,
    registerProvider(provider: ExternalTwoFactorProvider) {
      if (disposed) fail("TWO_FACTOR_PROVIDER_RUNTIME_DISPOSED");
      if (pending) fail("TWO_FACTOR_PROVIDER_ALREADY_REGISTERED");
      validateProvider(provider);
      pending = Object.freeze(provider);
      if (active) activatePending();
      let valid = true;
      return () => {
        if (!valid) return;
        valid = false;
        unregister();
        pending = null;
      };
    },
  });

  return Object.freeze({
    runtime,
    activate() {
      if (disposed) fail("TWO_FACTOR_PROVIDER_RUNTIME_DISPOSED");
      if (active) return;
      activatePending();
      active = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      unregister();
      pending = null;
    },
  });
}
