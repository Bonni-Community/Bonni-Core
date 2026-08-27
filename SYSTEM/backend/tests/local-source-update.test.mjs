import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  applyLocalSourceUpdate,
  assertNoPendingLocalSourceUpdate,
  assertPendingLocalSourceUpdate,
  finalizeLocalSourceUpdate,
  preflightLocalSourceUpdate,
  SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
  SOURCE_UPDATE_SCHEMA,
  sourceUpdatePayloadObjectName,
} from "../scripts/setup/local-source-update.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_NAME = "bonni-source-update.json";
const execFileAsync = promisify(execFile);
const TEST_ESSENTIAL_FILES = new Map([
  ["SYSTEM/backend", [
    "SYSTEM/backend/package-lock.json",
    "SYSTEM/backend/package.json",
    "SYSTEM/backend/scripts/setup/local-source-update.mjs",
    "SYSTEM/backend/scripts/setup/local-source-update-gate.mjs",
    "SYSTEM/backend/scripts/setup/local-source-update-supervisor.mjs",
    "SYSTEM/backend/scripts/setup/prebuilt-frontend.mjs",
    "SYSTEM/backend/scripts/setup/setup-system.mjs",
    "SYSTEM/backend/scripts/setup/update-system.mjs",
    "SYSTEM/backend/scripts/runtime/local-source-update-start-gate.mjs",
    "SYSTEM/backend/scripts/runtime/run-host-backend-entry.mjs",
    "SYSTEM/backend/scripts/runtime/runtime-mode-exclusion.mjs",
    "SYSTEM/backend/scripts/runtime/start-backend.mjs",
  ]],
  ["SYSTEM/frontend", [
    "SYSTEM/frontend/package-lock.json",
    "SYSTEM/frontend/package.json",
  ]],
  ["SYSTEM/app/kontorapp", [
    "SYSTEM/app/kontorapp/backend/package-lock.json",
    "SYSTEM/app/kontorapp/backend/package.json",
    "SYSTEM/app/kontorapp/frontend/package-lock.json",
    "SYSTEM/app/kontorapp/frontend/package.json",
    "SYSTEM/app/kontorapp/package-lock.json",
    "SYSTEM/app/kontorapp/package.json",
    "SYSTEM/app/kontorapp/manifest.ts",
  ]],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target) {
  return fs.lstat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function writeProductFile(productRoot, relativePath, value) {
  const target = path.join(productRoot, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}

async function createProductFixture(t) {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-local-source-update-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(productRoot, "SYSTEM", "backend"), { recursive: true });
  await fs.writeFile(path.join(productRoot, "SYSTEM", "backend", "package.json"), `${JSON.stringify({
    name: "bonni-core-backend",
    version: "0.1.19",
    private: true,
    scripts: {
      setup: "node scripts/setup/setup-system.mjs",
      update: "node scripts/setup/update-system.mjs",
      prestart: "node scripts/runtime/local-source-update-start-gate.mjs",
      predev: "node scripts/setup/local-source-update-gate.mjs",
      start: "npm run maintenance:cleanup && npm run auth:ensure-jwt && node scripts/runtime/start-backend.mjs",
    },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(productRoot, "SYSTEM", "backend", "package-lock.json"), `${JSON.stringify({
    name: "bonni-core-backend",
    version: "0.1.19",
    lockfileVersion: 3,
    packages: { "": { name: "bonni-core-backend", version: "0.1.19" } },
  })}\n`, "utf8");
  for (const scriptName of [
    "local-source-update.mjs",
    "local-source-update-gate.mjs",
    "local-source-update-supervisor.mjs",
    "prebuilt-frontend.mjs",
    "setup-system.mjs",
    "update-system.mjs",
  ]) {
    await writeProductFile(
      productRoot,
      `SYSTEM/backend/scripts/setup/${scriptName}`,
      `// fixture ${scriptName}\n`,
    );
  }
  for (const scriptName of [
    "local-source-update-start-gate.mjs",
    "run-host-backend-entry.mjs",
    "runtime-mode-exclusion.mjs",
    "start-backend.mjs",
  ]) {
    await writeProductFile(
      productRoot,
      `SYSTEM/backend/scripts/runtime/${scriptName}`,
      `// fixture ${scriptName}\n`,
    );
  }
  return productRoot;
}

async function createUpdatePackage(productRoot, updateId, entries, options = {}) {
  const packageRoot = path.join(productRoot, "UPDATE", "inbox", updateId);
  const payloadRoot = path.join(packageRoot, "payload");
  const files = [];
  const components = options.components || [
    { key: "bonni-core-backend", path: "SYSTEM/backend", mode: "managed" },
  ];
  const expandedEntries = [...entries];

  for (const component of components) {
    for (const essentialPath of TEST_ESSENTIAL_FILES.get(component.path) || []) {
      if (expandedEntries.some((entry) => entry.path === essentialPath)) continue;
      const installedTarget = path.join(productRoot, ...essentialPath.split("/"));
      const installedContent = await fs.readFile(installedTarget).catch(() => null);
      let content = installedContent;
      if (!content && essentialPath.endsWith("/manifest.ts")) {
        content = Buffer.from('export default { version: "0.19.3" };\n');
      } else if (!content && essentialPath.includes("/kontorapp/")) {
        content = Buffer.from('{"name":"kontorapp","version":"0.19.3"}\n');
      } else if (!content && essentialPath.endsWith("/package.json")) {
        content = Buffer.from('{"name":"bonni-core-frontend","version":"0.1.19"}\n');
      } else if (!content) {
        content = Buffer.from(`// fixture ${path.posix.basename(essentialPath)}\n`);
      }
      expandedEntries.push({ path: essentialPath, content });
    }
  }

  for (const entry of expandedEntries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ""), "utf8");
    const installedTarget = path.join(productRoot, ...entry.path.split("/"));
    const installedState = await fs.lstat(installedTarget).catch(() => null);
    const expectedPreviousSha256 = Object.hasOwn(entry, "expectedPreviousSha256")
      ? entry.expectedPreviousSha256
      : installedState?.isFile()
        ? createHash("sha256").update(await fs.readFile(installedTarget)).digest("hex")
        : null;
    const targetSha256 = entry.sha256 ?? sha256(content);
    files.push({
      path: entry.path,
      sizeBytes: entry.sizeBytes ?? content.byteLength,
      sha256: targetSha256,
      expectedPreviousSha256,
    });
    if (entry.writePayload === false) continue;
    const payloadPath = entry.payloadPath || (
      options.payloadLayout === SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT
        ? sourceUpdatePayloadObjectName(targetSha256)
        : entry.path
    );
    const target = path.join(payloadRoot, ...payloadPath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, MANIFEST_NAME), `${JSON.stringify({
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    status: "UNPUBLISHED_TEST_UPDATE",
    updateId,
    channel: "development",
    ...(options.payloadLayout ? { payloadLayout: options.payloadLayout } : {}),
    requires: options.requires ?? null,
    ...(options.releaseNotes ? { releaseNotes: options.releaseNotes } : {}),
    from: options.from || {
      coreVersion: "0.1.19",
      kontorAppVersion: "0.19.3",
    },
    to: options.to || {
      coreVersion: "0.1.19",
      kontorAppVersion: "0.19.3",
    },
    components,
    files,
    delete: options.delete || [],
  }, null, 2)}\n`, "utf8");
  return packageRoot;
}

