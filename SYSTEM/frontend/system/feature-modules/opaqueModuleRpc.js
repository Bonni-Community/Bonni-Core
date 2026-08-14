import { apiRequest } from "../api/apiClient.js";

export const OPAQUE_RPC_TRANSPORT = "opaque-rpc-v1";
export const OPAQUE_RPC_REQUEST = "bonni:module-rpc-request";
export const OPAQUE_RPC_RESPONSE = "bonni:module-rpc-response";
export const OPAQUE_RPC_CANCEL = "bonni:module-rpc-cancel";

const CONTRACT_SCHEMA = "bonni.module-rpc/v1";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,199}$/;
const SAFE_QUERY_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/;
const SAFE_FORM_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;
const SAFE_HEADER_NAME = /^[a-z][a-z0-9-]{0,99}$/;
const SAFE_CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_CONTRACT_BODY_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_ENTRIES = 100;
const MAX_FORM_ENTRIES = 200;
const CREDENTIAL_KEYS = new Set([
  "authorization",
  "apikey",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "token",
  "jwt",
]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "content-length",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
]);

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

function isCredentialKey(value) {
  return (
    CREDENTIAL_KEYS.has(value)
    || value.endsWith("token")
    || value.endsWith("password")
    || value.endsWith("secret")
    || value.endsWith("credential")
    || value.endsWith("credentials")
    || value.endsWith("cookie")
    || value.endsWith("apikey")
  );
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeMethod(value) {
  const method = String(value || "GET").trim().toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    invalid("RPC_METHOD_INVALID", "Die RPC-Methode ist nicht erlaubt.");
  }
  return method;
}

function sanitizeBasePath(value) {
  const basePath = String(value || "").trim().replace(/\/+$/, "");
  if (
    !basePath.startsWith("/api/")
    || basePath.startsWith("//")
    || basePath.length > 512
    || basePath.includes("?")
    || basePath.includes("#")
  ) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält keinen gültigen API-Basispfad.");
  }
  return basePath;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePathTemplate(template, basePath) {
  const rawTemplate = String(template || "").trim();
  if (!rawTemplate || rawTemplate.includes("?") || rawTemplate.includes("#")) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine ungültige Route.");
  }

  const fullTemplate = rawTemplate.startsWith("/api/")
    ? rawTemplate
    : `${basePath}${rawTemplate.startsWith("/") ? rawTemplate : `/${rawTemplate}`}`;
  if (!fullTemplate.startsWith("/api/") || fullTemplate.length > 2048) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine Route außerhalb der API.");
  }

  const parts = fullTemplate.split("/").filter(Boolean);
  let wildcardSeen = false;
  const compiled = parts.map((part, index) => {
    const parameter = part.match(/^\{([A-Za-z][A-Za-z0-9_]*)(\*)?\}$/);
    if (!parameter) return escapeRegex(part);
    if (parameter[2]) {
      if (index !== parts.length - 1 || wildcardSeen) {
        invalid("RPC_CONTRACT_INVALID", "Ein RPC-Platzhalter mit * muss am Ende der Route stehen.");
      }
      wildcardSeen = true;
      return "(?:[^/?#]+(?:/[^/?#]+)*)?";
    }
    return "[^/?#]+";
  });

  return {
    template: fullTemplate,
    pattern: new RegExp(`^/${compiled.join("/")}${fullTemplate.endsWith("/") ? "/" : ""}$`),
  };
}

