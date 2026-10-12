import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE_SCHEMA = "core";
const OPS_SCHEMA = "bonni_ops";
const MIGRATION_FILE_PATTERN = /^\d{8}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.sql$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPS_MIGRATION_LOCK = "73408345622060829";
const LEDGER_TABLE = `"${OPS_SCHEMA}"."_BonniOpsMigration"`;
const REDUNDANT_DATABASE_SETTING_KEY = "runtime.database.backupDatabaseUrl";

export const defaultOpsMigrationsDirectory = fileURLToPath(
  new URL("../../ops/migrations/", import.meta.url),
);

function stableError(code, detail = "") {
  return new Error(detail ? `${code}:${detail}` : code);
}

function logInfo(logger, message) {
  try {
    logger?.info?.(message);
  } catch {
    // Logging must never turn an already committed migration into a reported
    // failure. The migration ledger remains the authoritative result.
  }
}

function parsePostgresUrl(raw, label = "DATABASE_URL") {
  const value = String(raw || "").trim();
  if (!value) throw stableError("OPS_MIGRATION_DATABASE_URL_MISSING", label);

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw stableError("OPS_MIGRATION_DATABASE_URL_INVALID", label, error);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw stableError("OPS_MIGRATION_DATABASE_URL_NOT_POSTGRESQL", label);
  }
  if (parsed.hash) throw stableError("OPS_MIGRATION_DATABASE_URL_FRAGMENT_FORBIDDEN", label);

  let database;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  } catch (error) {
    throw stableError("OPS_MIGRATION_DATABASE_NAME_INVALID", label, error);
  }
  if (!database || database.includes("/") || database.includes("\0")) {
    throw stableError("OPS_MIGRATION_DATABASE_NAME_INVALID", label);
  }
  return { parsed, database };
}

function coreSchemaUrl(parsed) {
  const target = new URL(parsed.toString());
  target.searchParams.set("schema", CORE_SCHEMA);

  // Keep the installer migration connection aligned with the normal Bonni
  // Core runtime. node-postgres cannot fall back to a plain connection when
  // a PostgreSQL server rejects TLS, although `sslmode=prefer` explicitly
  // means that TLS is optional. Explicit TLS requirements such as `require`,
  // `verify-ca` and `verify-full` remain untouched.
  if (target.searchParams.get("sslmode")?.toLowerCase() === "prefer") {
    target.searchParams.set("sslmode", "disable");
    target.searchParams.delete("uselibpqcompat");
  }

  return target.toString();
}

function canonicalRedundantDatabaseName(primaryDatabase) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,43}$/u.test(primaryDatabase)) {
    throw stableError("OPS_MIGRATION_PRIMARY_DATABASE_NAME_NOT_CANONICAL", primaryDatabase);
  }
  return `${primaryDatabase}_redundant`;
}

function databaseIdentity(parsed, database) {
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  return `${host}:${port}/${database}`;
}

function comparablePostgresUrl(raw, label) {
  const { parsed } = parsePostgresUrl(raw, label);
  parsed.protocol = "postgresql:";
  if (!parsed.port) parsed.port = "5432";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.searchParams.sort();
  return parsed.toString();
}

export function parseRedundantMigrationFlag(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw stableError("OPS_MIGRATION_REDUNDANT_FLAG_INVALID", value);
}