async function packageRegularFiles(packageRoot) {
  const state = await fs.lstat(packageRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return [];
  const result = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  await walk(packageRoot);
  return result;
}

async function applyAndFinalize(productRoot) {
  const transaction = await applyLocalSourceUpdate({ productRoot });
  assert.ok(transaction, "Ein vorhandenes Paket muss eine Update-Transaktion liefern.");
  await finalizeLocalSourceUpdate({ productRoot, transaction });
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
  return transaction;
}

test("Versionshinweise bleiben im abgeschlossenen Update-Beleg erhalten", async (t) => {
  const productRoot = await createProductFixture(t);
  const updateId = "release-notes-history-0001";
  const releaseNotes = {
    title: " Update dauerhaft dokumentiert ",
    summary: " Die Versionsbeschreibung bleibt auch nach dem Entfernen des Inbox-Pakets sichtbar. ",
    changes: [{
      type: "improvement",
      title: " Verlauf bleibt verständlich ",
      detail: " Die geprüften Hinweise werden an den abgeschlossenen Update-Beleg gebunden. ",
    }],
  };
  await createUpdatePackage(productRoot, updateId, [
    { path: "SYSTEM/backend/src/release-notes-history.ts", content: "export const updated = true;\n" },
  ], { releaseNotes });

  await applyAndFinalize(productRoot);

  const receipt = JSON.parse(await fs.readFile(
    path.join(productRoot, "SYSTEM", ".bonni-source-update", "history", `${updateId}.json`),
    "utf8",
  ));
  assert.deepEqual(receipt.releaseNotes, {
    title: "Update dauerhaft dokumentiert",
    summary: "Die Versionsbeschreibung bleibt auch nach dem Entfernen des Inbox-Pakets sichtbar.",
    changes: [{
      type: "improvement",
      title: "Verlauf bleibt verständlich",
      detail: "Die geprüften Hinweise werden an den abgeschlossenen Update-Beleg gebunden.",
    }],
  });
  assert.deepEqual(receipt.updateMetadata.from, {
    coreVersion: "0.1.19",
    kontorAppVersion: "0.19.3",
  });
  assert.deepEqual(receipt.updateMetadata.to, receipt.updateMetadata.from);
  assert.deepEqual(receipt.updateMetadata.components, [{
    key: "bonni-core-backend",
    path: "SYSTEM/backend",
    mode: "managed",
  }]);
  assert.equal(receipt.updateMetadata.counts.files, receipt.updateMetadata.counts.inventory);
  assert.ok(receipt.updateMetadata.counts.inventory > 0);
  assert.equal(receipt.updateMetadata.counts.delete, 0);
  assert.equal(receipt.updateMetadata.repair, false);
});

test("repair payload restores missing managed files and accepts an already repaired target", async (t) => {
  const productRoot = await createProductFixture(t);
  const missingPath = "SYSTEM/backend/src/repair-missing.ts";
  const partialPath = "SYSTEM/backend/src/repair-partial.ts";
  const oldMissing = "export const missing = 'old';\n";
  const oldPartial = "export const partial = 'old';\n";
  const newPartial = "export const partial = 'repaired';\n";

  await createUpdatePackage(productRoot, "repair-predecessor-0001", [
    { path: missingPath, content: oldMissing },
    { path: partialPath, content: oldPartial },
  ]);
  const predecessor = await applyAndFinalize(productRoot);

  await fs.rm(path.join(productRoot, ...missingPath.split("/")));
  await fs.writeFile(path.join(productRoot, ...partialPath.split("/")), newPartial);
  await createUpdatePackage(productRoot, "repair-successor-0002", [
    {
      path: missingPath,
      content: oldMissing,
      expectedPreviousSha256: sha256(oldMissing),
    },
    {
      path: partialPath,
      content: newPartial,
      expectedPreviousSha256: sha256(oldPartial),
    },
  ], {
    payloadLayout: SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
    requires: {
      updateId: predecessor.updateId,
      manifestSha256: predecessor.manifestSha256,
    },
  });

  const repair = await applyAndFinalize(productRoot);
  assert.equal(repair.journal.operations.filter((entry) => entry.action === "write").length, 1);
  assert.equal(await fs.readFile(path.join(productRoot, ...missingPath.split("/")), "utf8"), oldMissing);
  assert.equal(await fs.readFile(path.join(productRoot, ...partialPath.split("/")), "utf8"), newPartial);
});

test("repair payload still rejects an unknown local modification", async (t) => {
  const productRoot = await createProductFixture(t);
  const targetPath = "SYSTEM/backend/src/repair-conflict.ts";
  const oldContent = "export const value = 'old';\n";
  const repairedContent = "export const value = 'repaired';\n";
  await createUpdatePackage(productRoot, "repair-conflict-predecessor-0001", [
    { path: targetPath, content: oldContent },
  ]);
  const predecessor = await applyAndFinalize(productRoot);
  await fs.writeFile(path.join(productRoot, ...targetPath.split("/")), "local change\n");

  const packageRoot = await createUpdatePackage(productRoot, "repair-conflict-successor-0002", [
    {
      path: targetPath,
      content: repairedContent,
      expectedPreviousSha256: sha256(oldContent),
    },
  ], {
    payloadLayout: SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
    requires: {
      updateId: predecessor.updateId,
      manifestSha256: predecessor.manifestSha256,
    },
  });
  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_LOCAL_MODIFICATION_CONFLICT/u,
  );
  assert.equal(await exists(packageRoot), true);
});

