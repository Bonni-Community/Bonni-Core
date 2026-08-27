import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MASTER_KEY ||= "test-master-key-at-least-16-characters";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/bonni_test";
process.env.SYSTEM_VERSION ||= "0.1.19";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-pg-tool-test-"));
const backups = path.join(workspace, "backups");
const storage = path.join(workspace, "storage");
process.env.BONNI_BACKUP_ROOT = backups;
process.env.BONNI_STORAGE_ROOT = storage;

const { resolvePostgreSqlTool } = await import(
  "../dist/system/routes/control-api/backup/postgres-tool.service.js"
);
const { createSystemBackup, validateSystemBackup } = await import(
  "../dist/system/routes/control-api/backup/backup.service.js"
);

async function executable(file, body = "#!/bin/sh\nexit 0\n") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return file;
}

test.after(async () => {
  delete process.env.PG_DUMP_PATH;
  await fs.rm(workspace, { recursive: true, force: true });
});

test("an explicit pg_dump file or bin directory is resolved", async () => {
  const bin = path.join(workspace, "configured-bin");
  const command = await executable(path.join(bin, "pg_dump"));

  const direct = resolvePostgreSqlTool("pg_dump", {
    env: { PG_DUMP_PATH: command, PATH: "" },
    platform: process.platform,
  });
  assert.deepEqual(direct, { ok: true, command, source: "configured-file" });

  const directory = resolvePostgreSqlTool("pg_dump", {
    env: { PG_DUMP_PATH: bin, PATH: "" },
    platform: process.platform,
  });
  assert.deepEqual(directory, { ok: true, command, source: "configured-directory" });
});

test("an invalid explicit pg_dump path fails closed", () => {
  const missing = path.join(workspace, "missing", "pg_dump");
  const result = resolvePostgreSqlTool("pg_dump", {
    env: { PG_DUMP_PATH: missing, PATH: process.env.PATH },
    platform: process.platform,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "POSTGRESQL_TOOL_CONFIG_INVALID");
  assert.match(result.message, /PG_DUMP_PATH/);
});

test("pg_dump is discovered from PATH without relying on shell lookup", async () => {
  const bin = path.join(workspace, "path-bin");
  const command = await executable(path.join(bin, "pg_dump"));
  const result = resolvePostgreSqlTool("pg_dump", {
    env: { PATH: bin },
    platform: process.platform,
  });
  assert.deepEqual(result, { ok: true, command, source: "path" });
});

test("missing PostgreSQL client tools produce the stable installation error", () => {
  const result = resolvePostgreSqlTool("pg_dump", {
    env: { PATH: "" },
    platform: "linux",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED");
  assert.match(result.message, /PostgreSQL-Clienttools/);
});

test("a missing pg_dump returns a durable actionable backup error", async () => {
  process.env.PG_DUMP_PATH = path.join(workspace, "not-installed", "pg_dump");
  const result = await createSystemBackup({ reason: "missing-tool-test" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "BACKUP_FAILED");
  assert.equal(result.causeCode, "POSTGRESQL_TOOL_CONFIG_INVALID");
  assert.match(result.message, /PG_DUMP_PATH/);
  assert.equal(result.backup.status, "failed");
  assert.equal(result.backup.errorCode, "POSTGRESQL_TOOL_CONFIG_INVALID");
});

test("a discovered pg_dump creates an atomic verifiable database backup", async (t) => {
  if (process.platform === "win32") {
    t.skip("The fake executable uses a POSIX test script.");
    return;
  }
  const command = await executable(path.join(workspace, "working-bin", "pg_dump"), [
    "#!/bin/sh",
    "target=''",
    "previous=''",
    "for argument in \"$@\"; do",
    "  if [ \"$previous\" = '--file' ]; then target=\"$argument\"; fi",
    "  previous=\"$argument\"",
    "done",
    "test -n \"$target\" || exit 9",
    "printf 'PGDMP-test-backup' > \"$target\"",
    "exit 0",
    "",
  ].join("\n"));
  process.env.PG_DUMP_PATH = command;

  const created = await createSystemBackup({ reason: "working-tool-test" });
  assert.equal(created.ok, true);
  assert.equal(created.backup.status, "completed");
  const validation = await validateSystemBackup(created.backup.id);
  assert.equal(validation.ok, true);
  assert.ok(created.backup.files.some((entry) => entry.path === "database/database.dump"));

  const databaseDirectory = path.join(backups, created.backup.id, "database");
  assert.deepEqual((await fs.readdir(databaseDirectory)).sort(), ["database.dump"]);
});
