import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type {
  ModuleRpcBodyPolicy,
  ModuleRpcContract,
  ModuleRpcRoute,
} from "../types.js";

export const MODULE_RPC_CONTRACT_SCHEMA = "bonni.module-rpc/v1";
export const MAX_MODULE_RPC_CONTRACT_BYTES = 256 * 1024;

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_ROUTES = 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 100;
const MAX_SCHEMA_ENUM_VALUES = 100;
const MAX_SCHEMA_PATTERN_LENGTH = 256;
const MAX_PATTERN_INPUT_LENGTH = 10_000;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const IDEMPOTENCY = new Set(["required", "optional", "forbidden"]);
const RESPONSE_TYPES = new Set(["json", "text", "blob"]);
const BODY_TYPES = new Set(["none", "json", "form-data", "blob"]);
const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SAFE_QUERY_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/;
const SAFE_LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,199}$/;
const SAFE_PARAMETER = /^\{([A-Za-z][A-Za-z0-9_]*)(\*)?\}$/;
const SAFE_HEADER_NAME = /^[a-z][a-z0-9-]{0,99}$/;
const SAFE_CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
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
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ROUTE_KEYS = new Set([
  "method",
  "path",
  "idempotency",
  "query",
  "body",
  "headers",
  "responseType",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contractError(code: string): never {
  throw new Error(code);
}

function assertInside(parent: string, candidate: string, code: string) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    contractError(code);
  }
}

function validateJsonTree(value: unknown) {
  let nodes = 0;
  const seen = new Set<object>();

  function visit(current: unknown, depth: number) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      contractError("MODULE_RPC_CONTRACT_JSON_COMPLEXITY_INVALID");
    }
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) contractError("MODULE_RPC_CONTRACT_JSON_INVALID");
      return;
    }
    if (!current || typeof current !== "object" || seen.has(current)) {
      contractError("MODULE_RPC_CONTRACT_JSON_INVALID");
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (DANGEROUS_JSON_KEYS.has(key) || /[\u0000-\u001f\u007f]/.test(key)) {
        contractError("MODULE_RPC_CONTRACT_JSON_KEY_INVALID");
      }
      visit(entry, depth + 1);
    }
  }

  visit(value, 0);
}

function validateApiBasePath(value: unknown) {
  const basePath = String(value || "").trim().replace(/\/+$/, "");
  if (
    !basePath.startsWith("/api/")
    || basePath.startsWith("//")
    || basePath.length > 512
    || basePath.includes("?")
    || basePath.includes("#")
    || /(?:^|\/)\.{1,2}(?:\/|$)/.test(basePath)
  ) {
    contractError("MODULE_RPC_CONTRACT_BASE_PATH_INVALID");
  }
  return basePath;
}

function validateSchemaInteger(
  value: unknown,
  code: string,
  maximum: number,
) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    contractError(code);
  }
  return Number(value);
}

function schemaValueMatchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return false;
}

function validateSchemaPattern(value: unknown, maxLength: number | undefined) {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_SCHEMA_PATTERN_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
    // The supported subset deliberately has no groups, lookarounds,
    // backreferences or alternations. This also removes the common nested
    // quantifier structures behind catastrophic browser-side backtracking.
    || /[()|]/u.test(value)
    || /\\(?:[1-9]|k[<{])/u.test(value)
    || /[+*?}]\s*(?:[+*?{])/u.test(value)
    || maxLength === undefined
    || maxLength > MAX_PATTERN_INPUT_LENGTH
  ) {
    contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_PATTERN_INVALID");
  }
  try {
    void new RegExp(value);
  } catch {
    contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_PATTERN_INVALID");
  }
  return value;
}

function validateBodySchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > MAX_SCHEMA_DEPTH) {
    contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_INVALID");
  }
  const type = value.type;
  if (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type)) {
    contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_TYPE_INVALID");
  }

  const commonKeys = ["type", "enum"];
  const allowedKeys = new Set(type === "object"
    ? [...commonKeys, "properties", "required", "additionalProperties", "maxProperties"]
    : type === "array"
      ? [...commonKeys, "items", "minItems", "maxItems", "uniqueItems"]
      : type === "string"
        ? [...commonKeys, "minLength", "maxLength", "pattern"]
        : commonKeys);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_KEY_INVALID");
  }

  let validatedEnum: unknown[] | undefined;
  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum)
      || !value.enum.length
      || value.enum.length > MAX_SCHEMA_ENUM_VALUES
      || value.enum.some((entry) => (
        !schemaValueMatchesType(entry, type)
        || (typeof entry === "string" && entry.length > 1_000)
      ))
    ) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_ENUM_INVALID");
    }
    const serialized = value.enum.map((entry) => JSON.stringify(entry));
    if (new Set(serialized).size !== serialized.length) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_ENUM_INVALID");
    }
    validatedEnum = [...value.enum];
  }

  if (type === "object") {
    if (
      value.properties !== undefined
      && (
        !isRecord(value.properties)
        || Object.keys(value.properties).length > MAX_SCHEMA_PROPERTIES
      )
    ) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_PROPERTIES_INVALID");
    }
    const properties = value.properties as Record<string, unknown> | undefined;
    const propertyNames = Object.keys(properties || {});
    if (propertyNames.some((name) => (
      !SAFE_QUERY_NAME.test(name)
      || DANGEROUS_JSON_KEYS.has(name)
    ))) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_PROPERTIES_INVALID");
    }
    const validatedProperties = properties === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(properties).map(([name, schema]) => [
            name,
            validateBodySchema(schema, depth + 1),
          ]),
        );
    if (
      value.required !== undefined
      && (
        !Array.isArray(value.required)
        || value.required.length > MAX_SCHEMA_PROPERTIES
        || value.required.some((name) => typeof name !== "string" || !propertyNames.includes(name))
        || new Set(value.required).size !== value.required.length
      )
    ) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_REQUIRED_INVALID");
    }
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_ADDITIONAL_PROPERTIES_INVALID");
    }
    const maxProperties = value.maxProperties === undefined
      ? undefined
      : validateSchemaInteger(
          value.maxProperties,
          "MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID",
          MAX_SCHEMA_PROPERTIES,
        );
    return {
      type,
      ...(validatedEnum === undefined ? {} : { enum: validatedEnum }),
      ...(validatedProperties === undefined ? {} : { properties: validatedProperties }),
      ...(value.required === undefined ? {} : { required: [...value.required] }),
      ...(value.additionalProperties === undefined ? {} : { additionalProperties: value.additionalProperties }),
      ...(maxProperties === undefined ? {} : { maxProperties }),
    };
  }

  if (type === "array") {
    const minItems = value.minItems === undefined
      ? undefined
      : validateSchemaInteger(
          value.minItems,
          "MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID",
          10_000,
        );
    const maxItems = value.maxItems === undefined
      ? undefined
      : validateSchemaInteger(
          value.maxItems,
          "MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID",
          10_000,
        );
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID");
    }
    if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean") {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_UNIQUE_ITEMS_INVALID");
    }
    return {
      type,
      ...(validatedEnum === undefined ? {} : { enum: validatedEnum }),
      ...(value.items === undefined ? {} : { items: validateBodySchema(value.items, depth + 1) }),
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(value.uniqueItems === undefined ? {} : { uniqueItems: value.uniqueItems }),
    };
  }

  if (type === "string") {
    const minLength = value.minLength === undefined
      ? undefined
      : validateSchemaInteger(
          value.minLength,
          "MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID",
          1_000_000,
        );
    const maxLength = value.maxLength === undefined
      ? undefined
      : validateSchemaInteger(
          value.maxLength,
          "MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID",
          1_000_000,
        );
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_LENGTH_INVALID");
    }
    const pattern = value.pattern === undefined
      ? undefined
      : validateSchemaPattern(value.pattern, maxLength);
    return {
      type,
      ...(validatedEnum === undefined ? {} : { enum: validatedEnum }),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(pattern === undefined ? {} : { pattern }),
    };
  }

  return {
    type,
    ...(validatedEnum === undefined ? {} : { enum: validatedEnum }),
  };
}