test("an identically re-extracted completed package is a safe no-op", async (t) => {
  const productRoot = await createProductFixture(t);
  const packageRoot = await createUpdatePackage(productRoot, "completed-noop-0001", [
    { path: "SYSTEM/backend/src/completed-noop.ts", content: "export const completed = true;\n" },
  ]);
  const savedPackage = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-completed-package-"));
  t.after(() => fs.rm(savedPackage, { recursive: true, force: true }));
  await fs.cp(packageRoot, savedPackage, { recursive: true });

  const transaction = await applyLocalSourceUpdate({ productRoot });
  await finalizeLocalSourceUpdate({ productRoot, transaction });
  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  const activeBefore = await fs.readFile(path.join(stateRoot, "active-manifest.json"), "utf8");
  const historyBefore = await fs.readFile(path.join(stateRoot, "history", "completed-noop-0001.json"), "utf8");

  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(savedPackage, packageRoot, { recursive: true });
  const repeated = await applyLocalSourceUpdate({ productRoot });

  assert.equal(repeated.alreadyCompleted, true);
  assert.equal(repeated.phase, "already-completed");
  assert.equal(await exists(packageRoot), false);
  assert.equal(await fs.readFile(path.join(stateRoot, "active-manifest.json"), "utf8"), activeBefore);
  assert.equal(await fs.readFile(path.join(stateRoot, "history", "completed-noop-0001.json"), "utf8"), historyBefore);
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

test("npm run update removes an exactly completed Inbox package without rerunning setup", async (t) => {
  const productRoot = await createProductFixture(t);
  const setupDirectory = path.join(productRoot, "SYSTEM", "backend", "scripts", "setup");
  await fs.mkdir(setupDirectory, { recursive: true });
  for (const scriptName of ["local-source-update.mjs", "update-system.mjs"]) {
    await fs.copyFile(
      path.join(backendRoot, "scripts", "setup", scriptName),
      path.join(setupDirectory, scriptName),
    );
  }
  await fs.copyFile(
    path.join(backendRoot, "scripts", "runtime", "runtime-mode-exclusion.mjs"),
    path.join(productRoot, "SYSTEM", "backend", "scripts", "runtime", "runtime-mode-exclusion.mjs"),
  );

  const packageRoot = await createUpdatePackage(productRoot, "completed-wrapper-noop-0001", [
    { path: "SYSTEM/backend/src/completed-wrapper-noop.ts", content: "export const completed = true;\n" },
  ]);
  const savedPackage = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-completed-wrapper-package-"));
  t.after(() => fs.rm(savedPackage, { recursive: true, force: true }));
  await fs.cp(packageRoot, savedPackage, { recursive: true });
  await applyAndFinalize(productRoot);

  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(savedPackage, packageRoot, { recursive: true });
  const result = await execFileAsync(process.execPath, [path.join(setupDirectory, "update-system.mjs")], {
    cwd: path.join(productRoot, "SYSTEM", "backend"),
    env: { ...process.env, NODE_ENV: "test" },
  });

  assert.match(result.stdout, /war bereits vollständig installiert/u);
  assert.match(result.stdout, /Aktualisierung erfolgreich abgeschlossen/u);
  assert.equal(await exists(packageRoot), false);
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

test("a completed predecessor package remains a safe no-op after a verified successor", async (t) => {
  const productRoot = await createProductFixture(t);
  const predecessorRoot = await createUpdatePackage(productRoot, "completed-predecessor-0001", [
    { path: "SYSTEM/backend/src/completed-chain.ts", content: "export const value = 1;\n" },
  ]);
  const savedPredecessor = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-completed-predecessor-"));
  t.after(() => fs.rm(savedPredecessor, { recursive: true, force: true }));
  await fs.cp(predecessorRoot, savedPredecessor, { recursive: true });
  const predecessor = await applyAndFinalize(productRoot);

  await createUpdatePackage(productRoot, "completed-successor-0002", [
    { path: "SYSTEM/backend/src/completed-chain.ts", content: "export const value = 2;\n" },
  ], {
    requires: {
      updateId: predecessor.updateId,
      manifestSha256: predecessor.manifestSha256,
    },
  });
  await applyAndFinalize(productRoot);

  await fs.mkdir(path.dirname(predecessorRoot), { recursive: true });
  await fs.cp(savedPredecessor, predecessorRoot, { recursive: true });
  const repeated = await applyLocalSourceUpdate({ productRoot });
  assert.equal(repeated.alreadyCompleted, true);
  assert.equal(repeated.updateId, "completed-predecessor-0001");
  assert.equal(await exists(predecessorRoot), false);
});

test("completed package cleanup rejects a tampered payload and retains the Inbox evidence", async (t) => {
  const productRoot = await createProductFixture(t);
  const packageRoot = await createUpdatePackage(productRoot, "completed-payload-tamper-0001", [
    { path: "SYSTEM/backend/src/completed-payload-tamper.ts", content: "export const value = 1;\n" },
  ]);
  const savedPackage = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-completed-payload-tamper-"));
  t.after(() => fs.rm(savedPackage, { recursive: true, force: true }));
  await fs.cp(packageRoot, savedPackage, { recursive: true });
  await applyAndFinalize(productRoot);

  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(savedPackage, packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "payload", "SYSTEM", "backend", "src", "completed-payload-tamper.ts"),
    "export const value = 2;\n",
  );
  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_(?:SIZE|HASH)_MISMATCH/u,
  );
  assert.equal(await exists(packageRoot), true);
});

test("completed package cleanup rejects contradictory receipt and active state", async (t) => {
  const scenarios = [
    {
      label: "receipt",
      mutate: async (stateRoot, updateId) => {
        const receiptPath = path.join(stateRoot, "history", `${updateId}.json`);
        const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
        receipt.files[0].sha256 = "f".repeat(64);
        await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      },
      expected: /SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH/u,
    },
    {
      label: "active",
      mutate: async (stateRoot) => {
        const activePath = path.join(stateRoot, "active-manifest.json");
        const active = JSON.parse(await fs.readFile(activePath, "utf8"));
        active.manifestSha256 = "e".repeat(64);
        await fs.writeFile(activePath, `${JSON.stringify(active, null, 2)}\n`);
      },
      expected: /SOURCE_UPDATE_COMPLETED_STATE_INCONSISTENT/u,
    },
    {
      label: "installed",
      mutate: async (_stateRoot, _updateId, productRoot) => {
        await fs.writeFile(
          path.join(productRoot, "SYSTEM", "backend", "src", "installed.ts"),
          "export const value = false;\n",
        );
      },
      expected: /SOURCE_UPDATE_COMPLETED_STATE_INCONSISTENT/u,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, async (subtest) => {
      const productRoot = await createProductFixture(subtest);
      const updateId = `completed-contradiction-${scenario.label}-0001`;
      const packageRoot = await createUpdatePackage(productRoot, updateId, [
        { path: `SYSTEM/backend/src/${scenario.label}.ts`, content: "export const value = true;\n" },
      ]);
      const savedPackage = await fs.mkdtemp(path.join(os.tmpdir(), `bonni-${scenario.label}-evidence-`));
      subtest.after(() => fs.rm(savedPackage, { recursive: true, force: true }));
      await fs.cp(packageRoot, savedPackage, { recursive: true });
      await applyAndFinalize(productRoot);

      await fs.mkdir(path.dirname(packageRoot), { recursive: true });
      await fs.cp(savedPackage, packageRoot, { recursive: true });
      const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
      await scenario.mutate(stateRoot, updateId, productRoot);
      await assert.rejects(applyLocalSourceUpdate({ productRoot }), scenario.expected);
      assert.equal(await exists(packageRoot), true);
    });
  }
});

test("a reused completed ID with changed content is retained and rejected", async (t) => {
  const productRoot = await createProductFixture(t);
  const packageRoot = await createUpdatePackage(productRoot, "completed-collision-0001", [
    { path: "SYSTEM/backend/src/completed-collision.ts", content: "export const value = 1;\n" },
  ]);
  const transaction = await applyLocalSourceUpdate({ productRoot });
  await finalizeLocalSourceUpdate({ productRoot, transaction });

  await createUpdatePackage(productRoot, "completed-collision-0001", [
    { path: "SYSTEM/backend/src/completed-collision.ts", content: "export const value = 2;\n" },
  ]);
  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_ID_COLLISION:completed-collision-0001/u,
  );
  assert.equal(await exists(packageRoot), true);
});

test("local source update copies hash-bound files and preserves HocketApp, .env and unknown files", async (t) => {
  const productRoot = await createProductFixture(t);
  const hocketFile = await writeProductFile(productRoot, "SYSTEM/app/HocketApp/own.txt", "hocket-owned\n");
  const environmentFile = await writeProductFile(productRoot, "SYSTEM/backend/.env", "JWT_SECRET=keep-me\n");
  const unknownFile = await writeProductFile(productRoot, "SYSTEM/backend/src/local-only.ts", "local addition\n");
  const packageRoot = await createUpdatePackage(productRoot, "copy-files-0001", [
    { path: "SYSTEM/backend/src/version.ts", content: "export const core = '0.1.19';\n" },
  ]);

  const transaction = await applyLocalSourceUpdate({ productRoot });
  assert.ok(transaction);
  assert.equal(
    await fs.readFile(path.join(productRoot, "SYSTEM", "backend", "src", "version.ts"), "utf8"),
    "export const core = '0.1.19';\n",
  );
  assert.equal(await fs.readFile(hocketFile, "utf8"), "hocket-owned\n");
  assert.equal(await fs.readFile(environmentFile, "utf8"), "JWT_SECRET=keep-me\n");
  assert.equal(await fs.readFile(unknownFile, "utf8"), "local addition\n");
  await assert.rejects(assertNoPendingLocalSourceUpdate({ productRoot }));

  await finalizeLocalSourceUpdate({ productRoot, transaction });
  assert.deepEqual(await packageRegularFiles(packageRoot), [], "Finalize muss das verarbeitete Paket leeren.");
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

test("a verified finalize empties consumed and stale UPDATE data", async (t) => {
  const productRoot = await createProductFixture(t);
  const updateRoot = path.join(productRoot, "UPDATE");
  await writeProductFile(productRoot, "UPDATE/old-download.tmp", "dead update download\n");
  await writeProductFile(productRoot, "UPDATE/inbox/old-extract/readme.txt", "dead extraction\n");
  await writeProductFile(productRoot, "UPDATE/old-work/cache.bin", "dead work data\n");
  await createUpdatePackage(productRoot, "cleanup-success-0001", [
    { path: "SYSTEM/backend/src/cleanup-success.ts", content: "export const clean = true;\n" },
  ]);

  const transaction = await applyLocalSourceUpdate({ productRoot });
  await finalizeLocalSourceUpdate({ productRoot, transaction });

  assert.deepEqual(
    await fs.readdir(updateRoot),
    [],
    "Nach dem verifizierten Abschluss darf UPDATE keine verbrauchten oder toten Daten enthalten.",
  );
});

test("cleanup preserves update data staged or changed after installation began", async (t) => {
  const productRoot = await createProductFixture(t);
  const changedCandidate = await writeProductFile(
    productRoot,
    "UPDATE/reused-download.tmp",
    "old dead bytes\n",
  );
  const consumedPackage = await createUpdatePackage(productRoot, "cleanup-current-0001", [
    { path: "SYSTEM/backend/src/cleanup-current.ts", content: "export const current = true;\n" },
  ]);
  const transaction = await applyLocalSourceUpdate({ productRoot });

  await fs.writeFile(changedCandidate, "new pending bytes\n");
  const pendingPackage = await createUpdatePackage(productRoot, "cleanup-next-0002", [
    { path: "SYSTEM/backend/src/cleanup-next.ts", content: "export const next = true;\n" },
  ]);
  await finalizeLocalSourceUpdate({ productRoot, transaction });

  assert.equal(await exists(consumedPackage), false);
  assert.equal(await exists(path.join(productRoot, "UPDATE", ".bonni-work", transaction.updateId)), false);
  assert.equal(await fs.readFile(changedCandidate, "utf8"), "new pending bytes\n");
  assert.equal(await exists(pendingPackage), true);
});

test("cleanup fingerprints bind file contents even when the byte length stays equal", async (t) => {
  const productRoot = await createProductFixture(t);
  const changedCandidate = await writeProductFile(
    productRoot,
    "UPDATE/same-size-download.tmp",
    "old1\n",
  );
  await createUpdatePackage(productRoot, "cleanup-same-size-0001", [
    { path: "SYSTEM/backend/src/cleanup-same-size.ts", content: "export const current = true;\n" },
  ]);
  const transaction = await applyLocalSourceUpdate({ productRoot });

  await fs.writeFile(changedCandidate, "new2\n");
  await finalizeLocalSourceUpdate({ productRoot, transaction });

  assert.equal(await fs.readFile(changedCandidate, "utf8"), "new2\n");
});

test("a failed finalize retains package, rollback work and pending evidence", async (t) => {
  const productRoot = await createProductFixture(t);
  const targetPath = "SYSTEM/backend/src/cleanup-failure.ts";
  const packageRoot = await createUpdatePackage(productRoot, "cleanup-failure-0001", [
    { path: targetPath, content: "export const installed = true;\n" },
  ]);
  const transaction = await applyLocalSourceUpdate({ productRoot });
  const pendingPath = path.join(
    productRoot,
    "SYSTEM",
    ".bonni-source-update",
    "pending-update.json",
  );
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  const transactionRoot = path.join(productRoot, ...pending.transactionPath.split("/"));
  await fs.writeFile(path.join(productRoot, ...targetPath.split("/")), "changed before finalize\n");

  await assert.rejects(
    finalizeLocalSourceUpdate({ productRoot, transaction }),
    /SOURCE_UPDATE_PENDING_TARGET_CHANGED/u,
  );

  assert.equal(await exists(packageRoot), true, "Das Paket muss für Diagnose und Wiederholung bleiben.");
  assert.equal(await exists(path.join(transactionRoot, "journal.json")), true);
  assert.equal(await exists(pendingPath), true);
  assert.equal(
    await exists(path.join(productRoot, "SYSTEM", ".bonni-source-update", "history", `${transaction.updateId}.json`)),
    false,
  );
});

test("an update requires the exact predecessor ID and manifest hash", async (t) => {
  const cases = [
    { label: "exact predecessor", mutate: (value) => value, accepted: true },
    {
      label: "wrong predecessor hash",
      mutate: (value) => ({ ...value, manifestSha256: "f".repeat(64) }),
      accepted: false,
    },
    {
      label: "wrong predecessor ID",
      mutate: (value) => ({ ...value, updateId: "different-predecessor-0001" }),
      accepted: false,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const productRoot = await createProductFixture(t);
      await createUpdatePackage(productRoot, "required-base-0001", [
        { path: "SYSTEM/backend/src/required-base.ts", content: "export const base = true;\n" },
      ]);
      await applyAndFinalize(productRoot);
      const active = JSON.parse(await fs.readFile(
        path.join(productRoot, "SYSTEM", ".bonni-source-update", "active-manifest.json"),
        "utf8",
      ));
      const target = path.join(productRoot, "SYSTEM", "backend", "src", "required-next.ts");
      await createUpdatePackage(productRoot, "required-next-0002", [
        { path: "SYSTEM/backend/src/required-next.ts", content: "export const next = true;\n" },
      ], {
        requires: scenario.mutate({
          updateId: active.updateId,
          manifestSha256: active.manifestSha256,
        }),
      });

      if (scenario.accepted) {
        await applyAndFinalize(productRoot);
        assert.equal(await exists(target), true);
      } else {
        await assert.rejects(
          applyLocalSourceUpdate({ productRoot }),
          /SOURCE_UPDATE_REQUIRED_PREDECESSOR_MISSING/u,
        );
        assert.equal(await exists(target), false);
      }
    });
  }
});

test("finalized active state removes only a subsequently omitted managed file", async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "managed-base-0001", [
    { path: "SYSTEM/backend/src/current.ts", content: "export const value = 'old';\n" },
    { path: "SYSTEM/backend/src/obsolete.ts", content: "export const obsolete = true;\n" },
  ]);
  await applyAndFinalize(productRoot);

  const unknownFile = await writeProductFile(
    productRoot,
    "SYSTEM/backend/src/user-created.ts",
    "export const userOwned = true;\n",
  );
  await createUpdatePackage(productRoot, "managed-next-0002", [
    { path: "SYSTEM/backend/src/current.ts", content: "export const value = 'new';\n" },
  ]);

  const transaction = await applyLocalSourceUpdate({ productRoot });
  assert.ok(transaction);
  assert.equal(await exists(path.join(productRoot, "SYSTEM", "backend", "src", "obsolete.ts")), false);
  assert.equal(await fs.readFile(unknownFile, "utf8"), "export const userOwned = true;\n");
  assert.equal(
    await fs.readFile(path.join(productRoot, "SYSTEM", "backend", "src", "current.ts"), "utf8"),
    "export const value = 'new';\n",
  );
  await finalizeLocalSourceUpdate({ productRoot, transaction });
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

test("a locally modified managed file causes a preflight conflict without partial mutation", async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "conflict-base-0001", [
    { path: "SYSTEM/backend/src/tracked.ts", content: "export const tracked = 'base';\n" },
  ]);
  await applyAndFinalize(productRoot);

  const tracked = await writeProductFile(
    productRoot,
    "SYSTEM/backend/src/tracked.ts",
    "export const tracked = 'locally changed';\n",
  );
  await createUpdatePackage(productRoot, "conflict-next-0002", [
    { path: "SYSTEM/backend/src/a-new.ts", content: "export const added = true;\n" },
    { path: "SYSTEM/backend/src/tracked.ts", content: "export const tracked = 'update';\n" },
  ]);

  await assert.rejects(applyLocalSourceUpdate({ productRoot }));
  assert.equal(await fs.readFile(tracked, "utf8"), "export const tracked = 'locally changed';\n");
  assert.equal(await exists(path.join(productRoot, "SYSTEM", "backend", "src", "a-new.ts")), false);
});

