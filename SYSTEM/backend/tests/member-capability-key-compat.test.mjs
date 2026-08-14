import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  migrateMemberCapabilityKey,
  resolveDatabaseSchema,
} from "../scripts/database/migrate-member-capability-key.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function databaseClient(column) {
  const calls = [];
  return {
    calls,
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (String(sql).includes('AS "hasUniqueKey"')) {
        return { rows: [{ hasUniqueKey: true }] };
      }
      if (String(sql).includes('AS "tableExists"')) {
        return { rows: [{ tableExists: false }] };
      }
      if (String(sql).includes("FROM pg_attribute AS column_definition")) {
        return { rows: column ? [column] : [] };
      }
      return { rows: [] };
    },
  };
}

test("database schema is read from DATABASE_URL", () => {
  assert.equal(
    resolveDatabaseSchema("postgresql://postgres:secret@localhost:5432/bonni?schema=vereinsdaten"),
    "vereinsdaten",
  );
  assert.equal(
    resolveDatabaseSchema("postgresql://postgres:secret@localhost:5432/bonni"),
    "public",
  );
});

test("missing MemberCapability table is left untouched", async () => {
  const client = databaseClient(null);
  assert.equal(await migrateMemberCapabilityKey(client, "public"), "table-missing");
  assert.equal(client.calls.some(({ sql }) => sql.includes("ALTER TABLE")), false);
});

test("text column is already compatible", async () => {
  const client = databaseClient({
    typeName: "text",
    typeKind: "b",
    typeSchema: "pg_catalog",
  });
  assert.equal(await migrateMemberCapabilityKey(client, "public"), "already-compatible");
  assert.equal(client.calls.some(({ sql }) => sql.includes("ALTER TABLE")), false);
  assert.equal(
    client.calls.some(({ sql }) => (
      sql.includes('DROP TYPE IF EXISTS "public"."MemberCapabilityKey" RESTRICT')
    )),
    true,
  );
});

test("legacy enum is converted to text inside the transaction", async () => {
  const client = databaseClient({
    typeName: "MemberCapabilityKey",
    typeKind: "e",
    typeSchema: "public",
  });

  assert.equal(await migrateMemberCapabilityKey(client, "public"), "migrated");
  assert.equal(
    client.calls.some(({ sql }) => (
      sql.includes('ALTER TABLE "public"."MemberCapability"')
      && sql.includes('ALTER COLUMN "key" TYPE TEXT USING "key"::text')
    )),
    true,
  );
  assert.equal(
    client.calls.some(({ sql }) => (
      sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS "MemberCapability_key_key"')
      && sql.includes('ON "public"."MemberCapability" ("key")')
    )),
    true,
  );
  assert.equal(
    client.calls.some(({ sql }) => (
      sql.includes('DROP TYPE "public"."MemberCapabilityKey" RESTRICT')
    )),
    true,
  );
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
});

test("an existing table without key column aborts and rolls back", async () => {
  const client = databaseClient(null);
  const originalQuery = client.query;
  client.query = async (sql, parameters) => {
    const result = await originalQuery(sql, parameters);
    if (String(sql).includes('AS "tableExists"')) {
      return { rows: [{ tableExists: true }] };
    }
    return result;
  };

  await assert.rejects(
    migrateMemberCapabilityKey(client, "public"),
    /MEMBER_CAPABILITY_COMPAT_KEY_COLUMN_MISSING/,
  );
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
});

test("unexpected column type aborts without destructive conversion", async () => {
  const client = databaseClient({
    typeName: "jsonb",
    typeKind: "b",
    typeSchema: "pg_catalog",
  });

  await assert.rejects(
    migrateMemberCapabilityKey(client, "public"),
    /MEMBER_CAPABILITY_COMPAT_UNEXPECTED_TYPE:pg_catalog\.jsonb/,
  );
  assert.equal(client.calls.some(({ sql }) => sql.includes("ALTER TABLE")), false);
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
});

test("fresh prisma push uses the isolated database bootstrap without a legacy compatibility mutation", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(backendRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["prisma:push"],
    "npm run database:bootstrap",
  );
  assert.doesNotMatch(packageJson.scripts.setup, /prisma:compatibility/);
});
