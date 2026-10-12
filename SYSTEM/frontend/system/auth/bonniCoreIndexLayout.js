export const BONNI_CORE_INDEX_SLOT_COUNT = 24;
export const BONNI_CORE_INDEX_VIEW_DESKTOP = "desktop";
export const BONNI_CORE_INDEX_VIEW_MOBILE = "mobile";
const STORAGE_PREFIX = "bonni.core.index.layout.v1";
const VIEW_STORAGE_PREFIX = "bonni.core.index.view.v1";

function stableIdentity(user, shell) {
  return user?.accountId
    || user?.id
    || shell?.identity?.accountId
    || shell?.identity?.id
    || user?.loginName
    || shell?.identity?.loginName
    || "anonymous";
}

export function indexLayoutStorageKey(user, shell) {
  return `${STORAGE_PREFIX}:${String(stableIdentity(user, shell))}`;
}

export function indexViewStorageKey(user, shell) {
  return `${VIEW_STORAGE_PREFIX}:${String(stableIdentity(user, shell))}`;
}

export function normalizeIndexViewMode(value) {
  return value === BONNI_CORE_INDEX_VIEW_MOBILE
    ? BONNI_CORE_INDEX_VIEW_MOBILE
    : BONNI_CORE_INDEX_VIEW_DESKTOP;
}

export function nextIndexViewMode(value) {
  return normalizeIndexViewMode(value) === BONNI_CORE_INDEX_VIEW_MOBILE
    ? BONNI_CORE_INDEX_VIEW_DESKTOP
    : BONNI_CORE_INDEX_VIEW_MOBILE;
}

export function normalizeIndexLayout(layout, availableKeys) {
  const allowed = new Set(Array.isArray(availableKeys) ? availableKeys : []);
  const used = new Set();
  const normalized = Array.from({ length: BONNI_CORE_INDEX_SLOT_COUNT }, (_, index) => {
    const key = Array.isArray(layout) ? layout[index] : null;
    if (typeof key !== "string" || !allowed.has(key) || used.has(key)) return null;
    used.add(key);
    return key;
  });

  for (const key of allowed) {
    if (used.has(key)) continue;
    const emptyIndex = normalized.indexOf(null);
    if (emptyIndex === -1) break;
    normalized[emptyIndex] = key;
    used.add(key);
  }

  return normalized;
}

export function moveIndexTile(layout, sourceIndex, targetIndex) {
  const next = normalizeIndexLayout(layout, (Array.isArray(layout) ? layout : []).filter(Boolean));
  if (
    !Number.isInteger(sourceIndex)
    || !Number.isInteger(targetIndex)
    || sourceIndex < 0
    || targetIndex < 0
    || sourceIndex >= BONNI_CORE_INDEX_SLOT_COUNT
    || targetIndex >= BONNI_CORE_INDEX_SLOT_COUNT
    || sourceIndex === targetIndex
    || !next[sourceIndex]
  ) return next;

  [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
  return next;
}

export function readIndexLayout(storage, key, availableKeys) {
  try {
    return normalizeIndexLayout(JSON.parse(storage?.getItem(key) || "null"), availableKeys);
  } catch {
    return normalizeIndexLayout(null, availableKeys);
  }
}

export function writeIndexLayout(storage, key, layout) {
  try {
    storage?.setItem(key, JSON.stringify(layout));
  } catch {
    // A blocked or full browser store must not prevent the Index from working.
  }
}

export function readIndexViewMode(storage, key) {
  try {
    return normalizeIndexViewMode(storage?.getItem(key));
  } catch {
    return BONNI_CORE_INDEX_VIEW_DESKTOP;
  }
}

export function writeIndexViewMode(storage, key, viewMode) {
  const normalized = normalizeIndexViewMode(viewMode);
  try {
    storage?.setItem(key, normalized);
  } catch {
    // The view switch continues to work for this session without browser storage.
  }
  return normalized;
}
