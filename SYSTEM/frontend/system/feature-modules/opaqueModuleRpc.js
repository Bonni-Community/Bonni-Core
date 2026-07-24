import { apiRequest } from "../api/apiClient.js";

export const OPAQUE_RPC_TRANSPORT = "opaque-rpc-v1";
export const OPAQUE_RPC_REQUEST = "bonni:module-rpc-request";
export const OPAQUE_RPC_RESPONSE = "bonni:module-rpc-response";
export const OPAQUE_RPC_CANCEL = "bonni:module-rpc-cancel";

const HOCKET_API_BASE = "/api/apps/hocketapp";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const MAX_BODY_BYTES = 256 * 1024;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,199}$/;
const CREDENTIAL_KEYS = new Set([
  "authorization",
  "accesstoken",
  "refreshtoken",
  "token",
  "jwt",
]);
const RECONCILE_PATH_PATTERN = /^\/api\/apps\/hocketapp\/warehouse\/allocations\/[^/]+\/[^/]+\/reconcile$/;
const CANCEL_RESERVATION_PATH_PATTERN = /^\/api\/apps\/hocketapp\/events\/[^/]+\/warehouse\/reservations\/[^/]+\/cancel$/;
const RECONCILE_RESOLUTIONS = new Set([
  "SOURCE_STOCK_ADJUSTED",
  "RETURNED_TO_STOCK",
  "REPLACED",
]);

const ALLOWED_ROUTES = [
  ["GET", /^\/api\/apps\/hocketapp\/capabilities$/],
  ["GET", /^\/api\/apps\/hocketapp\/events$/],
  ["GET", /^\/api\/apps\/hocketapp\/events\/[^/]+$/],
  ["GET", /^\/api\/apps\/hocketapp\/events\/[^/]+\/warehouse$/],
  ["GET", /^\/api\/apps\/hocketapp\/events\/[^/]+\/audit$/],
  ["GET", /^\/api\/apps\/hocketapp\/events\/[^/]+\/organizations\/[^/]+\/warehouse-source$/],
  ["GET", /^\/api\/apps\/hocketapp\/warehouse\/allocations\/[^/]+\/[^/]+$/],
  ["POST", /^\/api\/apps\/hocketapp\/events$/],
  ["POST", /^\/api\/apps\/hocketapp\/events\/[^/]+\/bridge\/invitations$/],
  ["POST", /^\/api\/apps\/hocketapp\/bridge\/invitations\/accept$/],
  ["POST", /^\/api\/apps\/hocketapp\/events\/[^/]+\/warehouse\/reservations$/],
  ["POST", CANCEL_RESERVATION_PATH_PATTERN],
  ["POST", /^\/api\/apps\/hocketapp\/events\/[^/]+\/warehouse\/issues$/],
  ["POST", /^\/api\/apps\/hocketapp\/events\/[^/]+\/warehouse\/issues\/[^/]+\/return$/],
  ["POST", /^\/api\/apps\/hocketapp\/events\/[^/]+\/close$/],
  ["POST", RECONCILE_PATH_PATTERN],
  ["PUT", /^\/api\/apps\/hocketapp\/events\/[^/]+\/organizations\/[^/]+\/warehouse-share$/],
  ["PATCH", /^\/api\/apps\/hocketapp\/events\/[^/]+$/],
];

export class OpaqueRpcValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpaqueRpcValidationError";
    this.code = code;
    this.status = 400;
  }
}

function invalid(code, message) {
  throw new OpaqueRpcValidationError(code, message);
}

function sanitizePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 2048) {
    invalid("RPC_PATH_INVALID", "Ungültiger RPC-Pfad.");
  }
  if (value.includes("?") || value.includes("#") || /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(value)) {
    invalid("RPC_PATH_INVALID", "RPC-Pfad enthält nicht erlaubte Bestandteile.");
  }

  const parsed = new URL(value, "https://bonni-rpc.invalid");
  if (parsed.origin !== "https://bonni-rpc.invalid" || parsed.pathname !== value) {
    invalid("RPC_PATH_INVALID", "RPC-Pfad konnte nicht sicher normalisiert werden.");
  }
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    let decodedSegment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      invalid("RPC_PATH_INVALID", "RPC-Pfad enthält eine ungültige Kodierung.");
    }
    if (!SAFE_PATH_SEGMENT.test(decodedSegment)) {
      invalid("RPC_PATH_INVALID", "RPC-Pfad enthält ein nicht erlaubtes Segment.");
    }
  }
  if (parsed.pathname !== HOCKET_API_BASE && !parsed.pathname.startsWith(`${HOCKET_API_BASE}/`)) {
    invalid("RPC_PATH_DENIED", "RPC-Zugriff außerhalb der HocketApp ist nicht erlaubt.");
  }
  return parsed.pathname;
}

function sanitizeHeaders(value, method) {
  if (value == null) {
    if (method !== "GET") invalid("RPC_IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key fehlt.");
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) invalid("RPC_HEADERS_INVALID", "Ungültige RPC-Header.");

  const entries = Object.entries(value);
  if (entries.some(([name]) => name.toLowerCase() !== "idempotency-key")) {
    invalid("RPC_HEADER_DENIED", "Nur Idempotency-Key darf vom Modul gesetzt werden.");
  }
  if (entries.length > 1) {
    invalid("RPC_HEADER_DENIED", "Idempotency-Key darf nur einmal gesetzt werden.");
  }
  const rawKey = entries.find(([name]) => name.toLowerCase() === "idempotency-key")?.[1];
  if (method === "GET") {
    if (rawKey !== undefined) invalid("RPC_HEADER_DENIED", "GET-Anfragen dürfen keinen Idempotency-Key setzen.");
    return {};
  }
  if (rawKey === undefined) {
    invalid("RPC_IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key fehlt.");
  }
  if (typeof rawKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
    invalid("RPC_IDEMPOTENCY_KEY_INVALID", "Ungültiger Idempotency-Key.");
  }
  return { "Idempotency-Key": rawKey };
}

function sanitizeBody(value, method) {
  if (method === "GET") {
    if (value !== undefined && value !== null) invalid("RPC_BODY_DENIED", "GET-Anfragen dürfen keinen Body enthalten.");
    return undefined;
  }
  if (value === undefined) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid("RPC_BODY_INVALID", "RPC-Body ist nicht als JSON serialisierbar.");
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) {
    invalid("RPC_BODY_INVALID", "RPC-Body ist ungültig oder zu groß.");
  }
  return JSON.parse(serialized);
}

function constrainRouteBody(path, method, body) {
  if (method !== "POST") return body;
  if (CANCEL_RESERVATION_PATH_PATTERN.test(path)) {
    if (body == null) return {};
    if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      invalid("RPC_BODY_DENIED", "Ein Reservierungsstorno akzeptiert keine Browser-Fachdaten.");
    }
    return {};
  }
  if (!RECONCILE_PATH_PATTERN.test(path)) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalid("RPC_BODY_INVALID", "Der Reconcile-Body muss ein JSON-Objekt sein.");
  }

  const allowedKeys = new Set(["claimIds", "resolution", "expectedCurrentRevision", "note"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    invalid("RPC_BODY_DENIED", "Der Reconcile-Body enthält nicht erlaubte Bestandsfelder.");
  }
  if (
    !Array.isArray(body.claimIds)
    || body.claimIds.length < 1
    || body.claimIds.length > 100
    || body.claimIds.some((value) => typeof value !== "string" || !SAFE_PATH_SEGMENT.test(value))
    || new Set(body.claimIds).size !== body.claimIds.length
  ) {
    invalid("RPC_BODY_INVALID", "Der Reconcile-Body enthält ungültige Claim-IDs.");
  }
  if (!RECONCILE_RESOLUTIONS.has(body.resolution)) {
    invalid("RPC_BODY_INVALID", "Der Reconcile-Body enthält eine ungültige Auflösung.");
  }
  if (typeof body.expectedCurrentRevision !== "string" || !SAFE_PATH_SEGMENT.test(body.expectedCurrentRevision)) {
    invalid("RPC_BODY_INVALID", "Der erwartete Quellstand ist ungültig.");
  }
  if (body.note !== undefined && (typeof body.note !== "string" || !body.note.trim() || body.note.trim().length > 1000)) {
    invalid("RPC_BODY_INVALID", "Die Reconcile-Notiz ist ungültig.");
  }

  return {
    claimIds: [...body.claimIds],
    resolution: body.resolution,
    expectedCurrentRevision: body.expectedCurrentRevision,
    ...(body.note !== undefined ? { note: body.note.trim() } : {}),
  };
}

