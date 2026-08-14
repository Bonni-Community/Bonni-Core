import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

function values(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

test("runtime env preflight replaces placeholders atomically and is idempotent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, ".env");
  await fs.writeFile(environmentFile, [
    "MASTER_KEY=change-me-long-random-master-key",
    "JWT_SECRET=short",
    "POSTGRES_PASSWORD=postgres",
    "UNCHANGED=value",
    "",
  ].join("\n"), { mode: 0o644 });

  const first = await run(process.execPath, ["scripts/runtime/ensure-runtime-env.mjs", environmentFile, "--fresh"], {
    cwd: path.resolve("."),
  });
  const firstText = await fs.readFile(environmentFile, "utf8");
  const configured = values(firstText);
  assert.ok(configured.MASTER_KEY.length >= 32);
  assert.ok(configured.JWT_SECRET.length >= 32);
  assert.ok(configured.POSTGRES_PASSWORD.length >= 24);
  assert.ok(configured.SANDBOX_PASSWORD.length >= 16);
  assert.match(configured.COMPOSE_PROJECT_NAME, /^bonni-[a-f0-9]{12}$/);
  assert.equal(configured.BONNI_ACTIVE_IMAGE_TAG, `${configured.COMPOSE_PROJECT_NAME}-system:active`);
  assert.equal(configured.BONNI_EMERGENCY_IMAGE_TAG, `${configured.COMPOSE_PROJECT_NAME}-system:emergency`);
  assert.equal(configured.BONNI_ROLLBACK_IMAGE_TAG, `${configured.COMPOSE_PROJECT_NAME}-system:rollback`);
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(configured.BONNI_SERIAL, uuidV4);
  assert.match(configured.BONNI_ORGANIZATION_ID, uuidV4);
  assert.match(configured.BONNI_SITE_ID, uuidV4);
  assert.match(configured.BONNI_NODE_ID, uuidV4);
  assert.equal(configured.BONNI_TENANT_ID, configured.BONNI_ORGANIZATION_ID);
  assert.equal(new Set([
    configured.BONNI_SERIAL,
    configured.BONNI_ORGANIZATION_ID,
    configured.BONNI_SITE_ID,
    configured.BONNI_NODE_ID,
  ]).size, 4);
  assert.ok(configured.BONNI_GATEWAY_INTERNAL_SECRET.length >= 32);
  assert.equal(configured.UNCHANGED, "value");
  assert.ok(!first.stdout.includes(configured.MASTER_KEY));
  assert.ok(!first.stdout.includes(configured.BONNI_GATEWAY_INTERNAL_SECRET));
  assert.equal((await fs.stat(environmentFile)).mode & 0o777, 0o600);

  const firstDigest = crypto.createHash("sha256").update(firstText).digest("hex");
  await run(process.execPath, ["scripts/runtime/ensure-runtime-env.mjs", environmentFile, "--fresh"], {
    cwd: path.resolve("."),
  });
  const secondText = await fs.readFile(environmentFile, "utf8");
  assert.equal(crypto.createHash("sha256").update(secondText).digest("hex"), firstDigest);
});

test("existing runtime initializes only missing public identities and add-on secrets once", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, ".env");
  const existingSerial = crypto.randomUUID();
  const existingOrganization = crypto.randomUUID();
  await fs.writeFile(environmentFile, [
    `MASTER_KEY=${"m".repeat(48)}`,
    `JWT_SECRET=${"j".repeat(48)}`,
    `POSTGRES_PASSWORD=${"p".repeat(36)}`,
    `SANDBOX_PASSWORD=${"s".repeat(24)}`,
    "COMPOSE_PROJECT_NAME=existing-bonni",
    "BONNI_ACTIVE_IMAGE_TAG=existing-bonni-system:active",
    "BONNI_EMERGENCY_IMAGE_TAG=existing-bonni-system:emergency",
    "BONNI_ROLLBACK_IMAGE_TAG=existing-bonni-system:rollback",
    `BONNI_SERIAL=${existingSerial}`,
    `BONNI_ORGANIZATION_ID=${existingOrganization}`,
    "",
  ].join("\n"), { mode: 0o600 });

  const first = await run(process.execPath, [
    "scripts/runtime/ensure-runtime-env.mjs",
    environmentFile,
    "--existing",
  ], { cwd: path.resolve(".") });
  const firstText = await fs.readFile(environmentFile, "utf8");
  const configured = values(firstText);
  assert.equal(configured.BONNI_SERIAL, existingSerial);
  assert.equal(configured.BONNI_ORGANIZATION_ID, existingOrganization);
  assert.equal(configured.BONNI_TENANT_ID, existingOrganization);
  assert.match(configured.BONNI_SITE_ID, /^[0-9a-f-]{36}$/);
  assert.match(configured.BONNI_NODE_ID, /^[0-9a-f-]{36}$/);
  assert.ok(configured.BONNI_GATEWAY_INTERNAL_SECRET.length >= 32);
  assert.ok(!first.stdout.includes(configured.BONNI_GATEWAY_INTERNAL_SECRET));

  await run(process.execPath, [
    "scripts/runtime/ensure-runtime-env.mjs",
    environmentFile,
    "--existing",
  ], { cwd: path.resolve(".") });
  assert.equal(await fs.readFile(environmentFile, "utf8"), firstText);
});