function normalizeBodyPolicy(value, defaultMaxBytes) {
  if (value == null) {
    return {
      type: "json",
      maxBytes: defaultMaxBytes,
      schema: null,
      contentType: null,
      required: true,
    };
  }
  if (typeof value === "string") {
    return normalizeBodyPolicy({ type: value }, defaultMaxBytes);
  }
  const policy = asObject(value);
  if (!policy) invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine ungültige Body-Regel.");

  const type = String(policy.type || "json").trim().toLowerCase();
  if (!["none", "json", "form-data", "blob"].includes(type)) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält einen unbekannten Body-Typ.");
  }
  const requestedMaxBytes = policy.maxBytes === undefined
    ? defaultMaxBytes
    : Number(policy.maxBytes);
  if (
    !Number.isInteger(requestedMaxBytes)
    || requestedMaxBytes < 1
    || requestedMaxBytes > defaultMaxBytes
    || requestedMaxBytes > MAX_CONTRACT_BODY_BYTES
  ) {
    invalid(
      "RPC_CONTRACT_INVALID",
      "Eine RPC-Body-Regel überschreitet die globale Vertragsgrenze.",
    );
  }
  const maxBytes = requestedMaxBytes;
  const contentType = type === "blob"
    ? String(policy.contentType || "application/octet-stream").trim().toLowerCase()
    : null;
  if (contentType && !SAFE_CONTENT_TYPE.test(contentType)) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält einen ungültigen Binärdatentyp.");
  }
  return {
    type,
    maxBytes,
    schema: asObject(policy.schema),
    contentType,
    required: type !== "none" && policy.required !== false,
  };
}

function normalizeHeaderPolicy(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine ungültige Header-Regel.");
  }
  const names = value.map((name) => String(name || "").trim().toLowerCase());
  if (names.some((name) => (
    !SAFE_HEADER_NAME.test(name)
    || FORBIDDEN_REQUEST_HEADERS.has(name)
    || name === "idempotency-key"
    || name.startsWith("sec-")
    || name.startsWith("proxy-")
    || name.startsWith("x-forwarded-")
  ))) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält einen nicht erlaubten Header.");
  }
  return [...new Set(names)];
}

function normalizeQueryPolicy(value) {
  if (value === true || value === "any") return "any";
  if (value == null || value === false || value === "none") return [];
  if (!Array.isArray(value)) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine ungültige Query-Regel.");
  }
  const names = value.map((name) => String(name || "").trim());
  if (names.some((name) => !SAFE_QUERY_NAME.test(name))) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält einen ungültigen Query-Namen.");
  }
  return [...new Set(names)];
}

function normalizeResponseType(value) {
  const normalized = String(value || "json").trim().toLowerCase();
  if (!["json", "text", "blob"].includes(normalized)) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält einen unbekannten Antworttyp.");
  }
  return normalized;
}

export function normalizeOpaqueRpcContract(value, { moduleId } = {}) {
  const contract = asObject(value);
  if (!contract || contract.schemaVersion !== CONTRACT_SCHEMA) {
    invalid("RPC_CONTRACT_INVALID", "Für dieses Modul fehlt ein gültiger RPC-Vertrag.");
  }
  if (String(contract.moduleId || "").trim() !== String(moduleId || "").trim()) {
    invalid("RPC_CONTRACT_MODULE_MISMATCH", "Der RPC-Vertrag gehört zu einem anderen Modul.");
  }

  const basePath = sanitizeBasePath(contract.basePath);
  const maxBodyBytes = Math.min(
    MAX_CONTRACT_BODY_BYTES,
    Math.max(1, Number(contract.maxBodyBytes || DEFAULT_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES),
  );
  if (!Array.isArray(contract.routes) || !contract.routes.length || contract.routes.length > 1024) {
    invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält keine gültige Routenliste.");
  }

  const routes = contract.routes.map((rawRoute) => {
    const route = asObject(rawRoute);
    if (!route) invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine ungültige Route.");
    const method = normalizeMethod(route.method);
    const compiledPath = compilePathTemplate(route.path, basePath);
    const idempotency = String(
      route.idempotency
      || (["GET", "HEAD"].includes(method) ? "forbidden" : "required"),
    ).trim().toLowerCase();
    if (!["required", "optional", "forbidden"].includes(idempotency)) {
      invalid("RPC_CONTRACT_INVALID", "Der RPC-Vertrag enthält eine ungültige Idempotenzregel.");
    }
    const body = normalizeBodyPolicy(
      route.body ?? (["GET", "HEAD"].includes(method) ? "none" : null),
      maxBodyBytes,
    );
    return {
      ...compiledPath,
      method,
      idempotency,
      body,
      headers: normalizeHeaderPolicy(route.headers),
      query: normalizeQueryPolicy(route.query),
      responseType: normalizeResponseType(route.responseType),
    };
  });

  return {
    schemaVersion: CONTRACT_SCHEMA,
    moduleId,
    basePath,
    maxBodyBytes,
    routes,
  };
}

function sanitizeRequestUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 4096) {
    invalid("RPC_PATH_INVALID", "Ungültiger RPC-Pfad.");
  }
  if (value.includes("#") || /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(value)) {
    invalid("RPC_PATH_INVALID", "RPC-Pfad enthält nicht erlaubte Bestandteile.");
  }

  let parsed;
  try {
    parsed = new URL(value, "https://bonni-rpc.invalid");
  } catch {
    invalid("RPC_PATH_INVALID", "RPC-Pfad konnte nicht sicher normalisiert werden.");
  }
  if (parsed.origin !== "https://bonni-rpc.invalid") {
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
  return parsed;
}

