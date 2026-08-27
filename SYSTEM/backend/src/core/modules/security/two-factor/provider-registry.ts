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

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), min), max) : fallback;
}

function publicAdminConfiguration(value: TwoFactorProviderAdminConfiguration) {
  const source = value && typeof value === "object" ? value : { values: {}, sections: [] };
  const sourceValues = source.values && typeof source.values === "object" ? source.values : {};
  const allowedNames = new Set<string>();
  const passwordNames = new Set<string>();
  const sections = (Array.isArray(source.sections) ? source.sections : []).slice(0, 20).map((section) => {
    const fields = (Array.isArray(section?.fields) ? section.fields : []).slice(0, 50).flatMap((field) => {
      const name = String(field?.name || "");
      if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/u.test(name) || allowedNames.has(name)) return [];
      const type = ["text", "password", "number", "select", "checkbox"].includes(field.type)
        ? field.type
        : "text";
      allowedNames.add(name);
      if (type === "password") passwordNames.add(name);
      return [{
        name,
        label: String(field.label || name).slice(0, 80),
        type,
        help: field.help === undefined ? undefined : String(field.help).slice(0, 240),
        placeholder: field.placeholder === undefined ? undefined : String(field.placeholder).slice(0, 160),
        min: Number.isFinite(field.min) ? Number(field.min) : undefined,
        max: Number.isFinite(field.max) ? Number(field.max) : undefined,
        options: Array.isArray(field.options)
          ? field.options.slice(0, 100).map((option) => ({
              value: String(option.value).slice(0, 160),
              label: String(option.label).slice(0, 160),
            }))
          : undefined,
      } satisfies TwoFactorAdminField];
    });
    return {
      title: String(section?.title || "Konfiguration").slice(0, 120),
      description: section?.description === undefined ? undefined : String(section.description).slice(0, 320),
      fields,
    };
  });
  const values: Record<string, unknown> = {};
  for (const name of allowedNames) {
    const raw = sourceValues[name];
    if (passwordNames.has(name)) {
      values[name] = raw === undefined || raw === null || raw === "" ? "" : "********";
    } else if (["string", "number", "boolean"].includes(typeof raw) || raw === null) {
      values[name] = typeof raw === "string" ? raw.slice(0, 1000) : raw;
    }
  }
  return Object.freeze({ values: Object.freeze(values), sections: Object.freeze(sections) });
}

function publicProviderPolicy(value: TwoFactorProviderPolicy) {
  const proofFields = (Array.isArray(value?.proofFields) ? value.proofFields : []).slice(0, 3).flatMap((field) => {
    if (field?.name !== "code" && field?.name !== "token" && field?.name !== "password") return [];
    return [{
      name: field.name,
      label: String(field.label || field.name).slice(0, 80),
      type: field.type === "text" ? "text" as const : "password" as const,
      autocomplete: field.autocomplete === "one-time-code"
        || field.autocomplete === "current-password"
        || field.autocomplete === "off"
        ? field.autocomplete
        : undefined,
      help: field.help === undefined ? undefined : String(field.help).slice(0, 240),
    } satisfies TwoFactorProofField];
  });
  return Object.freeze({
    challengeExpiresSeconds: boundedInteger(value?.challengeExpiresSeconds, 60, 30, 600),
    maxAttempts: boundedInteger(value?.maxAttempts, 8, 1, 20),
    proofFields: Object.freeze(proofFields),
  });
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
    details: Object.freeze({}),
    policy: publicProviderPolicy(state.policy),
    configuration: publicAdminConfiguration(configuration),
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