test("the explicit preflight verifies the complete package without creating update state", async (t) => {
  const productRoot = await createProductFixture(t);
  const targetPath = "SYSTEM/backend/src/preflight-only.ts";
  const packageRoot = await createUpdatePackage(productRoot, "preflight-only-0001", [
    { path: targetPath, content: "export const checked = true;\n" },
  ]);

  const result = await preflightLocalSourceUpdate({ productRoot });
  assert.equal(result.phase, "preflight");
  assert.ok(result.operationCount > 0);
  assert.equal(await exists(path.join(productRoot, ...targetPath.split("/"))), false);
  assert.equal(await exists(path.join(productRoot, "SYSTEM", ".bonni-source-update", "pending-update.json")), false);
  assert.equal(await exists(path.join(productRoot, "UPDATE", ".bonni-work", result.updateId)), false);
  assert.equal(await exists(packageRoot), true);
});

test("a payload hash mismatch fails before any destination is mutated", async (t) => {
  const productRoot = await createProductFixture(t);
  const existing = await writeProductFile(productRoot, "SYSTEM/backend/src/existing.ts", "unchanged\n");
  await createUpdatePackage(productRoot, "bad-hash-0001", [
    { path: "SYSTEM/backend/src/a-valid.ts", content: "must not be copied\n" },
    {
      path: "SYSTEM/backend/src/z-invalid.ts",
      content: "payload bytes\n",
      sha256: "0".repeat(64),
    },
  ]);

  await assert.rejects(applyLocalSourceUpdate({ productRoot }));
  assert.equal(await fs.readFile(existing, "utf8"), "unchanged\n");
  assert.equal(await exists(path.join(productRoot, "SYSTEM", "backend", "src", "a-valid.ts")), false);
  assert.equal(await exists(path.join(productRoot, "SYSTEM", "backend", "src", "z-invalid.ts")), false);
});

