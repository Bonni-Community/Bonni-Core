export const INSTALLATION_MONITOR_ACCESS_STORAGE_KEY =
  "bonni.local-update.monitor-access";

export const CLIENT_AUTH_STORAGE_KEYS = Object.freeze([
  "token",
  "user",
  "shell",
  "activeArea",
  "lastActivityAt",
  INSTALLATION_MONITOR_ACCESS_STORAGE_KEY,
  "bonni.core-update.accepted-transition",
  "bonni.core-update.last-action-error",
]);

export const CLIENT_AUTH_SESSION_STORAGE_PREFIXES = Object.freeze([
  "bonni.local-update.timeline:",
  "bonni.local-update.dismissed-error:",
  "bonni.local-update.action-error:",
]);

function removeExactKeys(storage) {
  if (!storage || typeof storage.removeItem !== "function") return;
  for (const key of CLIENT_AUTH_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Jeder weitere sicherheitsrelevante Schlüssel wird trotzdem versucht.
    }
  }
}

function removePrefixedKeys(storage) {
  if (
    !storage
    || typeof storage.removeItem !== "function"
    || typeof storage.key !== "function"
  ) return;

  const matches = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        typeof key === "string"
        && CLIENT_AUTH_SESSION_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
      ) matches.push(key);
    }
  } catch {
    return;
  }

  for (const key of matches) {
    try {
      storage.removeItem(key);
    } catch {
      // Andere gefundene Update-Sitzungsdaten werden weiterhin entfernt.
    }
  }
}

export function clearClientAuthStorage(options = {}) {
  let local = null;
  let session = null;
  try {
    local = Object.hasOwn(options, "localStorage")
      ? options.localStorage
      : globalThis.localStorage;
  } catch {
    // Der zweite Storage-Bereich wird unabhängig davon weiterhin bereinigt.
  }
  try {
    session = Object.hasOwn(options, "sessionStorage")
      ? options.sessionStorage
      : globalThis.sessionStorage;
  } catch {
    // Ein gesperrter Browser-Storage darf den lokalen Logout nicht verhindern.
  }
  removeExactKeys(local);
  removeExactKeys(session);
  removePrefixedKeys(session);
}
