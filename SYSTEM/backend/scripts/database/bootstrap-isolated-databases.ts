import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { env } from "../../src/core/config/env.js";
import { configureDatabaseRouting } from "../../src/core/database/database-routing.js";
import { configureDataDomainRouting } from "../../src/core/database/data-domain-routing.js";
import {
  dataDomainDatabase,
  dataDomainOwnerRoles,
  dataDomainRuntimeRoles,
  dataDomainSchemas,
  dataDomains,
  type DataDomain,
} from "../../src/core/database/data-domains.js";
import {
  buildDomainPrismaSchema,
  listActiveDataDomains,
} from "./domain-prisma-schema.mjs";

const { Client } = pg;
const BOOTSTRAP_LOCK = 8_410_241_102;
const projectRoot = process.cwd();

type DatabaseTarget = "normal" | "redundant";
type DatabaseSet = {
  main: Record<DatabaseTarget, string>;
  pos: Record<DatabaseTarget, string>;
};

function quoteIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/i.test(value)) {
    throw new Error(`DATABASE_IDENTIFIER_INVALID:${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseAdminUrl() {
  const parsed = new URL(env.DATABASE_URL);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_BOOTSTRAP_REQUIRES_POSTGRESQL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || !/^[a-zA-Z][a-zA-Z0-9_]{0,43}$/.test(database)) {
    throw new Error("DATABASE_BOOTSTRAP_DATABASE_NAME_INVALID");
  }
  return { parsed, database };
}

function withDatabase(source: URL, database: string, schema?: string) {
  const target = new URL(source.toString());
  target.pathname = `/${database}`;
  if (schema) target.searchParams.set("schema", schema);
  else target.searchParams.delete("schema");
  return target.toString();
}

function withCredentials(source: URL, database: string, schema: string, user: string, password: string) {
  const target = new URL(withDatabase(source, database, schema));
  target.username = user;
  target.password = password;
  return target.toString();
}

function databaseNames(primary: string): DatabaseSet {
  return {
    main: {
      normal: primary,
      redundant: `${primary}_redundant`,
    },
    pos: {
      normal: `${primary}_pos`,
      redundant: `${primary}_pos_redundant`,
    },
  };
}

async function roleExists(client: pg.Client, role: string) {
  const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  return result.rowCount === 1;
}

async function ensureOwnerRole(client: pg.Client, role: string) {
  if (!(await roleExists(client, role))) {
    await client.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  }
}

async function ensureRuntimeRole(client: pg.Client, role: string, password: string, rotate: boolean) {
  if (!(await roleExists(client, role))) {
    await client.query(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    return;
  }
  if (rotate) {
    await client.query(`ALTER ROLE ${quoteIdentifier(role)} PASSWORD ${quoteLiteral(password)}`);
  }
}

async function databaseExists(client: pg.Client, database: string) {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  return result.rowCount === 1;
}

async function ensureDatabase(client: pg.Client, database: string) {
  if (await databaseExists(client, database)) return;
  await client.query(`CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE template0 ENCODING 'UTF8'`);
}

async function connect(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function ensureDomainContainer(
  adminUrl: URL,
  database: string,
  domains: readonly DataDomain[],
) {
  const client = await connect(withDatabase(adminUrl, database));
  try {
    const adminRole = String((await client.query("SELECT current_user AS role")).rows[0]?.role || "");
    await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(adminRole)}`);

    for (const domain of domains) {
      const schema = dataDomainSchemas[domain];
      const owner = dataDomainOwnerRoles[domain];
      const runtimeRole = dataDomainRuntimeRoles[domain];
      await client.query(`GRANT ${quoteIdentifier(owner)} TO ${quoteIdentifier(adminRole)}`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)} AUTHORIZATION ${quoteIdentifier(owner)}`);
      await client.query(`ALTER SCHEMA ${quoteIdentifier(schema)} OWNER TO ${quoteIdentifier(owner)}`);
      await client.query(`REVOKE ALL ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(runtimeRole)}`);
      await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(runtimeRole)}`);
      await client.query(
        `ALTER ROLE ${quoteIdentifier(runtimeRole)} IN DATABASE ${quoteIdentifier(database)} SET search_path TO ${quoteIdentifier(schema)}`,
      );
    }

    // Re-running setup also removes accidental grants left by an older build.
    // A runtime role may use exactly one application schema in its database.
    for (const domain of domains) {
      const runtimeRole = dataDomainRuntimeRoles[domain];
      for (const foreignDomain of domains) {
        if (foreignDomain === domain) continue;
        const foreignSchema = dataDomainSchemas[foreignDomain];
        await client.query(
          `REVOKE ALL ON SCHEMA ${quoteIdentifier(foreignSchema)} FROM ${quoteIdentifier(runtimeRole)}`,
        );
        await client.query(
          `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdentifier(foreignSchema)} FROM ${quoteIdentifier(runtimeRole)}`,
        );
        await client.query(
          `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(foreignSchema)} FROM ${quoteIdentifier(runtimeRole)}`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

function runPrismaPush(schemaFile: string, databaseUrl: string) {
  const prismaCli = path.resolve(projectRoot, "node_modules", "prisma", "build", "index.js");
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [prismaCli, "db", "push", "--schema", schemaFile, "--skip-generate"],
      {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`DOMAIN_SCHEMA_PUSH_FAILED:${code}`));
    });
  });
}