test("manifest traversal and Windows case collisions are rejected", async (t) => {
  await t.test("traversal", async (t) => {
    const productRoot = await createProductFixture(t);
    const outside = await writeProductFile(productRoot, "outside.txt", "outside remains\n");
    await createUpdatePackage(productRoot, "traversal-0001", [
      {
        path: "SYSTEM/../outside.txt",
        payloadPath: "SYSTEM/backend/src/innocent.ts",
        content: "overwrite attempt\n",
      },
    ]);
    await assert.rejects(applyLocalSourceUpdate({ productRoot }));
    assert.equal(await fs.readFile(outside, "utf8"), "outside remains\n");
  });

  await t.test("case-insensitive duplicate", async (t) => {
    const productRoot = await createProductFixture(t);
    await createUpdatePackage(productRoot, "case-collision-0001", [
      { path: "SYSTEM/backend/src/Duplicate.ts", content: "first\n" },
      { path: "system/BACKEND/src/duplicate.ts", content: "second\n" },
    ]);
    await assert.rejects(applyLocalSourceUpdate({ productRoot }));
    assert.equal(await exists(path.join(productRoot, "SYSTEM", "backend", "src", "Duplicate.ts")), false);
  });
});

test("protected program-adjacent data paths cannot be supplied by a source update", async (t) => {
  const protectedPaths = [
    "SYSTEM/backend/.env",
    "SYSTEM/backend/docs/user-document.pdf",
    "SYSTEM/backend/run_system/runtime.json",
    "SYSTEM/backend/storage/private.bin",
    "SYSTEM/backend/uploads/document.pdf",
    "SYSTEM/backend/prisma/local.sqlite",
    "SYSTEM/app/HocketApp/manifest.ts",
  ];

  for (const [index, protectedPath] of protectedPaths.entries()) {
    await t.test(protectedPath, async (t) => {
      const productRoot = await createProductFixture(t);
      const target = await writeProductFile(productRoot, protectedPath, "protected original\n");
      await createUpdatePackage(productRoot, `protected-${String(index + 1).padStart(4, "0")}`, [
        { path: protectedPath, content: "must be rejected\n" },
      ]);
      await assert.rejects(applyLocalSourceUpdate({ productRoot }));
      assert.equal(await fs.readFile(target, "utf8"), "protected original\n");
    });
  }
});

test("setup-system never reads UPDATE; update-system owns the local source update step", async () => {
  const setupSource = await fs.readFile(path.join(backendRoot, "scripts", "setup", "setup-system.mjs"), "utf8");
  const updateSource = await fs.readFile(path.join(backendRoot, "scripts", "setup", "update-system.mjs"), "utf8");
  const packageJson = JSON.parse(await fs.readFile(path.join(backendRoot, "package.json"), "utf8"));

  assert.doesNotMatch(setupSource, /applyLocalSourceUpdate|finalizeLocalSourceUpdate|["']UPDATE["']/u);
  assert.match(updateSource, /applyLocalSourceUpdate/u);
  assert.match(String(packageJson?.scripts?.setup || ""), /setup-system\.mjs/u);
  assert.doesNotMatch(String(packageJson?.scripts?.setup || ""), /update-system\.mjs/u);
  assert.match(String(packageJson?.scripts?.update || ""), /update-system\.mjs/u);
});

test("regular file durability sync uses writable handles on Windows", async () => {
  const updaterSource = await fs.readFile(
    path.join(backendRoot, "scripts", "setup", "local-source-update.mjs"),
    "utf8",
  );

  assert.match(
    updaterSource,
    /process\.platform === "win32" \? "r\+" : "r"/u,
    "Windows fsync muss einen Handle mit Schreibzugriff erhalten.",
  );
  assert.doesNotMatch(
    updaterSource,
    /fs\.open\(temporary,\s*"r"\)/u,
    "Temporäre Programmdateien müssen denselben Windows-kompatiblen Sync-Pfad verwenden.",
  );
});

test("a simulated Windows update syncs backups and apply files through writable handles", async (t) => {
  const productRoot = await createProductFixture(t);
  await writeProductFile(
    productRoot,
    "SYSTEM/backend/src/windows-sync.ts",
    "export const value = 'before';\n",
  );
  await createUpdatePackage(productRoot, "windows-sync-0001", [
    {
      path: "SYSTEM/backend/src/windows-sync.ts",
      content: "export const value = 'after';\n",
    },
  ]);

  const originalOpen = fs.open;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const observed = [];
  try {
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "win32",
    });
    fs.open = async (file, flags, ...args) => {
      const basename = path.basename(String(file));
      if (
        String(file).includes(`${path.sep}backup${path.sep}`)
        || basename.startsWith(".bonni-update-")
      ) {
        observed.push({ basename, flags });
      }
      return originalOpen(file, flags, ...args);
    };

    await applyAndFinalize(productRoot);
  } finally {
    fs.open = originalOpen;
    Object.defineProperty(process, "platform", platformDescriptor);
  }

  assert.ok(observed.some(({ basename }) => /^\d{6}\.bin$/u.test(basename)));
  assert.ok(observed.some(({ basename }) => basename.startsWith(".bonni-update-")));
  assert.deepEqual(new Set(observed.map(({ flags }) => flags)), new Set(["r+"]));
});

test("an apply-file sync failure rolls back and removes temporary files before retry", async (t) => {
  const productRoot = await createProductFixture(t);
  const firstTarget = await writeProductFile(
    productRoot,
    "SYSTEM/backend/src/a-sync-retry.ts",
    "export const value = 'before';\n",
  );
  const secondTarget = await writeProductFile(
    productRoot,
    "SYSTEM/backend/src/b-sync-retry.ts",
    "export const value = 'before';\n",
  );
  await createUpdatePackage(productRoot, "sync-retry-0001", [
    {
      path: "SYSTEM/backend/src/a-sync-retry.ts",
      content: "export const value = 'after';\n",
    },
    {
      path: "SYSTEM/backend/src/b-sync-retry.ts",
      content: "export const value = 'after';\n",
    },
  ]);

  const originalOpen = fs.open;
  let temporarySyncs = 0;
  fs.open = async (file, flags, ...args) => {
    const handle = await originalOpen(file, flags, ...args);
    if (path.basename(String(file)).startsWith(".bonni-update-")) {
      temporarySyncs += 1;
      if (temporarySyncs === 2) {
        return {
          close: () => handle.close(),
          sync: async () => {
            const error = new Error("simulated Windows fsync failure");
            error.code = "EPERM";
            error.syscall = "fsync";
            throw error;
          },
        };
      }
    }
    return handle;
  };
  try {
    await assert.rejects(
      applyLocalSourceUpdate({ productRoot }),
      (error) => error?.code === "EPERM" && error?.syscall === "fsync",
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(await fs.readFile(firstTarget, "utf8"), "export const value = 'before';\n");
  assert.equal(await fs.readFile(secondTarget, "utf8"), "export const value = 'before';\n");
  const leftovers = [];
  async function findTemporaryFiles(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await findTemporaryFiles(child);
      else if (entry.name.startsWith(".bonni-update-")) leftovers.push(child);
    }
  }
  await findTemporaryFiles(productRoot);
  assert.deepEqual(leftovers, []);

  await applyAndFinalize(productRoot);
  assert.equal(await fs.readFile(firstTarget, "utf8"), "export const value = 'after';\n");
  assert.equal(await fs.readFile(secondTarget, "utf8"), "export const value = 'after';\n");
});

test("a staged package blocks setup/start until npm run update owns it", async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "waiting-0001", [
    { path: "SYSTEM/backend/src/waiting.ts", content: "export const waiting = true;\n" },
  ]);

  await assert.rejects(
    assertNoPendingLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_PACKAGE_WAITING_USE_NPM_RUN_UPDATE/u,
  );
});

