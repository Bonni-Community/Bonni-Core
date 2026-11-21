import { getVerifiedRequestIdentity } from "../../platform/auth/request-identity/request-identity-context.js";
import { HUB_PRODUCTS_VERSION, HUB_PRODUCT_OPERATIONS, HUB_PRODUCT_CLIENT_OPERATIONS, HUB_PRODUCT_CHANGE_VERSION, HUB_PRODUCT_PERMISSIONS, HUB_PRODUCT_OPERATION_PERMISSIONS, type ProductClientOperation, type ProductChange, type ProductNotification, type ProductListener, type HubProductsClient, type HubProductsDeclaration, type HubProductsProvider } from "./hub-products-contract.js";

function fail(code: string, statusCode: number): never {
  throw Object.assign(new Error(code), { code, statusCode });
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Used during discovery AND runtime creation so malformed persisted manifests fail closed. */
export function validateHubManifest(manifest: Record<string, any>): string[] {
  const errors: string[] = [];
  const dependencies = Array.isArray(manifest.dependsOn) ? manifest.dependsOn : [];
  const provides = Array.isArray(manifest.provides) ? manifest.provides : [];
  const declaration = manifest.metadata?.hubProducts;
  const provider = dependencies.includes("core.hub-provider");
  const providedRights = Array.isArray(manifest.permissions) ? manifest.permissions
    : Array.isArray(manifest.permissions?.provides) ? manifest.permissions.provides : [];
  const requiredRights = Array.isArray(manifest.permissions?.requires) ? manifest.permissions.requires : [];
  if (manifest.key !== "addon.hub" && providedRights.some((key: unknown) => typeof key === "string" && key.startsWith("hub."))) {
    errors.push("Hub-Rechtsschlüssel werden ausschließlich von addon.hub bereitgestellt; Apps fordern sie unter permissions.requires an.");
  }
  if ((provider || provides.includes("hub.products") || provides.includes("addon.hub") || manifest.metadata?.database?.domain === "hub")
      && (manifest.key !== "addon.hub" || manifest.kind !== "addon")) {
    errors.push("Hub-Provider und Hub-Datenbereich sind ausschließlich addon.hub vorbehalten.");
  }
  if (manifest.key === "addon.hub" && (!provider || !provides.includes("hub.products")
      || manifest.metadata?.database?.mode !== "scoped-v1" || manifest.metadata?.database?.domain !== "hub"
      || Object.values(HUB_PRODUCT_PERMISSIONS).some(key => !providedRights.includes(key)))) {
    errors.push("addon.hub benötigt core.hub-provider, hub.products, seine festen Produktrechte und den Datenbereich hub.");
  }
  if (dependencies.includes("core.hub-products") !== (declaration !== undefined)) {
    errors.push("core.hub-products und metadata.hubProducts müssen gemeinsam deklariert werden.");
  }
  if (declaration !== undefined) {
    if (!record(declaration) || declaration.contractVersion !== HUB_PRODUCTS_VERSION
        || Object.keys(declaration).some(key => !["contractVersion", "operations"].includes(key))
        || !Array.isArray(declaration.operations) || declaration.operations.length < 1
        || declaration.operations.length > HUB_PRODUCT_CLIENT_OPERATIONS.length
        || new Set(declaration.operations).size !== declaration.operations.length
        || declaration.operations.some((operation: unknown) => typeof operation !== "string"
          || !(HUB_PRODUCT_CLIENT_OPERATIONS as readonly string[]).includes(operation)
          || !requiredRights.includes(HUB_PRODUCT_OPERATION_PERMISSIONS[operation as ProductClientOperation]))) {
      errors.push("metadata.hubProducts benötigt hub.products/v2, eindeutige operations und die zugehörigen festen Hub-Rechte unter permissions.requires.");
    }
  }
  return errors;
}

/** In-process capabilities, not an isolation boundary for untrusted module code. */
export function createHubProductsRegistry(options: {
  connectionState?: () => Promise<{ installed: boolean; enabled: boolean }>;
  sourceInstanceId?: () => Promise<string>;
} = {}) {
  let active: { provider: HubProductsProvider; live: boolean } | null = null;
  type Subscription = { listener: ProductListener; isActive(): boolean };
  const subscriptions = new Set<Subscription>();
  const recentEvents = new Set<string>();
  const stateEvent = (type: "resync" | "unavailable"): ProductNotification => ({ contractVersion: HUB_PRODUCT_CHANGE_VERSION, type });
  function deliver(subscription: Subscription, event: ProductNotification) {
    queueMicrotask(() => {
      if (!subscriptions.has(subscription) || !subscription.isActive()) return;
      // Each app receives its own copy. A failing callback never fails a commit
      // or blocks another app. A failed change delivery requests one resync.
      Promise.resolve().then(() => {
        if (subscriptions.has(subscription) && subscription.isActive()) return subscription.listener(structuredClone(event));
      }).catch(() => {
        if (event.type === "changed") deliver(subscription, stateEvent("resync"));
      });
    });
  }
  function broadcast(event: ProductNotification) {
    for (const subscription of subscriptions) deliver(subscription, event);
  }
  return Object.freeze({
    stage(moduleKey: string, manifest: Record<string, any>) {
      if (manifest.key !== moduleKey || validateHubManifest(manifest).length) fail("HUB_MANIFEST_INVALID", 500);
      const dependencies = new Set(manifest.dependsOn || []);
      const isProvider = dependencies.has("core.hub-provider");
      const declaration = manifest.metadata?.hubProducts as HubProductsDeclaration | undefined;
      // A consumer can request fewer operations, never rename their rights.
      const operations = declaration ? new Set(declaration.operations) : null;
      let live = false;
      let disposed = false;
      const ownedSubscriptions = new Set<Subscription>();
      let owned: { provider: HubProductsProvider; live: boolean } | null = null;
      const providerRuntime = isProvider ? Object.freeze({
        contractVersion: HUB_PRODUCTS_VERSION,
        register(provider: HubProductsProvider) {
          if (live || disposed || owned) fail("HUB_PROVIDER_REGISTRATION_CLOSED", 409);
          if (provider?.contractVersion !== HUB_PRODUCTS_VERSION || typeof provider.invoke !== "function") fail("HUB_CONTRACT_VERSION_UNSUPPORTED", 400);
          owned = { provider: Object.freeze({ contractVersion: HUB_PRODUCTS_VERSION, invoke: provider.invoke.bind(provider) }), live: false };
        },
        publishChange(event: ProductChange) {
          if (!live || disposed || !owned?.live || active !== owned) return;
          const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          if (!record(event) || event.contractVersion !== HUB_PRODUCT_CHANGE_VERSION || event.type !== "changed"
              || Object.keys(event).some(key => !["contractVersion", "type", "eventId", "entity", "entityId", "productId", "revision", "action", "changedAt"].includes(key))
              || !["Product", "StockItem"].includes(event.entity) || !uuid.test(event.entityId)
              || (event.entity === "Product" && event.entityId !== event.productId)
              || !uuid.test(event.eventId) || !uuid.test(event.productId) || !Number.isSafeInteger(event.revision) || event.revision < 1
              || !(event.entity === "Product" ? ["create", "update", "archive", "setComponent", "removeComponent"] : ["create", "move", "archive"]).includes(event.action) || typeof event.changedAt !== "string"
              || !Number.isFinite(Date.parse(event.changedAt))) fail("HUB_NOTIFICATION_INVALID", 400);
          if (recentEvents.has(event.eventId)) return;
          recentEvents.add(event.eventId);
          if (recentEvents.size > 2048) recentEvents.delete(recentEvents.values().next().value!);
          broadcast(structuredClone(event));
        },
      }) : undefined;
      const client = operations ? Object.freeze(Object.fromEntries([
        ["contractVersion", HUB_PRODUCTS_VERSION],
        ["connectionState", async () => {
          if (!live || disposed) fail("HUB_CALLER_INACTIVE", 503);
          if (!options.connectionState) fail("HUB_STORAGE_CORE_REQUIRED", 503);
          const state = await options.connectionState();
          if (!live || disposed) fail("HUB_CALLER_INACTIVE", 503);
          return Object.freeze({ installed: state.installed, enabled: state.enabled });
        }],
        ["subscribe", (listener: ProductListener) => {
          if (disposed) fail("HUB_CALLER_INACTIVE", 503);
          if (!operations.has("subscribe")) fail("HUB_OPERATION_DENIED", 403);
          if (typeof listener !== "function") fail("HUB_INPUT_INVALID", 400);
          const subscription: Subscription = { listener, isActive: () => live && !disposed };
          subscriptions.add(subscription); ownedSubscriptions.add(subscription);
          if (live) deliver(subscription, stateEvent(active?.live ? "resync" : "unavailable"));
          return () => { subscriptions.delete(subscription); ownedSubscriptions.delete(subscription); };
        }],
        ...HUB_PRODUCT_OPERATIONS.map(operation => [operation, async (input: unknown = {}) => {
          if (!live || disposed) fail("HUB_CALLER_INACTIVE", 503);
          if (!operations.has(operation)) fail("HUB_OPERATION_DENIED", 403);
          const identity = getVerifiedRequestIdentity();
          if (!identity) fail("HUB_AUTHENTICATION_REQUIRED", 401);
          if (!identity.permissions.includes(HUB_PRODUCT_OPERATION_PERMISSIONS[operation])) fail("HUB_PERMISSION_DENIED", 403);
          const target = active;
          if (!target?.live) fail("HUB_UNAVAILABLE", 503);
          // Clone before any await; no shared mutable request object crosses the port.
          let payload: unknown;
          try {
            const json = JSON.stringify(input);
            if (!json || Buffer.byteLength(json, "utf8") > 16_384) fail("HUB_INPUT_INVALID", 400);
            payload = JSON.parse(json);
          } catch { fail("HUB_INPUT_INVALID", 400); }
          const context = Object.freeze({
            sourceInstanceId: options.sourceInstanceId ? await options.sourceInstanceId() : fail("HUB_INSTANCE_IDENTITY_REQUIRED", 503),
            sourceModule: moduleKey,
            actorAccountId: identity.accountId,
            assertActive() {
              if (!live || disposed || !target.live || active !== target) fail("HUB_CALL_CANCELLED", 503);
            },
          });
          context.assertActive();
          const result = await target.provider.invoke(operation, payload, context);
          context.assertActive();
          return structuredClone(result);
        }]),
      ])) as HubProductsClient : undefined;
      return Object.freeze({
        providerRuntime,
        client,
        activate() {
          if (disposed) fail("HUB_CALLER_INACTIVE", 503);
          if (isProvider) {
            if (!owned) fail("HUB_PROVIDER_NOT_REGISTERED", 500);
            if (active && active !== owned) fail("HUB_PROVIDER_ALREADY_ACTIVE", 409);
            owned.live = true;
            active = owned;
          }
          live = true;
          if (isProvider) broadcast(stateEvent("resync"));
          else for (const subscription of ownedSubscriptions) deliver(subscription, stateEvent(active?.live ? "resync" : "unavailable"));
        },
        dispose() {
          disposed = true;
          live = false;
          for (const subscription of ownedSubscriptions) subscriptions.delete(subscription);
          ownedSubscriptions.clear();
          if (owned) owned.live = false;
          if (active && active === owned) { active = null; broadcast(stateEvent("unavailable")); }
        },
      });
    },
  });
}

export const hubProductsRegistry = createHubProductsRegistry({
  async connectionState() {
    const { listInstalledModulesStrict } = await import("../../platform/module-manager/registry/index.js");
    const hub = (await listInstalledModulesStrict()).find(module => module.key === "addon.hub");
    return { installed: Boolean(hub?.installed), enabled: Boolean(hub?.installed && hub.enabled) };
  },
  // The original DEV68 Hub coordination is not reconstructed in this branch.
  // Installed Hub must use its matching Core rather than receive invented audit identity.
});