async function takeOwnershipAndGrant(
  adminUrl: URL,
  database: string,
  domain: DataDomain,
) {
  const schema = dataDomainSchemas[domain];
  const owner = dataDomainOwnerRoles[domain];
  const runtimeRole = dataDomainRuntimeRoles[domain];
  const client = await connect(withDatabase(adminUrl, database));
  try {
    const relations = await client.query<{ kind: string; name: string }>(`
      SELECT c.relkind AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
    `, [schema]);
    for (const relation of relations.rows) {
      const type = relation.kind === "S"
        ? "SEQUENCE"
        : relation.kind === "v"
          ? "VIEW"
          : relation.kind === "m"
            ? "MATERIALIZED VIEW"
            : "TABLE";
      await client.query(
        `ALTER ${type} ${quoteIdentifier(schema)}.${quoteIdentifier(relation.name)} OWNER TO ${quoteIdentifier(owner)}`,
      );
    }

    const types = await client.query<{ name: string }>(`
      SELECT t.typname AS name
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype IN ('e', 'd')
    `, [schema]);
    for (const type of types.rows) {
      await client.query(
        `ALTER TYPE ${quoteIdentifier(schema)}.${quoteIdentifier(type.name)} OWNER TO ${quoteIdentifier(owner)}`,
      );
    }

    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(runtimeRole)}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(runtimeRole)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner)} IN SCHEMA ${quoteIdentifier(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdentifier(runtimeRole)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner)} IN SCHEMA ${quoteIdentifier(schema)} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quoteIdentifier(runtimeRole)}`);
  } finally {
    await client.end();
  }
}

async function deploySchemas(
  adminUrl: URL,
  databases: DatabaseSet,
  domains: readonly DataDomain[],
) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-isolated-prisma-"));
  try {
    for (const domain of domains) {
      const schemaFile = path.join(temporaryRoot, `${domain}.prisma`);
      await fs.writeFile(schemaFile, await buildDomainPrismaSchema(projectRoot, domain), "utf8");
      const databaseGroup = dataDomainDatabase(domain);
      for (const target of ["normal", "redundant"] as const) {
        const database = databases[databaseGroup][target];
        console.log(`[bonni-core] Schema ${domain} -> ${database}.${dataDomainSchemas[domain]}`);
        await runPrismaPush(
          schemaFile,
          withDatabase(adminUrl, database, dataDomainSchemas[domain]),
        );
        await takeOwnershipAndGrant(adminUrl, database, domain);
      }
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyDomainIsolation(
  adminUrl: URL,
  database: string,
  domains: readonly DataDomain[],
) {
  const client = await connect(withDatabase(adminUrl, database));
  try {
    for (const domain of domains) {
      const schema = dataDomainSchemas[domain];
      const runtimeRole = dataDomainRuntimeRoles[domain];
      const own = await client.query<{
        can_connect: boolean;
        can_use_schema: boolean;
        search_path_configured: boolean;
        tables_missing: number;
        sequences_missing: number;
      }>(`
        SELECT
          has_database_privilege($1, $2, 'CONNECT') AS can_connect,
          has_schema_privilege($1, $3, 'USAGE') AS can_use_schema,
          EXISTS (
            SELECT 1
            FROM pg_db_role_setting setting
            JOIN pg_roles role ON role.oid = setting.setrole
            JOIN pg_database db ON db.oid = setting.setdatabase
            WHERE role.rolname = $1
              AND db.datname = $2
              AND ('search_path=' || $3) = ANY(setting.setconfig)
          ) AS search_path_configured,
          (
            SELECT COUNT(*)::int
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = $3
              -- Schreibrechte werden nur fuer echte Tabellen geprueft.
              -- Views koennen absichtlich schreibgeschuetzt sein.
              AND relation.relkind IN ('r', 'p')
              AND NOT (
                has_table_privilege($1, relation.oid, 'SELECT')
                AND has_table_privilege($1, relation.oid, 'INSERT')
                AND has_table_privilege($1, relation.oid, 'UPDATE')
                AND has_table_privilege($1, relation.oid, 'DELETE')
              )
          ) AS tables_missing,
          (
            SELECT COUNT(*)::int
            FROM pg_class sequence
            JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
            WHERE namespace.nspname = $3
              AND sequence.relkind = 'S'
              AND NOT (
                has_sequence_privilege($1, sequence.oid, 'USAGE')
                AND has_sequence_privilege($1, sequence.oid, 'SELECT')
                AND has_sequence_privilege($1, sequence.oid, 'UPDATE')
              )
          ) AS sequences_missing
      `, [runtimeRole, database, schema]);
      const status = own.rows[0];
      if (
        !status?.can_connect
        || !status.can_use_schema
        || !status.search_path_configured
        || Number(status.tables_missing) > 0
        || Number(status.sequences_missing) > 0
      ) {
        throw new Error(`DATABASE_DOMAIN_GRANTS_INCOMPLETE:${database}:${domain}`);
      }

      for (const foreignDomain of domains) {
        if (foreignDomain === domain) continue;
        const foreignSchema = dataDomainSchemas[foreignDomain];
        const crossAccess = await client.query<{ allowed: boolean }>(
          "SELECT has_schema_privilege($1, $2, 'USAGE') AS allowed",
          [runtimeRole, foreignSchema],
        );
        if (crossAccess.rows[0]?.allowed) {
          throw new Error(
            `DATABASE_DOMAIN_CROSS_ACCESS_DETECTED:${database}:${domain}:${foreignDomain}`,
          );
        }
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const activeDomains = await listActiveDataDomains(projectRoot) as readonly DataDomain[];
  const skippedDomains = dataDomains.filter((domain) => !activeDomains.includes(domain));
  for (const domain of skippedDomains) {
    console.info(`[bonni-core] Datendomäne ${domain}: zugehöriges optionales Paket nicht installiert.`);
  }
  const { parsed: adminUrl, database: primaryDatabase } = parseAdminUrl();
  const databases = databaseNames(primaryDatabase);
  const routingFile = path.join(path.resolve(env.RUN_SYSTEM_ROOT), "system", "data-domain-routing.json");
  const routingExists = await fs.access(routingFile).then(() => true).catch(() => false);
  const passwords = Object.fromEntries(
    activeDomains.map((domain) => [domain, randomBytes(36).toString("base64url")]),
  ) as Partial<Record<DataDomain, string>>;
  const mainDomains = activeDomains.filter((domain) => dataDomainDatabase(domain) === "main");
  const posDomains = activeDomains.filter((domain) => dataDomainDatabase(domain) === "pos");

  const maintenanceUrl = withDatabase(adminUrl, primaryDatabase);
  const clusterClient = await connect(maintenanceUrl);
  try {
    await clusterClient.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK]);
    for (const domain of activeDomains) {
      await ensureOwnerRole(clusterClient, dataDomainOwnerRoles[domain]);
      await ensureRuntimeRole(
        clusterClient,
        dataDomainRuntimeRoles[domain],
        passwords[domain]!,
        !routingExists,
      );
    }
    await ensureDatabase(clusterClient, databases.main.redundant);
    if (posDomains.length) {
      await ensureDatabase(clusterClient, databases.pos.normal);
      await ensureDatabase(clusterClient, databases.pos.redundant);
    }
  } finally {
    await clusterClient.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK]).catch(() => undefined);
    await clusterClient.end();
  }

  await ensureDomainContainer(adminUrl, databases.main.normal, mainDomains);
  await ensureDomainContainer(adminUrl, databases.main.redundant, mainDomains);
  if (posDomains.length) {
    await ensureDomainContainer(adminUrl, databases.pos.normal, posDomains);
    await ensureDomainContainer(adminUrl, databases.pos.redundant, posDomains);
  }

  await deploySchemas(adminUrl, databases, activeDomains);
  await verifyDomainIsolation(adminUrl, databases.main.normal, mainDomains);
  await verifyDomainIsolation(adminUrl, databases.main.redundant, mainDomains);
  if (posDomains.length) {
    await verifyDomainIsolation(adminUrl, databases.pos.normal, posDomains);
    await verifyDomainIsolation(adminUrl, databases.pos.redundant, posDomains);
  }

  if (!routingExists) {
    const connections = Object.fromEntries(activeDomains.map((domain) => {
      const databaseGroup = dataDomainDatabase(domain);
      const schema = dataDomainSchemas[domain];
      const role = dataDomainRuntimeRoles[domain];
      return [domain, {
        normal: withCredentials(adminUrl, databases[databaseGroup].normal, schema, role, passwords[domain]!),
        redundant: withCredentials(adminUrl, databases[databaseGroup].redundant, schema, role, passwords[domain]!),
      }];
    })) as Partial<Record<DataDomain, Record<DatabaseTarget, string>>>;

    if (!connections.core) throw new Error("DATABASE_CORE_DOMAIN_CONNECTION_MISSING");

    await configureDatabaseRouting({
      mode: "both",
      jsonEmergencyEnabled: true,
      normalUrl: connections.core.normal,
      redundantUrl: connections.core.redundant,
    });
    await configureDataDomainRouting({
      mode: "isolated",
      connections,
    });
  }

  console.log("[bonni-core] Isolierte Datenbanken, Schemas, Rollen und Berechtigungen sind bereit.");
}

main().catch((error) => {
  console.error("[bonni-core] Isolierter Datenbank-Bootstrap fehlgeschlagen.", error);
  process.exitCode = 1;
});