test("a retry refuses changed program files while an update is pending", async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "pending-change-0001", [
    { path: "SYSTEM/backend/src/pending.ts", content: "export const pending = true;\n" },
  ]);
  await applyLocalSourceUpdate({ productRoot });
  await writeProductFile(productRoot, "SYSTEM/backend/src/pending.ts", "tampered while pending\n");

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_PENDING_TARGET_CHANGED/u,
  );
});

test("the first managed update never overwrites an existing unbound file", async (t) => {
  const productRoot = await createProductFixture(t);
  const target = await writeProductFile(
    productRoot,
    "SYSTEM/backend/src/existing.ts",
    "local existing source\n",
  );
  await createUpdatePackage(productRoot, "unbound-existing-0001", [
    {
      path: "SYSTEM/backend/src/existing.ts",
      content: "replacement\n",
      expectedPreviousSha256: null,
    },
  ]);

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_PREVIOUS_HASH_CONFLICT/u,
  );
  assert.equal(await fs.readFile(target, "utf8"), "local existing source\n");
});

test("Kontor updates require the exact installed Kontor source version", async (t) => {
  const productRoot = await createProductFixture(t);
  await writeProductFile(productRoot, "SYSTEM/app/kontorapp/package.json", `${JSON.stringify({
    name: "kontorapp",
    version: "0.19.3",
  })}\n`);
  await createUpdatePackage(productRoot, "kontor-version-0001", [
    { path: "SYSTEM/app/kontorapp/src/version.ts", content: "export const version = 'next';\n" },
  ], {
    from: { coreVersion: "0.1.19", kontorAppVersion: "9.9.9" },
    components: [{ key: "app.kontorapp", path: "SYSTEM/app/kontorapp", mode: "managed" }],
  });

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_KONTOR_VERSION_MISMATCH/u,
  );
});

test("the installed Core target version must match the manifest after apply", async (t) => {
  const productRoot = await createProductFixture(t);
  const target = path.join(productRoot, "SYSTEM", "backend", "src", "target-version.ts");
  await createUpdatePackage(productRoot, "target-version-0001", [
    { path: "SYSTEM/backend/src/target-version.ts", content: "must roll back\n" },
  ], {
    to: { coreVersion: "9.9.9", kontorAppVersion: "0.19.3" },
  });

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_BOOTSTRAP_CONTRACT_INVALID/u,
  );
  assert.equal(await exists(target), false);
});

test("an explicit delete cannot legitimize a locally modified active file", async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "explicit-delete-base-0001", [
    { path: "SYSTEM/backend/src/current.ts", content: "current\n" },
    { path: "SYSTEM/backend/src/remove.ts", content: "managed original\n" },
  ]);
  await applyAndFinalize(productRoot);
  const modified = Buffer.from("local modification\n");
  await writeProductFile(productRoot, "SYSTEM/backend/src/remove.ts", modified);
  await createUpdatePackage(productRoot, "explicit-delete-next-0002", [
    { path: "SYSTEM/backend/src/current.ts", content: "current next\n" },
  ], {
    delete: [{
      path: "SYSTEM/backend/src/remove.ts",
      expectedSha256: sha256(modified),
      reason: "must not override active ownership",
    }],
  });

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_DELETE_BASELINE_ACTIVE_MISMATCH/u,
  );
  assert.equal(
    await fs.readFile(path.join(productRoot, "SYSTEM", "backend", "src", "remove.ts"), "utf8"),
    "local modification\n",
  );
});

test("an automatically removed managed file may not reappear before finalize", async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "delete-base-0001", [
    { path: "SYSTEM/backend/src/current.ts", content: "current v1\n" },
    { path: "SYSTEM/backend/src/removed.ts", content: "remove me\n" },
  ]);
  await applyAndFinalize(productRoot);
  await createUpdatePackage(productRoot, "delete-next-0002", [
    { path: "SYSTEM/backend/src/current.ts", content: "current v2\n" },
  ]);
  const transaction = await applyLocalSourceUpdate({ productRoot });
  await writeProductFile(productRoot, "SYSTEM/backend/src/removed.ts", "reappeared\n");

  await assert.rejects(
    finalizeLocalSourceUpdate({ productRoot, transaction }),
    /SOURCE_UPDATE_PENDING_DELETE_REAPPEARED/u,
  );
});

test("active ownership is retained for components omitted by an intermediate update", async (t) => {
  const productRoot = await createProductFixture(t);
  const backendComponent = { key: "bonni-core-backend", path: "SYSTEM/backend", mode: "managed" };
  const frontendComponent = { key: "bonni-core-frontend", path: "SYSTEM/frontend", mode: "managed" };
  await createUpdatePackage(productRoot, "components-all-0001", [
    { path: "SYSTEM/backend/src/backend.ts", content: "backend v1\n" },
    { path: "SYSTEM/frontend/src/frontend.ts", content: "frontend v1\n" },
  ], { components: [backendComponent, frontendComponent] });
  await applyAndFinalize(productRoot);

  await createUpdatePackage(productRoot, "components-backend-0002", [
    { path: "SYSTEM/backend/src/backend.ts", content: "backend v2\n" },
  ], { components: [backendComponent] });
  await applyAndFinalize(productRoot);
  await writeProductFile(productRoot, "SYSTEM/frontend/src/frontend.ts", "locally changed frontend\n");

  await createUpdatePackage(productRoot, "components-frontend-0003", [
    { path: "SYSTEM/frontend/src/frontend.ts", content: "frontend v2\n" },
  ], { components: [frontendComponent] });
  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_(?:LOCAL_MODIFICATION_CONFLICT|BASELINE_ACTIVE_MISMATCH)/u,
  );
});

test("an orphaned transaction blocks setup/start and an invalid update handoff is rejected", async (t) => {
  const productRoot = await createProductFixture(t);
  const workRoot = path.join(productRoot, "UPDATE", ".bonni-work", "crashed-0001");
  await fs.mkdir(workRoot, { recursive: true });
  await fs.writeFile(path.join(workRoot, "journal.json"), `${JSON.stringify({
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    updateId: "crashed-0001",
    status: "prepared",
    operations: [],
  })}\n`);
  await assert.rejects(
    assertNoPendingLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_INCOMPLETE_TRANSACTION_USE_NPM_RUN_UPDATE/u,
  );
  await assert.rejects(
    assertPendingLocalSourceUpdate({
      productRoot,
      updateId: "crashed-0001",
      handoffToken: "0".repeat(64),
    }),
    /SOURCE_UPDATE_SETUP_HANDOFF_INVALID/u,
  );
});

test("UPDATE itself may not be a symlink or junction", { skip: process.platform === "win32" }, async (t) => {
  const productRoot = await createProductFixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-external-update-"));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, path.join(productRoot, "UPDATE"), "dir");
  const externalProductView = { root: productRoot };
  const packageRoot = path.join(external, "inbox", "symlink-0001");
  const content = Buffer.from("outside\n");
  await fs.mkdir(path.join(packageRoot, "payload", "SYSTEM", "backend", "src"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "payload", "SYSTEM", "backend", "src", "outside.ts"), content);
  await fs.writeFile(path.join(packageRoot, MANIFEST_NAME), `${JSON.stringify({
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    status: "UNPUBLISHED_TEST_UPDATE",
    updateId: "symlink-0001",
    channel: "development",
    from: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    to: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    components: [{ key: "bonni-core-backend", path: "SYSTEM/backend", mode: "managed" }],
    files: [{
      path: "SYSTEM/backend/src/outside.ts",
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      expectedPreviousSha256: null,
    }],
    delete: [],
  })}\n`);

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot: externalProductView.root }),
    /SOURCE_UPDATE_UNSAFE_UPDATE_ROOT/u,
  );
  assert.equal(await exists(packageRoot), true);
});

