import { getVerifiedRequestIdentity } from '../../platform/auth/request-identity/request-identity-context.js';
export const MODULE_SERVICES_VERSION = 'bonni.module-services/v1';
/** Match the Core SYSTEM_ADMIN gate on verified, personal identities; never use role display labels. */
function canAdministerSystem(actor) {
    if (actor.type !== 'ADMIN' && actor.type !== 'MEMBER')
        return false;
    const norm = (s) => s.trim().toUpperCase().replaceAll('.', '_');
    return actor.permissions.some(p => p === '*' || norm(p) === 'SYSTEM_ADMIN') ||
        actor.roles.some(r => ['ADMIN', 'SYSTEM_ADMIN'].includes(norm(r)));
}
export const canReviewSystemErasure = canAdministerSystem;
const issue = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const record = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const moduleId = (v) => typeof v === 'string' && /^(?:app|addon|plugin)\.[a-z0-9][a-z0-9.-]{0,90}$/.test(v) && !v.includes('..');
const identifier = (v) => typeof v === 'string' && /^[a-z][a-zA-Z0-9.-]{0,79}$/.test(v);
const version = (v) => typeof v === 'string' && /^[a-z][a-z0-9.-]{1,90}\/v[1-9][0-9]*$/.test(v);
function offer(v) { return record(v) && identifier(v.id) && version(v.version) && Array.isArray(v.operations) && v.operations.length > 0 && v.operations.length <= 64 && new Set(v.operations).size === v.operations.length && v.operations.every(identifier); }
/** Module-owned contracts. Core validates declarations and transports values; it interprets no business data. */
export function validateModuleServicesManifest(manifest) {
    const declaration = manifest.metadata?.moduleServices, requested = manifest.dependsOn?.includes('core.module-services');
    if (!requested && declaration === undefined)
        return [];
    const errors = [];
    if (!requested || !record(declaration) || Object.keys(declaration).some(k => !['provides', 'consumes', 'connections'].includes(k))) {
        return ['core.module-services benötigt metadata.moduleServices mit provides/consumes.'];
    }
    const provided = declaration.provides ?? [], consumed = declaration.consumes ?? [], connections = declaration.connections ?? [];
    if (!Array.isArray(connections) || connections.length > 32 || connections.some(v => !moduleId(v)) || new Set(connections).size !== connections.length)
        errors.push('Ungültige deklarierte Modulverbindungen.');
    const rights = [...(Array.isArray(manifest.permissions) ? manifest.permissions : Array.isArray(manifest.permissions?.provides) ? manifest.permissions.provides : []), ...(Array.isArray(manifest.permissions?.requires) ? manifest.permissions.requires : [])];
    if (!Array.isArray(provided) || provided.length > 16 || provided.some(v => !offer(v) || Object.keys(v).some(k => !['id', 'version', 'operations', 'control'].includes(k))) || provided.some(v => v?.control !== undefined && (v.control !== true || v.version !== 'bonni.module-maintenance/v1' || v.operations.some((op) => !['status', 'configure', 'export'].includes(op)))) || new Set(provided.map(v => v?.id)).size !== provided.length)
        errors.push('Ungültige angebotene Modulschnittstellen.');
    if (!Array.isArray(consumed) || consumed.length > 32 || consumed.some(v => !offer(v) || !moduleId(v.provider) || typeof v.permission !== 'string' || !rights.includes(v.permission) || Object.keys(v).some(k => !['id', 'version', 'operations', 'provider', 'permission'].includes(k))) || new Set(consumed.map(v => v?.provider + ':' + v?.id)).size !== consumed.length)
        errors.push('Ungültige angeforderte Modulschnittstellen oder fehlende deklarierte Berechtigung.');
    return errors;
}
export function createModuleServicesRegistry(options = {}) {
    const active = new Map();
    return Object.freeze({
        /** Host scheduler only; absent from every module runtime capability. */
        async cycleAccountErasure(module, operation, subject, approvedBy, retention) {
            if (!moduleId(module) || !['freeze', 'inspect', 'erase', 'verify', 'retentionPreview'].includes(operation) || !approvedBy)
                throw issue('ERASURE_OPERATION_DENIED', 403);
            const key = module + ':accountErasure', slot = active.get(key);
            if (!slot?.active || !['bonni.account-erasure/v2', 'bonni.account-erasure/v3'].includes(slot.offer.version) || !slot.offer.operations.includes(operation))
                throw issue('ERASURE_PARTICIPANT_UNAVAILABLE', 503);
            const context = Object.freeze({ sourceModule: 'core.account-erasure-cycle', actorAccountId: approvedBy, retention, assertActive() { if (!slot.active || active.get(key) !== slot)
                    throw issue('ERASURE_PARTICIPANT_UNAVAILABLE', 503); } });
            context.assertActive();
            const result = await slot.provider.invoke(operation, structuredClone(subject), context);
            context.assertActive();
            return structuredClone(result);
        },
        // Host-only. The runtime handed to an app never exposes this method.
        async inspectAccountErasure(module, subject) {
            const actor = getVerifiedRequestIdentity();
            if (!actor || !canReviewSystemErasure(actor))
                throw issue('ACCOUNT_ERASURE_REVIEW_DENIED', 403);
            if (!moduleId(module))
                throw issue('ACCOUNT_ERASURE_INSPECTION_UNAVAILABLE', 503);
            const key = module + ':accountErasure', slot = active.get(key);
            if (!slot?.active || !['bonni.account-erasure/v1', 'bonni.account-erasure/v2', 'bonni.account-erasure/v3'].includes(slot.offer.version) || !slot.offer.operations.includes('inspect'))
                throw issue('ACCOUNT_ERASURE_INSPECTION_UNAVAILABLE', 503);
            const ctx = Object.freeze({ sourceModule: 'core.account-erasure', actorAccountId: actor.accountId, assertActive() {
                    if (!slot.active || active.get(key) !== slot)
                        throw issue('MODULE_SERVICE_CALL_CANCELLED', 503);
                } });
            ctx.assertActive();
            const result = await slot.provider.invoke('inspect', structuredClone(subject), ctx);
            ctx.assertActive();
            return result;
        },
        async invokeControl(module, operation, input = {}) {
            const identity = getVerifiedRequestIdentity();
            if (!identity)
                throw issue('MODULE_SERVICE_AUTHENTICATION_REQUIRED', 401);
            if (!canAdministerSystem(identity))
                throw issue('MODULE_SERVICE_PERMISSION_DENIED', 403);
            if (!moduleId(module) || !['status', 'configure', 'export'].includes(operation))
                throw issue('MODULE_SERVICE_OPERATION_DENIED', 403);
            const key = module + ':maintenance', target = active.get(key);
            if (!target?.active || target.offer.control !== true || target.offer.version !== 'bonni.module-maintenance/v1')
                throw issue('MODULE_MAINTENANCE_UNAVAILABLE', 404);
            if (!target.offer.operations.includes(operation))
                throw issue('MODULE_SERVICE_OPERATION_DENIED', 403);
            const capture = module === 'addon.capture' && operation !== 'status';
            const request = input;
            // Four compressed photos may be aligned together in receipt training.
            const assembly = capture && operation === 'configure' && request?.scope === 'training' && request.task === 'receipt' && request.action === 'assemble';
            const inputLimit = assembly ? 4_010_000 : capture ? 1_228_800 : 64 * 1024;
            let value;
            try {
                const json = JSON.stringify(input);
                if (!json || Buffer.byteLength(json) > inputLimit)
                    throw Error();
                value = JSON.parse(json);
            }
            catch {
                throw issue('MODULE_SERVICE_INPUT_INVALID', 400);
            }
            const context = Object.freeze({ sourceModule: 'core.control-center', actorAccountId: identity.accountId, assertActive() { if (!target.active || active.get(key) !== target)
                    throw issue('MODULE_SERVICE_CALL_CANCELLED', 503); } });
            context.assertActive();
            const result = await target.provider.invoke(operation, value, context);
            context.assertActive();
            return structuredClone(result);
        },
        stage(module, manifest) {
            if (manifest.key !== module || validateModuleServicesManifest(manifest).length)
                throw issue('MODULE_SERVICES_MANIFEST_INVALID', 500);
            const offers = structuredClone(manifest.metadata?.moduleServices?.provides ?? []), uses = structuredClone(manifest.metadata?.moduleServices?.consumes ?? []);
            const connections = structuredClone(manifest.metadata?.moduleServices?.connections ?? []);
            const owned = new Map();
            let live = false, disposed = false;
            const runtime = Object.freeze({ contractVersion: MODULE_SERVICES_VERSION,
                features: Object.freeze({ accountErasureCycle: 'bonni.account-erasure/v2', retentionArchive: 'bonni.retention/v1' }),
                register(id, provider) {
                    if (live || disposed || owned.has(id))
                        throw issue('MODULE_SERVICE_REGISTRATION_CLOSED', 409);
                    const declaration = offers.find(v => v.id === id);
                    if (!declaration || provider?.version !== declaration.version || typeof provider.invoke !== 'function')
                        throw issue('MODULE_SERVICE_DECLARATION_REQUIRED', 403);
                    owned.set(id, { module, offer: structuredClone(declaration), provider: { version: provider.version, invoke: provider.invoke.bind(provider) }, active: false });
                },
                async connectionState(provider) {
                    if (!live || disposed)
                        throw issue('MODULE_SERVICE_CALLER_INACTIVE', 503);
                    if (!moduleId(provider) || (!connections.includes(provider) && !uses.some(use => use.provider === provider)))
                        throw issue('MODULE_SERVICE_OPERATION_DENIED', 403);
                    if (!options.connectionState)
                        throw issue('MODULE_CONNECTION_STATE_UNAVAILABLE', 503);
                    let state;
                    try {
                        state = await options.connectionState(provider);
                    }
                    catch {
                        throw issue('MODULE_CONNECTION_STATE_UNAVAILABLE', 503);
                    }
                    if (!live || disposed)
                        throw issue('MODULE_SERVICE_CALLER_INACTIVE', 503);
                    if (typeof state?.installed !== 'boolean' || typeof state?.enabled !== 'boolean' || (!state.installed && state.enabled))
                        throw issue('MODULE_CONNECTION_STATE_INVALID', 503);
                    return Object.freeze({ installed: state.installed, enabled: state.enabled });
                },
                async invoke(provider, id, contract, operation, input) {
                    if (!live || disposed)
                        throw issue('MODULE_SERVICE_CALLER_INACTIVE', 503);
                    const use = uses.find(v => v.provider === provider && v.id === id && v.version === contract && v.operations.includes(operation));
                    if (!use)
                        throw issue('MODULE_SERVICE_OPERATION_DENIED', 403);
                    const identity = getVerifiedRequestIdentity();
                    if (!identity)
                        throw issue('MODULE_SERVICE_AUTHENTICATION_REQUIRED', 401);
                    if (!identity.permissions.includes(use.permission))
                        throw issue('MODULE_SERVICE_PERMISSION_DENIED', 403);
                    const key = provider + ':' + id, target = active.get(key);
                    if (!target?.active)
                        throw issue('MODULE_SERVICE_UNAVAILABLE', 503);
                    if (target.offer.version !== contract || !target.offer.operations.includes(operation))
                        throw issue('MODULE_SERVICE_VERSION_UNSUPPORTED', 409);
                    let value;
                    try {
                        const json = JSON.stringify(input);
                        if (!json || Buffer.byteLength(json) > 48 * 1024 * 1024)
                            throw Error();
                        value = JSON.parse(json);
                    }
                    catch {
                        throw issue('MODULE_SERVICE_INPUT_INVALID', 400);
                    }
                    const context = Object.freeze({ sourceModule: module, actorAccountId: identity.accountId, assertActive() { if (disposed || !live || !target.active || active.get(key) !== target)
                            throw issue('MODULE_SERVICE_CALL_CANCELLED', 503); } });
                    context.assertActive();
                    const result = await target.provider.invoke(operation, value, context);
                    context.assertActive();
                    return structuredClone(result);
                }
            });
            return Object.freeze({ runtime,
                activate() {
                    if (disposed)
                        throw issue('MODULE_SERVICE_CALLER_INACTIVE', 503);
                    if (offers.some(v => !owned.has(v.id)))
                        throw issue('MODULE_SERVICE_PROVIDER_MISSING', 500);
                    if ([...owned.keys()].some(id => active.has(module + ':' + id)))
                        throw issue('MODULE_SERVICE_PROVIDER_ALREADY_ACTIVE', 409);
                    for (const [id, slot] of owned) {
                        slot.active = true;
                        active.set(module + ':' + id, slot);
                    }
                    live = true;
                },
                dispose() { live = false; disposed = true; for (const [id, slot] of owned) {
                    slot.active = false;
                    if (active.get(module + ':' + id) === slot)
                        active.delete(module + ':' + id);
                } }
            });
        }
    });
}
export const moduleServicesRegistry = createModuleServicesRegistry({
    async connectionState(provider) {
        const { listInstalledModulesStrict } = await import('../../platform/module-manager/registry/index.js');
        const partner = (await listInstalledModulesStrict()).find(module => module.key === provider);
        return { installed: Boolean(partner?.installed), enabled: Boolean(partner?.installed && partner.enabled) };
    },
});