export function planOpsMigrationTargets({
  databaseUrl,
  includeCanonicalRedundantIfExists = false,
  redundantDatabaseUrl,
}) {
  const primary = parsePostgresUrl(databaseUrl);
  const { parsed, database } = primary;
  const targets = [{
    role: "primary",
    database,
    connectionString: coreSchemaUrl(parsed),
  }];

  const explicitRedundantUrl = String(redundantDatabaseUrl || "").trim();
  if (explicitRedundantUrl) {
    const redundant = parsePostgresUrl(
      explicitRedundantUrl,
      "BONNI_OPS_REDUNDANT_DATABASE_URL",
    );
    if (databaseIdentity(primary.parsed, primary.database)
      === databaseIdentity(redundant.parsed, redundant.database)) {
      throw stableError("OPS_MIGRATION_REDUNDANT_TARGET_EQUALS_PRIMARY", redundant.database);
    }
    targets.push({
      role: "redundant",
      database: redundant.database,
      connectionString: coreSchemaUrl(redundant.parsed),
      required: true,
    });
  } else if (includeCanonicalRedundantIfExists) {
    const redundantDatabase = canonicalRedundantDatabaseName(database);
    const redundantUrl = new URL(parsed.toString());
    redundantUrl.pathname = `/${redundantDatabase}`;
    targets.push({
      role: "redundant",
      database: redundantDatabase,
      connectionString: coreSchemaUrl(redundantUrl),
      required: false,
    });
  }

  return targets;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function topLevelSqlStatements(source) {
  const statements = [];
  let current = "";
  let statementStart = null;
  let index = 0;
  let state = "normal";
  let blockCommentDepth = 0;
  let dollarDelimiter = "";
  let singleQuoteBackslashEscapes = false;

  const append = (value, sourceIndex = index) => {
    if (statementStart === null && /\S/u.test(value)) statementStart = sourceIndex;
    current += value;
  };

  const finishStatement = (end) => {
    const statement = current.trim();
    if (statement) statements.push({ text: statement, start: statementStart, end });
    current = "";
    statementStart = null;
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "normal";
        append(" ");
      }
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) {
          state = "normal";
          append(" ");
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") {
        index += 2;
      } else if (singleQuoteBackslashEscapes && character === "\\") {
        index += Math.min(2, source.length - index);
      } else if (character === "'") {
        state = "normal";
        append("?");
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "double-quote") {
      append(character);
      if (character === '"' && next === '"') {
        append(next);
        index += 2;
      } else {
        index += 1;
        if (character === '"') state = "normal";
      }
      continue;
    }
    if (state === "dollar-quote") {
      if (source.startsWith(dollarDelimiter, index)) {
        append("?");
        index += dollarDelimiter.length;
        state = "normal";
      } else {
        index += 1;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'") {
      if (statementStart === null) statementStart = index;
      const prefix = source.slice(0, index);
      singleQuoteBackslashEscapes = /(?:^|[^a-zA-Z0-9_$])(?:E|U&)$/iu.test(prefix);
      state = "single-quote";
      index += 1;
      continue;
    }
    if (character === '"') {
      state = "double-quote";
      append(character);
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = source.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/u)?.[0];
      if (delimiter) {
        if (statementStart === null) statementStart = index;
        state = "dollar-quote";
        dollarDelimiter = delimiter;
        index += delimiter.length;
        continue;
      }
    }
    if (character === ";") {
      finishStatement(index + 1);
      index += 1;
      continue;
    }

    append(character);
    index += 1;
  }

  if (state !== "normal" && state !== "line-comment") {
    throw stableError("OPS_MIGRATION_SQL_UNTERMINATED", state);
  }
  finishStatement(source.length);
  return statements;
}

export function assertRunnerOwnedTransaction(sql, migrationName = "migration.sql") {
  const statements = topLevelSqlStatements(String(sql));
  if (!statements.length) throw stableError("OPS_MIGRATION_SQL_EMPTY", migrationName);

  for (const statement of statements) {
    const normalized = statement.text.replace(/\s+/gu, " ").trim().toUpperCase();
    if (/^(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|SAVEPOINT\b|RELEASE\s+SAVEPOINT\b|PREPARE\s+TRANSACTION\b)/u.test(normalized)) {
      throw stableError("OPS_MIGRATION_TRANSACTION_CONTROL_FORBIDDEN", migrationName);
    }
  }
}

/**
 * A migration that predates this runner contains a legacy outer
 * BEGIN/COMMIT pair. Its raw bytes remain the ledger identity; only that
 * proven top-level wrapper is removed for execution so the runner can commit
 * the SQL and its ledger entry atomically.
 */
