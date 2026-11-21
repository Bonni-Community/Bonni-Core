import { dataDomainForModule } from "../../../core/database/data-domains.js";
import { normalizeLegacyPrivacyIdeaManifest } from "../manifests/manifest.service.js";
const DELEGATE_NAME = /^[a-z][A-Za-z0-9]{0,99}$/;
function databaseDeclaration(manifest) {
    const normalizedManifest = normalizeLegacyPrivacyIdeaManifest(manifest);
    const database = normalizedManifest?.metadata?.database;
    if (!database || !["none", "scoped-v1"].includes(database.mode)) {
        throw new Error("MODULE_DATABASE_SCOPE_REQUIRED");
    }
    return database;
}
/**
 * Resolves the isolated data domain only for modules that explicitly request
 * database delegates. Plugins using Core ports can opt out without being
 * assigned an unrelated application database.
 */
export function moduleDatabaseDomain(moduleKey, manifest) {
    const database = databaseDeclaration(manifest);
    if (database.mode === "none")
        return null;
    return dataDomainForModule(moduleKey, database.domain);
}
const TRANSACTION_ISOLATION_LEVELS = new Set([
    "ReadUncommitted",
    "ReadCommitted",
    "RepeatableRead",
    "Serializable",
]);
const TRANSACTION_OPTION_KEYS = new Set(["maxWait", "timeout", "isolationLevel"]);
function validatedTransactionOptions(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("MODULE_DATABASE_TRANSACTION_OPTIONS_INVALID");
    }
    const options = value;
    if (Object.keys(options).some((key) => !TRANSACTION_OPTION_KEYS.has(key))) {
        throw new Error("MODULE_DATABASE_TRANSACTION_OPTIONS_INVALID");
    }
    if (options.maxWait !== undefined
        && (!Number.isInteger(options.maxWait) || Number(options.maxWait) < 1 || Number(options.maxWait) > 60_000)) {
        throw new Error("MODULE_DATABASE_TRANSACTION_MAX_WAIT_INVALID");
    }
    if (options.timeout !== undefined
        && (!Number.isInteger(options.timeout) || Number(options.timeout) < 1 || Number(options.timeout) > 300_000)) {
        throw new Error("MODULE_DATABASE_TRANSACTION_TIMEOUT_INVALID");
    }
    if (options.isolationLevel !== undefined
        && (typeof options.isolationLevel !== "string"
            || !TRANSACTION_ISOLATION_LEVELS.has(options.isolationLevel))) {
        throw new Error("MODULE_DATABASE_TRANSACTION_ISOLATION_INVALID");
    }
    return {
        ...(options.maxWait === undefined ? {} : { maxWait: Number(options.maxWait) }),
        ...(options.timeout === undefined ? {} : { timeout: Number(options.timeout) }),
        ...(options.isolationLevel === undefined
            ? {}
            : { isolationLevel: options.isolationLevel }),
    };
}
function configuredDelegates(manifest) {
    const database = databaseDeclaration(manifest);
    if (database.mode !== "scoped-v1") {
        throw new Error("MODULE_DATABASE_SCOPE_REQUIRED");
    }
    if (!Array.isArray(database.delegates)
        || !database.delegates.length
        || database.delegates.length > 256
        || database.delegates.some((entry) => typeof entry !== "string" || !DELEGATE_NAME.test(entry))) {
        throw new Error("MODULE_DATABASE_DELEGATES_INVALID");
    }
    return new Set(database.delegates);
}
function databaseUnavailableProxy(moduleKey) {
    return new Proxy(Object.create(null), {
        get(_target, property) {
            if (property === "then")
                return undefined;
            if (property === Symbol.toStringTag)
                return "BonniModuleDatabaseUnavailable";
            throw new Error(`MODULE_DATABASE_UNAVAILABLE:${moduleKey}:${String(property)}`);
        },
        has() {
            return false;
        },
        ownKeys() {
            return [];
        },
        getOwnPropertyDescriptor() {
            return undefined;
        },
        set() {
            return false;
        },
    });
}
function scopedPrismaProxy(moduleKey, prisma, allowedDelegates, guard) {
    const proxyTarget = Object.create(null);
    return new Proxy(proxyTarget, {
        get(_target, property) {
            if (property === "then")
                return undefined;
            if (property === Symbol.toStringTag)
                return "BonniModuleDatabase";
            if (property === "$transaction") {
                if (typeof prisma.$transaction !== "function") {
                    throw new Error("MODULE_DATABASE_TRANSACTION_UNAVAILABLE");
                }
                return async (callback, options) => {
                    if (typeof callback !== "function") {
                        throw new Error("MODULE_DATABASE_TRANSACTION_CALLBACK_REQUIRED");
                    }
                    const transactionOptions = validatedTransactionOptions(options);
                    const work = () => prisma.$transaction(async (transaction) => (callback(scopedPrismaProxy(moduleKey, transaction, allowedDelegates, guard))), transactionOptions);
                    return guard ? guard.transaction(work) : work();
                };
            }
            if (typeof property !== "string" || !allowedDelegates.has(property)) {
                throw new Error(`MODULE_DATABASE_DELEGATE_DENIED:${moduleKey}:${String(property)}`);
            }
            const delegate = prisma[property];
            if (!delegate || typeof delegate !== "object") {
                throw new Error(`MODULE_DATABASE_DELEGATE_UNAVAILABLE:${moduleKey}:${property}`);
            }
            if (!guard)
                return delegate;
            return new Proxy(delegate, {
                get(target, method) {
                    const value = Reflect.get(target, method, target);
                    if (typeof value !== "function")
                        return value;
                    const mutation = typeof method === "string" && /^(create|update|delete|upsert)/.test(method);
                    return (...args) => mutation
                        ? guard.write(target, String(method), args, () => Promise.resolve(Reflect.apply(value, target, args)))
                        : Reflect.apply(value, target, args);
                },
            });
        },
        has(_target, property) {
            return typeof property === "string" && allowedDelegates.has(property);
        },
        ownKeys() {
            return [...allowedDelegates];
        },
        getOwnPropertyDescriptor(_target, property) {
            if (typeof property === "string" && allowedDelegates.has(property)) {
                return { enumerable: true, configurable: true };
            }
            return undefined;
        },
        set() {
            return false;
        },
    });
}
/**
 * Every runtime module makes an explicit database choice: a scoped Prisma
 * capability list or none. No module ever receives an unrestricted client.
 */
export function createModuleDatabaseRuntime(moduleKey, prisma, manifest, jsonNulls, guard) {
    const declaration = databaseDeclaration(manifest);
    if (declaration.mode === "none") {
        return Object.freeze({
            mode: "none",
            moduleKey,
            allowedDelegates: Object.freeze([]),
            client: databaseUnavailableProxy(moduleKey),
        });
    }
    if (!prisma)
        throw new Error(`MODULE_DATABASE_CLIENT_REQUIRED:${moduleKey}`);
    const delegates = configuredDelegates(manifest);
    const client = scopedPrismaProxy(moduleKey, prisma, delegates, guard);
    return Object.freeze({
        mode: "scoped-v1",
        moduleKey,
        allowedDelegates: Object.freeze([...delegates]),
        client,
        get jsonNulls() { return jsonNulls?.(); },
    });
}
