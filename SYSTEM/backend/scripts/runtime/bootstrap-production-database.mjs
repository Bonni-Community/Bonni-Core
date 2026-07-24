import { spawn } from "node:child_process";
import path from "node:path";

import pg from "pg";

const { Client } = pg;
const BOOTSTRAP_LOCK = 7_320_240_110;

function databaseUrl() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  if (!raw) throw new Error("DATABASE_URL fehlt für den Datenbank-Bootstrap.");
  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error("Datenbank-Bootstrap unterstützt ausschließlich PostgreSQL.");
  }
  return raw;
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

const url = databaseUrl();
const client = new Client({ connectionString: url });

try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK]);
  const result = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
  `);
  const tableCount = Number(result.rows[0]?.count || 0);

  if (tableCount > 0) {
    console.log(`[bonni-core] Datenbank-Bootstrap übersprungen: ${tableCount} bestehende Tabellen.`);
  } else {
    console.log("[bonni-core] Leere PostgreSQL-Datenbank erkannt; initiales Schema wird angelegt.");
    await runPrismaDbPushForEmptyDatabase({ ...process.env, DATABASE_URL: url });
    console.log("[bonni-core] Initiales Datenbankschema wurde angelegt.");
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK]).catch(() => undefined);
  await client.end().catch(() => undefined);
}
