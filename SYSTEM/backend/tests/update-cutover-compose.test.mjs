import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../docker-compose.runtime.yml", import.meta.url);

function serviceBlock(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  const end = nextName ? source.indexOf(`  ${nextName}:\n`, start + 1) : source.indexOf("\nvolumes:\n", start + 1);
  assert.ok(start >= 0 && end > start, `Compose-Service ${name} fehlt oder ist nicht eindeutig begrenzt.`);
  return source.slice(start, end);
}

test("cutover helper mounts enforce immutable snapshot and separated restore receipt", async () => {
  const source = await fs.readFile(composePath, "utf8");
  const create = serviceBlock(source, "update-snapshot-create", "update-snapshot-restore");
  const restore = serviceBlock(source, "update-snapshot-restore", "runtime-proxy");
  const runner = serviceBlock(source, "update-runner", null);

  assert.match(create, /update_rollback_snapshots:\/var\/lib\/bonni-rollback-snapshots\n/);
  assert.match(create, /\/storage:\/source-storage:ro/);
  assert.match(create, /\/run_system}:\/source-run-system:ro/);
  assert.doesNotMatch(create, /docker\.sock|ports:|runtime_frontend|runtime_update/);

  assert.match(restore, /update_rollback_snapshots:\/var\/lib\/bonni-rollback-snapshots:ro/);
  assert.match(restore, /update_rollback_results:\/var\/lib\/bonni-rollback-results\n/);
  assert.match(restore, /\/storage:\/target-storage\n/);
  assert.match(restore, /\/run_system}:\/target-run-system\n/);
  assert.doesNotMatch(restore, /\/target-storage:ro|\/target-run-system:ro|docker\.sock|ports:|runtime_frontend|runtime_update/);

  for (const block of [create, restore]) {
    assert.match(block, /pull_policy: never/);
    assert.match(block, /restart: "no"/);
    assert.match(block, /read_only: true/);
    assert.match(block, /cap_drop:\n      - ALL/);
    assert.match(block, /no-new-privileges:true/);
    assert.match(block, /runtime_database/);
    assert.match(block, /update-cutover-snapshot\.mjs/);
  }

  assert.match(runner, /update_rollback_snapshots:\/var\/lib\/bonni-rollback-snapshots:ro/);
  assert.match(runner, /update_rollback_results:\/var\/lib\/bonni-rollback-results:ro/);
  assert.match(source, /update_rollback_snapshots:\n    labels:/);
  assert.match(source, /update_rollback_results:\n    labels:/);
});

test("production database health and manual proxy switch respect crash recovery fence", async () => {
  const [compose, switchScript, startScript, snapshotScript] = await Promise.all([
    fs.readFile(composePath, "utf8"),
    fs.readFile(new URL("../scripts/runtime/switch-proxy-to-active.sh", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/runtime/start-runtime.sh", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/backup/update-cutover-snapshot.mjs", import.meta.url), "utf8"),
  ]);
  const database = serviceBlock(compose, "db", "database-bootstrap");
  assert.match(database, /maintenance=postgres/);
  assert.match(database, /maintenance=template1/);
  assert.match(switchScript, /update-transaction-fence\.json/);
  assert.match(switchScript, /if \[ -e "\$transaction_fence" \]/);
  assert.match(startScript, /update-snapshot-create update-snapshot-restore/);
  const gateIndex = startScript.indexOf("update-runner --once --boot-gate");
  const transportCloseIndex = startScript.indexOf("update-runner --network-transport-gate=close");
  const transportOpenIndex = startScript.indexOf("update-runner --network-transport-gate=open");
  const bootstrapIndex = startScript.lastIndexOf("database-bootstrap");
  const proxyIndex = startScript.lastIndexOf('runtime-proxy"');
  assert.ok(gateIndex >= 0 && bootstrapIndex > gateIndex, "database-bootstrap muss nach dem Boot-Recovery-Gate laufen.");
  assert.ok(transportCloseIndex >= 0 && transportCloseIndex < gateIndex);
  assert.ok(transportOpenIndex > proxyIndex);
  assert.match(snapshotScript, /database === "postgres" \? "template1" : "postgres"/);
  assert.match(snapshotScript, /run\("dropdb", \[/);
  assert.match(snapshotScript, /"--if-exists", "--force"/);
  assert.match(snapshotScript, /run\("createdb", \[/);
  assert.match(snapshotScript, /"--exit-on-error", "--single-transaction"/);
});
