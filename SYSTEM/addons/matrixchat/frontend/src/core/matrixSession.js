const SESSION_KEY = "bonni.matrixchat.session.v1";

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

export function normalizeHomeserver(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Bitte einen Matrix-Homeserver angeben.");

  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;

  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("Der Matrix-Homeserver ist keine gültige URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Der Matrix-Homeserver muss HTTP oder HTTPS verwenden.");
  }

  if (url.protocol === "http:" && !isLocalHostname(url.hostname)) {
    throw new Error("Außerhalb von localhost ist für Matrix HTTPS erforderlich.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Die Homeserver-URL darf keine Zugangsdaten, Abfrage oder Raute enthalten.");
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${normalizedPath === "/" ? "" : normalizedPath}`;
}

export function normalizeMatrixSession(value) {
  if (!value || typeof value !== "object") return null;

  try {
    const homeserver = normalizeHomeserver(value.homeserver || value.baseUrl);
    const accessToken = String(value.accessToken || value.access_token || "").trim();
    const userId = String(value.userId || value.user_id || "").trim();
    const deviceId = String(value.deviceId || value.device_id || "").trim();
    const refreshToken = String(value.refreshToken || value.refresh_token || "").trim();

    if (!accessToken || !userId) return null;

    return {
      homeserver,
      accessToken,
      userId,
      deviceId,
      refreshToken,
    };
  } catch {
    return null;
  }
}

function readStorage(storage) {
  try {
    return normalizeMatrixSession(JSON.parse(storage.getItem(SESSION_KEY) || "null"));
  } catch {
    return null;
  }
}

export function loadMatrixSession() {
  if (typeof window === "undefined") return null;
  return readStorage(window.sessionStorage) || readStorage(window.localStorage);
}

export function saveMatrixSession(session, remember = false) {
  const normalized = normalizeMatrixSession(session);
  if (!normalized) throw new Error("Die Matrix-Sitzung ist unvollständig.");

  const selectedStorage = remember ? window.localStorage : window.sessionStorage;
  const otherStorage = remember ? window.sessionStorage : window.localStorage;
  otherStorage.removeItem(SESSION_KEY);
  selectedStorage.setItem(SESSION_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearMatrixSession() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(SESSION_KEY);
}

export function formatMatrixError(error, fallback = "Matrix konnte die Anfrage nicht ausführen.") {
  const matrixMessage = error?.data?.error || error?.body?.error;
  const message = matrixMessage || error?.message || fallback;
  const code = error?.errcode || error?.data?.errcode || error?.body?.errcode;

  if (code === "M_FORBIDDEN") return "Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.";
  if (code === "M_LIMIT_EXCEEDED") return "Zu viele Anfragen. Bitte kurz warten und erneut versuchen.";
  if (code === "M_UNKNOWN_TOKEN") return "Die Matrix-Sitzung ist abgelaufen. Bitte erneut anmelden.";
  if (/failed to fetch|networkerror|load failed/i.test(String(message))) {
    return "Der Homeserver ist nicht erreichbar oder erlaubt diese Bonni-Core-Origin nicht (CORS).";
  }

  return String(message || fallback);
}

export function cryptoDatabasePrefix(session) {
  const identity = `${session?.userId || "user"}-${session?.deviceId || "device"}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `bonni-matrixchat-${identity || "session"}`;
}

export async function cryptoStorageKey(session) {
  const secret = String(session?.accessToken || "");
  if (!secret || !globalThis.crypto?.subtle) return undefined;

  const material = new TextEncoder().encode(
    `bonni-matrixchat|${session?.deviceId || "device"}|${secret}`,
  );
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
}
