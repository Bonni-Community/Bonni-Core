import { coreEventBus } from "../event-bus/event-bus.js";
export const CORE_DATA_CHANGED_EVENT = "bonni.core.data.changed";
function cleanText(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
}
function normalizeDomainId(value) {
    const domainId = cleanText(value, 120).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(domainId)) {
        throw new Error("CORE_DATA_ADAPTER_DOMAIN_INVALID");
    }
    return domainId;
}
function normalizeOperation(value) {
    const entityId = cleanText(value?.entityId, 240);
    if (!entityId)
        throw new Error("CORE_DATA_ADAPTER_ENTITY_ID_REQUIRED");
    const action = value?.action === "delete" ? "delete" : "upsert";
    const version = Math.max(1, Math.floor(Number(value?.version || 1)));
    return {
        entityId,
        action,
        version,
        payload: action === "delete" ? null : structuredClone(value?.payload ?? {}),
        occurredAt: value?.occurredAt ? cleanText(value.occurredAt, 64) : undefined,
        eventId: value?.eventId ? cleanText(value.eventId, 240) : undefined,
    };
}
function adapterSummary(adapter) {
    return {
        domainId: adapter.domainId,
        name: adapter.name,
        description: adapter.description || "",
        protocolVersion: adapter.protocolVersion || "1.0",
        sourceModule: adapter.sourceModule,
        canExport: typeof adapter.exportSnapshot === "function",
        canApplyRemote: typeof adapter.applyRemote === "function",
        registeredAt: adapter.registeredAt,
    };
}
class CoreDataAdapterRegistry {
    adapters = new Map();
    register(definition) {
        const domainId = normalizeDomainId(definition.domainId);
        const sourceModule = cleanText(definition.sourceModule, 160);
        if (!sourceModule)
            throw new Error("CORE_DATA_ADAPTER_SOURCE_REQUIRED");
        const existing = this.adapters.get(domainId);
        if (existing && existing.sourceModule !== sourceModule) {
            throw new Error(`CORE_DATA_ADAPTER_DOMAIN_ALREADY_OWNED:${domainId}`);
        }
        const adapter = {
            ...definition,
            domainId,
            sourceModule,
            name: cleanText(definition.name, 160) || domainId,
            description: cleanText(definition.description, 320),
            protocolVersion: cleanText(definition.protocolVersion, 32) || "1.0",
            registeredAt: existing?.registeredAt || new Date().toISOString(),
        };
        this.adapters.set(domainId, adapter);
        return () => {
            if (this.adapters.get(domainId) === adapter)
                this.adapters.delete(domainId);
        };
    }
    list() {
        return [...this.adapters.values()]
            .map(adapterSummary)
            .sort((left, right) => left.name.localeCompare(right.name, "de"));
    }
    async snapshot(domainIdValue) {
        const domainId = normalizeDomainId(domainIdValue);
        const adapter = this.adapters.get(domainId);
        if (!adapter)
            throw new Error("CORE_DATA_ADAPTER_NOT_REGISTERED");
        if (!adapter.exportSnapshot)
            throw new Error("CORE_DATA_ADAPTER_EXPORT_NOT_SUPPORTED");
        const values = await adapter.exportSnapshot();
        return (Array.isArray(values) ? values : []).slice(0, 100_000).map(normalizeOperation);
    }
    async applyRemote(domainIdValue, operations, context = {}) {
        const domainId = normalizeDomainId(domainIdValue);
        const adapter = this.adapters.get(domainId);
        if (!adapter?.applyRemote) {
            return { handled: false, reason: adapter ? "CORE_DATA_ADAPTER_IMPORT_NOT_SUPPORTED" : "CORE_DATA_ADAPTER_NOT_REGISTERED" };
        }
        const normalized = (Array.isArray(operations) ? operations : []).map(normalizeOperation);
        return {
            handled: true,
            result: await adapter.applyRemote(normalized, structuredClone(context)),
        };
    }
    async publishLocal(change) {
        const domainId = normalizeDomainId(change.domainId);
        const operations = (Array.isArray(change.operations) ? change.operations : []).map(normalizeOperation);
        if (!operations.length)
            return { published: 0 };
        const event = {
            domainId,
            operations,
            sourceModule: cleanText(change.sourceModule, 160) || "unknown",
            actor: change.actor
                ? {
                    accountId: cleanText(change.actor.accountId, 160) || null,
                    loginName: cleanText(change.actor.loginName, 160) || null,
                }
                : null,
            occurredAt: cleanText(change.occurredAt, 64) || new Date().toISOString(),
        };
        await coreEventBus.emit(CORE_DATA_CHANGED_EVENT, event);
        return { published: operations.length };
    }
    onLocalChange(handler) {
        return coreEventBus.on(CORE_DATA_CHANGED_EVENT, handler);
    }
}
export const coreDataAdapterRegistry = new CoreDataAdapterRegistry();
export function createModuleDataAdapterRuntime(sourceModuleValue) {
    const sourceModule = cleanText(sourceModuleValue, 160) || "unknown";
    const coordinator = sourceModule === "addon.bonni-network";
    function ownedDomain(domainIdValue) {
        const domainId = normalizeDomainId(domainIdValue);
        const owner = coreDataAdapterRegistry.list().find((entry) => entry.domainId === domainId)?.sourceModule;
        if (!coordinator && owner !== sourceModule)
            throw new Error("CORE_DATA_ADAPTER_DOMAIN_NOT_OWNED");
        return domainId;
    }
    return Object.freeze({
        register: (definition) => (coreDataAdapterRegistry.register({ ...definition, sourceModule })),
        publish: (domainId, operations, actor = null) => coreDataAdapterRegistry.publishLocal({
            domainId: ownedDomain(domainId),
            operations: Array.isArray(operations) ? operations : [operations],
            sourceModule,
            actor,
        }),
        list: () => coreDataAdapterRegistry.list(),
        snapshot: (domainId) => coreDataAdapterRegistry.snapshot(ownedDomain(domainId)),
        applyRemote: (domainId, operations, context = {}) => {
            if (!coordinator)
                throw new Error("CORE_DATA_ADAPTER_COORDINATOR_REQUIRED");
            return coreDataAdapterRegistry.applyRemote(domainId, Array.isArray(operations) ? operations : [operations], context);
        },
        onLocalChange: (handler) => (coordinator
            ? coreDataAdapterRegistry.onLocalChange(handler)
            : (() => { throw new Error("CORE_DATA_ADAPTER_COORDINATOR_REQUIRED"); })()),
    });
}
