import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg, { type Pool as PgPool } from "pg";

import { env } from "../config/env.js";
import { getActiveDatabaseRole, type DatabaseRole } from "./database-context.js";
import {
  getDatabaseReadOrder,
  getDatabaseRoutingStatus,
  getDatabaseTargetConnectionString,
  getDatabaseWriteOrder,
  isDatabaseConnectionFailure,
  recordDatabaseTargetFailure,
  recordDatabaseTargetSuccess,
  type DatabaseTarget,
} from "./database-routing.js";
import {
  acknowledgeJsonEmergencyWrite,
  enqueueJsonEmergencyWrite,
  getJsonEmergencyStatus,
  listJsonEmergencyWrites,
  markJsonEmergencyDatabaseRecovered,
  recordJsonEmergencyReplayFailure,
} from "./json-emergency-store.js";

const { Pool } = pg;

type PrismaClientEntry = {
  connectionString: string;
  pool: PgPool;
  client: PrismaClient;
};

const clients = new Map<string, PrismaClientEntry>();
const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const MODEL_PROPERTIES = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    `${model.name[0].toLowerCase()}${model.name.slice(1)}`,
    model,
  ]),
);
const delegateProxies = new Map<string, object>();
let jsonEmergencyReplayRunning = false;

function localConnectionString() {
  if (!env.LOCAL_DATABASE_URL) {
    throw new Error("LOCAL_DATABASE_URL is not configured for the active database context.");
  }
  return env.LOCAL_DATABASE_URL;
}

export function normalizePrismaConnectionString(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "postgres:" && protocol !== "postgresql:") return connectionString;

    // node-postgres does not fall back to a plain connection when a server
    // rejects TLS. In this application, "prefer" is the optional SSL mode;
    // "require" remains untouched for databases that must use TLS.
    if (parsed.searchParams.get("sslmode")?.toLowerCase() === "prefer") {
      parsed.searchParams.set("sslmode", "disable");
      parsed.searchParams.delete("uselibpqcompat");
      return parsed.toString();
    }
  } catch {
    // Keep non-URL connection strings unchanged and let node-postgres report
    // a useful configuration error when the connection is opened.
  }

  return connectionString;
}

function createPrismaClient(connectionString: string): PrismaClientEntry {
  const pool = new Pool({
    connectionString: normalizePrismaConnectionString(connectionString),
  });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });
  return { connectionString, pool, client };
}

function clientEntry(key: string, connectionString: string) {
  const existing = clients.get(key);
  if (existing?.connectionString === connectionString) return existing;

  if (existing) {
    clients.delete(key);
    void Promise.allSettled([existing.client.$disconnect(), existing.pool.end()]);
  }

  const created = createPrismaClient(connectionString);
  clients.set(key, created);
  return created;
}

export function getDatabaseTargetPrismaClient(target: DatabaseTarget) {
  return clientEntry(`server:${target}`, getDatabaseTargetConnectionString(target)).client;
}

function getLocalPrismaClientEntry() {
  return clientEntry("local", localConnectionString());
}

function targetDelegate(target: DatabaseTarget, modelProperty: string) {
  const client = getDatabaseTargetPrismaClient(target) as unknown as Record<string, unknown>;
  return Reflect.get(client, modelProperty, client) as Record<string, unknown>;
}

async function runDelegateOperation(
  target: DatabaseTarget,
  modelProperty: string,
  operation: string,
  args: unknown[],
) {
  const delegate = targetDelegate(target, modelProperty);
  const method = Reflect.get(delegate, operation, delegate);
  if (typeof method !== "function") {
    throw new Error(`PRISMA_OPERATION_NOT_AVAILABLE:${modelProperty}.${operation}`);
  }
  return Reflect.apply(method, delegate, args);
}

function generatedStringId(modelProperty: string) {
  const model = MODEL_PROPERTIES.get(modelProperty);
  const id = model?.fields.find((field) => field.isId);
  const generated = id?.default && typeof id.default === "object"
    ? String((id.default as { name?: unknown }).name || "")
    : "";
  return id?.type === "String" && ["cuid", "uuid", "ulid"].includes(generated)
    ? id.name
    : null;
}