test("the internal update state may not be redirected through a symlink", { skip: process.platform === "win32" }, async (t) => {
  const productRoot = await createProductFixture(t);
  await createUpdatePackage(productRoot, "state-symlink-0001", [
    { path: "SYSTEM/backend/src/state.ts", content: "state\n" },
  ]);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-external-state-"));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, path.join(productRoot, "SYSTEM", ".bonni-source-update"), "dir");

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_UNSAFE_TARGET/u,
  );
  assert.deepEqual(await fs.readdir(external), []);
});

test("a committed finalize can resume cleanup without rerunning setup", async (t) => {
  const productRoot = await createProductFixture(t);
  const packageRoot = await createUpdatePackage(productRoot, "committed-resume-0001", [
    { path: "SYSTEM/backend/src/committed.ts", content: "committed\n" },
  ]);
  const transaction = await applyLocalSourceUpdate({ productRoot });
  const pendingPath = path.join(productRoot, "SYSTEM", ".bonni-source-update", "pending-update.json");
  const appliedPending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  await finalizeLocalSourceUpdate({ productRoot, transaction });

  await fs.mkdir(packageRoot, { recursive: true });
  const transactionRoot = path.join(productRoot, ...appliedPending.transactionPath.split("/"));
  await fs.mkdir(transactionRoot, { recursive: true });
  await fs.writeFile(pendingPath, `${JSON.stringify({
    ...appliedPending,
    phase: "committed",
    committedAt: new Date().toISOString(),
  })}\n`);

  const resumed = await applyLocalSourceUpdate({ productRoot });
  assert.equal(resumed.committed, true);
  await finalizeLocalSourceUpdate({ productRoot, transaction: resumed });
  assert.equal(await exists(packageRoot), false);
  assert.equal(await exists(transactionRoot), false);
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

test("an applied pending state recognizes an already committed journal without rerunning setup", async (t) => {
  const productRoot = await createProductFixture(t);
  const packageRoot = await createUpdatePackage(productRoot, "commit-window-0001", [
    { path: "SYSTEM/backend/src/commit-window.ts", content: "export const committed = true;\n" },
  ]);
  await applyLocalSourceUpdate({ productRoot });

  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  const pendingPath = path.join(stateRoot, "pending-update.json");
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, MANIFEST_NAME), "utf8"));
  const completedAt = new Date().toISOString();
  const active = {
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    updateId: pending.updateId,
    manifestSha256: pending.manifestSha256,
    completedAt,
    versions: manifest.to,
    components: manifest.components,
    files: manifest.files.map(({ path: filePath, sizeBytes, sha256: fileHash }) => ({
      path: filePath,
      sizeBytes,
      sha256: fileHash,
    })),
  };
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.writeFile(path.join(stateRoot, "active-manifest.json"), `${JSON.stringify(active)}\n`);
  await fs.writeFile(
    path.join(stateRoot, "history", `${pending.updateId}.json`),
    `${JSON.stringify({ ...active, status: "COMPLETED" })}\n`,
  );
  const journalPath = path.join(productRoot, ...pending.transactionPath.split("/"), "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  await fs.writeFile(journalPath, `${JSON.stringify({
    ...journal,
    status: "committed",
    committedAt: completedAt,
  })}\n`);

  const resumed = await applyLocalSourceUpdate({ productRoot });
  assert.equal(resumed.phase, "committed");
  assert.equal(resumed.committed, true);
  assert.equal(
    JSON.parse(await fs.readFile(pendingPath, "utf8")).phase,
    "committed",
  );
  await finalizeLocalSourceUpdate({ productRoot, transaction: resumed });
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

test("rollback preflights every target before restoring any file", async (t) => {
  const productRoot = await createProductFixture(t);
  const canonicalPackage = JSON.parse(
    await fs.readFile(path.join(productRoot, "SYSTEM", "backend", "package.json"), "utf8"),
  );
  canonicalPackage.description = "updated bootstrap";
  await createUpdatePackage(productRoot, "rollback-preflight-0001", [
    {
      path: "SYSTEM/backend/package.json",
      content: `${JSON.stringify(canonicalPackage, null, 2)}\n`,
    },
    {
      path: "SYSTEM/backend/scripts/setup/local-source-update.mjs",
      content: "// updated recovery updater\n",
    },
    {
      path: "SYSTEM/backend/scripts/setup/update-system.mjs",
      content: "// updated recovery launcher\n",
    },
    { path: "SYSTEM/backend/src/rollback-clean.ts", content: "export const clean = true;\n" },
  ]);
  await applyLocalSourceUpdate({ productRoot });

  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  const pendingPath = path.join(stateRoot, "pending-update.json");
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  const journalPath = path.join(productRoot, ...pending.transactionPath.split("/"), "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  const lateConflict = journal.operations[0];
  assert.equal(lateConflict.action, "write");
  await writeProductFile(productRoot, lateConflict.path, "local change during recovery\n");
  await fs.rm(pendingPath);

  const beforeRecovery = new Map();
  for (const operation of journal.operations) {
    const target = path.join(productRoot, ...operation.path.split("/"));
    const content = await fs.readFile(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    beforeRecovery.set(operation.path, content?.toString("base64") ?? null);
  }

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_ROLLBACK_CONFLICT/u,
  );
  for (const operation of journal.operations) {
    const target = path.join(productRoot, ...operation.path.split("/"));
    const content = await fs.readFile(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    assert.equal(content?.toString("base64") ?? null, beforeRecovery.get(operation.path));
  }
});

test("versioned local lifecycle marker is exact and survives a code rollback", async (t) => {
  const productRoot = await createProductFixture(t);
  const backendPackagePath = path.join(productRoot, "SYSTEM", "backend", "package.json");
  const backendLockPath = path.join(productRoot, "SYSTEM", "backend", "package-lock.json");
  const setInstalledVersion = async (version) => {
    const packageJson = JSON.parse(await fs.readFile(backendPackagePath, "utf8"));
    const packageLock = JSON.parse(await fs.readFile(backendLockPath, "utf8"));
    packageJson.version = version;
    packageLock.version = version;
    packageLock.packages[""].version = version;
    await fs.writeFile(backendPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await fs.writeFile(backendLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  };
  const createRevisionPackage = async (updateId, fromVersion, toVersion, markerName) => {
    const packageJson = JSON.parse(await fs.readFile(backendPackagePath, "utf8"));
    const packageLock = JSON.parse(await fs.readFile(backendLockPath, "utf8"));
    packageJson.version = toVersion;
    packageLock.version = toVersion;
    packageLock.packages[""].version = toVersion;
    return createUpdatePackage(productRoot, updateId, [
      { path: "SYSTEM/backend/package.json", content: `${JSON.stringify(packageJson, null, 2)}\n` },
      { path: "SYSTEM/backend/package-lock.json", content: `${JSON.stringify(packageLock, null, 2)}\n` },
      { path: `SYSTEM/backend/src/${markerName}.ts`, content: `export const revision = ${JSON.stringify(toVersion)};\n` },
    ], {
      from: { coreVersion: fromVersion, kontorAppVersion: "0.19.3" },
      to: { coreVersion: toVersion, kontorAppVersion: "0.19.3" },
    });
  };

  await setInstalledVersion("0.1.19+a");
  await createRevisionPackage("lifecycle-marker-b-0001", "0.1.19+a", "0.1.19+b", "revision-b");
  await applyAndFinalize(productRoot);

  const stateRoot = path.join(productRoot, "SYSTEM", ".bonni-source-update");
  const expectedMarker = {
    schemaVersion: "bonni.local-source-deployment-lifecycle/v1",
    mode: "local-source",
    required: true,
  };
  const activeB = JSON.parse(await fs.readFile(path.join(stateRoot, "active-manifest.json"), "utf8"));
  const historyB = JSON.parse(await fs.readFile(
    path.join(stateRoot, "history", "lifecycle-marker-b-0001.json"),
    "utf8",
  ));
  assert.deepEqual(activeB.localDeploymentLifecycle, expectedMarker);
  assert.deepEqual(historyB.localDeploymentLifecycle, expectedMarker);

  const completedB = JSON.parse(await fs.readFile(path.join(stateRoot, "deployment-lifecycle.json"), "utf8"));
  await fs.writeFile(path.join(stateRoot, "deployment-lifecycle.json"), `${JSON.stringify({
    ...completedB,
    status: "finalized",
    state: "finalized",
    generation: completedB.generation + 1,
    blocksUpdates: false,
    followUpdatesBlocked: false,
    canFinalize: false,
    canRollback: false,
  }, null, 2)}\n`);

  await createRevisionPackage("lifecycle-marker-c-0002", "0.1.19+b", "0.1.19+c", "revision-c");
  await applyAndFinalize(productRoot);
  const lifecycleCPath = path.join(stateRoot, "deployment-lifecycle.json");
  const lifecycleC = JSON.parse(await fs.readFile(lifecycleCPath, "utf8"));
  const previousActive = JSON.parse(await fs.readFile(
    path.join(stateRoot, ...lifecycleC.holdPath.split("/"), "previous-active-manifest.json"),
    "utf8",
  ));
  assert.deepEqual(previousActive.localDeploymentLifecycle, expectedMarker);

  const rollbackSource = path.join(stateRoot, ...lifecycleC.holdPath.split("/"), "package");
  const rollbackTarget = path.join(productRoot, "UPDATE", "inbox", lifecycleC.rollbackUpdateId);
  await fs.mkdir(path.dirname(rollbackTarget), { recursive: true });
  await fs.cp(rollbackSource, rollbackTarget, { recursive: true, errorOnExist: true, force: false });
  await fs.writeFile(lifecycleCPath, `${JSON.stringify({
    ...lifecycleC,
    status: "rolling-back",
    state: "rolling-back",
    generation: lifecycleC.generation + 1,
    canFinalize: false,
    canRollback: false,
  }, null, 2)}\n`);

  const rollback = await applyLocalSourceUpdate({ productRoot });
  await finalizeLocalSourceUpdate({
    productRoot,
    transaction: rollback,
    preserveCompletedPackage: true,
  });
  const restored = JSON.parse(await fs.readFile(path.join(stateRoot, "active-manifest.json"), "utf8"));
  assert.equal(restored.versions.coreVersion, "0.1.19+b");
  assert.deepEqual(restored.localDeploymentLifecycle, expectedMarker);

  const rollbackReceipt = JSON.parse(await fs.readFile(
    path.join(stateRoot, "history", `${lifecycleC.rollbackUpdateId}.json`),
    "utf8",
  ));
  assert.equal(
    rollbackReceipt.localDeploymentLifecycle,
    undefined,
    "the rollback receipt must remain readable by the restored previous updater",
  );
  const replay = await applyLocalSourceUpdate({ productRoot });
  assert.equal(replay.alreadyCompleted, true);
});

test("bootstrap scripts must be the exact setup, update and start gates", async (t) => {
  const productRoot = await createProductFixture(t);
  const originalPackage = await fs.readFile(
    path.join(productRoot, "SYSTEM", "backend", "package.json"),
    "utf8",
  );
  const deceptivePackage = {
    name: "bonni-core-backend",
    version: "0.1.19",
    private: true,
    scripts: {
      setup: "echo scripts/setup/setup-system.mjs",
      update: "echo scripts/setup/update-system.mjs",
      prestart: "echo scripts/setup/local-source-update-gate.mjs",
      predev: "echo scripts/setup/local-source-update-gate.mjs",
    },
  };
  await createUpdatePackage(productRoot, "deceptive-bootstrap-0001", [{
    path: "SYSTEM/backend/package.json",
    content: `${JSON.stringify(deceptivePackage, null, 2)}\n`,
  }]);

  await assert.rejects(
    applyLocalSourceUpdate({ productRoot }),
    /SOURCE_UPDATE_BOOTSTRAP_CONTRACT_INVALID/u,
  );
  assert.equal(
    await fs.readFile(path.join(productRoot, "SYSTEM", "backend", "package.json"), "utf8"),
    originalPackage,
  );
});

test("bootstrap contract accepts only the legacy or lifetime-wrapper start command", async (t) => {
  await t.test("accepts the lifetime-wrapper start command for a future release", async (t) => {
    const productRoot = await createProductFixture(t);
    const packagePath = path.join(productRoot, "SYSTEM", "backend", "package.json");
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    packageJson.scripts.start = "node scripts/runtime/run-host-backend-entry.mjs start";
    await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await createUpdatePackage(productRoot, "wrapper-bootstrap-0001", [{
      path: "SYSTEM/backend/src/wrapper-bootstrap.ts",
      content: "export const wrapperBootstrap = true;\n",
    }]);

    await applyAndFinalize(productRoot);
  });

  await t.test("rejects every start command outside the fixed allowlist", async (t) => {
    const productRoot = await createProductFixture(t);
    const packagePath = path.join(productRoot, "SYSTEM", "backend", "package.json");
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    packageJson.scripts.start = "node scripts/runtime/start-backend.mjs --unsafe-bypass";
    await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await createUpdatePackage(productRoot, "unknown-bootstrap-0001", [{
      path: "SYSTEM/backend/src/unknown-bootstrap.ts",
      content: "export const unknownBootstrap = true;\n",
    }]);

    await assert.rejects(
      applyLocalSourceUpdate({ productRoot }),
      /SOURCE_UPDATE_BOOTSTRAP_CONTRACT_INVALID/u,
    );
  });
});

test("update-system applies, runs the freshly installed setup process and finalizes", async (t) => {
  const productRoot = await createProductFixture(t);
  const setupDirectory = path.join(productRoot, "SYSTEM", "backend", "scripts", "setup");
  await fs.mkdir(setupDirectory, { recursive: true });
  for (const scriptName of ["local-source-update.mjs", "update-system.mjs"]) {
    await fs.copyFile(
      path.join(backendRoot, "scripts", "setup", scriptName),
      path.join(setupDirectory, scriptName),
    );
  }
  await fs.copyFile(
    path.join(backendRoot, "scripts", "runtime", "runtime-mode-exclusion.mjs"),
    path.join(productRoot, "SYSTEM", "backend", "scripts", "runtime", "runtime-mode-exclusion.mjs"),
  );
  const markerPath = path.join(productRoot, "setup-process-ran.txt");
  const setupSource = [
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    `await fs.writeFile(${JSON.stringify(markerPath)}, String(process.env.BONNI_LOCAL_SOURCE_UPDATE_ID || "missing"));`,
    'if (process.env.BONNI_SETUP_MODE !== "update") process.exitCode = 7;',
    "",
  ].join("\n");
  const packageRoot = await createUpdatePackage(productRoot, "wrapper-0001", [
    { path: "SYSTEM/backend/scripts/setup/setup-system.mjs", content: setupSource },
    { path: "SYSTEM/backend/src/wrapper.ts", content: "export const wrapper = true;\n" },
  ]);

  const result = await execFileAsync(process.execPath, [path.join(setupDirectory, "update-system.mjs")], {
    cwd: path.join(productRoot, "SYSTEM", "backend"),
    env: { ...process.env, NODE_ENV: "test" },
  });
  assert.match(result.stdout, /Aktualisierung erfolgreich abgeschlossen/u);
  assert.equal(await fs.readFile(markerPath, "utf8"), "wrapper-0001");
  assert.equal(await exists(packageRoot), false);
  assert.equal(
    await fs.readFile(path.join(productRoot, "SYSTEM", "backend", "src", "wrapper.ts"), "utf8"),
    "export const wrapper = true;\n",
  );
  await assert.doesNotReject(assertNoPendingLocalSourceUpdate({ productRoot }));
});

// The fixtures intentionally define the smallest public v1 manifest contract:
// The manifest also binds its unpublished-development status, source/target
// versions and the managed `SYSTEM/backend` component. Paths are product-root-
// relative (SYSTEM/...), and `files` is the complete managed tree for the new
// active state. Internal journal and active-state file locations are deliberately
// not asserted; their persisted effect is proven by the omitted-file test above.
assert.ok(SOURCE_UPDATE_SCHEMA, "SOURCE_UPDATE_SCHEMA muss öffentlich exportiert werden.");
