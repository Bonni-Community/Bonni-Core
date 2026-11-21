export function createCoreEventBus() {
    const handlers = new Map();
    return {
        on(eventName, handler) {
            const eventHandlers = handlers.get(eventName) ?? new Set();
            eventHandlers.add(handler);
            handlers.set(eventName, eventHandlers);
            return () => {
                eventHandlers.delete(handler);
                if (eventHandlers.size === 0) {
                    handlers.delete(eventName);
                }
            };
        },
        async emit(eventName, payload) {
            const eventHandlers = handlers.get(eventName);
            if (!eventHandlers) {
                return;
            }
            await Promise.all([...eventHandlers].map((handler) => handler(payload)));
        },
    };
}
export const coreEventBus = createCoreEventBus();
