import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertSetupReadiness,
  createSetupStages,
  runSetupStages,
  writeSetupProgressBestEffort,
} from "../scripts/setup/setup-system.mjs";

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t, environmentSource = null, mode = 0o600) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-setup-readiness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backendDirectory = path.join(root, "SYSTEM", "backend");
  const distMarker = path.join(backendDirectory, "dist", "runtime-marker.js");
  await fs.mkdir(path.dirname(distMarker), { recursive: true });
  await fs.writeFile(distMarker, "existing runtime\n");
  if (environmentSource !== null) {
    const environmentPath = path.join(backendDirectory, ".env");
    await fs.writeFile(environmentPath, environmentSource, { mode });
    await fs.chmod(environmentPath, mode);
  }
  return { root, backendDirectory, distMarker };
}

test("setup readiness accepts a protected dotenv file with a PostgreSQL DATABASE_URL", async (t) => {
  const current = await fixture(t, [
    "# Lokale Bonni-Konfiguration",
    'DATABASE_URL="postgresql://bonni:secret@127.0.0.1:5432/bonni_core"',
    "MASTER_KEY='local-test-key'",
    "",
  ].join("\n"));

  const result = await assertSetupReadiness({
    backendDirectory: current.backendDirectory,
    inheritedEnvironment: {},
  });
  assert.equal(result.environmentPath, path.join(current.backendDirectory, ".env"));
  assert.equal(await fs.readFile(current.distMarker, "utf8"), "existing runtime\n");
});

test("missing or invalid setup configuration fails in German and preserves dist", async (t) => {
  const scenarios = [
    {
      label: "missing env",
      source: null,
      expected: /SETUP_READINESS_ENV_MISSING:[^\n]*System\/backend\/\.env fehlt[^\n]*nicht verändert oder gelöscht/u,
    },
    {
      label: "missing database url",
      source: "MASTER_KEY=local-test-key\n",
      expected: /SETUP_READINESS_DATABASE_URL_MISSING:[^\n]*Pflichtkonfiguration DATABASE_URL fehlt[^\n]*nicht verändert oder gelöscht/u,
    },
    {
      label: "invalid dotenv",
      source: 'DATABASE_URL="postgresql://bonni@127.0.0.1:5432/bonni_core\n',
      expected: /SETUP_READINESS_ENV_PARSE_INVALID:[^\n]*nicht geschlossenen Wert[^\n]*nicht verändert oder gelöscht/u,
    },
    {
      label: "invalid database url",
      source: "DATABASE_URL=not-a-database-url\n",
      expected: /SETUP_READINESS_DATABASE_URL_INVALID:[^\n]*keine gültige Verbindungsadresse[^\n]*nicht verändert oder gelöscht/u,
    },
    {
      label: "database placeholder",
      source: 'DATABASE_URL="postgresql://postgres:<POSTGRES-PASSWORT>@127.0.0.1:5432/bonni_core"\n',
      expected: /SETUP_READINESS_DATABASE_URL_INVALID:[^\n]*ohne Platzhalter[^\n]*nicht verändert oder gelöscht/u,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, async (subtest) => {
      const current = await fixture(subtest, scenario.source);
      await assert.rejects(
        assertSetupReadiness({
          backendDirectory: current.backendDirectory,
          inheritedEnvironment: {},
        }),
        scenario.expected,
      );
      assert.equal(await fs.readFile(current.distMarker, "utf8"), "existing runtime\n");
    });
  }
});

test("a broadly readable dotenv file is rejected before dist cleanup", {
  skip: process.platform === "win32",
}, async (t) => {
  const current = await fixture(
    t,
    "DATABASE_URL=postgresql://bonni@127.0.0.1:5432/bonni_core\n",
    0o644,
  );
  await assert.rejects(
    assertSetupReadiness({ backendDirectory: current.backendDirectory, inheritedEnvironment: {} }),
    /SETUP_READINESS_ENV_PERMISSIONS_UNSAFE:[^\n]*Dateirechte 600/u,
  );
  assert.equal(await fs.readFile(current.distMarker, "utf8"), "existing runtime\n");
});

test("an unreachable database stops setup before dist and public cleanup", async (t) => {
  const current = await fixture(
    t,
    "DATABASE_URL=postgresql://bonni@127.0.0.1:5432/bonni_core\n",
  );
  const publicMarker = path.join(current.backendDirectory, "public", "system", "index.html");
  await fs.mkdir(path.dirname(publicMarker), { recursive: true });
  await fs.writeFile(publicMarker, "existing public runtime\n");
  const executed = [];
  const stages = createSetupStages("source");

  await assert.rejects(
    runSetupStages(stages, async (label, _cwd, args) => {
      executed.push({ label, args });
      if (args.includes("database:bootstrap")) {
        throw new Error("TEST_DATABASE_UNREACHABLE");
      }
      if (args.includes("maintenance:cleanup")) {
        await fs.rm(path.dirname(current.distMarker), { recursive: true, force: true });
        await fs.rm(path.dirname(publicMarker), { recursive: true, force: true });
      }
    }),
    /TEST_DATABASE_UNREACHABLE/u,
  );

  assert.equal(executed.some(({ args }) => args.includes("database:bootstrap")), true);
  assert.equal(executed.some(({ args }) => args.includes("maintenance:cleanup")), false);
  assert.equal(await fs.readFile(current.distMarker, "utf8"), "existing runtime\n");
  assert.equal(await fs.readFile(publicMarker, "utf8"), "existing public runtime\n");
});