function selectRoute(parsed, method, contract) {
  const route = contract.routes.find((candidate) => (
    candidate.method === method && candidate.pattern.test(parsed.pathname)
  ));
  if (!route) invalid("RPC_ROUTE_DENIED", "Diese Modul-API-Route ist nicht freigegeben.");

  const entries = [...parsed.searchParams.entries()];
  if (entries.length > MAX_QUERY_ENTRIES) {
    invalid("RPC_QUERY_INVALID", "Die RPC-Anfrage enthält zu viele Query-Werte.");
  }
  if (entries.some(([name, value]) => (
    !SAFE_QUERY_NAME.test(name)
    || value.length > 1000
    || (route.query !== "any" && !route.query.includes(name))
  ))) {
    invalid("RPC_QUERY_DENIED", "Die RPC-Anfrage enthält nicht freigegebene Query-Werte.");
  }
  return route;
}

function sanitizeHeaders(value, route) {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) {
    invalid("RPC_HEADERS_INVALID", "Ungültige RPC-Header.");
  }
  const entries = Object.entries(value || {});
  if (entries.length > route.headers.length + 1) {
    invalid("RPC_HEADER_DENIED", "Die RPC-Anfrage enthält zu viele Header.");
  }
  const normalizedEntries = entries.map(([name, rawValue]) => {
    const normalizedName = String(name || "").trim().toLowerCase();
    if (
      !SAFE_HEADER_NAME.test(normalizedName)
      || FORBIDDEN_REQUEST_HEADERS.has(normalizedName)
      || normalizedName.startsWith("sec-")
      || normalizedName.startsWith("proxy-")
      || normalizedName.startsWith("x-forwarded-")
      || (normalizedName !== "idempotency-key" && !route.headers.includes(normalizedName))
    ) {
      invalid("RPC_HEADER_DENIED", "Die RPC-Anfrage enthält einen nicht freigegebenen Header.");
    }
    if (
      typeof rawValue !== "string"
      || rawValue.length > 4096
      || /[\0\r\n]/.test(rawValue)
    ) {
      invalid("RPC_HEADER_INVALID", "Die RPC-Anfrage enthält einen ungültigen Header-Wert.");
    }
    return [normalizedName, rawValue];
  });
  if (new Set(normalizedEntries.map(([name]) => name)).size !== normalizedEntries.length) {
    invalid("RPC_HEADER_DENIED", "Die RPC-Anfrage enthält einen Header mehrfach.");
  }
  const rawKey = normalizedEntries.find(([name]) => name === "idempotency-key")?.[1];
  if (route.idempotency === "forbidden" && rawKey !== undefined) {
    invalid("RPC_HEADER_DENIED", "Diese Anfrage darf keinen Idempotency-Key setzen.");
  }
  if (route.idempotency === "required" && rawKey === undefined) {
    invalid("RPC_IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key fehlt.");
  }
  if (rawKey !== undefined && (typeof rawKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(rawKey))) {
    invalid("RPC_IDEMPOTENCY_KEY_INVALID", "Ungültiger Idempotency-Key.");
  }
  const headers = Object.fromEntries(
    normalizedEntries
      .filter(([name]) => name !== "idempotency-key")
      .map(([name, headerValue]) => [name, headerValue]),
  );
  if (rawKey !== undefined) headers["Idempotency-Key"] = rawKey;
  if (route.body.type === "blob") headers["Content-Type"] = route.body.contentType;
  return headers;
}

