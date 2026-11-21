import { getDiagnosticRequest, isDiagnosticModuleKey } from "../../../core/logger/diagnostic-context.js";
function onceRuntimeModuleCleanup(cleanup) {
    let called = false;
    return async () => {
        if (called)
            return;
        called = true;
        await cleanup();
    };
}
export function normalizeRuntimeModuleCleanup(value) {
    if (typeof value === "function")
        return onceRuntimeModuleCleanup(value);
    if (value && typeof value === "object" && typeof value.dispose === "function") {
        const disposable = value;
        return onceRuntimeModuleCleanup(() => disposable.dispose());
    }
    return undefined;
}
/**
 * Creates one stable Express mount whose module routers can be published and
 * deactivated at runtime. The callback supplies the already validated live
 * runtime state. Registry/database synchronisation belongs to startup and the
 * explicit activation lifecycle, not to every feature request.
 */
export function createDynamicModuleRuntime(enabledModuleKeys) {
    const slots = new Map();
    async function deactivateSlot(key) {
        const slot = slots.get(key);
        if (!slot)
            return;
        // Delete before awaiting user code. Concurrent deactivation/replacement
        // therefore cannot execute the same cleanup a second time, and HTTP is
        // closed immediately even when disposal is slow or fails.
        slots.delete(key);
        slot.active = false;
        await slot.cleanup?.();
    }
    const middleware = async (request, response, next) => {
        let enabled;
        try {
            enabled = new Set(await enabledModuleKeys());
            await Promise.all([...slots.keys()].filter((key) => !enabled.has(key)).map((key) => deactivateSlot(key)));
        }
        catch {
            // Fail closed: an unavailable registry must never leave previously
            // loaded feature routes or their background work reachable.
            await Promise.allSettled([...slots.keys()].map((key) => deactivateSlot(key)));
            next();
            return;
        }
        const candidates = [...slots.entries()].filter(([key, slot]) => slot.active && enabled.has(key));
        const diagnostic = getDiagnosticRequest();
        const originalModuleId = diagnostic?.moduleId;
        let index = 0;
        const dispatch = (error) => {
            if (error) {
                next(error);
                return;
            }
            const candidate = candidates[index];
            index += 1;
            if (!candidate) {
                next();
                return;
            }
            const [key, slot] = candidate;
            if (diagnostic && isDiagnosticModuleKey(key))
                diagnostic.moduleId = key;
            slot.router(request, response, (routeError) => {
                if (diagnostic && !routeError)
                    diagnostic.moduleId = originalModuleId;
                dispatch(routeError);
            });
        };
        dispatch();
    };
    return {
        middleware,
        async publish(key, router, cleanup, isCurrent = () => true, beforeCommit) {
            // Map replacement keeps exactly one dispatch slot per module even when
            // an updated package is loaded later in the same process.
            try {
                await deactivateSlot(key);
            }
            catch (error) {
                await Promise.resolve(cleanup?.()).catch(() => undefined);
                throw error;
            }
            if (!isCurrent()) {
                await cleanup?.();
                return false;
            }
            try {
                // Capability activation and route publication happen in the same
                // synchronous commit. Add-ons never receive this callback.
                beforeCommit?.();
                slots.set(key, { active: true, router, cleanup });
            }
            catch (error) {
                await Promise.resolve(cleanup?.()).catch(() => undefined);
                throw error;
            }
            return true;
        },
        activate(key) {
            const slot = slots.get(key);
            if (slot)
                slot.active = true;
        },
        async deactivate(key) {
            await deactivateSlot(key);
        },
        hasRoute(key) {
            return slots.has(key);
        },
    };
}