function mapObjectOrArray(value: unknown, mapper: (item: unknown) => unknown) {
  return Array.isArray(value) ? value.map(mapper) : mapper(value);
}

function prepareNestedRelationWrite(modelProperty: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const nested = { ...(value as Record<string, unknown>) };

  if ("create" in nested) {
    nested.create = mapObjectOrArray(
      nested.create,
      (item) => prepareWriteData(modelProperty, item, true),
    );
  }
  if (nested.createMany && typeof nested.createMany === "object" && !Array.isArray(nested.createMany)) {
    const createMany = { ...(nested.createMany as Record<string, unknown>) };
    createMany.data = mapObjectOrArray(
      createMany.data,
      (item) => prepareWriteData(modelProperty, item, true),
    );
    nested.createMany = createMany;
  }
  if ("connectOrCreate" in nested) {
    nested.connectOrCreate = mapObjectOrArray(nested.connectOrCreate, (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const connectOrCreate = { ...(item as Record<string, unknown>) };
      connectOrCreate.create = prepareWriteData(modelProperty, connectOrCreate.create, true);
      return connectOrCreate;
    });
  }
  if ("upsert" in nested) {
    nested.upsert = mapObjectOrArray(nested.upsert, (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const upsert = { ...(item as Record<string, unknown>) };
      upsert.create = prepareWriteData(modelProperty, upsert.create, true);
      upsert.update = prepareWriteData(modelProperty, upsert.update, false);
      return upsert;
    });
  }
  if ("update" in nested) {
    nested.update = mapObjectOrArray(nested.update, (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const update = { ...(item as Record<string, unknown>) };
      if ("data" in update) {
        update.data = prepareWriteData(modelProperty, update.data, false);
        return update;
      }
      return prepareWriteData(modelProperty, update, false);
    });
  }
  if ("updateMany" in nested) {
    nested.updateMany = mapObjectOrArray(nested.updateMany, (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const updateMany = { ...(item as Record<string, unknown>) };
      updateMany.data = prepareWriteData(modelProperty, updateMany.data, false);
      return updateMany;
    });
  }

  return nested;
}

function prepareWriteData(modelProperty: string, data: unknown, injectId: boolean): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const model = MODEL_PROPERTIES.get(modelProperty);
  const row = { ...(data as Record<string, unknown>) };
  const idField = generatedStringId(modelProperty);
  if (injectId && idField && !row[idField]) row[idField] = randomUUID();

  for (const field of model?.fields || []) {
    if (field.kind !== "object" || !(field.name in row)) continue;
    const relatedProperty = `${field.type[0].toLowerCase()}${field.type.slice(1)}`;
    row[field.name] = prepareNestedRelationWrite(relatedProperty, row[field.name]);
  }
  return row;
}

function prepareMirroredWriteArgs(modelProperty: string, operation: string, args: unknown[]) {
  if (!args.length || !args[0] || typeof args[0] !== "object") return args;
  const options = { ...(args[0] as Record<string, unknown>) };

  if (operation === "create") {
    options.data = prepareWriteData(modelProperty, options.data, true);
  } else if (operation === "createMany" || operation === "createManyAndReturn") {
    options.data = Array.isArray(options.data)
      ? options.data.map((row) => prepareWriteData(modelProperty, row, true))
      : prepareWriteData(modelProperty, options.data, true);
  } else if (operation === "upsert") {
    options.create = prepareWriteData(modelProperty, options.create, true);
    options.update = prepareWriteData(modelProperty, options.update, false);
  } else if (operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn") {
    options.data = prepareWriteData(modelProperty, options.data, false);
  }

  return [options, ...args.slice(1)];
}

function reportDatabaseRecovered() {
  void markJsonEmergencyDatabaseRecovered().catch((error) => {
    console.warn("[bonni-core] JSON-Notlaufstatus konnte nicht aktualisiert werden", {
      code: (error as { code?: unknown } | null)?.code || "JSON_EMERGENCY_STATUS_UPDATE_FAILED",
    });
  });
}

