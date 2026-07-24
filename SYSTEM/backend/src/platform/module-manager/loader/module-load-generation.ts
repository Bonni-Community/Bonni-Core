export type ModuleLoadLease = {
  generation: number;
  isCurrent: () => boolean;
  settle: () => void;
};

/** Coordinates in-flight registrations with lifecycle invalidation. */
export function createModuleLoadGenerations() {
  const generations = new Map<string, number>();
  const pending = new Map<string, Set<Promise<void>>>();

  function current(key: string) {
    return generations.get(key) || 0;
  }

  function begin(key: string): ModuleLoadLease {
    const generation = current(key);
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const entries = pending.get(key) || new Set<Promise<void>>();
    entries.add(settled);
    pending.set(key, entries);
    let completed = false;

    return {
      generation,
      isCurrent: () => current(key) === generation,
      settle() {
        if (completed) return;
        completed = true;
        entries.delete(settled);
        if (!entries.size) pending.delete(key);
        resolveSettled();
      },
    };
  }

  function invalidate(key: string): Promise<void> {
    generations.set(key, current(key) + 1);
    const olderLoads = [...(pending.get(key) || [])];
    return Promise.allSettled(olderLoads).then(() => undefined);
  }

  return { begin, current, invalidate };
}
