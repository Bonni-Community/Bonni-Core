import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MASTER_KEY ||= "test-master-key-at-least-16-characters";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/bonni_test";
process.env.SYSTEM_VERSION ||= "0.1.10";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-backup-test-"));
process.env.BONNI_BACKUP_ROOT = root;

const {
  getSystemBackupOverview,
  listSystemBackups,
  validateSystemBackup,
} = await import("../dist/system/routes/control-api/backup/backup.service.js");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("backup validation detects complete and changed files", async () => {
  const id = "backup-unit-test";
  const directory = path.join(root, id);
  const databaseFile = path.join(directory, "database", "database.dump");
  const content = Buffer.from("verified database dump");
  await fs.mkdir(path.dirname(databaseFile), { recursive: true });
  await fs.writeFile(databaseFile, content);
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    status: "completed",
    reason: "test",
    coreVersion: "0.1.10",
    createdAt: new Date().toISOString(),
    components: [],
    files: [{
      path: "database/database.dump",
      sizeBytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    }],
  }));

  const valid = await validateSystemBackup(id);
  assert.equal(valid.ok, true);
  assert.equal(valid.checkedFiles, 1);

  const unexpectedFile = path.join(directory, "storage", "unexpected.json");
  await fs.mkdir(path.dirname(unexpectedFile), { recursive: true });
  await fs.writeFile(unexpectedFile, "unexpected");
  const unexpected = await validateSystemBackup(id);
  assert.equal(unexpected.ok, false);
  assert.ok(unexpected.errors.some((error) => error.reason === "UNEXPECTED_FILE"));
  await fs.unlink(unexpectedFile);

  await fs.writeFile(databaseFile, "tampered database dump");
  const invalid = await validateSystemBackup(id);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length > 0);
});

test("backup overview ignores a damaged manifest instead of breaking update status polling", async () => {
  const damagedId = "backup-damaged-overview";
  const damagedDirectory = path.join(root, damagedId);
  await fs.mkdir(damagedDirectory, { recursive: true });
  await fs.writeFile(path.join(damagedDirectory, "manifest.json"), "{not-valid-json");

  const backups = await listSystemBackups();
  assert.equal(backups.some((backup) => backup.id === damagedId), false);

  const overview = await getSystemBackupOverview();
  assert.equal(overview.ok, true);
  assert.equal(overview.backups.some((backup) => backup.id === damagedId), false);
});