function queuedWriteResult(operation: string, args: unknown[]) {
  const options = args[0] && typeof args[0] === "object"
    ? args[0] as Record<string, unknown>
    : {};
  const data = options.data;
  if (operation === "createMany") {
    return { count: Array.isArray(data) ? data.length : data ? 1 : 0 };
  }
  if (operation === "createManyAndReturn") {
    return Array.isArray(data) ? data : data ? [data] : [];
  }
  if (operation === "updateMany" || operation === "deleteMany") return { count: 0 };
  if (operation === "updateManyAndReturn") return [];
  if (operation === "delete") return options.where || {};
  if (operation === "upsert") {
    return {
      ...(options.where && typeof options.where === "object" ? options.where as object : {}),
      ...(options.create && typeof options.create === "object" ? options.create as object : {}),
    };
  }
  return {
    ...(options.where && typeof options.where === "object" ? options.where as object : {}),
    ...(data && typeof data === "object" ? data as object : {}),
  };
}

async function queueEmergencyWrite(
  modelProperty: string,
  operation: string,
  args: unknown[],
  databaseError: unknown,
) {
  const routing = getDatabaseRoutingStatus();
  if (!routing.jsonEmergency.enabled || !isDatabaseConnectionFailure(databaseError)) {
    throw databaseError;
  }
  const queued = await enqueueJsonEmergencyWrite({
    modelProperty,
    operation,
    args,
    databaseError,
  });
  console.warn("[bonni-core] Schreibvorgang verschlüsselt im JSON-Notlauf gespeichert", {
    model: modelProperty,
    operation,
    queueId: queued.id,
  });
  return modelProperty === "$client" ? 0 : queuedWriteResult(operation, args);
}

async function executeRead(modelProperty: string, operation: string, args: unknown[]) {
  const targets = getDatabaseReadOrder();
  let lastError: unknown;

  for (const target of targets) {
    try {
      const result = await runDelegateOperation(target, modelProperty, operation, args);
      recordDatabaseTargetSuccess(target);
      reportDatabaseRecovered();
      return result;
    } catch (error) {
      recordDatabaseTargetFailure(target, `${modelProperty}.${operation}`, error);
      lastError = error;
      if (!isDatabaseConnectionFailure(error)) throw error;
    }
  }

  throw lastError;
}

async function executeWrite(modelProperty: string, operation: string, originalArgs: unknown[]) {
  const targets = getDatabaseWriteOrder();
  const routing = getDatabaseRoutingStatus();
  const args = targets.length > 1 || routing.jsonEmergency.enabled
    ? prepareMirroredWriteArgs(modelProperty, operation, originalArgs)
    : originalArgs;
  const primary = targets[0];

  try {
    const result = await runDelegateOperation(primary, modelProperty, operation, args);
    recordDatabaseTargetSuccess(primary);
    reportDatabaseRecovered();

    if (targets.length > 1) {
      const mirror = targets[1];
      try {
        await runDelegateOperation(mirror, modelProperty, operation, args);
        recordDatabaseTargetSuccess(mirror);
        reportDatabaseRecovered();
      } catch (error) {
        recordDatabaseTargetFailure(mirror, `${modelProperty}.${operation}`, error);
        console.warn("[bonni-core] Redundante Datenbankspiegelung fehlgeschlagen", {
          target: mirror,
          operation: `${modelProperty}.${operation}`,
          code: (error as { code?: unknown } | null)?.code || "DATABASE_MIRROR_WRITE_FAILED",
        });
      }
    }

    return result;
  } catch (error) {
    recordDatabaseTargetFailure(primary, `${modelProperty}.${operation}`, error);
    const fallback = targets[1];
    if (!fallback) return queueEmergencyWrite(modelProperty, operation, args, error);
    if (!isDatabaseConnectionFailure(error)) throw error;

    try {
      const result = await runDelegateOperation(fallback, modelProperty, operation, args);
      recordDatabaseTargetSuccess(fallback);
      reportDatabaseRecovered();
      return result;
    } catch (fallbackError) {
      recordDatabaseTargetFailure(fallback, `${modelProperty}.${operation}`, fallbackError);
      return queueEmergencyWrite(modelProperty, operation, args, fallbackError);
    }
  }
}

