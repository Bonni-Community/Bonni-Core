import type { ModuleManifestSummary } from "../types.js";
import { dataDomainForModule, type DataDomain } from "../../../core/database/data-domains.js";

const DELEGATE_NAME = /^[a-z][A-Za-z0-9]{0,99}$/;

type PrismaLike = Record<string, any> & {
  $transaction?: (...arguments_: any[]) => Promise<any>;
};

function databaseDeclaration(manifest: ModuleManifestSummary | null) {
  const database = (manifest?.metadata as any)?.database;
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
export function moduleDatabaseDomain(
  moduleKey: string,
  manifest: ModuleManifestSummary | null,
): DataDomain | null {
  const database = databaseDeclaration(manifest);
  if (database.mode === "none") return null;
  return dataDomainForModule(moduleKey, database.domain);
}

type ModuleTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable";
};

const TRANSACTION_ISOLATION_LEVELS = new Set([
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable",
]);
const TRANSACTION_OPTION_KEYS = new Set(["maxWait", "timeout", "isolationLevel"]);

function validatedTransactionOptions(value: unknown): ModuleTransactionOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MODULE_DATABASE_TRANSACTION_OPTIONS_INVALID");
  }
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some((key) => !TRANSACTION_OPTION_KEYS.has(key))) {
    throw new Error("MODULE_DATABASE_TRANSACTION_OPTIONS_INVALID");
  }
  if (
    options.maxWait !== undefined
    && (!Number.isInteger(options.maxWait) || Number(options.maxWait) < 1 || Number(options.maxWait) > 60_000)
  ) {
    throw new Error("MODULE_DATABASE_TRANSACTION_MAX_WAIT_INVALID");
  }
  if (
    options.timeout !== undefined
    && (!Number.isInteger(options.timeout) || Number(options.timeout) < 1 || Number(options.timeout) > 300_000)
  ) {
    throw new Error("MODULE_DATABASE_TRANSACTION_TIMEOUT_INVALID");
  }
  if (
    options.isolationLevel !== undefined
    && (
      typeof options.isolationLevel !== "string"
      || !TRANSACTION_ISOLATION_LEVELS.has(options.isolationLevel)
    )
  ) {
    throw new Error("MODULE_DATABASE_TRANSACTION_ISOLATION_INVALID");
  }
  return {
    ...(options.maxWait === undefined ? {} : { maxWait: Number(options.maxWait) }),
    ...(options.timeout === undefined ? {} : { timeout: Number(options.timeout) }),
    ...(options.isolationLevel === undefined
      ? {}
      : { isolationLevel: options.isolationLevel as ModuleTransactionOptions["isolationLevel"] }),
  };
}

function configuredDelegates(manifest: ModuleManifestSummary | null) {
  const database = databaseDeclaration(manifest);
  if (database.mode !== "scoped-v1") {
    throw new Error("MODULE_DATABASE_SCOPE_REQUIRED");
  }
  if (
    !Array.isArray(database.delegates)
    || !database.delegates.length
    || database.delegates.length > 256
    || database.delegates.some((entry: unknown) => typeof entry !== "string" || !DELEGATE_NAME.test(entry))
  ) {
    throw new Error("MODULE_DATABASE_DELEGATES_INVALID");
  }
  return new Set<string>(database.delegates);
}

function databaseUnavailableProxy(moduleKey: string): PrismaLike {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toStringTag) return "BonniModuleDatabaseUnavailable";
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
  }) as PrismaLike;
}

function scopedPrismaProxy(
  moduleKey: string,
  prisma: PrismaLike,
  allowedDelegates: ReadonlySet<string>,
): PrismaLike {
  const proxyTarget = Object.create(null);
  return new Proxy(proxyTarget, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toStringTag) return "BonniModuleDatabase";
      if (property === "$transaction") {
        if (typeof prisma.$transaction !== "function") {
          throw new Error("MODULE_DATABASE_TRANSACTION_UNAVAILABLE");
        }
        return async (callback: unknown, options?: unknown) => {
          if (typeof callback !== "function") {
            throw new Error("MODULE_DATABASE_TRANSACTION_CALLBACK_REQUIRED");
          }
          const transactionOptions = validatedTransactionOptions(options);
          return prisma.$transaction!(async (transaction: Record<string, any>) => (
            callback(scopedPrismaProxy(moduleKey, transaction, allowedDelegates))
          ), transactionOptions);
        };
      }
      if (typeof property !== "string" || !allowedDelegates.has(property)) {
        throw new Error(`MODULE_DATABASE_DELEGATE_DENIED:${moduleKey}:${String(property)}`);
      }
      const delegate = prisma[property];
      if (!delegate || typeof delegate !== "object") {
        throw new Error(`MODULE_DATABASE_DELEGATE_UNAVAILABLE:${moduleKey}:${property}`);
      }
      return delegate;
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
  }) as PrismaLike;
}

/**
 * Every runtime module makes an explicit database choice: a scoped Prisma
 * capability list or none. No module ever receives an unrestricted client.
 */
export function createModuleDatabaseRuntime(
  moduleKey: string,
  prisma: PrismaLike | null,
  manifest: ModuleManifestSummary | null,
) {
  const declaration = databaseDeclaration(manifest);
  if (declaration.mode === "none") {
    return Object.freeze({
      mode: "none" as const,
      moduleKey,
      allowedDelegates: Object.freeze([] as string[]),
      client: databaseUnavailableProxy(moduleKey),
    });
  }
  if (!prisma) throw new Error(`MODULE_DATABASE_CLIENT_REQUIRED:${moduleKey}`);
  const delegates = configuredDelegates(manifest);
  const client = scopedPrismaProxy(moduleKey, prisma, delegates);

  return Object.freeze({
    mode: "scoped-v1" as const,
    moduleKey,
    allowedDelegates: Object.freeze([...delegates]),
    client,
  });
}
