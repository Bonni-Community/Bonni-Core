export type CoreEventHandler<TPayload = unknown> = (payload: TPayload) => void | Promise<void>;

export type CoreEventBus = {
  on<TPayload = unknown>(eventName: string, handler: CoreEventHandler<TPayload>): () => void;
  emit<TPayload = unknown>(eventName: string, payload: TPayload): Promise<void>;
};

export function createCoreEventBus(): CoreEventBus {
  const handlers = new Map<string, Set<CoreEventHandler>>();

  return {
    on(eventName, handler) {
      const eventHandlers = handlers.get(eventName) ?? new Set<CoreEventHandler>();
      eventHandlers.add(handler as CoreEventHandler);
      handlers.set(eventName, eventHandlers);

      return () => {
        eventHandlers.delete(handler as CoreEventHandler);
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