for (const key of [
  "BONNI_SERIAL",
  "BONNI_ORGANIZATION_ID",
  "BONNI_SITE_ID",
  "BONNI_NODE_ID",
  "BONNI_TENANT_ID",
]) {
  test(`existing runtime rejects invalid ${key} without replacing it`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-env-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const environmentFile = path.join(directory, ".env");
    const original = [
      `MASTER_KEY=${"m".repeat(48)}`,
      `JWT_SECRET=${"j".repeat(48)}`,
      `POSTGRES_PASSWORD=${"p".repeat(36)}`,
      `SANDBOX_PASSWORD=${"s".repeat(24)}`,
      "COMPOSE_PROJECT_NAME=existing-bonni",
      `${key}=not-a-valid-uuid`,
      "",
    ].join("\n");
    await fs.writeFile(environmentFile, original, { mode: 0o600 });
    await assert.rejects(
      run(process.execPath, [
        "scripts/runtime/ensure-runtime-env.mjs",
        environmentFile,
        "--existing",
      ], { cwd: path.resolve(".") }),
      new RegExp(`${key} ist ungültig`),
    );
    assert.equal(await fs.readFile(environmentFile, "utf8"), original);
  });
}

test("existing runtime rejects an explicitly configured insecure gateway secret", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, ".env");
  const original = [
    `MASTER_KEY=${"m".repeat(48)}`,
    `JWT_SECRET=${"j".repeat(48)}`,
    `POSTGRES_PASSWORD=${"p".repeat(36)}`,
    `SANDBOX_PASSWORD=${"s".repeat(24)}`,
    "COMPOSE_PROJECT_NAME=existing-bonni",
    "BONNI_GATEWAY_INTERNAL_SECRET=change-me",
    "",
  ].join("\n");
  await fs.writeFile(environmentFile, original, { mode: 0o600 });
  await assert.rejects(
    run(process.execPath, [
      "scripts/runtime/ensure-runtime-env.mjs",
      environmentFile,
      "--existing",
    ], { cwd: path.resolve(".") }),
    /BONNI_GATEWAY_INTERNAL_SECRET/,
  );
  assert.equal(await fs.readFile(environmentFile, "utf8"), original);
});

test("runtime env preflight rejects ambiguous duplicate secrets", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, ".env");
  await fs.writeFile(environmentFile, "MASTER_KEY=one\nMASTER_KEY=two\n", { mode: 0o600 });
  await assert.rejects(
    run(process.execPath, ["scripts/runtime/ensure-runtime-env.mjs", environmentFile, "--fresh"], { cwd: path.resolve(".") }),
    /mehrfach/,
  );
});

test("existing runtime refuses automatic database and master-key rotation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-runtime-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, ".env");
  const original = "MASTER_KEY=change-me\nPOSTGRES_PASSWORD=postgres\n";
  await fs.writeFile(environmentFile, original, { mode: 0o600 });
  await assert.rejects(
    run(process.execPath, [
      "scripts/runtime/ensure-runtime-env.mjs",
      environmentFile,
      "--existing",
      "--project-name=backend",
    ], { cwd: path.resolve(".") }),
    /Automatische Schlüsselrotation wurde verweigert/,
  );
  assert.equal(await fs.readFile(environmentFile, "utf8"), original);
});
