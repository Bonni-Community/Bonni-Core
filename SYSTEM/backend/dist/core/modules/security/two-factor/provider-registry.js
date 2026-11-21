export const TWO_FACTOR_PROVIDER_CONTRACT_VERSION = "bonni.two-factor-provider/v1";
const registeredProviders = new Map();
function fail(code, statusCode = 500) {
    throw Object.assign(new Error(code), { code, statusCode });
}
function normalizeModuleKey(value) {
    const moduleKey = String(value || "").trim().toLowerCase();
    if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(moduleKey)) {
        fail("TWO_FACTOR_PROVIDER_MODULE_KEY_INVALID");
    }
    return moduleKey;
}
function normalizeProviderId(value) {
    const id = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(id) || id === "local") {
        fail("TWO_FACTOR_PROVIDER_ID_INVALID");
    }
    return id;
}
function validateProvider(provider) {
    if (!provider || typeof provider !== "object")
        fail("TWO_FACTOR_PROVIDER_INVALID");
    normalizeProviderId(provider.id);
    if (!String(provider.label || "").trim())
        fail("TWO_FACTOR_PROVIDER_LABEL_REQUIRED");
    for (const method of ["getState", "verify", "getAdminConfiguration", "updateAdminConfiguration"]) {
        if (typeof provider[method] !== "function")
            fail(`TWO_FACTOR_PROVIDER_METHOD_REQUIRED:${method}`);
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
export function getRegisteredExternalTwoFactorProviderById(providerId) {
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
    if (active.length > 1)
        fail("TWO_FACTOR_MULTIPLE_ACTIVE_PROVIDERS", 409);
    return active[0] || null;
}
export async function getExternalTwoFactorProviderAdminState() {
    return (await getExternalTwoFactorProviderAdminStates())[0] || null;
}
function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), min), max) : fallback;
}
function publicAdminConfiguration(value) {
    const source = value && typeof value === "object" ? value : { values: {}, sections: [] };
    const sourceValues = source.values && typeof source.values === "object" ? source.values : {};
    const allowedNames = new Set();
    const passwordNames = new Set();
    const sections = (Array.isArray(source.sections) ? source.sections : []).slice(0, 20).map((section) => {
        const fields = (Array.isArray(section?.fields) ? section.fields : []).slice(0, 50).flatMap((field) => {
            const name = String(field?.name || "");
            if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/u.test(name) || allowedNames.has(name))
                return [];
            const type = ["text", "password", "number", "select", "checkbox"].includes(field.type)
                ? field.type
                : "text";
            allowedNames.add(name);
            if (type === "password")
                passwordNames.add(name);
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
                }];
        });
        return {
            title: String(section?.title || "Konfiguration").slice(0, 120),
            description: section?.description === undefined ? undefined : String(section.description).slice(0, 320),
            fields,
        };
    });
    const values = {};
    for (const name of allowedNames) {
        const raw = sourceValues[name];
        if (passwordNames.has(name)) {
            values[name] = raw === undefined || raw === null || raw === "" ? "" : "********";
        }
        else if (["string", "number", "boolean"].includes(typeof raw) || raw === null) {
            values[name] = typeof raw === "string" ? raw.slice(0, 1000) : raw;
        }
    }
    return Object.freeze({ values: Object.freeze(values), sections: Object.freeze(sections) });
}
function publicProviderPolicy(value) {
    const proofFields = (Array.isArray(value?.proofFields) ? value.proofFields : []).slice(0, 3).flatMap((field) => {
        if (field?.name !== "code" && field?.name !== "token" && field?.name !== "password")
            return [];
        return [{
                name: field.name,
                label: String(field.label || field.name).slice(0, 80),
                type: field.type === "text" ? "text" : "password",
                autocomplete: field.autocomplete === "one-time-code"
                    || field.autocomplete === "current-password"
                    || field.autocomplete === "off"
                    ? field.autocomplete
                    : undefined,
                help: field.help === undefined ? undefined : String(field.help).slice(0, 240),
            }];
    });
    return Object.freeze({
        challengeExpiresSeconds: boundedInteger(value?.challengeExpiresSeconds, 60, 30, 600),
        maxAttempts: boundedInteger(value?.maxAttempts, 8, 1, 20),
        proofFields: Object.freeze(proofFields),
    });
}
async function buildExternalTwoFactorProviderAdminState(provider) {
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
    return Promise.all(getRegisteredExternalTwoFactorProviders().map(buildExternalTwoFactorProviderAdminState));
}
export async function updateExternalTwoFactorProviderAdminState(providerId, values) {
    const provider = getRegisteredExternalTwoFactorProviderById(providerId);
    if (!provider)
        fail("TWO_FACTOR_PROVIDER_NOT_INSTALLED", 409);
    await provider.updateAdminConfiguration(values);
    return buildExternalTwoFactorProviderAdminState(provider);
}
export function createStagedModuleTwoFactorProviderRuntime(moduleKeyValue) {
    const moduleKey = normalizeModuleKey(moduleKeyValue);
    const token = Symbol(moduleKey);
    let pending = null;
    let active = false;
    let disposed = false;
    function unregister() {
        if (!pending)
            return;
        const current = registeredProviders.get(pending.id);
        if (current?.token === token)
            registeredProviders.delete(pending.id);
    }
    function activatePending() {
        if (!pending)
            return;
        const current = registeredProviders.get(pending.id);
        if (current && current.token !== token) {
            fail("TWO_FACTOR_PROVIDER_ID_OCCUPIED", 409);
        }
        registeredProviders.set(pending.id, { moduleKey, token, provider: pending });
    }
    const runtime = Object.freeze({
        contractVersion: TWO_FACTOR_PROVIDER_CONTRACT_VERSION,
        registerProvider(provider) {
            if (disposed)
                fail("TWO_FACTOR_PROVIDER_RUNTIME_DISPOSED");
            if (pending)
                fail("TWO_FACTOR_PROVIDER_ALREADY_REGISTERED");
            validateProvider(provider);
            pending = Object.freeze(provider);
            if (active)
                activatePending();
            let valid = true;
            return () => {
                if (!valid)
                    return;
                valid = false;
                unregister();
                pending = null;
            };
        },
    });
    return Object.freeze({
        runtime,
        activate() {
            if (disposed)
                fail("TWO_FACTOR_PROVIDER_RUNTIME_DISPOSED");
            if (active)
                return;
            activatePending();
            active = true;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            active = false;
            unregister();
            pending = null;
        },
    });
}
