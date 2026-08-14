import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureCoreRuntimeSecrets,
  ensureJwtSecret,
  isSecureMasterKey,
  isSecureJwtSecret,
} from "../scripts/auth/ensure-jwt-secret.mjs";

async function temporaryEnvironmentFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-jwt-test-"));
  return {
    directory,
    environmentPath: path.join(directory, ".env"),
  };
}

function jwtDefinitions(content) {
  return content
    .split(/\r?\n/u)
    .filter((line) => /^\s*(?:export\s+)?JWT_SECRET\s*=/u.test(line));
}

function jwtValue(content) {
  const definition = jwtDefinitions(content)[0] || "";
  return definition
    .replace(/^\s*(?:export\s+)?JWT_SECRET\s*=\s*/u, "")
    .replace(/^["']|["']$/gu, "");
}

function masterValue(content) {
  const definition = content
    .split(/\r?\n/u)
    .find((line) => /^\s*(?:export\s+)?MASTER_KEY\s*=/u.test(line)) || "";
  return definition
    .replace(/^\s*(?:export\s+)?MASTER_KEY\s*=\s*/u, "")
    .replace(/^["']|["']$/gu, "");
}

test("a missing JWT secret is generated once and then preserved", async (t) => {
  const { directory, environmentPath } = await temporaryEnvironmentFile();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const messages = [];

  const first = await ensureJwtSecret({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log: (message) => messages.push(message) },
  });
  const firstContent = await fs.readFile(environmentPath, "utf8");
  const firstSecret = jwtValue(firstContent);

  assert.deepEqual(first, { changed: true, source: "generated" });
  assert.equal(jwtDefinitions(firstContent).length, 1);
  assert.equal(isSecureJwtSecret(firstSecret), true);
  assert.equal(messages.length, 1);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(environmentPath)).mode & 0o777, 0o600);
  }

  const second = await ensureJwtSecret({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log: (message) => messages.push(message) },
  });
  const secondContent = await fs.readFile(environmentPath, "utf8");

  assert.deepEqual(second, { changed: false, source: "file" });
  assert.equal(secondContent, firstContent);
  assert.equal(messages.length, 1);
});

test("the private module-data key is generated once with the Core runtime secrets", async (t) => {
  const { directory, environmentPath } = await temporaryEnvironmentFile();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await ensureCoreRuntimeSecrets({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log() {} },
  });
  const content = await fs.readFile(environmentPath, "utf8");
  const masterMatch = /^MASTER_KEY="([^"]+)"$/mu.exec(content);
  const match = /^MODULE_PRIVATE_DATA_SECRET="([^"]+)"$/mu.exec(content);
  assert.equal(first.master.changed, true);
  assert.equal(isSecureMasterKey(masterMatch?.[1]), true);
  assert.equal(first.privateData.changed, true);
  assert.ok(match?.[1]?.length >= 43);

  const second = await ensureCoreRuntimeSecrets({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log() {} },
  });
  assert.equal(second.privateData.changed, false);
  assert.equal(second.master.changed, false);
  assert.equal(await fs.readFile(environmentPath, "utf8"), content);
});

test("a weak local master key is repaired automatically and only once", async (t) => {
  const { directory, environmentPath } = await temporaryEnvironmentFile();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    environmentPath,
    "DATABASE_URL=postgresql://localhost/bonni\nMASTER_KEY=change-me\n",
    "utf8",
  );
  const messages = [];

  const first = await ensureCoreRuntimeSecrets({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log: (message) => messages.push(message) },
  });
  const repaired = await fs.readFile(environmentPath, "utf8");

  assert.deepEqual(first.master, { changed: true, source: "replaced" });
  assert.equal(isSecureMasterKey(masterValue(repaired)), true);
  assert.match(repaired, /DATABASE_URL=postgresql:\/\/localhost\/bonni/u);
  assert.doesNotMatch(repaired, /MASTER_KEY=change-me/u);
  assert.match(messages[0], /automatisch ersetzt/u);

  const second = await ensureCoreRuntimeSecrets({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log: (message) => messages.push(message) },
  });
  assert.deepEqual(second.master, { changed: false, source: "file" });
  assert.equal(await fs.readFile(environmentPath, "utf8"), repaired);
});