export function normalizeMigrationSql(source, migrationName = "migration.sql") {
  const raw = String(source);
  const statements = topLevelSqlStatements(raw);
  if (!statements.length) throw stableError("OPS_MIGRATION_SQL_EMPTY", migrationName);

  const first = statements[0];
  const last = statements.at(-1);
  const firstKeyword = first.text.replace(/\s+/gu, " ").trim().toUpperCase();
  const lastKeyword = last.text.replace(/\s+/gu, " ").trim().toUpperCase();
  const wrapped = firstKeyword === "BEGIN" && lastKeyword === "COMMIT";
  if ((firstKeyword === "BEGIN") !== (lastKeyword === "COMMIT")) {
    throw stableError("OPS_MIGRATION_TRANSACTION_WRAPPER_INVALID", migrationName);
  }

  let executable = raw;
  if (wrapped) {
    if (statements.length < 3
      || !/^BEGIN\s*;$/iu.test(raw.slice(first.start, first.end))
      || !/^COMMIT\s*;$/iu.test(raw.slice(last.start, last.end))) {
      throw stableError("OPS_MIGRATION_TRANSACTION_WRAPPER_INVALID", migrationName);
    }
    executable = `${raw.slice(0, first.start)}${raw.slice(first.end, last.start)}${raw.slice(last.end)}`;
  }

  assertRunnerOwnedTransaction(executable, migrationName);
  return executable;
}

export async function loadOpsMigrations(migrationsDirectory = defaultOpsMigrationsDirectory) {
  const root = path.resolve(migrationsDirectory);
  const rootState = await fs.lstat(root).catch((error) => {
    throw stableError("OPS_MIGRATION_DIRECTORY_UNAVAILABLE", error?.code || "UNKNOWN");
  });
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw stableError("OPS_MIGRATION_DIRECTORY_NOT_REGULAR");
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw stableError("OPS_MIGRATION_FILE_NOT_REGULAR", entry.name);
      }
      if (!MIGRATION_FILE_PATTERN.test(entry.name)) {
        throw stableError("OPS_MIGRATION_FILE_NAME_INVALID", entry.name);
      }
      return entry.name;
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const migrations = [];
  for (const name of names) {
    const file = path.join(root, name);
    const fileState = await fs.lstat(file);
    if (!fileState.isFile() || fileState.isSymbolicLink()) {
      throw stableError("OPS_MIGRATION_FILE_NOT_REGULAR", name);
    }
    const content = await fs.readFile(file);
    const sourceSql = content.toString("utf8");
    if (!Buffer.from(sourceSql, "utf8").equals(content)) {
      throw stableError("OPS_MIGRATION_FILE_NOT_UTF8", name);
    }
    const sql = normalizeMigrationSql(sourceSql, name);
    migrations.push(Object.freeze({ name, sha256: sha256(content), sql, sourceSql }));
  }
  return Object.freeze(migrations);
}

async function defaultClientFactory(connectionString) {
  const pgModule = await import("pg");
  const Client = pgModule.Client || pgModule.default?.Client;
  if (typeof Client !== "function") throw stableError("OPS_MIGRATION_PG_CLIENT_UNAVAILABLE");
  return new Client({ connectionString, connectionTimeoutMillis: 10_000 });
}

async function configureMigrationSession(client) {
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '120s'");
  await client.query("SET standard_conforming_strings = on");
}

