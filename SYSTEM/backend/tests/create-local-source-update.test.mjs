import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createLocalSourceUpdate } from "../scripts/setup/create-local-source-update.mjs";
import {
  SOURCE_UPDATE_PAYLOAD_LAYOUT,
  SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
  applyLocalSourceUpdate,
  finalizeLocalSourceUpdate,
  SOURCE_UPDATE_SCHEMA,
  sourceUpdatePayloadObjectName,
} from "../scripts/setup/local-source-update.mjs";

const executeFile = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderScript = path.join(backendRoot, "scripts", "setup", "create-local-source-update.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target) {
  return fs.lstat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function writeProductFile(productRoot, relativePath, value = "fixture\n") {
  const target = path.join(productRoot, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}

async function createProductFixture(t, {
  coreVersion = "0.1.20",
  kontorVersion = "0.19.4",
} = {}) {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-source-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  await writeProductFile(productRoot, "SYSTEM/backend/package.json", `${JSON.stringify({
    name: "bonni-core-backend",
    version: coreVersion,
    private: true,
    scripts: {
      setup: "node scripts/setup/setup-system.mjs",
      update: "node scripts/setup/update-system.mjs",
      prestart: "node scripts/runtime/local-source-update-start-gate.mjs",
      predev: "node scripts/setup/local-source-update-gate.mjs",
      start: "npm run maintenance:cleanup && npm run auth:ensure-jwt && node scripts/runtime/start-backend.mjs",
    },
  }, null, 2)}\n`);
  await writeProductFile(productRoot, "SYSTEM/backend/package-lock.json", `${JSON.stringify({
    name: "bonni-core-backend",
    version: coreVersion,
    lockfileVersion: 3,
    packages: { "": { name: "bonni-core-backend", version: coreVersion } },
  })}\n`);
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
  await writeProductFile(productRoot, "SYSTEM/backend/src/server.ts", "export const server = true;\n");
  await writeProductFile(productRoot, "SYSTEM/backend/.env.example", "JWT_SECRET=change-me\n");
  await writeProductFile(
    productRoot,
    "SYSTEM/frontend/package-lock.json",
    `${JSON.stringify({
      name: "bonni-core-frontend",
      version: coreVersion,
      lockfileVersion: 3,
      packages: { "": { name: "bonni-core-frontend", version: coreVersion } },
    })}\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/frontend/package.json",
    `${JSON.stringify({ name: "bonni-core-frontend", version: coreVersion })}\n`,
  );
  await writeProductFile(productRoot, "SYSTEM/frontend/src/main.jsx", "export default 'Bonni';\n");
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/manifest.ts",
    `const manifest = { key: "app.kontorapp", version: "${kontorVersion}" };\nexport default manifest;\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/package.json",
    `${JSON.stringify({ name: "bonni-kontorapp", version: kontorVersion })}\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/package-lock.json",
    `${JSON.stringify({
      name: "bonni-kontorapp",
      version: kontorVersion,
      lockfileVersion: 3,
      packages: { "": { name: "bonni-kontorapp", version: kontorVersion } },
    })}\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/backend/package.json",
    `${JSON.stringify({ name: "bonni-kontorapp-backend", version: kontorVersion })}\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/backend/package-lock.json",
    `${JSON.stringify({
      name: "bonni-kontorapp-backend",
      version: kontorVersion,
      lockfileVersion: 3,
      packages: { "": { name: "bonni-kontorapp-backend", version: kontorVersion } },
    })}\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/backend/src/register.ts",
    "export const register = true;\n",
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/frontend/package.json",
    `${JSON.stringify({ name: "kontorapp-frontend", version: kontorVersion })}\n`,
  );
  await writeProductFile(
    productRoot,
    "SYSTEM/app/kontorapp/frontend/package-lock.json",
    `${JSON.stringify({
      name: "kontorapp-frontend",
      version: kontorVersion,
      lockfileVersion: 3,
      packages: { "": { name: "kontorapp-frontend", version: kontorVersion } },
    })}\n`,
  );
  return productRoot;
}

async function readManifest(packageRoot) {
  return JSON.parse(await fs.readFile(path.join(packageRoot, "bonni-source-update.json"), "utf8"));
}

async function assertPayloadMatchesManifest(packageRoot, manifest) {
  const expectedObjects = new Set();
  const repairMode = manifest.payloadLayout === SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT;
  for (const entry of manifest.files) {
    const objectName = sourceUpdatePayloadObjectName(entry.sha256);
    const objectPath = path.join(packageRoot, "payload", objectName);
    if (!repairMode && entry.expectedPreviousSha256 === entry.sha256) {
      assert.equal(await exists(objectPath), false, `unchanged file must not be packaged: ${entry.path}`);
      continue;
    }
    expectedObjects.add(objectName);
    const payload = await fs.readFile(objectPath);
    const state = await fs.lstat(objectPath);
    assert.equal(state.isFile(), true);
    assert.equal(state.isSymbolicLink(), false);
    assert.equal(state.nlink, 1);
    assert.equal(payload.byteLength, entry.sizeBytes);
    assert.equal(sha256(payload), entry.sha256);
  }
  assert.deepEqual(
    (await fs.readdir(path.join(packageRoot, "payload"))).sort(),
    [...expectedObjects].sort(),
  );
}

test("repair packages contain every managed target object while keeping the payload flat", async (t) => {
  const productRoot = await createProductFixture(t);
  const baselineRoot = await createProductFixture(t, {
    coreVersion: "0.1.19",
    kontorVersion: "0.19.3",
  });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-repair-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  const created = await createLocalSourceUpdate({
    sourceProduct: productRoot,
    baselineProduct: baselineRoot,
    output,
    updateId: "repair-package-0001",
    fromCoreVersion: "0.1.19",
    fromKontorAppVersion: "0.19.3",
    payloadMode: "repair",
  });
  const manifest = await readManifest(created.packageRoot);
  assert.equal(manifest.payloadLayout, SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT);
  await assertPayloadMatchesManifest(created.packageRoot, manifest);

  const expectedObjects = new Set(manifest.files.map((entry) => (
    sourceUpdatePayloadObjectName(entry.sha256)
  )));
  const actualObjects = await fs.readdir(path.join(created.packageRoot, "payload"));
  assert.deepEqual(actualObjects.sort(), [...expectedObjects].sort());
  assert.equal(actualObjects.every((name) => /^[a-f0-9]{64}\.bin$/u.test(name)), true);

  const unchanged = manifest.files.find((entry) => (
    entry.path === "SYSTEM/backend/src/server.ts"
    && entry.expectedPreviousSha256 === entry.sha256
  ));
  assert.ok(unchanged, "fixture must contain an unchanged managed file");
  assert.equal(
    await exists(path.join(created.packageRoot, "payload", sourceUpdatePayloadObjectName(unchanged.sha256))),
    true,
  );
});

test("builder creates a deterministic, source-only package accepted by the v1 updater", async (t) => {
  const productRoot = await createProductFixture(t);
  const baselineRoot = await createProductFixture(t, {
    coreVersion: "0.1.19",
    kontorVersion: "0.19.3",
  });
  await writeProductFile(productRoot, "SYSTEM/backend/src/new-only.ts", "export const added = true;\n");
  const longLogicalPath = "SYSTEM/app/kontorapp/frontend/src/kontorapp/WorkSpace/Manager/WorkArea/member/views/members/components/MemberFinanceHistoryPanel.jsx";
  await writeProductFile(productRoot, longLogicalPath, "export default 'new finance history';\n");
  await writeProductFile(baselineRoot, longLogicalPath, "export default 'old finance history';\n");
  const obsoleteBaselineFile = await writeProductFile(
    baselineRoot,
    "SYSTEM/backend/src/obsolete.ts",
    "export const obsolete = true;\n",
  );
  await writeProductFile(
    baselineRoot,
    "SYSTEM/backend/storage/baseline-private.json",
    "must never become a deletion\n",
  );
  const excludedPaths = [
    "SYSTEM/backend/node_modules/pkg/index.js",
    "SYSTEM/backend/dist/server.js",
    "SYSTEM/backend/build/generated.js",
    "SYSTEM/backend/coverage/report.json",
    "SYSTEM/backend/.cache/cache.bin",
    "SYSTEM/backend/.eslintcache",
    "SYSTEM/backend/cache/cache.bin",
    "SYSTEM/backend/caches/cache.bin",
    "SYSTEM/backend/archives/archive.zip",
    "SYSTEM/backend/backups/backup.zip",
    "SYSTEM/backend/data/private.json",
    "SYSTEM/backend/docs/generated.pdf",
    "SYSTEM/backend/logs/system.log",
    "SYSTEM/backend/run_system/runtime.json",
    "SYSTEM/backend/storage/private.bin",
    "SYSTEM/backend/uploads/upload.bin",
    "SYSTEM/backend/updates/pending.json",
    "SYSTEM/backend/public/system/index.html",
    "SYSTEM/backend/prisma/domains/assembled/app/schema.prisma",
    "SYSTEM/backend/config/update/keys/private.pem",
    "SYSTEM/backend/config/update/trusted-keys/release.jwk",
    "SYSTEM/backend/.bonni-source-update/active-manifest.json",
    "SYSTEM/backend/.env",
    "SYSTEM/backend/.env.local",
    "SYSTEM/backend/local.sqlite",
    "SYSTEM/backend/private.key",
    "SYSTEM/frontend/dist/index.html",
    "SYSTEM/frontend/uploads/avatar.png",
    "SYSTEM/frontend/public/uploads/avatar.png",
    "SYSTEM/app/kontorapp/frontend/node_modules/vite/index.js",
    "SYSTEM/app/kontorapp/frontend/dist/index.html",
    "SYSTEM/app/kontorapp/frontend/coverage/report.json",
    "SYSTEM/app/kontorapp/backend/prisma/domains/assembled/schema.prisma",
  ];
  for (const excludedPath of excludedPaths) await writeProductFile(productRoot, excludedPath, "excluded\n");

  const firstOutput = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-output-a-"));
  const secondOutput = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-output-b-"));
  t.after(() => fs.rm(firstOutput, { recursive: true, force: true }));
  t.after(() => fs.rm(secondOutput, { recursive: true, force: true }));

  const options = {
    sourceProduct: productRoot,
    baselineProduct: baselineRoot,
    updateId: "core-0.1.20-kontor-0.19.4-test.1",
    fromCoreVersion: "0.1.19",
    fromKontorAppVersion: "0.19.3",
    releaseNotes: {
      title: "Sicherer und übersichtlicher aktualisieren",
      summary: "Die neue Update-Seite zeigt Änderungen, Fortschritt und das Ergebnis dauerhaft an.",
      changes: [{
        type: "improvement",
        title: "Eigene Update-Seite",
        detail: "Aktualisierungen werden mit Verlauf, Fortschrittsanzeige und Abschlussstatus dargestellt.",
      }],
    },
  };
  const first = await createLocalSourceUpdate({ ...options, output: firstOutput });
  const second = await createLocalSourceUpdate({ ...options, output: secondOutput });
  const manifest = await readManifest(first.packageRoot);

  assert.deepEqual(manifest, {
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    status: "UNPUBLISHED_TEST_UPDATE",
    updateId: options.updateId,
    channel: "development",
    payloadLayout: SOURCE_UPDATE_PAYLOAD_LAYOUT,
    requires: null,
    releaseNotes: options.releaseNotes,
    from: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    to: { coreVersion: "0.1.20", kontorAppVersion: "0.19.4" },
    components: [
      { key: "bonni-core-backend", path: "SYSTEM/backend", mode: "managed" },
      { key: "bonni-core-frontend", path: "SYSTEM/frontend", mode: "managed" },
      { key: "app.kontorapp", path: "SYSTEM/app/kontorapp", mode: "managed" },
    ],
    files: manifest.files,
    delete: manifest.delete,
  });
  const manifestPaths = manifest.files.map((entry) => entry.path);
  assert.deepEqual(manifestPaths, [...manifestPaths].sort((left, right) => (
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  )));
  assert.equal(manifestPaths.includes("SYSTEM/backend/.env.example"), true);
  assert.equal(manifestPaths.includes("SYSTEM/backend/src/server.ts"), true);
  assert.equal(manifestPaths.includes("SYSTEM/frontend/src/main.jsx"), true);
  assert.equal(manifestPaths.includes("SYSTEM/app/kontorapp/backend/src/register.ts"), true);
  const longEntry = manifest.files.find((entry) => entry.path === longLogicalPath);
  assert.ok(longEntry);
  assert.equal(
    await exists(path.join(first.packageRoot, "payload", sourceUpdatePayloadObjectName(longEntry.sha256))),
    true,
  );
  const formerArchivePath = `C:\\2026.08.20__Bonni Core\\UPDATE\\.bonni-bootstrap\\staged\\dev-core-0.1.19-kontor-0.19.3-control-center-update-20260821-02a\\payload\\${longLogicalPath.replaceAll("/", "\\")}`;
  const indexedArchivePath = `C:\\2026.08.20__Bonni Core\\UPDATE\\.b\\a\\payload\\${sourceUpdatePayloadObjectName(longEntry.sha256)}`;
  assert.ok(formerArchivePath.length >= 260, "fixture must reproduce the former Windows path limit");
  assert.ok(indexedArchivePath.length < 180, "content-addressed payload path must stay short");
  const baselineServer = await fs.readFile(
    path.join(baselineRoot, "SYSTEM", "backend", "src", "server.ts"),
  );
  assert.equal(
    manifest.files.find((entry) => entry.path === "SYSTEM/backend/src/server.ts")
      ?.expectedPreviousSha256,
    sha256(baselineServer),
  );
  assert.equal(
    manifest.files.find((entry) => entry.path === "SYSTEM/backend/src/new-only.ts")
      ?.expectedPreviousSha256,
    null,
  );
  assert.deepEqual(manifest.delete, [{
    path: "SYSTEM/backend/src/obsolete.ts",
    expectedSha256: sha256(await fs.readFile(obsoleteBaselineFile)),
    reason: "Im neuen verwalteten Quellstand nicht mehr enthalten.",
  }]);
  for (const excludedPath of excludedPaths) {
    assert.equal(manifestPaths.includes(excludedPath), false, `must exclude ${excludedPath}`);
    assert.equal(await exists(path.join(first.packageRoot, "payload", ...excludedPath.split("/"))), false);
  }
  await assertPayloadMatchesManifest(first.packageRoot, manifest);
  assert.equal(
    await fs.readFile(first.manifestPath, "utf8"),
    await fs.readFile(second.manifestPath, "utf8"),
    "same input and arguments must produce byte-identical manifests",
  );

  const internalOutput = path.join(productRoot, "UPDATE", ".package-build");
  const internal = await createLocalSourceUpdate({
    ...options,
    output: internalOutput,
    updateId: "integration-accepted-0001",
  });
  const installedPackage = path.join(
    baselineRoot,
    "UPDATE",
    "inbox",
    "integration-accepted-0001",
  );
  await fs.mkdir(path.dirname(installedPackage), { recursive: true });
  await fs.cp(internal.packageRoot, installedPackage, { recursive: true, errorOnExist: true });
  const transaction = await applyLocalSourceUpdate({ productRoot: baselineRoot });
  assert.equal(transaction.packageRoot, installedPackage);
  await finalizeLocalSourceUpdate({ productRoot: baselineRoot, transaction });
  assert.equal(await exists(installedPackage), false);
  assert.equal(await exists(obsoleteBaselineFile), false);
});

test("builder rejects unbounded release notes without leaving a package", async (t) => {
  const productRoot = await createProductFixture(t);
  const baselineRoot = await createProductFixture(t, {
    coreVersion: "0.1.19",
    kontorVersion: "0.19.3",
  });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-release-notes-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  await assert.rejects(
    createLocalSourceUpdate({
      sourceProduct: productRoot,
      baselineProduct: baselineRoot,
      output,
      updateId: "invalid-release-notes-0001",
      fromCoreVersion: "0.1.19",
      fromKontorAppVersion: "0.19.3",
      releaseNotes: {
        title: "Update",
        summary: "Beschreibung",
        changes: [{ type: "html", title: "Nicht erlaubt", detail: "Unbekannter Typ" }],
      },
    }),
    /LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID:changes\.0\.type/u,
  );
  assert.equal(await exists(path.join(output, "invalid-release-notes-0001")), false);
});

test("CLI derives target versions and writes the requested nested package", async (t) => {
  const productRoot = await createProductFixture(t);
  const baselineRoot = await createProductFixture(t, {
    coreVersion: "0.1.19",
    kontorVersion: "0.19.3",
  });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-cli-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  const { stdout } = await executeFile(process.execPath, [
    builderScript,
    "--source-product", productRoot,
    "--baseline-product", baselineRoot,
    "--output", output,
    "--update-id", "cli-package-0001",
    "--from-core", "0.1.19",
    "--from-kontor", "0.19.3",
  ]);

  const packageRoot = path.join(output, "cli-package-0001");
  const manifest = await readManifest(packageRoot);
  assert.match(stdout, /cli-package-0001/u);
  assert.deepEqual(manifest.to, { coreVersion: "0.1.20", kontorAppVersion: "0.19.4" });
  await assertPayloadMatchesManifest(packageRoot, manifest);
});

test("builder records an exact predecessor and rejects incomplete or invalid predecessor proof", async (t) => {
  const productRoot = await createProductFixture(t);
  const baselineRoot = await createProductFixture(t, {
    coreVersion: "0.1.19",
    kontorVersion: "0.19.3",
  });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-predecessor-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const baseOptions = {
    sourceProduct: productRoot,
    baselineProduct: baselineRoot,
    output,
    fromCoreVersion: "0.1.19",
    fromKontorAppVersion: "0.19.3",
  };
  const predecessor = {
    updateId: "required-update-0001",
    manifestSha256: "a".repeat(64),
  };
  const created = await createLocalSourceUpdate({
    ...baseOptions,
    updateId: "requires-valid-0002",
    requiresUpdateId: predecessor.updateId,
    requiresManifestSha256: predecessor.manifestSha256,
  });
  assert.deepEqual((await readManifest(created.packageRoot)).requires, predecessor);

  await assert.rejects(
    createLocalSourceUpdate({
      ...baseOptions,
      updateId: "requires-incomplete-0003",
      requiresUpdateId: predecessor.updateId,
    }),
    /LOCAL_SOURCE_UPDATE_REQUIRED_PREDECESSOR_INCOMPLETE/u,
  );
  await assert.rejects(
    createLocalSourceUpdate({
      ...baseOptions,
      updateId: "requires-invalid-0004",
      requiresUpdateId: predecessor.updateId,
      requiresManifestSha256: "invalid",
    }),
    /LOCAL_SOURCE_UPDATE_REQUIRED_PREDECESSOR_HASH_INVALID/u,
  );
  assert.equal(await exists(path.join(output, "requires-incomplete-0003")), false);
  assert.equal(await exists(path.join(output, "requires-invalid-0004")), false);
});

test("builder fails closed for an existing target and unsafe output inside the source tree", async (t) => {
  const productRoot = await createProductFixture(t);
  const baselineRoot = await createProductFixture(t, {
    coreVersion: "0.1.19",
    kontorVersion: "0.19.3",
  });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-existing-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const packageRoot = path.join(output, "existing-0001");
  const marker = await writeProductFile(packageRoot, "owner.txt", "do not replace\n");

  await assert.rejects(
    createLocalSourceUpdate({
      sourceProduct: productRoot,
      output,
      updateId: "missing-baseline-0001",
      fromCoreVersion: "0.1.19",
      fromKontorAppVersion: "0.19.3",
    }),
    /LOCAL_SOURCE_UPDATE_ARGUMENT_REQUIRED:baselineProduct/u,
  );
  assert.equal(await exists(path.join(output, "missing-baseline-0001")), false);

  await assert.rejects(
    createLocalSourceUpdate({
      sourceProduct: productRoot,
      baselineProduct: baselineRoot,
      output,
      updateId: "wrong-baseline-version-0001",
      fromCoreVersion: "9.9.9",
      fromKontorAppVersion: "0.19.3",
    }),
    /LOCAL_SOURCE_UPDATE_BASELINE_VERSION_MISMATCH/u,
  );
  assert.equal(await exists(path.join(output, "wrong-baseline-version-0001")), false);

  await assert.rejects(
    createLocalSourceUpdate({
      sourceProduct: productRoot,
      baselineProduct: baselineRoot,
      output,
      updateId: "existing-0001",
      fromCoreVersion: "0.1.19",
      fromKontorAppVersion: "0.19.3",
    }),
    /LOCAL_SOURCE_UPDATE_TARGET_EXISTS/u,
  );
  assert.equal(await fs.readFile(marker, "utf8"), "do not replace\n");

  await assert.rejects(
    createLocalSourceUpdate({
      sourceProduct: productRoot,
      baselineProduct: baselineRoot,
      output: path.join(productRoot, "SYSTEM", "backend", "package-output"),
      updateId: "unsafe-output-0001",
      fromCoreVersion: "0.1.19",
      fromKontorAppVersion: "0.19.3",
    }),
    /LOCAL_SOURCE_UPDATE_OUTPUT_INSIDE_SOURCE/u,
  );
  assert.equal(await exists(path.join(productRoot, "SYSTEM", "backend", "package-output")), false);
});

test("builder rejects source symlinks and hardlinks without leaving a package", async (t) => {
  await t.test("symlink", async (t) => {
    const productRoot = await createProductFixture(t);
    const baselineRoot = await createProductFixture(t, {
      coreVersion: "0.1.19",
      kontorVersion: "0.19.3",
    });
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-symlink-"));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const link = path.join(productRoot, "SYSTEM", "backend", "src", "server-link.ts");
    await fs.symlink("server.ts", link);

    await assert.rejects(
      createLocalSourceUpdate({
        sourceProduct: productRoot,
        baselineProduct: baselineRoot,
        output,
        updateId: "symlink-0001",
        fromCoreVersion: "0.1.19",
        fromKontorAppVersion: "0.19.3",
      }),
      /LOCAL_SOURCE_UPDATE_SYMLINK_REJECTED:SYSTEM\/backend\/src\/server-link\.ts/u,
    );
    assert.equal(await exists(path.join(output, "symlink-0001")), false);
  });

  await t.test("hardlink", async (t) => {
    const productRoot = await createProductFixture(t);
    const baselineRoot = await createProductFixture(t, {
      coreVersion: "0.1.19",
      kontorVersion: "0.19.3",
    });
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-package-hardlink-"));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const source = path.join(productRoot, "SYSTEM", "frontend", "src", "main.jsx");
    await fs.link(source, path.join(productRoot, "SYSTEM", "frontend", "src", "main-copy.jsx"));

    await assert.rejects(
      createLocalSourceUpdate({
        sourceProduct: productRoot,
        baselineProduct: baselineRoot,
        output,
        updateId: "hardlink-0001",
        fromCoreVersion: "0.1.19",
        fromKontorAppVersion: "0.19.3",
      }),
      /LOCAL_SOURCE_UPDATE_HARDLINK_REJECTED/u,
    );
    assert.equal(await exists(path.join(output, "hardlink-0001")), false);
  });
});
