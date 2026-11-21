import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { env } from "../config/env.js";
import { getActiveDatabaseRole } from "./database-context.js";
import { getDataDomainConnectionString } from "./data-domain-routing.js";
import { dataDomainAllowsJsonEmergency, dataDomainSchemas, } from "./data-domains.js";
import { getDatabaseReadOrder, getDatabaseRoutingStatus, getDatabaseTargetConnectionString, getDatabaseWriteOrder, isDatabaseConnectionFailure, recordDatabaseTargetFailure, recordDatabaseTargetSuccess, } from "./database-routing.js";
import { acknowledgeJsonEmergencyWrite, enqueueJsonEmergencyWrite, getJsonEmergencyStatus, listJsonEmergencyWrites, markJsonEmergencyDatabaseRecovered, recordJsonEmergencyReplayFailure, } from "./json-emergency-store.js";
const { Pool } = pg;
const clients = new Map();
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
const MODEL_PROPERTIES = new Map(Prisma.dmmf.datamodel.models.map((model) => [
    `${model.name[0].toLowerCase()}${model.name.slice(1)}`,
    model,
]));
const coreJsonNulls = Object.freeze({ database: Prisma.DbNull, json: Prisma.JsonNull });
const appClients = new Map();
export function getDataDomainJsonNulls(domain) {
    return appClients.get(domain)?.jsonNulls || coreJsonNulls;
}
function modelsFor(domain) { return appClients.get(domain)?.models || MODEL_PROPERTIES; }
export async function registerAppDatabaseClient(domain, constructor, models, namespace) {
    if (!['stueberl', 'hocket', 'kontor', 'meet', 'pos'].includes(domain))
        throw new Error('APP_DATABASE_DOMAIN_DENIED');
    if (constructor && (!namespace?.DbNull || !namespace?.JsonNull))
        throw new Error('APP_DATABASE_JSON_NULLS_REQUIRED');
    for (const [key, entry] of [...clients])
        if (key.endsWith(':' + domain)) {
            clients.delete(key);
            await Promise.allSettled([entry.client.$disconnect(), entry.pool.end()]);
        }
    if (constructor)
        appClients.set(domain, { constructor, models: new Map(models.map(m => [m.name[0].toLowerCase() + m.name.slice(1), m])), jsonNulls: Object.freeze({ database: namespace.DbNull, json: namespace.JsonNull }) });
    else
        appClients.delete(domain);
    routedServerClients.delete(domain);
    for (const key of delegateProxies.keys())
        if (key.startsWith(domain + ':'))
            delegateProxies.delete(key);
}
const delegateProxies = new Map();
const routedServerClients = new Map();
let jsonEmergencyReplayRunning = false;
function localConnectionString() {
    if (!env.LOCAL_DATABASE_URL) {
        throw new Error("LOCAL_DATABASE_URL is not configured for the active database context.");
    }
    return env.LOCAL_DATABASE_URL;
}
export function normalizePrismaConnectionString(connectionString) {
    try {
        const parsed = new URL(connectionString);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol !== "postgres:" && protocol !== "postgresql:")
            return connectionString;
        const schema = parsed.searchParams.get("schema");
        if (schema) {
            const allowedSchemas = new Set(Object.values(dataDomainSchemas));
            if (!allowedSchemas.has(schema)) {
                throw new Error(`DATABASE_SCHEMA_INVALID:${schema}`);
            }
            // `schema` is a Prisma URL parameter. The pg driver used by the Prisma
            // adapter does not apply it to PostgreSQL sessions by itself. Passing a
            // startup option makes the selected schema effective before Prisma sends
            // its first query and prevents an unintended fallback to `public`.
            const existingOptions = parsed.searchParams.get("options")?.trim();
            const schemaOption = `-c search_path=${schema}`;
            parsed.searchParams.delete("schema");
            parsed.searchParams.set("options", existingOptions ? `${existingOptions} ${schemaOption}` : schemaOption);
        }
        // node-postgres does not fall back to a plain connection when a server
        // rejects TLS. In this application, "prefer" is the optional SSL mode;
        // "require" remains untouched for databases that must use TLS.
        if (parsed.searchParams.get("sslmode")?.toLowerCase() === "prefer") {
            parsed.searchParams.set("sslmode", "disable");
            parsed.searchParams.delete("uselibpqcompat");
        }
        return parsed.toString();
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith("DATABASE_SCHEMA_INVALID:")) {
            throw error;
        }
        // Keep non-URL connection strings unchanged and let node-postgres report
        // a useful configuration error when the connection is opened.
    }
    return connectionString;
}
export function prismaPgOptionsForDomain(domain) {
    return { schema: dataDomainSchemas[domain] };
}
function createPrismaClient(connectionString, domain) {
    const pool = new Pool({
        connectionString: normalizePrismaConnectionString(connectionString),
    });
    // `@prisma/adapter-pg` does not derive Prisma's logical schema reliably
    // from node-postgres pool options. The adapter requires its own explicit
    // schema option; without it Prisma falls back to `public` even when the
    // PostgreSQL role itself has the correct search_path.
    const adapter = new PrismaPg(pool, prismaPgOptionsForDomain(domain));
    const Constructor = appClients.get(domain)?.constructor || PrismaClient;
    const client = new Constructor({ adapter });
    return { connectionString, pool, client };
}
function clientEntry(key, connectionString, domain) {
    const existing = clients.get(key);
    if (existing?.connectionString === connectionString)
        return existing;
    if (existing) {
        clients.delete(key);
        void Promise.allSettled([existing.client.$disconnect(), existing.pool.end()]);
    }
    const created = createPrismaClient(connectionString, domain);
    clients.set(key, created);
    return created;
}
export function getDatabaseTargetPrismaClient(target, domain = "core") {
    const connectionString = getDataDomainConnectionString(domain, target, getDatabaseTargetConnectionString(target));
    return clientEntry(`server:${target}:${domain}`, connectionString, domain).client;
}
function getLocalPrismaClientEntry(domain = "core") {
    const connectionString = getDataDomainConnectionString(domain, "local", localConnectionString());
    return clientEntry(`local:${domain}`, connectionString, domain);
}
function targetDelegate(target, domain, modelProperty) {
    const client = getDatabaseTargetPrismaClient(target, domain);
    return Reflect.get(client, modelProperty, client);
}
async function runDelegateOperation(target, domain, modelProperty, operation, args) {
    const delegate = targetDelegate(target, domain, modelProperty);
    const method = Reflect.get(delegate, operation, delegate);
    if (typeof method !== "function") {
        throw new Error(`PRISMA_OPERATION_NOT_AVAILABLE:${modelProperty}.${operation}`);
    }
    return Reflect.apply(method, delegate, args);
}
function generatedStringId(domain, modelProperty) {
    const model = modelsFor(domain).get(modelProperty);
    const id = model?.fields.find((field) => field.isId);
    const generated = id?.default && typeof id.default === "object"
        ? String(id.default.name || "")
        : "";
    return id?.type === "String" && ["cuid", "uuid", "ulid"].includes(generated)
        ? id.name
        : null;
}
function mapObjectOrArray(value, mapper) {
    return Array.isArray(value) ? value.map(mapper) : mapper(value);
}
function prepareNestedRelationWrite(domain, modelProperty, value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    const nested = { ...value };
    if ("create" in nested) {
        nested.create = mapObjectOrArray(nested.create, (item) => prepareWriteData(domain, modelProperty, item, true));
    }
    if (nested.createMany && typeof nested.createMany === "object" && !Array.isArray(nested.createMany)) {
        const createMany = { ...nested.createMany };
        createMany.data = mapObjectOrArray(createMany.data, (item) => prepareWriteData(domain, modelProperty, item, true));
        nested.createMany = createMany;
    }
    if ("connectOrCreate" in nested) {
        nested.connectOrCreate = mapObjectOrArray(nested.connectOrCreate, (item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return item;
            const connectOrCreate = { ...item };
            connectOrCreate.create = prepareWriteData(domain, modelProperty, connectOrCreate.create, true);
            return connectOrCreate;
        });
    }
    if ("upsert" in nested) {
        nested.upsert = mapObjectOrArray(nested.upsert, (item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return item;
            const upsert = { ...item };
            upsert.create = prepareWriteData(domain, modelProperty, upsert.create, true);
            upsert.update = prepareWriteData(domain, modelProperty, upsert.update, false);
            return upsert;
        });
    }
    if ("update" in nested) {
        nested.update = mapObjectOrArray(nested.update, (item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return item;
            const update = { ...item };
            if ("data" in update) {
                update.data = prepareWriteData(domain, modelProperty, update.data, false);
                return update;
            }
            return prepareWriteData(domain, modelProperty, update, false);
        });
    }
    if ("updateMany" in nested) {
        nested.updateMany = mapObjectOrArray(nested.updateMany, (item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return item;
            const updateMany = { ...item };
            updateMany.data = prepareWriteData(domain, modelProperty, updateMany.data, false);
            return updateMany;
        });
    }
    return nested;
}
function prepareWriteData(domain, modelProperty, data, injectId) {
    if (!data || typeof data !== "object" || Array.isArray(data))
        return data;
    const model = modelsFor(domain).get(modelProperty);
    const row = { ...data };
    const idField = generatedStringId(domain, modelProperty);
    if (injectId && idField && !row[idField])
        row[idField] = randomUUID();
    for (const field of model?.fields || []) {
        if (field.kind !== "object" || !(field.name in row))
            continue;
        const relatedProperty = `${field.type[0].toLowerCase()}${field.type.slice(1)}`;
        row[field.name] = prepareNestedRelationWrite(domain, relatedProperty, row[field.name]);
    }
    return row;
}
function prepareMirroredWriteArgs(domain, modelProperty, operation, args) {
    if (!args.length || !args[0] || typeof args[0] !== "object")
        return args;
    const options = { ...args[0] };
    if (operation === "create") {
        options.data = prepareWriteData(domain, modelProperty, options.data, true);
    }
    else if (operation === "createMany" || operation === "createManyAndReturn") {
        options.data = Array.isArray(options.data)
            ? options.data.map((row) => prepareWriteData(domain, modelProperty, row, true))
            : prepareWriteData(domain, modelProperty, options.data, true);
    }
    else if (operation === "upsert") {
        options.create = prepareWriteData(domain, modelProperty, options.create, true);
        options.update = prepareWriteData(domain, modelProperty, options.update, false);
    }
    else if (operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn") {
        options.data = prepareWriteData(domain, modelProperty, options.data, false);
    }
    return [options, ...args.slice(1)];
}
function reportDatabaseRecovered() {
    void markJsonEmergencyDatabaseRecovered().catch((error) => {
        console.warn("[bonni-core] JSON-Notlaufstatus konnte nicht aktualisiert werden", {
            code: error?.code || "JSON_EMERGENCY_STATUS_UPDATE_FAILED",
        });
    });
}
function queuedWriteResult(operation, args) {
    const options = args[0] && typeof args[0] === "object"
        ? args[0]
        : {};
    const data = options.data;
    if (operation === "createMany") {
        return { count: Array.isArray(data) ? data.length : data ? 1 : 0 };
    }
    if (operation === "createManyAndReturn") {
        return Array.isArray(data) ? data : data ? [data] : [];
    }
    if (operation === "updateMany" || operation === "deleteMany")
        return { count: 0 };
    if (operation === "updateManyAndReturn")
        return [];
    if (operation === "delete")
        return options.where || {};
    if (operation === "upsert") {
        return {
            ...(options.where && typeof options.where === "object" ? options.where : {}),
            ...(options.create && typeof options.create === "object" ? options.create : {}),
        };
    }
    return {
        ...(options.where && typeof options.where === "object" ? options.where : {}),
        ...(data && typeof data === "object" ? data : {}),
    };
}
async function queueEmergencyWrite(domain, modelProperty, operation, args, databaseError) {
    // Security capabilities, credential proofs and transactions are never safe
    // to acknowledge now and replay later. Their CAS/revision context is valid
    // only in the live database transaction which produced the request.
    if (modelProperty.startsWith("securityTwoFactor")
        || modelProperty.startsWith("securityNfc")
        || modelProperty.startsWith("securityPresence")
        || modelProperty === "securityMemberPresence"
        || modelProperty.startsWith("securityAccountRecovery")
        || (modelProperty === "$client" && operation === "$transaction")) {
        throw databaseError;
    }
    const routing = getDatabaseRoutingStatus();
    if (!dataDomainAllowsJsonEmergency(domain)
        || !routing.jsonEmergency.enabled
        || !isDatabaseConnectionFailure(databaseError)) {
        throw databaseError;
    }
    const queued = await enqueueJsonEmergencyWrite({
        dataDomain: domain,
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
async function executeRead(domain, modelProperty, operation, args) {
    const targets = getDatabaseReadOrder();
    let lastError;
    for (const target of targets) {
        try {
            const result = await runDelegateOperation(target, domain, modelProperty, operation, args);
            recordDatabaseTargetSuccess(target);
            reportDatabaseRecovered();
            return result;
        }
        catch (error) {
            recordDatabaseTargetFailure(target, `${modelProperty}.${operation}`, error);
            lastError = error;
            if (!isDatabaseConnectionFailure(error))
                throw error;
        }
    }
    throw lastError;
}
async function executeWrite(domain, modelProperty, operation, originalArgs) {
    const targets = getDatabaseWriteOrder();
    const routing = getDatabaseRoutingStatus();
    const args = targets.length > 1 || routing.jsonEmergency.enabled
        ? prepareMirroredWriteArgs(domain, modelProperty, operation, originalArgs)
        : originalArgs;
    const primary = targets[0];
    try {
        const result = await runDelegateOperation(primary, domain, modelProperty, operation, args);
        recordDatabaseTargetSuccess(primary);
        reportDatabaseRecovered();
        if (targets.length > 1) {
            const mirror = targets[1];
            try {
                await runDelegateOperation(mirror, domain, modelProperty, operation, args);
                recordDatabaseTargetSuccess(mirror);
                reportDatabaseRecovered();
            }
            catch (error) {
                recordDatabaseTargetFailure(mirror, `${modelProperty}.${operation}`, error);
                console.warn("[bonni-core] Redundante Datenbankspiegelung fehlgeschlagen", {
                    target: mirror,
                    operation: `${modelProperty}.${operation}`,
                    code: error?.code || "DATABASE_MIRROR_WRITE_FAILED",
                });
            }
        }
        return result;
    }
    catch (error) {
        recordDatabaseTargetFailure(primary, `${modelProperty}.${operation}`, error);
        const fallback = targets[1];
        if (!fallback)
            return queueEmergencyWrite(domain, modelProperty, operation, args, error);
        if (!isDatabaseConnectionFailure(error))
            throw error;
        try {
            const result = await runDelegateOperation(fallback, domain, modelProperty, operation, args);
            recordDatabaseTargetSuccess(fallback);
            reportDatabaseRecovered();
            return result;
        }
        catch (fallbackError) {
            recordDatabaseTargetFailure(fallback, `${modelProperty}.${operation}`, fallbackError);
            return queueEmergencyWrite(domain, modelProperty, operation, args, fallbackError);
        }
    }
}
function delegateProxy(domain, modelProperty) {
    const cacheKey = `${domain}:${modelProperty}`;
    const cached = delegateProxies.get(cacheKey);
    if (cached)
        return cached;
    const proxy = new Proxy({}, {
        get(_target, operation) {
            if (typeof operation !== "string")
                return undefined;
            return (...args) => WRITE_OPERATIONS.has(operation)
                ? executeWrite(domain, modelProperty, operation, args)
                : executeRead(domain, modelProperty, operation, args);
        },
    });
    delegateProxies.set(cacheKey, proxy);
    return proxy;
}
async function executeClientRead(domain, property, args) {
    const targets = getDatabaseReadOrder();
    let lastError;
    for (const target of targets) {
        const client = getDatabaseTargetPrismaClient(target, domain);
        const method = Reflect.get(client, property, client);
        try {
            const result = await Reflect.apply(method, client, args);
            recordDatabaseTargetSuccess(target);
            return result;
        }
        catch (error) {
            recordDatabaseTargetFailure(target, property, error);
            lastError = error;
            if (!isDatabaseConnectionFailure(error))
                throw error;
        }
    }
    throw lastError;
}
async function executeClientWrite(domain, property, args) {
    const targets = getDatabaseWriteOrder();
    const primary = targets[0];
    const primaryClient = getDatabaseTargetPrismaClient(primary, domain);
    const primaryMethod = Reflect.get(primaryClient, property, primaryClient);
    let result;
    try {
        result = await Reflect.apply(primaryMethod, primaryClient, args);
        recordDatabaseTargetSuccess(primary);
        reportDatabaseRecovered();
    }
    catch (error) {
        recordDatabaseTargetFailure(primary, property, error);
        const fallback = targets[1];
        if (!fallback)
            return queueEmergencyWrite(domain, "$client", property, args, error);
        if (!isDatabaseConnectionFailure(error))
            throw error;
        const fallbackClient = getDatabaseTargetPrismaClient(fallback, domain);
        const fallbackMethod = Reflect.get(fallbackClient, property, fallbackClient);
        try {
            result = await Reflect.apply(fallbackMethod, fallbackClient, args);
            recordDatabaseTargetSuccess(fallback);
            reportDatabaseRecovered();
            return result;
        }
        catch (fallbackError) {
            recordDatabaseTargetFailure(fallback, property, fallbackError);
            return queueEmergencyWrite(domain, "$client", property, args, fallbackError);
        }
    }
    if (targets.length > 1) {
        const mirror = targets[1];
        const mirrorClient = getDatabaseTargetPrismaClient(mirror, domain);
        const mirrorMethod = Reflect.get(mirrorClient, property, mirrorClient);
        try {
            await Reflect.apply(mirrorMethod, mirrorClient, args);
            recordDatabaseTargetSuccess(mirror);
            reportDatabaseRecovered();
        }
        catch (error) {
            recordDatabaseTargetFailure(mirror, property, error);
        }
    }
    return result;
}
async function replayJsonEmergencyWritesUnlocked(target) {
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
        const domain = entry.dataDomain || "core";
        try {
            if (entry.modelProperty === "$client") {
                if (entry.operation !== "$executeRaw" && entry.operation !== "$executeRawUnsafe") {
                    throw new Error(`JSON_EMERGENCY_OPERATION_NOT_ALLOWED:${entry.operation}`);
                }
                const client = getDatabaseTargetPrismaClient(target, domain);
                const method = Reflect.get(client, entry.operation, client);
                if (typeof method !== "function") {
                    throw new Error(`PRISMA_OPERATION_NOT_AVAILABLE:${entry.operation}`);
                }
                await Reflect.apply(method, client, entry.args);
            }
            else {
                if (!WRITE_OPERATIONS.has(entry.operation) || !modelsFor(domain).has(entry.modelProperty)) {
                    throw new Error(`JSON_EMERGENCY_OPERATION_NOT_ALLOWED:${entry.modelProperty}.${entry.operation}`);
                }
                await runDelegateOperation(target, domain, entry.modelProperty, entry.operation, entry.args);
            }
            recordDatabaseTargetSuccess(target);
            if (!recoveryMarked) {
                await markJsonEmergencyDatabaseRecovered();
                recoveryMarked = true;
            }
            await acknowledgeJsonEmergencyWrite(entry.id, target);
            replayed += 1;
        }
        catch (error) {
            recordDatabaseTargetFailure(target, `jsonEmergency.${entry.modelProperty}.${entry.operation}`, error);
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
export async function replayJsonEmergencyWrites(target) {
    if (jsonEmergencyReplayRunning) {
        throw Object.assign(new Error("JSON_EMERGENCY_REPLAY_ALREADY_RUNNING"), {
            statusCode: 409,
            code: "JSON_EMERGENCY_REPLAY_ALREADY_RUNNING",
        });
    }
    jsonEmergencyReplayRunning = true;
    try {
        return await replayJsonEmergencyWritesUnlocked(target);
    }
    finally {
        jsonEmergencyReplayRunning = false;
    }
}
function routedServerClient(domain) {
    const existing = routedServerClients.get(domain);
    if (existing)
        return existing;
    const routed = new Proxy({}, {
        get(_target, property) {
            if (typeof property !== "string")
                return undefined;
            if (modelsFor(domain).has(property))
                return delegateProxy(domain, property);
            if (property === "$queryRaw" || property === "$queryRawUnsafe") {
                return (...args) => executeClientRead(domain, property, args);
            }
            if (property === "$executeRaw" || property === "$executeRawUnsafe") {
                return (...args) => executeClientWrite(domain, property, args);
            }
            const primary = getDatabaseReadOrder()[0];
            const client = getDatabaseTargetPrismaClient(primary, domain);
            const value = Reflect.get(client, property, client);
            return typeof value === "function" ? value.bind(client) : value;
        },
    });
    routedServerClients.set(domain, routed);
    return routed;
}
export function getPrismaClient(role = getActiveDatabaseRole(), domain = "core") {
    return role === "local" ? getLocalPrismaClientEntry(domain).client : routedServerClient(domain);
}
export function getDataDomainPrismaClient(domain) {
    return getPrismaClient(getActiveDatabaseRole(), domain);
}
export function getServerPrismaClient(domain = "core") {
    return routedServerClient(domain);
}
export function getLocalPrismaClient(domain = "core") {
    return getLocalPrismaClientEntry(domain).client;
}
export async function disconnectDatabaseTarget(target) {
    const prefix = `server:${target}:`;
    const entries = [...clients.entries()].filter(([key]) => key.startsWith(prefix));
    await Promise.all(entries.map(async ([key, entry]) => {
        clients.delete(key);
        await Promise.allSettled([entry.client.$disconnect(), entry.pool.end()]);
    }));
    routedServerClients.clear();
    delegateProxies.clear();
}
export async function disconnectPrismaClients() {
    await Promise.all([...clients.values()].map(async ({ client, pool }) => {
        await client.$disconnect();
        await pool.end();
    }));
    clients.clear();
    routedServerClients.clear();
    delegateProxies.clear();
}
export const prisma = new Proxy({}, {
    get(_target, property) {
        const client = getPrismaClient(getActiveDatabaseRole(), "core");
        const value = Reflect.get(client, property, client);
        return typeof value === "function" ? value.bind(client) : value;
    },
});
export { getDatabaseRoutingStatus };
