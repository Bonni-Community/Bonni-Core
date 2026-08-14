const CLEANUP_SCHEMA_VERSION = 1;

export const TECHNICAL_DATA_VERSION_KEY = "bonniCoreTechnicalDataVersion";

export const OBSOLETE_TECHNICAL_STORAGE_KEYS = Object.freeze([
  "runtimeEndpoint",
  "bonni.runtimeEndpoint",
  "bonni.apiOrigin",
  "bonni.backendOrigin",
  "bonni.emergencyApiOrigin",
]);

const BONNI_CACHE_NAME = /^(?:bonni|stueberl|hocket|kontor|feature-module|vite|workbox)(?:[-:_.]|$)/i;
const LEGACY_SERVICE_WORKER_FILE = /(?:^|\/)(?:bonni[-_.])?(?:service-worker|sw)(?:[-_.][A-Za-z0-9]+)*\.js$/i;

export function technicalDataRevision(appVersion) {
  return `${String(appVersion || "unknown").trim() || "unknown"}:technical-${CLEANUP_SCHEMA_VERSION}`;
}

function uniqueStorages(storages) {
  return [...new Set(storages.filter(Boolean))];
}

function readStorage(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function removeStorageKey(storage, key) {
  try {
    if (storage?.getItem?.(key) === null) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
    return true;
  } catch {
    return false;
  }
}

function isLegacyBonniServiceWorker(registration, origin) {
  const worker = registration?.active || registration?.waiting || registration?.installing;
  const scriptUrl = worker?.scriptURL;
  if (!scriptUrl || !origin) return false;

  try {
    const parsed = new URL(scriptUrl, origin);
    return parsed.origin === new URL(origin).origin
      && LEGACY_SERVICE_WORKER_FILE.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function removeBonniCaches(cacheStorage) {
  if (!cacheStorage?.keys || !cacheStorage?.delete) return [];

  try {
    const names = await cacheStorage.keys();
    const candidates = names.filter((name) => BONNI_CACHE_NAME.test(String(name)));
    const results = await Promise.allSettled(
      candidates.map(async (name) => ({ name, deleted: await cacheStorage.delete(name) })),
    );

    return results.flatMap((result) => (
      result.status === "fulfilled" && result.value.deleted ? [result.value.name] : []
    ));
  } catch {
    return [];
  }
}

async function unregisterLegacyBonniWorkers(serviceWorkerContainer, origin) {
  if (!serviceWorkerContainer?.getRegistrations) return 0;

  try {
    const registrations = await serviceWorkerContainer.getRegistrations();
    const candidates = registrations.filter((registration) =>
      isLegacyBonniServiceWorker(registration, origin)
    );
    const results = await Promise.allSettled(
      candidates.map((registration) => registration.unregister()),
    );
    return results.filter((result) => result.status === "fulfilled" && result.value).length;
  } catch {
    return 0;
  }
}

export async function cleanupObsoleteTechnicalData({
  appVersion,
  localStorage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  cacheStorage = globalThis.caches,
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  origin = globalThis.location?.origin || "",
} = {}) {
  const revision = technicalDataRevision(appVersion);
  if (readStorage(localStorage, TECHNICAL_DATA_VERSION_KEY) === revision) {
    return {
      changed: false,
      revision,
      removedStorageKeys: [],
      removedCaches: [],
      unregisteredServiceWorkers: 0,
    };
  }

  const removedStorageKeys = [];
  for (const storage of uniqueStorages([localStorage, sessionStorage])) {
    for (const key of OBSOLETE_TECHNICAL_STORAGE_KEYS) {
      if (removeStorageKey(storage, key)) removedStorageKeys.push(key);
    }
  }

  const [removedCaches, unregisteredServiceWorkers] = await Promise.all([
    removeBonniCaches(cacheStorage),
    unregisterLegacyBonniWorkers(serviceWorkerContainer, origin),
  ]);

  writeStorage(localStorage, TECHNICAL_DATA_VERSION_KEY, revision);

  return {
    changed: true,
    revision,
    removedStorageKeys: [...new Set(removedStorageKeys)],
    removedCaches,
    unregisteredServiceWorkers,
  };
}