test("setup reports every visible stage in order and marks the failed stage", async () => {
  const stages = [
    ["Systemschlüssel sicherstellen", "/tmp/backend", ["run", "auth:ensure-jwt"]],
    ["Backend erzeugen und prüfen", "/tmp/backend", ["run", "build:code"]],
  ];
  const progress = [];

  await assert.rejects(
    runSetupStages(
      stages,
      async (label) => {
        if (label === "Backend erzeugen und prüfen") throw new Error("TEST_BUILD_FAILED");
      },
      async (event) => progress.push(event),
    ),
    /TEST_BUILD_FAILED/u,
  );

  assert.deepEqual(progress, [
    {
      status: "running",
      stage: "setup-1",
      stageIndex: 1,
      stageCount: 2,
      message: "Systemschlüssel werden geprüft",
    },
    {
      status: "running",
      stage: "setup-2",
      stageIndex: 2,
      stageCount: 2,
      message: "Bonni-Core-Backend wird erzeugt und geprüft",
    },
    {
      status: "failed",
      stage: "setup-2",
      stageIndex: 2,
      stageCount: 2,
      message: "Bonni-Core-Backend wird erzeugt und geprüft – sicher abgebrochen",
    },
  ]);
});

test("setup progress retries transient Windows filesystem locks", async () => {
  let renameAttempts = 0;
  const waits = [];
  const warnings = [];
  const fileSystem = {
    async mkdir() {},
    async writeFile() {},
    async rename() {
      renameAttempts += 1;
      if (renameAttempts > 2) return;
      const error = new Error("temporarily locked");
      error.code = renameAttempts === 1 ? "EPERM" : "EBUSY";
      throw error;
    },
    async rm() {},
  };

  const written = await writeSetupProgressBestEffort({
    progressPath: path.join(os.tmpdir(), "bonni-progress-test.json"),
    progress: { status: "running" },
    fileSystem,
    retryDelays: [1, 2],
    wait: async (milliseconds) => waits.push(milliseconds),
    warn: (message) => warnings.push(message),
  });

  assert.equal(written, true);
  assert.equal(renameAttempts, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.deepEqual(warnings, []);
});

test("setup progress remains best effort after persistent access errors", async () => {
  let renameAttempts = 0;
  const warnings = [];
  const fileSystem = {
    async mkdir() {},
    async writeFile() {},
    async rename() {
      renameAttempts += 1;
      const error = new Error("still locked");
      error.code = "EACCES";
      throw error;
    },
    async rm() {},
  };

  const written = await writeSetupProgressBestEffort({
    progressPath: path.join(os.tmpdir(), "bonni-progress-test.json"),
    progress: { status: "running" },
    fileSystem,
    retryDelays: [1, 2],
    wait: async () => {},
    warn: (message) => warnings.push(message),
  });

  assert.equal(written, false);
  assert.equal(renameAttempts, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Einrichtung läuft weiter \(EACCES\)/u);
});

test("a broken progress channel never interrupts setup stages", async () => {
  const stages = [
    ["Systemschlüssel sicherstellen", "/tmp/backend", ["run", "auth:ensure-jwt"]],
    ["Backend erzeugen und prüfen", "/tmp/backend", ["run", "build:code"]],
  ];
  const executed = [];

  await runSetupStages(
    stages,
    async (label) => executed.push(label),
    async () => {
      const error = new Error("progress file locked");
      error.code = "EPERM";
      throw error;
    },
  );

  assert.deepEqual(executed, stages.map(([label]) => label));
});

test("the real setup entry point stops before maintenance cleanup when .env is missing", async (t) => {
  const current = await fixture(t);
  const setupDirectory = path.join(current.backendDirectory, "scripts", "setup");
  await fs.mkdir(setupDirectory, { recursive: true });
  for (const scriptName of [
    "setup-system.mjs",
    "prebuilt-frontend.mjs",
    "local-source-update.mjs",
  ]) {
    await fs.copyFile(
      path.join(backendRoot, "scripts", "setup", scriptName),
      path.join(setupDirectory, scriptName),
    );
  }

  const childEnvironment = { ...process.env };
  delete childEnvironment.BONNI_SETUP_MODE;
  delete childEnvironment.DATABASE_URL;
  let failure;
  try {
    await execFileAsync(process.execPath, [path.join(setupDirectory, "setup-system.mjs")], {
      cwd: current.backendDirectory,
      env: childEnvironment,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "setup must fail before starting a destructive stage");
  assert.equal(failure.code, 1);
  assert.match(String(failure.stderr || ""), /SETUP_READINESS_ENV_MISSING/u);
  assert.doesNotMatch(String(failure.stdout || ""), /Alte technische Dateien vor dem Neubau bereinigen/u);
  assert.equal(await fs.readFile(current.distMarker, "utf8"), "existing runtime\n");
});