test("a placeholder JWT secret is replaced without changing other settings", async (t) => {
  const { directory, environmentPath } = await temporaryEnvironmentFile();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = [
    "MASTER_KEY=do-not-change-this-existing-master-key",
    "DATABASE_URL=postgresql://example.invalid/bonni",
    'JWT_SECRET="change-me"',
    "",
  ].join("\r\n");
  await fs.writeFile(environmentPath, original, "utf8");

  const result = await ensureJwtSecret({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log() {} },
  });
  const updated = await fs.readFile(environmentPath, "utf8");

  assert.deepEqual(result, { changed: true, source: "generated" });
  assert.match(updated, /MASTER_KEY=do-not-change-this-existing-master-key/u);
  assert.match(updated, /DATABASE_URL=postgresql:\/\/example\.invalid\/bonni/u);
  assert.equal(jwtDefinitions(updated).length, 1);
  assert.equal(isSecureJwtSecret(jwtValue(updated)), true);
  assert.doesNotMatch(updated, /JWT_SECRET="change-me"/u);
  assert.match(updated, /\r\n/u);
});

test("an existing secure file or process secret is never rotated", async (t) => {
  const { directory, environmentPath } = await temporaryEnvironmentFile();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secureSecret = "Bonni-JWT-2026-Strong-Existing-Secret-123456789";
  const original = `JWT_SECRET="${secureSecret}"\n`;
  await fs.writeFile(environmentPath, original, "utf8");

  const fromFile = await ensureJwtSecret({
    environmentPath,
    inheritedEnvironment: {},
    logger: { log() {} },
  });
  assert.deepEqual(fromFile, { changed: false, source: "file" });
  assert.equal(await fs.readFile(environmentPath, "utf8"), original);

  const externalPath = path.join(directory, "external.env");
  const fromEnvironment = await ensureJwtSecret({
    environmentPath: externalPath,
    inheritedEnvironment: { JWT_SECRET: secureSecret },
    logger: { log() {} },
  });
  assert.deepEqual(fromEnvironment, {
    changed: false,
    source: "environment",
  });
  await assert.rejects(fs.access(externalPath));
});

test("ambiguous or unsafe external configuration fails closed", async (t) => {
  const { directory, environmentPath } = await temporaryEnvironmentFile();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const duplicate = [
    "JWT_SECRET=first-placeholder",
    "JWT_SECRET=second-placeholder",
    "",
  ].join("\n");
  await fs.writeFile(environmentPath, duplicate, "utf8");

  await assert.rejects(
    ensureJwtSecret({
      environmentPath,
      inheritedEnvironment: {},
      logger: { log() {} },
    }),
    /JWT_SECRET_BOOTSTRAP_DUPLICATE/u,
  );
  assert.equal(await fs.readFile(environmentPath, "utf8"), duplicate);

  const externalPath = path.join(directory, "weak-external.env");
  await assert.rejects(
    ensureJwtSecret({
      environmentPath: externalPath,
      inheritedEnvironment: { JWT_SECRET: "change-me" },
      logger: { log() {} },
    }),
    /JWT_SECRET_BOOTSTRAP_EXTERNAL_SECRET_WEAK/u,
  );
  await assert.rejects(fs.access(externalPath));
});

test("the local entry points run the automatic JWT preflight", async () => {
  const backendRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const packageJson = JSON.parse(
    await fs.readFile(path.join(backendRoot, "package.json"), "utf8"),
  );
  const repairScript = await fs.readFile(
    path.join(
      backendRoot,
      "scripts",
      "auth",
      "repair-bootstrap-admin.mjs",
    ),
    "utf8",
  );
  const setupScript = await fs.readFile(
    path.join(backendRoot, "scripts", "setup", "setup-system.mjs"),
    "utf8",
  );
  const dockerfile = await fs.readFile(
    path.join(backendRoot, "Dockerfile"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["auth:ensure-jwt"],
    "node scripts/auth/ensure-jwt-secret.mjs",
  );
  for (const scriptName of [
    "dev",
    "start",
    "dev:run",
    "redundant:dev",
    "redundant:start",
  ]) {
    assert.match(
      packageJson.scripts[scriptName],
      /npm run auth:ensure-jwt/u,
      `${scriptName} must run the JWT preflight`,
    );
  }
  assert.match(packageJson.scripts.setup, /scripts\/setup\/setup-system\.mjs/u);
  assert.match(setupScript, /"run", "auth:ensure-jwt"/u);
  assert.match(repairScript, /await ensureJwtSecret\(\)/u);
  assert.match(
    dockerfile,
    /COPY System\/backend\/scripts\/auth \.\/scripts\/auth/u,
  );
});
