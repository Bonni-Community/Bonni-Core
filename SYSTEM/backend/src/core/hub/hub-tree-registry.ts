import { getVerifiedRequestIdentity } from "../../platform/auth/request-identity/request-identity-context.js";
import { getCoreInstanceId } from "../instance-identity/core-instance-id.js";
const VERSION = "hub.tree/v1";
const operations = ["snapshot", "command", "subscribe"] as const;
type Operation = typeof operations[number];
type Provider = { contractVersion: string; invoke(operation: "snapshot" | "command", input: unknown, context: { sourceInstanceId: string; sourceModule: string; actorAccountId: string; assertActive(): void }): Promise<unknown> };
function fail(code: string, statusCode = 503): never { throw Object.assign(new Error(code), { code, statusCode }); }
export function validateHubTreeManifest(manifest: any): string[] {
  const errors: string[] = [], deps = Array.isArray(manifest.dependsOn) ? manifest.dependsOn : [], declaration = manifest.metadata?.hubTree;
  if (deps.includes("core.hub-tree-provider") && (manifest.key !== "addon.hub" || manifest.kind !== "addon")) errors.push("Nur addon.hub darf den zentralen Gruppen-/Standortvertrag bereitstellen.");
  if (deps.includes("core.hub-tree") !== (declaration !== undefined)) errors.push("core.hub-tree und metadata.hubTree müssen gemeinsam angegeben werden.");
  if (declaration !== undefined) {
    const rights = Array.isArray(manifest.permissions?.requires) ? manifest.permissions.requires : [], ops = declaration?.operations;
    if (!declaration || declaration.contractVersion !== VERSION || Object.keys(declaration).some(key => !["contractVersion", "operations"].includes(key)) || !Array.isArray(ops) || !ops.length || ops.length > 3 || new Set(ops).size !== ops.length || ops.some((op: unknown) => !operations.includes(op as Operation)) || !rights.includes("hub.stock.read") || !rights.includes("hub.products.read") || ops.includes("command") && !rights.includes("hub.stock.write")) errors.push("hub.tree/v1 benötigt eindeutige Operationen und die zugehörigen Hub-Lese-/Schreibrechte.");
  }
  return errors;
}
export function createHubTreeRegistry(options: { sourceInstanceId?: () => Promise<string> } = {}) {
  let active: { provider: Provider; live: boolean } | null = null;
  const listeners = new Set<{ listener(): unknown; active(): boolean }>();
  const publish = () => { for (const entry of listeners) queueMicrotask(() => { if (listeners.has(entry) && entry.active()) Promise.resolve().then(() => listeners.has(entry) && entry.active() && entry.listener()).catch(() => {}); }); };
  return { stage(moduleKey: string, manifest: any) {
    if (moduleKey !== manifest.key || validateHubTreeManifest(manifest).length) fail("HUB_TREE_MANIFEST_INVALID", 500);
    const isProvider = manifest.dependsOn?.includes("core.hub-tree-provider"), declaration = manifest.metadata?.hubTree;
    let live = false, disposed = false, owned: { provider: Provider; live: boolean } | null = null;
    const subscriptions = new Set<any>();
    const providerRuntime = isProvider ? Object.freeze({ contractVersion: VERSION, register(provider: Provider) { if (disposed || live || owned || provider?.contractVersion !== VERSION || typeof provider.invoke !== "function") fail("HUB_TREE_PROVIDER_INVALID"); owned = { provider: Object.freeze({ contractVersion: VERSION, invoke: provider.invoke.bind(provider) }), live: false }; }, publishInvalidation() { if (live && !disposed && owned === active && owned?.live) publish(); } }) : undefined;
    const allowed = new Set<Operation>(declaration?.operations || []);
    const client = declaration ? Object.freeze({ contractVersion: VERSION,
      subscribe(listener: () => unknown) { if (disposed || !allowed.has("subscribe") || typeof listener !== "function") fail("HUB_TREE_OPERATION_DENIED", 403); const entry = { listener, active: () => live && !disposed }; listeners.add(entry); subscriptions.add(entry); return () => { listeners.delete(entry); subscriptions.delete(entry); }; },
      ...Object.fromEntries((["snapshot", "command"] as const).map(operation => [operation, async (input: unknown = {}) => {
        if (!live || disposed) fail("HUB_TREE_CALLER_INACTIVE"); if (!allowed.has(operation)) fail("HUB_TREE_OPERATION_DENIED", 403);
        const identity = getVerifiedRequestIdentity(); if (!identity || identity.type !== "MEMBER") fail("HUB_AUTHENTICATION_REQUIRED", 401);
        const rights = operation === "command" ? ["hub.stock.read", "hub.products.read", "hub.stock.write"] : ["hub.stock.read", "hub.products.read"];
        if (rights.some(right => !identity.permissions.includes(right))) fail("HUB_PERMISSION_DENIED", 403);
        const target = active; if (!target?.live) fail("HUB_UNAVAILABLE");
        let payload: unknown; try { const json = JSON.stringify(input); if (!json || Buffer.byteLength(json, "utf8") > 16384) fail("HUB_TREE_INPUT_INVALID", 400); payload = JSON.parse(json); } catch { fail("HUB_TREE_INPUT_INVALID", 400); }
        const context = Object.freeze({ sourceInstanceId: options.sourceInstanceId ? await options.sourceInstanceId() : fail("HUB_INSTANCE_IDENTITY_REQUIRED"), sourceModule: moduleKey, actorAccountId: identity.accountId, assertActive() { if (!live || disposed || !target.live || target !== active) fail("HUB_CALL_CANCELLED"); } });
        context.assertActive(); const result = await target.provider.invoke(operation, payload, context); context.assertActive(); return structuredClone(result);
      }])) }) : undefined;
    return { providerRuntime, client, activate() { if (disposed) fail("HUB_TREE_CALLER_INACTIVE"); if (isProvider) { if (!owned) fail("HUB_TREE_PROVIDER_NOT_REGISTERED"); if (active && active !== owned) fail("HUB_TREE_PROVIDER_ALREADY_ACTIVE", 409); owned.live = true; active = owned; } live = true; publish(); }, dispose() { disposed = true; live = false; for (const item of subscriptions) listeners.delete(item); subscriptions.clear(); if (owned) owned.live = false; if (active === owned) { active = null; publish(); } } };
  } };
}
export const hubTreeRegistry = createHubTreeRegistry({ async sourceInstanceId() { const { getPrismaClient } = await import("../database/prisma.js"); return getCoreInstanceId(getPrismaClient()); } });