function validateRoutePath(value: unknown, basePath: string) {
  const routePath = String(value || "").trim();
  if (
    !routePath
    || routePath.length > 2048
    || routePath.includes("?")
    || routePath.includes("#")
    || routePath.startsWith("//")
    || /[\u0000-\u001f\u007f\\]/.test(routePath)
  ) {
    contractError("MODULE_RPC_CONTRACT_ROUTE_PATH_INVALID");
  }

  const fullPath = routePath.startsWith("/api/")
    ? routePath
    : `${basePath}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
  if (!fullPath.startsWith("/api/") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(fullPath)) {
    contractError("MODULE_RPC_CONTRACT_ROUTE_PATH_INVALID");
  }

  const parts = fullPath.split("/").filter(Boolean);
  parts.forEach((segment, index) => {
    const parameter = segment.match(SAFE_PARAMETER);
    if (parameter) {
      if (parameter[2] && index !== parts.length - 1) {
        contractError("MODULE_RPC_CONTRACT_WILDCARD_POSITION_INVALID");
      }
      return;
    }
    if (!SAFE_LITERAL_SEGMENT.test(segment)) {
      contractError("MODULE_RPC_CONTRACT_ROUTE_SEGMENT_INVALID");
    }
  });
  return routePath;
}

function validateQueryPolicy(value: unknown): ModuleRpcRoute["query"] {
  if (value === undefined || value === true || value === false || value === "any" || value === "none") {
    return value as ModuleRpcRoute["query"];
  }
  if (!Array.isArray(value) || value.length > 100) {
    contractError("MODULE_RPC_CONTRACT_QUERY_INVALID");
  }
  const names = value.map((entry) => String(entry || "").trim());
  if (names.some((entry) => !SAFE_QUERY_NAME.test(entry)) || new Set(names).size !== names.length) {
    contractError("MODULE_RPC_CONTRACT_QUERY_INVALID");
  }
  return names;
}

function validateBodyPolicy(
  value: unknown,
  contractMaxBytes: number,
): ModuleRpcRoute["body"] {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!BODY_TYPES.has(value)) contractError("MODULE_RPC_CONTRACT_BODY_INVALID");
    return value as ModuleRpcRoute["body"];
  }
  if (!isRecord(value)) contractError("MODULE_RPC_CONTRACT_BODY_INVALID");

  const type = String(value.type || "json").trim();
  if (!BODY_TYPES.has(type)) contractError("MODULE_RPC_CONTRACT_BODY_INVALID");
  if (
    value.maxBytes !== undefined
    && (
      !Number.isInteger(value.maxBytes)
      || Number(value.maxBytes) < 1
      || Number(value.maxBytes) > contractMaxBytes
    )
  ) {
    contractError("MODULE_RPC_CONTRACT_BODY_SIZE_INVALID");
  }
  if (value.schema !== undefined && (type !== "json" || !isRecord(value.schema))) {
    contractError("MODULE_RPC_CONTRACT_BODY_SCHEMA_INVALID");
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    contractError("MODULE_RPC_CONTRACT_BODY_REQUIRED_INVALID");
  }
  const contentType = value.contentType === undefined
    ? undefined
    : String(value.contentType).trim().toLowerCase();
  if (
    (type === "blob" && contentType !== undefined && !SAFE_CONTENT_TYPE.test(contentType))
    || (type !== "blob" && contentType !== undefined)
  ) {
    contractError("MODULE_RPC_CONTRACT_BODY_CONTENT_TYPE_INVALID");
  }
  return {
    type: type as ModuleRpcBodyPolicy["type"],
    ...(value.maxBytes === undefined ? {} : { maxBytes: Number(value.maxBytes) }),
    ...(value.schema === undefined ? {} : { schema: validateBodySchema(value.schema) }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(value.required === undefined ? {} : { required: value.required }),
  };
}

function validateHeaderPolicy(value: unknown): ModuleRpcRoute["headers"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    contractError("MODULE_RPC_CONTRACT_HEADERS_INVALID");
  }
  const names = value.map((entry) => String(entry || "").trim().toLowerCase());
  if (
    names.some((name) => (
      !SAFE_HEADER_NAME.test(name)
      || FORBIDDEN_REQUEST_HEADERS.has(name)
      || name === "idempotency-key"
      || name.startsWith("sec-")
      || name.startsWith("proxy-")
      || name.startsWith("x-forwarded-")
    ))
    || new Set(names).size !== names.length
  ) {
    contractError("MODULE_RPC_CONTRACT_HEADERS_INVALID");
  }
  return names;
}

function validateRoute(value: unknown, basePath: string, maxBodyBytes: number): ModuleRpcRoute {
  if (!isRecord(value)) contractError("MODULE_RPC_CONTRACT_ROUTE_INVALID");
  if (Object.keys(value).some((key) => !ROUTE_KEYS.has(key))) {
    contractError("MODULE_RPC_CONTRACT_ROUTE_KEY_INVALID");
  }
  const method = String(value.method || "").trim().toUpperCase();
  if (!METHODS.has(method)) contractError("MODULE_RPC_CONTRACT_METHOD_INVALID");
  const routePath = validateRoutePath(value.path, basePath);

  const idempotency = value.idempotency === undefined
    ? undefined
    : String(value.idempotency).trim().toLowerCase();
  if (idempotency !== undefined && !IDEMPOTENCY.has(idempotency)) {
    contractError("MODULE_RPC_CONTRACT_IDEMPOTENCY_INVALID");
  }

  const responseType = value.responseType === undefined
    ? undefined
    : String(value.responseType).trim().toLowerCase();
  if (responseType !== undefined && !RESPONSE_TYPES.has(responseType)) {
    contractError("MODULE_RPC_CONTRACT_RESPONSE_INVALID");
  }
  const query = validateQueryPolicy(value.query);
  const body = validateBodyPolicy(value.body, maxBodyBytes);
  const headers = validateHeaderPolicy(value.headers);

  return {
    method: method as ModuleRpcRoute["method"],
    path: routePath,
    ...(idempotency ? { idempotency: idempotency as ModuleRpcRoute["idempotency"] } : {}),
    ...(query === undefined ? {} : { query }),
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
    ...(responseType ? { responseType: responseType as ModuleRpcRoute["responseType"] } : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
  }
  return value;
}

export function validateModuleRpcContract(
  value: unknown,
  moduleId: string,
): ModuleRpcContract {
  validateJsonTree(value);
  if (!isRecord(value)) contractError("MODULE_RPC_CONTRACT_INVALID");
  if (value.schemaVersion !== MODULE_RPC_CONTRACT_SCHEMA) {
    contractError("MODULE_RPC_CONTRACT_SCHEMA_UNSUPPORTED");
  }
  if (String(value.moduleId || "").trim() !== moduleId) {
    contractError("MODULE_RPC_CONTRACT_MODULE_MISMATCH");
  }

  const basePath = validateApiBasePath(value.basePath);
  const maxBodyBytes = value.maxBodyBytes === undefined ? 256 * 1024 : Number(value.maxBodyBytes);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES) {
    contractError("MODULE_RPC_CONTRACT_MAX_BODY_INVALID");
  }
  if (!Array.isArray(value.routes) || !value.routes.length || value.routes.length > MAX_ROUTES) {
    contractError("MODULE_RPC_CONTRACT_ROUTES_INVALID");
  }

  const routes = value.routes.map((route) => validateRoute(route, basePath, maxBodyBytes));
  const routeKeys = routes.map((route) => `${route.method}\u0000${route.path}`);
  if (new Set(routeKeys).size !== routeKeys.length) {
    contractError("MODULE_RPC_CONTRACT_ROUTE_DUPLICATE");
  }

  return deepFreeze({
    schemaVersion: MODULE_RPC_CONTRACT_SCHEMA,
    moduleId,
    basePath,
    maxBodyBytes,
    routes,
  });
}

export async function loadModuleRpcContract({
  packageRoot,
  contractPath,
  moduleId,
}: {
  packageRoot: string;
  contractPath: string;
  moduleId: string;
}) {
  const configuredPath = String(contractPath || "").trim();
  if (
    !configuredPath
    || configuredPath.length > 512
    || path.isAbsolute(configuredPath)
    || configuredPath.includes("\\")
    || !configuredPath.toLowerCase().endsWith(".json")
    || /[\u0000-\u001f\u007f]/.test(configuredPath)
  ) {
    contractError("MODULE_RPC_CONTRACT_PATH_INVALID");
  }

  const absolutePackageRoot = path.resolve(packageRoot);
  const absoluteContractPath = path.resolve(absolutePackageRoot, configuredPath);
  assertInside(absolutePackageRoot, absoluteContractPath, "MODULE_RPC_CONTRACT_OUTSIDE_PACKAGE");

  const [realPackageRoot, linkStats] = await Promise.all([
    fs.realpath(absolutePackageRoot),
    fs.lstat(absoluteContractPath).catch(() => null),
  ]);
  if (!linkStats?.isFile() || linkStats.isSymbolicLink()) {
    contractError("MODULE_RPC_CONTRACT_FILE_INVALID");
  }
  const realContractPath = await fs.realpath(absoluteContractPath);
  assertInside(realPackageRoot, realContractPath, "MODULE_RPC_CONTRACT_OUTSIDE_PACKAGE");

  const handle = await fs.open(
    realContractPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 2 || stats.size > MAX_MODULE_RPC_CONTRACT_BYTES) {
      contractError("MODULE_RPC_CONTRACT_SIZE_INVALID");
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      contractError("MODULE_RPC_CONTRACT_JSON_INVALID");
    }
    return validateModuleRpcContract(parsed, moduleId);
  } finally {
    await handle.close();
  }
}
