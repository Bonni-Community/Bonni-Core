import { spawn } from "node:child_process";
import path from "node:path";

import pg from "pg";

import { seedSystemDatabase } from "../../dist/system/database/seed-system.js";
import { resolveDatabaseBootstrapAction } from "./database-bootstrap-policy.mjs";

const { Client } = pg;
const BOOTSTRAP_LOCK = 7_320_240_110;
const CORE_SCHEMA = "core";

function databaseUrl() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  if (!raw) throw new Error("DATABASE_URL fehlt für den Datenbank-Bootstrap.");
  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error("Datenbank-Bootstrap unterstützt ausschließlich PostgreSQL.");
  }
  return raw;
}

function coreDatabaseUrl(raw) {
  const parsed = new URL(raw);
  parsed.searchParams.set("schema", CORE_SCHEMA);
  return parsed.toString();
}

function runPrismaDbPushForEmptyDatabase(env) {
  const prismaCli = path.resolve(process.cwd(), "node_modules", "prisma", "build", "index.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Prisma-Bootstrap wurde mit Status ${code} beendet.`));
    });
  });
}

async function readBootstrapAccountState(client) {
  const tableResult = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = '${CORE_SCHEMA}'
        AND table_name = 'Account'
        AND table_type = 'BASE TABLE'
    ) AS exists
  `);

  if (!tableResult.rows[0]?.exists) {
    return {
      accountTableExists: false,
      accountCount: 0,
      adminExists: false,
    };
  }

  const accountResult = await client.query(`
    SELECT
      COUNT(*)::int AS "accountCount",
      COUNT(*) FILTER (WHERE "loginName" = 'admin')::int AS "adminCount"
    FROM "${CORE_SCHEMA}"."Account"
  `);

  return {
    accountTableExists: true,
    accountCount: Number(accountResult.rows[0]?.accountCount || 0),
    adminExists: Number(accountResult.rows[0]?.adminCount || 0) > 0,
  };
}

const url = databaseUrl();
const client = new Client({ connectionString: url });

try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK]);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${CORE_SCHEMA}"`);
  await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  const result = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = '${CORE_SCHEMA}'
      AND table_type = 'BASE TABLE'
  `);
  const tableCount = Number(result.rows[0]?.count || 0);

  if (tableCount > 0) {
    console.log(`[bonni-core] Datenbank-Bootstrap übersprungen: ${tableCount} bestehende Tabellen.`);
  } else {
    console.log("[bonni-core] Leere PostgreSQL-Datenbank erkannt; initiales Schema wird angelegt.");
    await runPrismaDbPushForEmptyDatabase({
      ...process.env,
      DATABASE_URL: coreDatabaseUrl(url),
    });
    console.log("[bonni-core] Initiales Core-Datenbankschema wurde angelegt.");
  }

  const accountState = {
    ...await readBootstrapAccountState(client),
    repairRequested: Boolean(
      String(process.env.BONNI_BOOTSTRAP_ADMIN_PASSWORD || "").trim(),
    ),
  };
  const bootstrapAction = resolveDatabaseBootstrapAction(accountState);

  if (bootstrapAction === "skip") {
    console.log("[bonni-core] Datenbank-Seed übersprungen: Bootstrap-Administrator ist vorhanden.");
  } else {
    console.log("[bonni-core] Bootstrap-Administrator fehlt; technischer System-Seed wird ausgeführt.");
    await seedSystemDatabase();
    const seededState = await readBootstrapAccountState(client);
    if (!seededState.adminExists) {
      throw new Error(
        "Datenbank-Bootstrap abgebrochen: Der System-Seed hat keinen Bootstrap-Administrator angelegt.",
      );
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK]).catch(() => undefined);
  await client.end().catch(() => undefined);
}
