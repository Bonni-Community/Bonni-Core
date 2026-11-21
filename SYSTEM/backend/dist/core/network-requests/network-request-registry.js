export const CORE_NETWORK_REQUEST_TRANSPORT_MODULE = "addon.bonni-network";
export const CORE_NETWORK_REQUEST_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const CORE_NETWORK_REQUEST_MAX_RESPONSE_BYTES = 1024 * 1024;
export const CORE_NETWORK_REQUEST_DEFAULT_TIMEOUT_MS = 10_000;
export const CORE_NETWORK_REQUEST_MAX_TIMEOUT_MS = 60_000;
const MAX_JSON_DEPTH = 128;
class CoreNetworkRequestFailure extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "CoreNetworkRequestFailure";
    }
}
function fail(code) {
    throw new CoreNetworkRequestFailure(code);
}
function rethrowBoundary(error, fallbackCode) {
    if (error instanceof CoreNetworkRequestFailure)
        throw error;
    fail(fallbackCode);
}
function cleanText(value, maxLength) {
    return String(value ?? "").trim().slice(0, maxLength);
}
function normalizeModuleId(value) {
    const raw = String(value ?? "").trim();
    if (raw.length > 160)
        fail("CORE_NETWORK_REQUEST_MODULE_INVALID");
    const moduleId = raw.toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,159}$/.test(moduleId)) {
        fail("CORE_NETWORK_REQUEST_MODULE_INVALID");
    }
    return moduleId;
}
function normalizeProtocol(value) {
    const raw = String(value ?? "").trim();
    if (raw.length > 120)
        fail("CORE_NETWORK_REQUEST_PROTOCOL_INVALID");
    const protocol = raw.toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{2,119}$/.test(protocol)) {
        fail("CORE_NETWORK_REQUEST_PROTOCOL_INVALID");
    }
    return protocol;
}
function normalizeIdentityId(value, code, options = {}) {
    const minimumLength = options.minimumLength ?? 1;
    const maximumLength = options.maximumLength ?? 160;
    const id = String(value ?? "").trim();
    if (id.length < minimumLength
        || id.length > maximumLength
        || id.includes("*")
        || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(id)) {
        fail(code);
    }
    return id;
}
function normalizeOptionalIdentityId(value, code) {
    if (value === undefined || value === null || String(value).trim() === "")
        return undefined;
    return normalizeIdentityId(value, code);
}
function normalizeRequestId(value, code) {
    return normalizeIdentityId(value, code, { minimumLength: 8, maximumLength: 200 });
}
function normalizeExpiresAt(value, now = Date.now()) {
    const raw = cleanText(value, 64);
    const expiresAtMs = Date.parse(raw);
    if (!raw || !Number.isFinite(expiresAtMs))
        fail("CORE_NETWORK_REQUEST_EXPIRES_AT_INVALID");
    if (expiresAtMs <= now)
        fail("CORE_NETWORK_REQUEST_EXPIRED");
    if (expiresAtMs > now + 31 * 24 * 60 * 60 * 1000) {
        fail("CORE_NETWORK_REQUEST_EXPIRY_TOO_FAR");
    }
    return new Date(expiresAtMs).toISOString();
}
function normalizeCreatedAt(value, expiresAt, now = Date.now()) {
    const raw = cleanText(value, 64);
    const createdAtMs = Date.parse(raw);
    if (!raw || !Number.isFinite(createdAtMs))
        fail("CORE_NETWORK_REQUEST_CREATED_AT_INVALID");
    if (createdAtMs > now + 5 * 60 * 1000)
        fail("CORE_NETWORK_REQUEST_CREATED_AT_IN_FUTURE");
    if (createdAtMs >= Date.parse(expiresAt))
        fail("CORE_NETWORK_REQUEST_TIME_RANGE_INVALID");
    return new Date(createdAtMs).toISOString();
}
function normalizeTimeout(value) {
    const parsed = Number(value ?? CORE_NETWORK_REQUEST_DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(parsed))
        fail("CORE_NETWORK_REQUEST_TIMEOUT_INVALID");
    return Math.max(100, Math.min(CORE_NETWORK_REQUEST_MAX_TIMEOUT_MS, Math.floor(parsed)));
}
function cloneStrictJsonValue(value, ancestors, depth) {
    if (depth > MAX_JSON_DEPTH)
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
        }
        return value;
    }
    if (typeof value !== "object")
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    const objectValue = value;
    if (ancestors.has(objectValue))
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    ancestors.add(objectValue);
    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) {
                fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
            }
            if (Object.getOwnPropertySymbols(value).length) {
                fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
            }
            const descriptors = Object.getOwnPropertyDescriptors(value);
            const keys = Object.keys(descriptors).filter((key) => key !== "length");
            if (keys.length !== value.length)
                fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
            const result = [];
            for (let index = 0; index < value.length; index += 1) {
                const descriptor = descriptors[String(index)];
                if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
                    fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
                }
                result.push(cloneStrictJsonValue(descriptor.value, ancestors, depth + 1));
            }
            return result;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
        }
        if (Object.getOwnPropertySymbols(value).length) {
            fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const result = Object.create(null);
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (!descriptor.enumerable || !("value" in descriptor)) {
                fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
            }
            result[key] = cloneStrictJsonValue(descriptor.value, ancestors, depth + 1);
        }
        return result;
    }
    catch (error) {
        if (error instanceof CoreNetworkRequestFailure)
            throw error;
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    }
    finally {
        ancestors.delete(objectValue);
    }
}
function cloneJsonValue(value, maximumBytes, sizeError) {
    let serialized;
    try {
        const cloned = cloneStrictJsonValue(value, new Set(), 0);
        serialized = JSON.stringify(cloned);
    }
    catch (error) {
        if (error instanceof CoreNetworkRequestFailure)
            throw error;
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    }
    if (serialized === undefined)
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    if (Buffer.byteLength(serialized, "utf8") > maximumBytes)
        fail(sizeError);
    try {
        return JSON.parse(serialized);
    }
    catch {
        fail("CORE_NETWORK_REQUEST_JSON_REQUIRED");
    }
}
function normalizeActor(value) {
    if (!value)
        return null;
    const actor = {
        accountId: cleanText(value.accountId, 160) || null,
        loginName: cleanText(value.loginName, 160) || null,
        memberId: cleanText(value.memberId, 160) || null,
        displayName: cleanText(value.displayName, 240) || null,
    };
    return Object.values(actor).some(Boolean) ? actor : null;
}
function normalizePeer(value) {
    const transportSecurity = value?.transportSecurity;
    if (transportSecurity !== "mtls"
        && transportSecurity !== "relay-e2ee"
        && transportSecurity !== "direct-e2ee") {
        fail("CORE_NETWORK_REQUEST_PEER_SECURITY_INVALID");
    }
    return {
        sourceOrganizationId: normalizeIdentityId(value?.sourceOrganizationId, "CORE_NETWORK_REQUEST_SOURCE_ORGANIZATION_INVALID"),
        sourceBonniSerial: normalizeIdentityId(value?.sourceBonniSerial, "CORE_NETWORK_REQUEST_SOURCE_SERIAL_INVALID"),
        linkId: normalizeIdentityId(value?.linkId, "CORE_NETWORK_REQUEST_LINK_ID_INVALID"),
        serviceAccountId: normalizeIdentityId(value?.serviceAccountId, "CORE_NETWORK_REQUEST_SERVICE_ACCOUNT_ID_INVALID"),
        serviceLoginName: value?.serviceLoginName
            ? cleanText(value.serviceLoginName, 160)
            : undefined,
        transportSecurity,
    };
}
function handlerSummary(value) {
    return {
        protocol: value.protocol,
        sourceModule: value.sourceModule,
        registeredAt: value.registeredAt,
    };
}
function cloneEnvelope(value) {
    return {
        ...value,
        actor: value.actor ? { ...value.actor } : null,
        payload: cloneJsonValue(value.payload, CORE_NETWORK_REQUEST_MAX_PAYLOAD_BYTES, "CORE_NETWORK_REQUEST_PAYLOAD_TOO_LARGE"),
    };
}
function deactivateLease(value) {
    if (!value.active)
        return;
    value.active = false;
    value.controller.abort();
}
async function runWithTimeout(operation, requestedTimeoutMs, expiresAt, options = {}) {
    const remainingMs = Date.parse(expiresAt) - Date.now();
    if (remainingMs <= 0)
        fail("CORE_NETWORK_REQUEST_EXPIRED");
    const timeoutMs = Math.max(1, Math.min(requestedTimeoutMs, remainingMs));
    const controller = new AbortController();
    const lifecycleSignals = options.lifecycleSignals || [];
    let timeout;
    let settled = false;
    const listeners = [];
    try {
        return await new Promise((resolve, reject) => {
            const finishResolve = (value) => {
                if (settled)
                    return;
                settled = true;
                resolve(value);
            };
            const finishReject = (error) => {
                if (settled)
                    return;
                settled = true;
                reject(error);
            };
            const cancel = () => {
                controller.abort();
                finishReject(new CoreNetworkRequestFailure("CORE_NETWORK_REQUEST_CANCELLED"));
            };
            for (const signal of lifecycleSignals) {
                if (signal.aborted) {
                    cancel();
                    return;
                }
                const listener = () => cancel();
                signal.addEventListener("abort", listener, { once: true });
                listeners.push({ signal, listener });
            }
            timeout = setTimeout(() => {
                controller.abort();
                finishReject(new CoreNetworkRequestFailure("CORE_NETWORK_REQUEST_TIMEOUT"));
            }, timeoutMs);
            timeout.unref?.();
            Promise.resolve()
                .then(() => {
                if (settled || lifecycleSignals.some((signal) => signal.aborted)) {
                    fail("CORE_NETWORK_REQUEST_CANCELLED");
                }
                if (options.isCurrent && !options.isCurrent()) {
                    fail("CORE_NETWORK_REQUEST_CANCELLED");
                }
                return operation(controller.signal, timeoutMs);
            })
                .then(finishResolve, finishReject);
        });
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        for (const { signal, listener } of listeners) {
            signal.removeEventListener("abort", listener);
        }
    }
}
class CoreNetworkRequestRegistry {
    handlers = new Map();
    provider = null;
    available() {
        return Boolean(this.provider?.active);
    }
    list() {
        return [...this.handlers.values()]
            .filter((entry) => entry.active)
            .map(handlerSummary)
            .sort((left, right) => left.protocol.localeCompare(right.protocol, "en"));
    }
    registerHandler(sourceModuleValue, runtimeToken, definition, authorize) {
        const sourceModule = normalizeModuleId(sourceModuleValue);
        const protocol = normalizeProtocol(definition?.protocol);
        if (typeof definition?.handler !== "function") {
            fail("CORE_NETWORK_REQUEST_HANDLER_REQUIRED");
        }
        if (this.handlers.has(protocol)) {
            fail(`CORE_NETWORK_REQUEST_PROTOCOL_ALREADY_OWNED:${protocol}`);
        }
        const registered = {
            protocol,
            sourceModule,
            runtimeToken,
            handler: definition.handler,
            authorize,
            registeredAt: new Date().toISOString(),
            active: true,
            controller: new AbortController(),
        };
        this.handlers.set(protocol, registered);
        return () => {
            deactivateLease(registered);
            if (this.handlers.get(protocol) === registered)
                this.handlers.delete(protocol);
        };
    }
    registerProvider(sourceModuleValue, runtimeToken, provider) {
        const sourceModule = normalizeModuleId(sourceModuleValue);
        if (sourceModule !== CORE_NETWORK_REQUEST_TRANSPORT_MODULE) {
            fail("CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_FORBIDDEN");
        }
        if (!provider
            || typeof provider.request !== "function"
            || !provider.localIdentity
            || typeof provider.localIdentity !== "object") {
            fail("CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_INVALID");
        }
        if (this.provider) {
            fail("CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_ALREADY_OWNED");
        }
        const localIdentity = Object.freeze({
            organizationId: normalizeIdentityId(provider.localIdentity.organizationId, "CORE_NETWORK_REQUEST_LOCAL_IDENTITY_INVALID"),
            bonniSerial: normalizeIdentityId(provider.localIdentity.bonniSerial, "CORE_NETWORK_REQUEST_LOCAL_IDENTITY_INVALID"),
        });
        const registered = {
            sourceModule,
            runtimeToken,
            provider: Object.freeze({
                localIdentity,
                request: provider.request.bind(provider),
            }),
            active: true,
            controller: new AbortController(),
        };
        this.provider = registered;
        return () => {
            deactivateLease(registered);
            if (this.provider === registered)
                this.provider = null;
        };
    }
    async request(sourceModuleValue, runtimeToken, runtimeSignal, input) {
        const sourceModule = normalizeModuleId(sourceModuleValue);
        const now = Date.now();
        const protocol = normalizeProtocol(input?.protocol);
        const owner = this.handlers.get(protocol);
        if (!owner
            || !owner.active
            || owner.sourceModule !== sourceModule
            || owner.runtimeToken !== runtimeToken) {
            fail("CORE_NETWORK_REQUEST_PROTOCOL_NOT_OWNED");
        }
        const provider = this.provider;
        if (!provider?.active)
            fail("CORE_NETWORK_REQUEST_TRANSPORT_UNAVAILABLE");
        const expiresAt = normalizeExpiresAt(input?.expiresAt, now);
        const envelope = {
            protocol,
            sourceModule,
            recipientOrganizationId: normalizeIdentityId(input?.recipientOrganizationId, "CORE_NETWORK_REQUEST_RECIPIENT_ORGANIZATION_INVALID"),
            recipientBonniSerial: normalizeOptionalIdentityId(input?.recipientBonniSerial, "CORE_NETWORK_REQUEST_RECIPIENT_SERIAL_INVALID"),
            linkId: normalizeOptionalIdentityId(input?.linkId, "CORE_NETWORK_REQUEST_LINK_ID_INVALID"),
            requestId: normalizeRequestId(input?.requestId, "CORE_NETWORK_REQUEST_ID_INVALID"),
            idempotencyKey: normalizeRequestId(input?.idempotencyKey, "CORE_NETWORK_REQUEST_IDEMPOTENCY_KEY_INVALID"),
            createdAt: new Date(now).toISOString(),
            expiresAt,
            actor: normalizeActor(input?.actor),
            payload: cloneJsonValue(input?.payload, CORE_NETWORK_REQUEST_MAX_PAYLOAD_BYTES, "CORE_NETWORK_REQUEST_PAYLOAD_TOO_LARGE"),
        };
        const timeoutMs = normalizeTimeout(input?.timeoutMs);
        if (owner.authorize) {
            await owner.authorize({
                moduleKey: sourceModule,
                direction: "OUTBOUND",
                protocol,
                remoteHost: envelope.recipientOrganizationId,
                route: envelope.linkId || envelope.recipientBonniSerial || null,
                secure: true,
                sameOrganization: envelope.recipientOrganizationId === provider.provider.localIdentity.organizationId,
                accountId: envelope.actor?.accountId || null,
            });
        }
        let response;
        try {
            response = await runWithTimeout((signal, effectiveTimeoutMs) => provider.provider.request(cloneEnvelope(envelope), { signal, timeoutMs: effectiveTimeoutMs }), timeoutMs, expiresAt, {
                lifecycleSignals: [
                    runtimeSignal,
                    owner.controller.signal,
                    provider.controller.signal,
                ],
                isCurrent: () => (owner.active
                    && provider.active
                    && this.handlers.get(protocol) === owner
                    && this.provider === provider),
            });
        }
        catch (error) {
            rethrowBoundary(error, "CORE_NETWORK_REQUEST_TRANSPORT_FAILED");
        }
        return cloneJsonValue(response, CORE_NETWORK_REQUEST_MAX_RESPONSE_BYTES, "CORE_NETWORK_REQUEST_RESPONSE_TOO_LARGE");
    }
    async dispatchInbound(sourceModuleValue, runtimeToken, runtimeSignal, envelopeValue, peerValue, options = {}) {
        const transportModule = normalizeModuleId(sourceModuleValue);
        if (transportModule !== CORE_NETWORK_REQUEST_TRANSPORT_MODULE) {
            fail("CORE_NETWORK_REQUEST_INBOUND_DISPATCH_FORBIDDEN");
        }
        const provider = this.provider;
        if (!provider?.active || provider.runtimeToken !== runtimeToken) {
            fail("CORE_NETWORK_REQUEST_TRANSPORT_UNAVAILABLE");
        }
        const now = Date.now();
        const protocol = normalizeProtocol(envelopeValue?.protocol);
        const handler = this.handlers.get(protocol);
        if (!handler?.active)
            fail("CORE_NETWORK_REQUEST_HANDLER_NOT_FOUND");
        const sourceModule = normalizeModuleId(envelopeValue?.sourceModule);
        if (sourceModule !== handler.sourceModule) {
            fail("CORE_NETWORK_REQUEST_SOURCE_MODULE_MISMATCH");
        }
        const expiresAt = normalizeExpiresAt(envelopeValue?.expiresAt, now);
        const envelope = {
            protocol,
            sourceModule,
            recipientOrganizationId: normalizeIdentityId(envelopeValue?.recipientOrganizationId, "CORE_NETWORK_REQUEST_RECIPIENT_ORGANIZATION_INVALID"),
            recipientBonniSerial: normalizeOptionalIdentityId(envelopeValue?.recipientBonniSerial, "CORE_NETWORK_REQUEST_RECIPIENT_SERIAL_INVALID"),
            linkId: normalizeIdentityId(envelopeValue?.linkId, "CORE_NETWORK_REQUEST_LINK_ID_INVALID"),
            requestId: normalizeRequestId(envelopeValue?.requestId, "CORE_NETWORK_REQUEST_ID_INVALID"),
            idempotencyKey: normalizeRequestId(envelopeValue?.idempotencyKey, "CORE_NETWORK_REQUEST_IDEMPOTENCY_KEY_INVALID"),
            createdAt: normalizeCreatedAt(envelopeValue?.createdAt, expiresAt, now),
            expiresAt,
            actor: normalizeActor(envelopeValue?.actor),
            payload: cloneJsonValue(envelopeValue?.payload, CORE_NETWORK_REQUEST_MAX_PAYLOAD_BYTES, "CORE_NETWORK_REQUEST_PAYLOAD_TOO_LARGE"),
        };
        const peer = normalizePeer(peerValue);
        if (envelope.linkId !== peer.linkId) {
            fail("CORE_NETWORK_REQUEST_LINK_ID_MISMATCH");
        }
        const localIdentity = provider.provider.localIdentity;
        if (envelope.recipientOrganizationId !== localIdentity.organizationId) {
            fail("CORE_NETWORK_REQUEST_RECIPIENT_ORGANIZATION_MISMATCH");
        }
        if (envelope.recipientBonniSerial
            && envelope.recipientBonniSerial !== localIdentity.bonniSerial) {
            fail("CORE_NETWORK_REQUEST_RECIPIENT_SERIAL_MISMATCH");
        }
        if (handler.authorize) {
            await handler.authorize({
                moduleKey: handler.sourceModule,
                direction: "INBOUND",
                protocol,
                remoteHost: peer.sourceOrganizationId,
                route: peer.sourceBonniSerial,
                secure: true,
                sameOrganization: peer.sourceOrganizationId === localIdentity.organizationId,
                accountId: envelope.actor?.accountId || null,
            });
        }
        const timeoutMs = normalizeTimeout(options.timeoutMs);
        let response;
        try {
            response = await runWithTimeout((signal) => handler.handler(cloneEnvelope(envelope), {
                peer: { ...peer },
                receivedAt: new Date().toISOString(),
                signal,
            }), timeoutMs, expiresAt, {
                lifecycleSignals: [
                    runtimeSignal,
                    provider.controller.signal,
                    handler.controller.signal,
                ],
                isCurrent: () => (provider.active
                    && handler.active
                    && this.provider === provider
                    && this.handlers.get(protocol) === handler),
            });
        }
        catch (error) {
            rethrowBoundary(error, "CORE_NETWORK_REQUEST_HANDLER_FAILED");
        }
        return cloneJsonValue(response, CORE_NETWORK_REQUEST_MAX_RESPONSE_BYTES, "CORE_NETWORK_REQUEST_RESPONSE_TOO_LARGE");
    }
}
const coreNetworkRequestRegistry = new CoreNetworkRequestRegistry();
export function createStagedModuleNetworkRequestRuntime(sourceModuleValue, authorize) {
    const sourceModule = normalizeModuleId(sourceModuleValue);
    const coordinator = sourceModule === CORE_NETWORK_REQUEST_TRANSPORT_MODULE;
    const runtimeToken = Symbol(sourceModule);
    const runtimeController = new AbortController();
    const handlers = new Map();
    let provider = null;
    let active = false;
    let disposed = false;
    function ensureUsable() {
        if (disposed)
            fail("CORE_NETWORK_REQUEST_RUNTIME_DISPOSED");
    }
    function ensureActive() {
        ensureUsable();
        if (!active)
            fail("CORE_NETWORK_REQUEST_RUNTIME_NOT_ACTIVE");
    }
    function privileged() {
        if (!coordinator)
            fail("CORE_NETWORK_REQUEST_TRANSPORT_COORDINATOR_REQUIRED");
    }
    function unregisterHandler(entry) {
        entry.unregisterGlobal?.();
        entry.unregisterGlobal = undefined;
        if (handlers.get(entry.protocol) === entry)
            handlers.delete(entry.protocol);
    }
    function unregisterProvider(entry) {
        entry.unregisterGlobal?.();
        entry.unregisterGlobal = undefined;
        if (provider === entry)
            provider = null;
    }
    const runtime = Object.freeze({
        available: () => active && !disposed && coreNetworkRequestRegistry.available(),
        isAvailable: () => active && !disposed && coreNetworkRequestRegistry.available(),
        list: () => active && !disposed ? coreNetworkRequestRegistry.list() : [],
        registerHandler: (definition) => {
            ensureUsable();
            const protocol = normalizeProtocol(definition?.protocol);
            if (typeof definition?.handler !== "function") {
                fail("CORE_NETWORK_REQUEST_HANDLER_REQUIRED");
            }
            if (handlers.has(protocol)) {
                fail(`CORE_NETWORK_REQUEST_PROTOCOL_ALREADY_OWNED:${protocol}`);
            }
            const entry = { protocol, handler: definition.handler };
            handlers.set(protocol, entry);
            try {
                if (active) {
                    entry.unregisterGlobal = coreNetworkRequestRegistry.registerHandler(sourceModule, runtimeToken, entry, authorize);
                }
            }
            catch (error) {
                handlers.delete(protocol);
                throw error;
            }
            let registered = true;
            return () => {
                if (!registered)
                    return;
                registered = false;
                unregisterHandler(entry);
            };
        },
        request: (input) => {
            try {
                ensureActive();
            }
            catch (error) {
                return Promise.reject(error);
            }
            return coreNetworkRequestRegistry.request(sourceModule, runtimeToken, runtimeController.signal, input);
        },
        registerTransportProvider: (transportProvider) => {
            privileged();
            ensureUsable();
            if (!transportProvider
                || typeof transportProvider.request !== "function"
                || !transportProvider.localIdentity
                || typeof transportProvider.localIdentity !== "object") {
                fail("CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_INVALID");
            }
            normalizeIdentityId(transportProvider.localIdentity.organizationId, "CORE_NETWORK_REQUEST_LOCAL_IDENTITY_INVALID");
            normalizeIdentityId(transportProvider.localIdentity.bonniSerial, "CORE_NETWORK_REQUEST_LOCAL_IDENTITY_INVALID");
            if (provider)
                fail("CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_ALREADY_OWNED");
            const entry = { provider: transportProvider };
            provider = entry;
            try {
                if (active) {
                    entry.unregisterGlobal = coreNetworkRequestRegistry.registerProvider(sourceModule, runtimeToken, transportProvider);
                }
            }
            catch (error) {
                provider = null;
                throw error;
            }
            let registered = true;
            return () => {
                if (!registered)
                    return;
                registered = false;
                unregisterProvider(entry);
            };
        },
        dispatchInbound: (envelope, peer, options) => {
            privileged();
            try {
                ensureActive();
            }
            catch (error) {
                return Promise.reject(error);
            }
            return coreNetworkRequestRegistry.dispatchInbound(sourceModule, runtimeToken, runtimeController.signal, envelope, peer, options);
        },
        dispose: () => {
            controller.dispose();
        },
    });
    const controller = {
        runtime,
        activate() {
            ensureUsable();
            if (active)
                return;
            const activatedHandlers = [];
            let activatedProvider = null;
            try {
                for (const entry of handlers.values()) {
                    entry.unregisterGlobal = coreNetworkRequestRegistry.registerHandler(sourceModule, runtimeToken, entry, authorize);
                    activatedHandlers.push(entry);
                }
                if (provider) {
                    provider.unregisterGlobal = coreNetworkRequestRegistry.registerProvider(sourceModule, runtimeToken, provider.provider);
                    activatedProvider = provider;
                }
                active = true;
            }
            catch (error) {
                activatedProvider?.unregisterGlobal?.();
                if (activatedProvider)
                    activatedProvider.unregisterGlobal = undefined;
                for (const entry of activatedHandlers.reverse()) {
                    entry.unregisterGlobal?.();
                    entry.unregisterGlobal = undefined;
                }
                throw error;
            }
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            active = false;
            runtimeController.abort();
            if (provider)
                unregisterProvider(provider);
            for (const entry of [...handlers.values()].reverse()) {
                unregisterHandler(entry);
            }
        },
    };
    return controller;
}
export function createModuleNetworkRequestRuntime(sourceModuleValue) {
    const staged = createStagedModuleNetworkRequestRuntime(sourceModuleValue);
    staged.activate();
    return staged.runtime;
}