function delegateProxy(modelProperty: string) {
  const cached = delegateProxies.get(modelProperty);
  if (cached) return cached;

  const proxy = new Proxy({}, {
    get(_target, operation) {
      if (typeof operation !== "string") return undefined;
      return (...args: unknown[]) => WRITE_OPERATIONS.has(operation)
        ? executeWrite(modelProperty, operation, args)
        : executeRead(modelProperty, operation, args);
    },
  });
  delegateProxies.set(modelProperty, proxy);
  return proxy;
}

async function executeClientRead(property: string, args: unknown[]) {
  const targets = getDatabaseReadOrder();
  let lastError: unknown;
  for (const target of targets) {
    const client = getDatabaseTargetPrismaClient(target) as unknown as Record<string, unknown>;
    const method = Reflect.get(client, property, client);
    try {
      const result = await Reflect.apply(method as (...values: unknown[]) => unknown, client, args);
      recordDatabaseTargetSuccess(target);
      return result;
    } catch (error) {
      recordDatabaseTargetFailure(target, property, error);
      lastError = error;
      if (!isDatabaseConnectionFailure(error)) throw error;
    }
  }
  throw lastError;
}

async function executeClientWrite(property: string, args: unknown[]) {
  const targets = getDatabaseWriteOrder();
  const primary = targets[0];
  const primaryClient = getDatabaseTargetPrismaClient(primary) as unknown as Record<string, unknown>;
  const primaryMethod = Reflect.get(primaryClient, property, primaryClient);
  let result: unknown;
  try {
    result = await Reflect.apply(primaryMethod as (...values: unknown[]) => unknown, primaryClient, args);
    recordDatabaseTargetSuccess(primary);
    reportDatabaseRecovered();
  } catch (error) {
    recordDatabaseTargetFailure(primary, property, error);
    const fallback = targets[1];
    if (!fallback) return queueEmergencyWrite("$client", property, args, error);
    if (!isDatabaseConnectionFailure(error)) throw error;
    const fallbackClient = getDatabaseTargetPrismaClient(fallback) as unknown as Record<string, unknown>;
    const fallbackMethod = Reflect.get(fallbackClient, property, fallbackClient);
    try {
      result = await Reflect.apply(fallbackMethod as (...values: unknown[]) => unknown, fallbackClient, args);
      recordDatabaseTargetSuccess(fallback);
      reportDatabaseRecovered();
      return result;
    } catch (fallbackError) {
      recordDatabaseTargetFailure(fallback, property, fallbackError);
      return queueEmergencyWrite("$client", property, args, fallbackError);
    }
  }

  if (targets.length > 1) {
    const mirror = targets[1];
    const mirrorClient = getDatabaseTargetPrismaClient(mirror) as unknown as Record<string, unknown>;
    const mirrorMethod = Reflect.get(mirrorClient, property, mirrorClient);
    try {
      await Reflect.apply(mirrorMethod as (...values: unknown[]) => unknown, mirrorClient, args);
      recordDatabaseTargetSuccess(mirror);
      reportDatabaseRecovered();
    } catch (error) {
      recordDatabaseTargetFailure(mirror, property, error);
    }
  }
  return result;
}

