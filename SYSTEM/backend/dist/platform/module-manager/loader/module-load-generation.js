/** Coordinates in-flight registrations with lifecycle invalidation. */
export function createModuleLoadGenerations() {
    const generations = new Map();
    const pending = new Map();
    function current(key) {
        return generations.get(key) || 0;
    }
    function begin(key) {
        const generation = current(key);
        let resolveSettled;
        const settled = new Promise((resolve) => { resolveSettled = resolve; });
        const entries = pending.get(key) || new Set();
        entries.add(settled);
        pending.set(key, entries);
        let completed = false;
        return {
            generation,
            isCurrent: () => current(key) === generation,
            settle() {
                if (completed)
                    return;
                completed = true;
                entries.delete(settled);
                if (!entries.size)
                    pending.delete(key);
                resolveSettled();
            },
        };
    }
    function invalidate(key) {
        generations.set(key, current(key) + 1);
        const olderLoads = [...(pending.get(key) || [])];
        return Promise.allSettled(olderLoads).then(() => undefined);
    }
    return { begin, current, invalidate };
}
