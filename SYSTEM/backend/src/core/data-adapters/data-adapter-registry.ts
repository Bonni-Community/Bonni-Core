import { coreEventBus } from "../event-bus/event-bus.js";

export const CORE_DATA_CHANGED_EVENT = "bonni.core.data.changed";

export type CoreDataAdapterAction = "upsert" | "delete";

export type CoreDataAdapterOperation = {
  entityId: string;
  action: CoreDataAdapterAction;
  version: number;
  payload: unknown;
  occurredAt?: string;
  eventId?: string;
};

export type CoreDataActor = {
  accountId?: string | null;
  loginName?: string | null;
};

export type CoreDataChange = {
  domainId: string;
  operations: CoreDataAdapterOperation[];
  sourceModule: string;
  actor: CoreDataActor | null;
  occurredAt: string;
};

export type CoreDataRemoteContext = {
  sourceBonniSerial?: string | null;
  sourceOrganizationId?: string | null;
  serviceAccountId?: string | null;
  serviceLoginName?: string | null;
  eventId?: string | null;
  occurredAt?: string | null;
};

export type CoreDataAdapterDefinition = {
  domainId: string;
  name: string;
  description?: string;
  protocolVersion?: string;
  sourceModule: string;
  exportSnapshot?: () => Promise<CoreDataAdapterOperation[]>;
  applyRemote?: (
    operations: CoreDataAdapterOperation[],
    context: CoreDataRemoteContext,
  ) => Promise<unknown>;
};

export type CoreDataAdapterSummary = {
  domainId: string;
  name: string;
  description: string;
  protocolVersion: string;
  sourceModule: string;
  canExport: boolean;
  canApplyRemote: boolean;
  registeredAt: string;
};

type RegisteredAdapter = CoreDataAdapterDefinition & {
  registeredAt: string;
};

function cleanText(value: unknown, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeDomainId(value: unknown) {
  const domainId = cleanText(value, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(domainId)) {
    throw new Error("CORE_DATA_ADAPTER_DOMAIN_INVALID");
  }
  return domainId;
}

function normalizeOperation(value: CoreDataAdapterOperation): CoreDataAdapterOperation {
  const entityId = cleanText(value?.entityId, 240);
  if (!entityId) throw new Error("CORE_DATA_ADAPTER_ENTITY_ID_REQUIRED");

  const action: CoreDataAdapterAction = value?.action === "delete" ? "delete" : "upsert";
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

function adapterSummary(adapter: RegisteredAdapter): CoreDataAdapterSummary {
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
  private readonly adapters = new Map<string, RegisteredAdapter>();

  register(definition: CoreDataAdapterDefinition) {
    const domainId = normalizeDomainId(definition.domainId);
    const sourceModule = cleanText(definition.sourceModule, 160);
    if (!sourceModule) throw new Error("CORE_DATA_ADAPTER_SOURCE_REQUIRED");

    const existing = this.adapters.get(domainId);
    if (existing && existing.sourceModule !== sourceModule) {
      throw new Error(`CORE_DATA_ADAPTER_DOMAIN_ALREADY_OWNED:${domainId}`);
    }

    const adapter: RegisteredAdapter = {
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
      if (this.adapters.get(domainId) === adapter) this.adapters.delete(domainId);
    };
  }

  list() {
    return [...this.adapters.values()]
      .map(adapterSummary)
      .sort((left, right) => left.name.localeCompare(right.name, "de"));
  }

  async snapshot(domainIdValue: string) {
    const domainId = normalizeDomainId(domainIdValue);
    const adapter = this.adapters.get(domainId);
    if (!adapter) throw new Error("CORE_DATA_ADAPTER_NOT_REGISTERED");
    if (!adapter.exportSnapshot) throw new Error("CORE_DATA_ADAPTER_EXPORT_NOT_SUPPORTED");

    const values = await adapter.exportSnapshot();
    return (Array.isArray(values) ? values : []).slice(0, 100_000).map(normalizeOperation);
  }

  async applyRemote(
    domainIdValue: string,
    operations: CoreDataAdapterOperation[],
    context: CoreDataRemoteContext = {},
  ) {
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

  async publishLocal(change: Omit<CoreDataChange, "occurredAt"> & { occurredAt?: string }) {
    const domainId = normalizeDomainId(change.domainId);
    const operations = (Array.isArray(change.operations) ? change.operations : []).map(normalizeOperation);
    if (!operations.length) return { published: 0 };

    const event: CoreDataChange = {
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

  onLocalChange(handler: (change: CoreDataChange) => void | Promise<void>) {
    return coreEventBus.on<CoreDataChange>(CORE_DATA_CHANGED_EVENT, handler);
  }
}

export const coreDataAdapterRegistry = new CoreDataAdapterRegistry();

export function createModuleDataAdapterRuntime(sourceModuleValue: string) {
  const sourceModule = cleanText(sourceModuleValue, 160) || "unknown";
  const coordinator = sourceModule === "addon.bonni-network";

  function ownedDomain(domainIdValue: string) {
    const domainId = normalizeDomainId(domainIdValue);
    const owner = coreDataAdapterRegistry.list().find((entry) => entry.domainId === domainId)?.sourceModule;
    if (!coordinator && owner !== sourceModule) throw new Error("CORE_DATA_ADAPTER_DOMAIN_NOT_OWNED");
    return domainId;
  }

  return Object.freeze({
    register: (definition: Omit<CoreDataAdapterDefinition, "sourceModule">) => (
      coreDataAdapterRegistry.register({ ...definition, sourceModule })
    ),
    publish: (
      domainId: string,
      operations: CoreDataAdapterOperation | CoreDataAdapterOperation[],
      actor: CoreDataActor | null = null,
    ) => coreDataAdapterRegistry.publishLocal({
      domainId: ownedDomain(domainId),
      operations: Array.isArray(operations) ? operations : [operations],
      sourceModule,
      actor,
    }),
    list: () => coreDataAdapterRegistry.list(),
    snapshot: (domainId: string) => coreDataAdapterRegistry.snapshot(ownedDomain(domainId)),
    applyRemote: (
      domainId: string,
      operations: CoreDataAdapterOperation | CoreDataAdapterOperation[],
      context: CoreDataRemoteContext = {},
    ) => {
      if (!coordinator) throw new Error("CORE_DATA_ADAPTER_COORDINATOR_REQUIRED");
      return coreDataAdapterRegistry.applyRemote(
        domainId,
        Array.isArray(operations) ? operations : [operations],
        context,
      );
    },
    onLocalChange: (handler: (change: CoreDataChange) => void | Promise<void>) => (
      coordinator
        ? coreDataAdapterRegistry.onLocalChange(handler)
        : (() => { throw new Error("CORE_DATA_ADAPTER_COORDINATOR_REQUIRED"); })()
    ),
  });
}
