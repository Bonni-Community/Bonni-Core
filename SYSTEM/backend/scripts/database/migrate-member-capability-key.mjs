import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const { Client } = pg;
const COMPATIBILITY_LOCK = 7_320_240_111;
const TABLE_NAME = "MemberCapability";
const COLUMN_NAME = "key";
const LEGACY_TYPE_NAME = "MemberCapabilityKey";
const UNIQUE_INDEX_NAME = "MemberCapability_key_key";

function quoteIdentifier(value) {
  const identifier = String(value || "");
  if (!identifier || identifier.includes("\0") || Buffer.byteLength(identifier, "utf8") > 63) {
    throw new Error("MEMBER_CAPABILITY_COMPAT_IDENTIFIER_INVALID");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function resolveDatabaseSchema(databaseUrl) {
  const raw = String(databaseUrl || "").trim();
  if (!raw) throw new Error("DATABASE_URL fehlt für die Datenbank-Kompatibilitätsprüfung.");

  const parsed = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Die Datenbank-Kompatibilitätsprüfung unterstützt ausschließlich PostgreSQL.");
  }

  return parsed.searchParams.get("schema") || "public";
}

export async function migrateMemberCapabilityKey(client, schema) {
  const tableIdentifier = `${quoteIdentifier(schema)}.${quoteIdentifier(TABLE_NAME)}`;
  const legacyTypeIdentifier =
    `${quoteIdentifier(schema)}.${quoteIdentifier(LEGACY_TYPE_NAME)}`;

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [COMPATIBILITY_LOCK]);
    const result = await client.query(
      `
        SELECT
          column_type.typname AS "typeName",
          column_type.typtype AS "typeKind",
          type_schema.nspname AS "typeSchema"
        FROM pg_attribute AS column_definition
        INNER JOIN pg_class AS table_definition
          ON table_definition.oid = column_definition.attrelid
        INNER JOIN pg_namespace AS table_schema
          ON table_schema.oid = table_definition.relnamespace
        INNER JOIN pg_type AS column_type
          ON column_type.oid = column_definition.atttypid
        INNER JOIN pg_namespace AS type_schema
          ON type_schema.oid = column_type.typnamespace
        WHERE table_schema.nspname = $1
          AND table_definition.relname = $2
          AND table_definition.relkind IN ('r', 'p')
          AND column_definition.attname = $3
          AND column_definition.attnum > 0
          AND NOT column_definition.attisdropped
      `,
      [schema, TABLE_NAME, COLUMN_NAME],
    );

    const column = result.rows[0];
    if (!column) {
      const tableResult = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM pg_class AS table_definition
            INNER JOIN pg_namespace AS table_schema
              ON table_schema.oid = table_definition.relnamespace
            WHERE table_schema.nspname = $1
              AND table_definition.relname = $2
              AND table_definition.relkind IN ('r', 'p')
          ) AS "tableExists"
        `,
        [schema, TABLE_NAME],
      );
      if (tableResult.rows[0]?.tableExists) {
        throw new Error("MEMBER_CAPABILITY_COMPAT_KEY_COLUMN_MISSING");
      }
      await client.query("COMMIT");
      return "table-missing";
    }

    const alreadyCompatible = column.typeName === "text";
    const safelyConvertibleString = ["varchar", "bpchar"].includes(column.typeName);
    const legacyEnum = column.typeKind === "e" && column.typeName === LEGACY_TYPE_NAME;
    if (!alreadyCompatible && !safelyConvertibleString && !legacyEnum) {
      throw new Error(
        `MEMBER_CAPABILITY_COMPAT_UNEXPECTED_TYPE:${column.typeSchema}.${column.typeName}`,
      );
    }

    if (!alreadyCompatible) {
      await client.query(
        `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${quoteIdentifier(COLUMN_NAME)} DROP DEFAULT`,
      );
      await client.query(
        `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${quoteIdentifier(COLUMN_NAME)} TYPE TEXT USING ${quoteIdentifier(COLUMN_NAME)}::text`,
      );
    }

    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(UNIQUE_INDEX_NAME)} ON ${tableIdentifier} (${quoteIdentifier(COLUMN_NAME)})`,
    );
    const uniqueResult = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_index AS index_definition
          INNER JOIN pg_class AS table_definition
            ON table_definition.oid = index_definition.indrelid
          INNER JOIN pg_namespace AS table_schema
            ON table_schema.oid = table_definition.relnamespace
          INNER JOIN pg_attribute AS column_definition
            ON column_definition.attrelid = table_definition.oid
            AND column_definition.attname = $3
            AND NOT column_definition.attisdropped
          WHERE table_schema.nspname = $1
            AND table_definition.relname = $2
            AND index_definition.indisunique
            AND index_definition.indisvalid
            AND index_definition.indisready
            AND index_definition.indislive
            AND index_definition.indnkeyatts = 1
            AND index_definition.indnatts = 1
            AND index_definition.indkey[0] = column_definition.attnum
            AND index_definition.indexprs IS NULL
            AND index_definition.indpred IS NULL
        ) AS "hasUniqueKey"
      `,
      [schema, TABLE_NAME, COLUMN_NAME],
    );
    if (!uniqueResult.rows[0]?.hasUniqueKey) {
      throw new Error("MEMBER_CAPABILITY_COMPAT_UNIQUE_INVARIANT_MISSING");
    }

    if (legacyEnum) {
      const actualLegacyTypeIdentifier =
        `${quoteIdentifier(column.typeSchema)}.${quoteIdentifier(column.typeName)}`;
      await client.query(`DROP TYPE ${actualLegacyTypeIdentifier} RESTRICT`);
    } else {
      await client.query(`DROP TYPE IF EXISTS ${legacyTypeIdentifier} RESTRICT`);
    }

    await client.query("COMMIT");
    return alreadyCompatible ? "already-compatible" : "migrated";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const schema = resolveDatabaseSchema(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    const status = await migrateMemberCapabilityKey(client, schema);
    if (status === "migrated") {
      console.log(
        "[prisma-compatibility] MemberCapability.key wurde ohne Datenverlust von Enum auf Text umgestellt.",
      );
    } else if (status === "already-compatible") {
      console.log("[prisma-compatibility] MemberCapability.key ist bereits kompatibel.");
    } else {
      console.log("[prisma-compatibility] MemberCapability-Tabelle ist noch nicht vorhanden.");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