async function replayJsonEmergencyWritesUnlocked(target: DatabaseTarget) {
  const routing = getDatabaseRoutingStatus();
  if (routing.maintenance) {
    throw Object.assign(new Error("DATABASE_FULL_SYNC_IN_PROGRESS"), {
      statusCode: 423,
      code: "DATABASE_FULL_SYNC_IN_PROGRESS",
    });
  }
  if (!routing.configured[target]) {
    throw Object.assign(new Error(`${target.toUpperCase()}_DATABASE_NOT_CONFIGURED`), {
      statusCode: 409,
    });
  }

  const entries = await listJsonEmergencyWrites();
  let replayed = 0;
  let recoveryMarked = false;

  for (const entry of entries) {
    try {
      if (entry.modelProperty === "$client") {
        if (entry.operation !== "$executeRaw" && entry.operation !== "$executeRawUnsafe") {
          throw new Error(`JSON_EMERGENCY_OPERATION_NOT_ALLOWED:${entry.operation}`);
        }
        const client = getDatabaseTargetPrismaClient(target) as unknown as Record<string, unknown>;
        const method = Reflect.get(client, entry.operation, client);
        if (typeof method !== "function") {
          throw new Error(`PRISMA_OPERATION_NOT_AVAILABLE:${entry.operation}`);
        }
        await Reflect.apply(method, client, entry.args);
      } else {
        if (!WRITE_OPERATIONS.has(entry.operation) || !MODEL_PROPERTIES.has(entry.modelProperty)) {
          throw new Error(
            `JSON_EMERGENCY_OPERATION_NOT_ALLOWED:${entry.modelProperty}.${entry.operation}`,
          );
        }
        await runDelegateOperation(target, entry.modelProperty, entry.operation, entry.args);
      }

      recordDatabaseTargetSuccess(target);
      if (!recoveryMarked) {
        await markJsonEmergencyDatabaseRecovered();
        recoveryMarked = true;
      }
      await acknowledgeJsonEmergencyWrite(entry.id, target);
      replayed += 1;
    } catch (error) {
      recordDatabaseTargetFailure(
        target,
        `jsonEmergency.${entry.modelProperty}.${entry.operation}`,
        error,
      );
      const status = await recordJsonEmergencyReplayFailure(entry.id, target, error);
      return {
        ok: false,
        target,
        replayed,
        failedEntryId: entry.id,
        remaining: status.pendingCount,
        status,
      };
    }
  }

  const status = await getJsonEmergencyStatus();
  return {
    ok: true,
    target,
    replayed,
    remaining: status.pendingCount,
    status,
  };
}

export async function replayJsonEmergencyWrites(target: DatabaseTarget) {
  if (jsonEmergencyReplayRunning) {
    throw Object.assign(new Error("JSON_EMERGENCY_REPLAY_ALREADY_RUNNING"), {
      statusCode: 409,
      code: "JSON_EMERGENCY_REPLAY_ALREADY_RUNNING",
    });
  }
  jsonEmergencyReplayRunning = true;
  try {
    return await replayJsonEmergencyWritesUnlocked(target);
  } finally {
    jsonEmergencyReplayRunning = false;
  }
}

const routedServerClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    if (MODEL_PROPERTIES.has(property)) return delegateProxy(property);
    if (property === "$queryRaw" || property === "$queryRawUnsafe") {
      return (...args: unknown[]) => executeClientRead(property, args);
    }
    if (property === "$executeRaw" || property === "$executeRawUnsafe") {
      return (...args: unknown[]) => executeClientWrite(property, args);
    }

    const primary = getDatabaseReadOrder()[0];
    const client = getDatabaseTargetPrismaClient(primary) as unknown as Record<string, unknown>;
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export function getPrismaClient(role: DatabaseRole = getActiveDatabaseRole()) {
  return role === "local" ? getLocalPrismaClientEntry().client : routedServerClient;
}

export function getServerPrismaClient() {
  return routedServerClient;
}

export function getLocalPrismaClient() {
  return getLocalPrismaClientEntry().client;
}

export async function disconnectDatabaseTarget(target: DatabaseTarget) {
  const key = `server:${target}`;
  const entry = clients.get(key);
  if (!entry) return;
  clients.delete(key);
  await Promise.allSettled([entry.client.$disconnect(), entry.pool.end()]);
}

export async function disconnectPrismaClients() {
  await Promise.all(
    [...clients.values()].map(async ({ client, pool }) => {
      await client.$disconnect();
      await pool.end();
    }),
  );
  clients.clear();
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrismaClient();
    const value = Reflect.get(client, property, client) as unknown;
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export { getDatabaseRoutingStatus };