export function validateOpaqueRpcRequest(data, {
  moduleId,
  rpcSessionId,
} = {}) {
  if (!data || data.type !== OPAQUE_RPC_REQUEST) invalid("RPC_MESSAGE_INVALID", "Ungültige RPC-Nachricht.");
  if (data.moduleId !== moduleId || data.rpcSessionId !== rpcSessionId) {
    invalid("RPC_CHANNEL_INVALID", "RPC-Kanal stimmt nicht überein.");
  }
  if (typeof data.requestId !== "string" || !REQUEST_ID_PATTERN.test(data.requestId)) {
    invalid("RPC_REQUEST_ID_INVALID", "Ungültige RPC-Anfrage-ID.");
  }
  const method = String(data.method || "GET").trim().toUpperCase();
  const path = sanitizePath(data.path);
  if (!ALLOWED_ROUTES.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(path))) {
    invalid("RPC_ROUTE_DENIED", "Diese HocketApp-API-Route ist nicht freigegeben.");
  }
  const body = constrainRouteBody(path, method, sanitizeBody(data.body, method));
  return {
    requestId: data.requestId,
    method,
    path,
    headers: sanitizeHeaders(data.headers, method),
    body,
  };
}

export function isTrustedOpaqueModuleMessage(event, {
  frameWindow,
  moduleId,
  rpcSessionId,
} = {}) {
  return Boolean(
    event
    && event.source === frameWindow
    && event.origin === "null"
    && event.data?.moduleId === moduleId
    && event.data?.rpcSessionId === rpcSessionId,
  );
}

export function sanitizeOpaqueModuleContext(value) {
  const seen = new WeakSet();

  function sanitize(current) {
    if (current == null || typeof current !== "object") return current;
    if (seen.has(current)) return null;
    seen.add(current);
    if (Array.isArray(current)) return current.map(sanitize);

    const result = {};
    for (const [key, nestedValue] of Object.entries(current)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      if (CREDENTIAL_KEYS.has(normalizedKey)) continue;
      result[key] = sanitize(nestedValue);
    }
    return result;
  }

  return sanitize(value);
}

export function createOpaqueRpcSessionId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `rpc-${randomId}`;
  return `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function withOpaqueRpcSession(entry, rpcSessionId, baseUrl) {
  const url = new URL(entry, baseUrl);
  url.hash = `bonni-rpc-session=${encodeURIComponent(rpcSessionId)}`;
  return url;
}

export function normalizeSameOriginNavigationUrl(value, origin) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, origin);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.origin !== origin
      || url.username
      || url.password
    ) return "";
    return url.href;
  } catch {
    return "";
  }
}

export async function executeOpaqueHocketRpc(request, { token } = {}) {
  try {
    const payload = await apiRequest(request.path, {
      token,
      method: request.method,
      body: request.body,
      headers: request.headers,
    });
    return { ok: true, status: 200, payload };
  } catch (error) {
    return {
      ok: false,
      status: Number(error?.status || 0),
      payload: error?.data && typeof error.data === "object"
        ? error.data
        : {
            code: error?.code || "RPC_REQUEST_FAILED",
            message: error?.message || "HocketApp-Anfrage fehlgeschlagen.",
          },
    };
  }
}
