type ModuleState = {
  key: string; kind?: string; installed?: boolean; enabled?: boolean;
  manifestJson?: unknown; manifest?: unknown; dependsOn?: unknown; metadata?: unknown;
};

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** A running application participates only through its declared Hub contract. */
export function usesHubProducts(module: ModuleState): boolean {
  const manifest = record(module.manifestJson) || record(module.manifest) || module;
  const declaration = record(record(manifest.metadata)?.hubProducts);
  return module.kind === "app"
    && Array.isArray(manifest.dependsOn) && manifest.dependsOn.includes("core.hub-products")
    && declaration?.contractVersion === "hub.products/v2"
    && Array.isArray(declaration.operations) && declaration.operations.length > 0;
}

/** Count installed Hub consumers, including disabled apps. Meeting, finance and other unrelated apps do not count. */
export function hubInstallationPolicy(modules: readonly ModuleState[], candidate?: ModuleState, manifests: readonly ModuleState[] = []) {
  const contracts = new Map(manifests.map(manifest => [manifest.key, manifest]));
  const states = new Map(modules.map(module => {
    const manifest = contracts.get(module.key);
    return [module.key, manifest ? { ...module, kind: manifest.kind || module.kind, manifestJson: manifest } : module];
  }));
  if (candidate) states.set(candidate.key, candidate);
  const appKeys = new Set([...states.values()]
    .filter(module => module.installed && usesHubProducts(module))
    .map(module => module.key));
  const hub = modules.find(module => module.key === "addon.hub");
  return Object.freeze({
    required: appKeys.size >= 2,
    appKeys: [...appKeys].sort(),
    installed: Boolean(hub?.installed),
    enabled: Boolean(hub?.installed && hub.enabled),
  });
}

export function hubRemovalBlock(key: string, modules: readonly ModuleState[], manifests: readonly ModuleState[] = []) {
  const policy = hubInstallationPolicy(modules, undefined, manifests);
  return key === "addon.hub" && policy.required
    ? { ok: false as const, error: "HUB_REQUIRED_FOR_MULTIPLE_APPS", key,
      message: "Ab zwei installierten Lager-Apps mit Hub-Schnittstelle ist Hub erforderlich und kann nicht deaktiviert oder entfernt werden.", appKeys: policy.appKeys }
    : null;
}

/** Serialize the registry-changing lifecycle requests within the module manager. */
export function createModuleLifecycleQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation);
    tail = current.catch(() => undefined);
    return current;
  };
}