function serializedJson(value, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid("RPC_BODY_INVALID", "RPC-Body ist nicht als JSON serialisierbar.");
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maxBytes) {
    invalid("RPC_BODY_INVALID", "RPC-Body ist ungültig oder zu groß.");
  }
  return JSON.parse(serialized);
}

function validateJsonSchema(value, schema, path = "body") {
  if (!schema) return;
  const type = schema.type;
  if (type === "object") {
    if (!asObject(value)) invalid("RPC_BODY_INVALID", `${path} muss ein Objekt sein.`);
    const properties = asObject(schema.properties) || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => value[key] === undefined)) {
      invalid("RPC_BODY_INVALID", `${path} enthält nicht alle Pflichtfelder.`);
    }
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) {
      invalid("RPC_BODY_DENIED", `${path} enthält nicht erlaubte Felder.`);
    }
    if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) {
      invalid("RPC_BODY_DENIED", `${path} enthält zu viele Felder.`);
    }
    for (const [key, nestedSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) validateJsonSchema(value[key], nestedSchema, `${path}.${key}`);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) invalid("RPC_BODY_INVALID", `${path} muss eine Liste sein.`);
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      invalid("RPC_BODY_INVALID", `${path} enthält zu wenige Einträge.`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      invalid("RPC_BODY_INVALID", `${path} enthält zu viele Einträge.`);
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      invalid("RPC_BODY_INVALID", `${path} enthält doppelte Einträge.`);
    }
    if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items, `${path}[${index}]`));
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") invalid("RPC_BODY_INVALID", `${path} muss Text sein.`);
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      invalid("RPC_BODY_INVALID", `${path} ist zu kurz.`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      invalid("RPC_BODY_INVALID", `${path} ist zu lang.`);
    }
    if (schema.pattern) {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        invalid("RPC_BODY_INVALID", `${path} enthält eine ungültige Formatregel.`);
      }
      if (!pattern.test(value)) {
        invalid("RPC_BODY_INVALID", `${path} hat ein ungültiges Format.`);
      }
    }
  } else if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    invalid("RPC_BODY_INVALID", `${path} muss eine Zahl sein.`);
  } else if (type === "integer" && !Number.isInteger(value)) {
    invalid("RPC_BODY_INVALID", `${path} muss eine ganze Zahl sein.`);
  } else if (type === "boolean" && typeof value !== "boolean") {
    invalid("RPC_BODY_INVALID", `${path} muss ein Wahrheitswert sein.`);
  } else if (type === "null" && value !== null) {
    invalid("RPC_BODY_INVALID", `${path} muss null sein.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    invalid("RPC_BODY_INVALID", `${path} enthält keinen erlaubten Wert.`);
  }
}

function formEntrySize(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return -1;
}

function sanitizeFormData(value, policy) {
  const envelope = asObject(value);
  if (envelope?.__bonniRpcBody !== "form-data" || !Array.isArray(envelope.entries)) {
    invalid("RPC_BODY_INVALID", "Der RPC-Body muss Formulardaten enthalten.");
  }
  if (envelope.entries.length > MAX_FORM_ENTRIES) {
    invalid("RPC_BODY_INVALID", "Die Formulardaten enthalten zu viele Einträge.");
  }
  let totalBytes = 0;
  const formData = new FormData();
  for (const rawEntry of envelope.entries) {
    const entry = asObject(rawEntry);
    const name = String(entry?.name || "");
    if (!SAFE_FORM_NAME.test(name)) invalid("RPC_BODY_INVALID", "Die Formulardaten enthalten einen ungültigen Feldnamen.");
    const size = formEntrySize(entry.value);
    if (size < 0) invalid("RPC_BODY_INVALID", "Die Formulardaten enthalten einen ungültigen Wert.");
    totalBytes += size;
    if (totalBytes > policy.maxBytes) invalid("RPC_BODY_INVALID", "Die Formulardaten sind zu groß.");
    if (typeof entry.value === "string") {
      formData.append(name, entry.value);
    } else {
      const filename = typeof entry.filename === "string" && entry.filename.trim()
        ? entry.filename.trim().replace(/[\\/\0\r\n]/g, "_").slice(0, 255)
        : "upload";
      formData.append(name, entry.value, filename);
    }
  }
  return formData;
}

function sanitizeBlob(value, policy) {
  if (typeof Blob === "undefined" || !(value instanceof Blob)) {
    invalid("RPC_BODY_INVALID", "Der RPC-Body muss Binärdaten enthalten.");
  }
  if (value.size > policy.maxBytes) {
    invalid("RPC_BODY_INVALID", "Die Binärdaten sind zu groß.");
  }
  return value;
}

function sanitizeBody(value, route) {
  const policy = route.body;
  if (policy.type === "none") {
    if (value !== undefined && value !== null) invalid("RPC_BODY_DENIED", "Diese Anfrage darf keinen Body enthalten.");
    return undefined;
  }
  if (value === undefined) {
    if (policy.required) invalid("RPC_BODY_REQUIRED", "Für diese RPC-Anfrage fehlt der Body.");
    return undefined;
  }
  if (policy.type === "form-data") return sanitizeFormData(value, policy);
  if (policy.type === "blob") return sanitizeBlob(value, policy);

  const body = serializedJson(value, policy.maxBytes);
  validateJsonSchema(body, policy.schema);
  return body;
}

export function validateOpaqueRpcRequest(data, {
  moduleId,
  rpcSessionId,
  contract: rawContract,
} = {}) {
  if (!data || data.type !== OPAQUE_RPC_REQUEST) invalid("RPC_MESSAGE_INVALID", "Ungültige RPC-Nachricht.");
  if (data.moduleId !== moduleId || data.rpcSessionId !== rpcSessionId) {
    invalid("RPC_CHANNEL_INVALID", "RPC-Kanal stimmt nicht überein.");
  }
  if (typeof data.requestId !== "string" || !REQUEST_ID_PATTERN.test(data.requestId)) {
    invalid("RPC_REQUEST_ID_INVALID", "Ungültige RPC-Anfrage-ID.");
  }

  const contract = normalizeOpaqueRpcContract(rawContract, { moduleId });
  const method = normalizeMethod(data.method);
  const parsed = sanitizeRequestUrl(data.path);
  const route = selectRoute(parsed, method, contract);
  return {
    requestId: data.requestId,
    method,
    path: `${parsed.pathname}${parsed.search}`,
    headers: sanitizeHeaders(data.headers, route),
    body: sanitizeBody(data.body, route),
    responseType: route.responseType,
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
      if (isCredentialKey(normalizedKey)) continue;
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

export async function executeOpaqueModuleRpc(request, { token, signal } = {}) {
  try {
    const payload = await apiRequest(request.path, {
      token,
      method: request.method,
      body: request.body,
      headers: request.headers,
      responseType: request.responseType,
      signal,
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
            message: error?.message || "Die Modul-Anfrage ist fehlgeschlagen.",
          },
    };
  }
}