async function connectClient(clientFactory, connectionString) {
  const client = await clientFactory(connectionString);
  if (!client || typeof client.connect !== "function" || typeof client.query !== "function"
      || typeof client.end !== "function") {
    throw stableError("OPS_MIGRATION_CLIENT_INVALID");
  }
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

export async function resolveStoredRedundantDatabaseUrl({
  primaryConnectionString,
  candidateRedundantDatabaseUrl,
  clientFactory = defaultClientFactory,
}) {
  const candidate = String(candidateRedundantDatabaseUrl || "").trim();
  if (!candidate) {
    throw stableError("OPS_MIGRATION_REDUNDANT_SETTING_CANDIDATE_MISSING");
  }

  // Validate the encrypted routing candidate before opening the primary DB.
  const comparableCandidate = comparablePostgresUrl(
    candidate,
    "BONNI_OPS_REDUNDANT_DATABASE_URL",
  );
  const client = await connectClient(clientFactory, primaryConnectionString);
  let transactionOpen = false;
  try {
    await configureMigrationSession(client);
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SET LOCAL search_path TO "core"');
    const schema = await client.query(
      "SELECT current_schema() = 'core'"
      + " AND current_schemas(false) = ARRAY['core']::name[] AS \"valid\"",
    );
    if (schema.rows[0]?.valid !== true) {
      throw stableError("OPS_MIGRATION_CORE_SCHEMA_MISSING");
    }
    const result = await client.query(
      'SELECT "value" FROM "core"."SystemSetting" WHERE "key" = $1 LIMIT 1',
      [REDUNDANT_DATABASE_SETTING_KEY],
    );
    await client.query("ROLLBACK");
    transactionOpen = false;

    const storedValue = result.rows[0]?.value;
    if (storedValue === undefined || storedValue === null || storedValue === "") return "";
    if (typeof storedValue !== "string" || !storedValue.trim()) {
      throw stableError("OPS_MIGRATION_REDUNDANT_SETTING_INVALID");
    }
    const comparableStored = comparablePostgresUrl(
      storedValue,
      "runtime.database.backupDatabaseUrl",
    );
    if (comparableStored !== comparableCandidate) {
      throw stableError("OPS_MIGRATION_REDUNDANT_SETTING_MISMATCH");
    }
    return candidate;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
    if ([
      "OPS_MIGRATION_REDUNDANT_SETTING_INVALID",
      "OPS_MIGRATION_REDUNDANT_SETTING_MISMATCH",
    ].includes(code)) throw error;
    throw stableError("OPS_MIGRATION_REDUNDANT_SETTING_LOOKUP_FAILED");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function beginCoreTransaction(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SET LOCAL search_path TO "core"');
    const schema = await client.query(
      "SELECT current_schema() = 'core'"
      + " AND current_schemas(false) = ARRAY['core']::name[] AS \"valid\"",
    );
    if (schema.rows[0]?.valid !== true) {
      throw stableError("OPS_MIGRATION_CORE_SCHEMA_MISSING");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function ensureLedger(client) {
  await beginCoreTransaction(client);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS "bonni_ops"');
    await client.query('REVOKE ALL ON SCHEMA "bonni_ops" FROM PUBLIC');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        "name" TEXT PRIMARY KEY,
        "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
        "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await client.query(`REVOKE ALL ON ${LEDGER_TABLE} FROM PUBLIC`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function validateLedgerRows(rows) {
  const applied = new Map();
  for (const row of rows) {
    const name = String(row?.name || "");
    const digest = String(row?.sha256 || "").trim();
    if (!MIGRATION_FILE_PATTERN.test(name) || !SHA256_PATTERN.test(digest) || applied.has(name)) {
      throw stableError("OPS_MIGRATION_LEDGER_INVALID", name || "UNKNOWN");
    }
    applied.set(name, digest);
  }
  return applied;
}

function validateMigrationSet(migrations) {
  if (!Array.isArray(migrations)) throw stableError("OPS_MIGRATION_SET_INVALID");
  let previousName = "";
  for (const migration of migrations) {
    const name = String(migration?.name || "");
    const digest = String(migration?.sha256 || "");
    const sql = typeof migration?.sql === "string" ? migration.sql : "";
    const sourceSql = typeof migration?.sourceSql === "string" ? migration.sourceSql : sql;
    if (!MIGRATION_FILE_PATTERN.test(name) || !SHA256_PATTERN.test(digest)) {
      throw stableError("OPS_MIGRATION_DESCRIPTOR_INVALID", name || "UNKNOWN");
    }
    if (previousName && name <= previousName) {
      throw stableError("OPS_MIGRATION_ORDER_INVALID", name);
    }
    if (sha256(Buffer.from(sourceSql, "utf8")) !== digest
      || normalizeMigrationSql(sourceSql, name) !== sql) {
      throw stableError("OPS_MIGRATION_CONTENT_HASH_MISMATCH", name);
    }
    previousName = name;
  }
}

function snapshotMigrationSet(migrations) {
  validateMigrationSet(migrations);
  return Object.freeze(migrations.map((migration) => {
    const sql = String(migration.sql);
    return Object.freeze({
      name: String(migration.name),
      sha256: String(migration.sha256),
      sql,
      sourceSql: typeof migration.sourceSql === "string" ? migration.sourceSql : sql,
    });
  }));
}

function validateLedgerAgainstMigrations(rows, migrations) {
  const applied = validateLedgerRows(rows);
  const packagedNames = new Set(migrations.map(({ name }) => name));

  for (const appliedName of applied.keys()) {
    if (!packagedNames.has(appliedName)) {
      throw stableError("OPS_MIGRATION_FILE_MISSING", appliedName);
    }
  }

  for (const migration of migrations) {
    const recordedHash = applied.get(migration.name);
    if (recordedHash && recordedHash !== migration.sha256) {
      throw stableError("OPS_MIGRATION_HASH_DRIFT", migration.name);
    }
  }

  let pendingMigrationSeen = false;
  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      pendingMigrationSeen = true;
    } else if (pendingMigrationSeen) {
      throw stableError("OPS_MIGRATION_LEDGER_NOT_PREFIX", migration.name);
    }
  }

  return applied;
}

async function readLedgerRowsIfPresent(client) {
  const relation = await client.query(
    `SELECT to_regclass('${OPS_SCHEMA}."_BonniOpsMigration"') IS NOT NULL AS "exists"`,
  );
  if (relation.rows[0]?.exists !== true) return [];
  const ledger = await client.query(
    `SELECT "name", "sha256" FROM ${LEDGER_TABLE} ORDER BY "name" ASC`,
  );
  return ledger.rows;
}

export async function preflightOpsMigrationsTarget({
  target,
  migrations,
  clientFactory = defaultClientFactory,
}) {
  const migrationSnapshot = snapshotMigrationSet(migrations);
  const client = await connectClient(clientFactory, target.connectionString);
  let transactionOpen = false;
  try {
    await configureMigrationSession(client);
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SET LOCAL search_path TO "core"');
    const schema = await client.query(
      "SELECT current_schema() = 'core'"
      + " AND current_schemas(false) = ARRAY['core']::name[] AS \"valid\"",
    );
    if (schema.rows[0]?.valid !== true) {
      throw stableError("OPS_MIGRATION_CORE_SCHEMA_MISSING");
    }

    const rows = await readLedgerRowsIfPresent(client);
    const applied = validateLedgerAgainstMigrations(rows, migrationSnapshot);
    await client.query("ROLLBACK");
    transactionOpen = false;
    return { applied: applied.size, pending: migrationSnapshot.length - applied.size };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function applyOpsMigrationsToTarget({
  target,
  migrations,
  clientFactory = defaultClientFactory,
  logger = console,
}) {
  const migrationSnapshot = snapshotMigrationSet(migrations);
  const client = await connectClient(clientFactory, target.connectionString);
  let lockAcquired = false;
  try {
    await configureMigrationSession(client);
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS "acquired"',
      [OPS_MIGRATION_LOCK],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw stableError("OPS_MIGRATION_LOCK_BUSY", target.database);
    }
    lockAcquired = true;
    await ensureLedger(client);

    const ledger = await client.query(
      `SELECT "name", "sha256" FROM ${LEDGER_TABLE} ORDER BY "name" ASC`,
    );
    const applied = validateLedgerAgainstMigrations(ledger.rows, migrationSnapshot);

    let appliedCount = 0;
    for (const migration of migrationSnapshot) {
      if (applied.has(migration.name)) {
        logInfo(logger, `[ops-migrate] ${target.database}: ${migration.name} bereits angewendet.`);
        continue;
      }

      await beginCoreTransaction(client);
      try {
        await client.query(migration.sql);
        const schema = await client.query(
          "SELECT current_schema() = 'core'"
          + " AND current_schemas(false) = ARRAY['core']::name[] AS \"valid\"",
        );
        if (schema.rows[0]?.valid !== true) {
          throw stableError("OPS_MIGRATION_SEARCH_PATH_CHANGED", migration.name);
        }
        await client.query(
          `INSERT INTO ${LEDGER_TABLE} ("name", "sha256") VALUES ($1, $2)`,
          [migration.name, migration.sha256],
        );
        await client.query("COMMIT");
        appliedCount += 1;
        applied.set(migration.name, migration.sha256);
        logInfo(logger, `[ops-migrate] ${target.database}: ${migration.name} angewendet.`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return { applied: appliedCount, skipped: migrationSnapshot.length - appliedCount };
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [OPS_MIGRATION_LOCK])
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

export async function databaseExists({
  connectionString,
  database,
  clientFactory = defaultClientFactory,
}) {
  const client = await connectClient(clientFactory, connectionString);
  try {
    await configureMigrationSession(client);
    const result = await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS \"exists\"",
      [database],
    );
    return result.rows[0]?.exists === true;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runOpsMigrations({
  databaseUrl,
  includeCanonicalRedundantIfExists = false,
  redundantDatabaseUrl,
  verifyRedundantDatabaseFromStoredSetting = false,
  migrationsDirectory = defaultOpsMigrationsDirectory,
  migrations: suppliedMigrations,
  clientFactory = defaultClientFactory,
  logger = console,
} = {}) {
  let effectiveRedundantDatabaseUrl = String(redundantDatabaseUrl || "").trim();
  let effectiveCanonicalRedundantCheck = includeCanonicalRedundantIfExists;
  if (verifyRedundantDatabaseFromStoredSetting) {
    const [primaryTarget] = planOpsMigrationTargets({ databaseUrl });
    effectiveRedundantDatabaseUrl = await resolveStoredRedundantDatabaseUrl({
      primaryConnectionString: primaryTarget.connectionString,
      candidateRedundantDatabaseUrl: effectiveRedundantDatabaseUrl,
      clientFactory,
    });
    if (!effectiveRedundantDatabaseUrl) {
      effectiveCanonicalRedundantCheck = true;
      logInfo(
        logger,
        "[ops-migrate] Nicht konfigurierte Redundanz-Vorschau wird nicht als Pflichtziel verwendet.",
      );
    }
  }
  const targets = planOpsMigrationTargets({
    databaseUrl,
    includeCanonicalRedundantIfExists: effectiveCanonicalRedundantCheck,
    redundantDatabaseUrl: effectiveRedundantDatabaseUrl,
  });
  const migrations = snapshotMigrationSet(
    suppliedMigrations || await loadOpsMigrations(migrationsDirectory),
  );
  const selectedTargets = [targets[0]];

  if (targets[1]?.required === true) {
    selectedTargets.push(targets[1]);
  } else if (targets[1] && await databaseExists({
    connectionString: targets[0].connectionString,
    database: targets[1].database,
    clientFactory,
  })) {
    selectedTargets.push(targets[1]);
  } else if (targets[1]) {
    logInfo(
      logger,
      `[ops-migrate] ${targets[1].database}: kanonische redundante Datenbank ist nicht vorhanden; übersprungen.`,
    );
  }

  // Alle ausgewaehlten Ledger werden zuerst in read-only Transaktionen
  // vollstaendig gegen das Paket geprueft. Damit kann ein kaputter
  // Redundanz-Ledger den Primary nicht erst nach dessen Mutation stoppen.
  for (const target of selectedTargets) {
    await preflightOpsMigrationsTarget({ target, migrations, clientFactory });
  }

  // Expand-only migrations run on the redundant target first. If its DDL,
  // lock or connection fails after preflight, the active primary remains
  // untouched. A later primary failure can leave only the redundant schema
  // ahead, which stays backwards-compatible by the Ops migration contract.
  const applyOrder = selectedTargets.length > 1
    ? [...selectedTargets.slice(1), selectedTargets[0]]
    : selectedTargets;
  const resultsByTarget = new Map();
  for (const target of applyOrder) {
    resultsByTarget.set(target, {
      role: target.role,
      database: target.database,
      ...await applyOpsMigrationsToTarget({ target, migrations, clientFactory, logger }),
    });
  }
  return selectedTargets.map((target) => resultsByTarget.get(target));
}

async function main() {
  const includeCanonicalRedundantIfExists = parseRedundantMigrationFlag(
    process.env.BONNI_OPS_MIGRATE_CANONICAL_REDUNDANT_IF_EXISTS,
  );
  const results = await runOpsMigrations({
    databaseUrl: process.env.DATABASE_URL,
    includeCanonicalRedundantIfExists,
    redundantDatabaseUrl: process.env.BONNI_OPS_REDUNDANT_DATABASE_URL,
    verifyRedundantDatabaseFromStoredSetting: parseRedundantMigrationFlag(
      process.env.BONNI_OPS_VERIFY_REDUNDANT_STORED_SETTING,
    ),
  });
  for (const result of results) {
    console.log(
      `[ops-migrate] ${result.database}: ${result.applied} angewendet, ${result.skipped} übersprungen.`,
    );
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error("[ops-migrate] Ops-Migration fehlgeschlagen.", error);
    process.exitCode = 1;
  });
}
