import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPrebuiltFrontendMarker,
  resolveFrontendSetupMode,
  verifyPrebuiltFrontend,
} from "../scripts/setup/prebuilt-frontend.mjs";
import {
  cleanupOrphanedFrontendBuilds,
  cleanupStagedFrontendBuild,
  createSetupStages,
  publishFrontend,
  stageFrontendSourceForUpdate,
} from "../scripts/setup/setup-system.mjs";
import { cleanupFrontendDist } from "../scripts/maintenance/cleanup-stale-technical-data.mjs";

async function createFrontendPublicationFixture(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemDirectory = path.join(root, "SYSTEM");
  const backendDirectory = path.join(systemDirectory, "backend");
  const buildDirectory = path.join(systemDirectory, "frontend", "dist");
  const publishedDirectory = path.join(backendDirectory, "public", "system");
  await fs.mkdir(path.join(buildDirectory, "assets"), { recursive: true });
  await fs.mkdir(publishedDirectory, { recursive: true });
  return {
    systemDirectory,
    backendDirectory,
    buildDirectory,
    publishedDirectory,
    transactionRoot: path.join(systemDirectory, ".bonni-frontend-publish"),
  };
}

async function writeValidFrontend(root, name) {
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "index.html"),
    `<script type="module" src="/assets/${name}.js"></script><div id="root"></div>`,
  );
  await fs.writeFile(path.join(root, "assets", `${name}.js`), `export const release = "${name}";\n`);
}

test("setup preserves a complete prebuilt frontend when source is absent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-prebuilt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frontendRoot = path.join(root, "frontend");
  const published = path.join(root, "backend", "public", "system");
  await fs.mkdir(path.join(published, "assets"), { recursive: true });
  await fs.writeFile(path.join(published, "index.html"), '<script type="module" src="/assets/app.js"></script><div id="root"></div>');
  await fs.writeFile(path.join(published, "assets", "app.js"), "export {};\n");
  const marker = await createPrebuiltFrontendMarker(published);
  assert.match(marker.treeSha256, /^[a-f0-9]{64}$/u);
  assert.equal(await resolveFrontendSetupMode({ frontendRoot, publishedFrontendRoot: published }), "prebuilt");
  assert.equal((await verifyPrebuiltFrontend(published)).treeSha256, marker.treeSha256);
});

test("setup fails closed without a source frontend and valid exact-tree marker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-prebuilt-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frontendRoot = path.join(root, "frontend");
  const published = path.join(root, "published");
  await fs.mkdir(published, { recursive: true });
  await fs.mkdir(path.join(published, "assets"), { recursive: true });
  await fs.writeFile(path.join(published, "index.html"), '<script type="module" src="/assets/app.js"></script>');
  await fs.writeFile(path.join(published, "assets", "app.js"), "export {};\n");
  await assert.rejects(
    resolveFrontendSetupMode({ frontendRoot, publishedFrontendRoot: published }),
    /SETUP_PREBUILT_FRONTEND_MARKER_MISSING/u,
  );
  await createPrebuiltFrontendMarker(published);
  await fs.writeFile(path.join(published, "extra.js"), "tampered");
  await assert.rejects(verifyPrebuiltFrontend(published), /SETUP_PREBUILT_FRONTEND_EXACT_TREE_MISMATCH/u);
});

test("a real source frontend selects source build mode without trusting old public output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-source-fe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frontendRoot = path.join(root, "frontend");
  await fs.mkdir(frontendRoot, { recursive: true });
  await fs.writeFile(path.join(frontendRoot, "package.json"), "{}\n");
  assert.equal(await resolveFrontendSetupMode({ frontendRoot, publishedFrontendRoot: path.join(root, "missing") }), "source");
});

test("frontend publication validates a staging tree before replacing the working frontend", async (t) => {
  const fixture = await createFrontendPublicationFixture(t, "bonni-frontend-publish-fail-");
  await fs.writeFile(path.join(fixture.publishedDirectory, "index.html"), "working frontend\n");
  await fs.writeFile(path.join(fixture.buildDirectory, "index.html"), "invalid build without an asset entry\n");

  await assert.rejects(
    publishFrontend(fixture),
    /SETUP_PREBUILT_FRONTEND_ASSET_BINDING_MISSING/u,
  );

  assert.equal(
    await fs.readFile(path.join(fixture.publishedDirectory, "index.html"), "utf8"),
    "working frontend\n",
  );
  assert.equal(await fs.lstat(fixture.transactionRoot).catch(() => null), null);
});

test("frontend publication restores the previous tree after a crash between directory swaps", async (t) => {
  const fixture = await createFrontendPublicationFixture(t, "bonni-frontend-publish-crash-");
  await fs.writeFile(path.join(fixture.publishedDirectory, "index.html"), "previous working frontend\n");
  await fs.writeFile(path.join(fixture.buildDirectory, "index.html"), "invalid retry build\n");
  const previousDirectory = path.join(fixture.transactionRoot, "previous");
  const stagedDirectory = path.join(fixture.transactionRoot, "staged");
  await fs.mkdir(fixture.transactionRoot, { recursive: true });
  await fs.rename(fixture.publishedDirectory, previousDirectory);
  await fs.mkdir(stagedDirectory);
  await fs.writeFile(path.join(stagedDirectory, "partial.txt"), "interrupted copy\n");

  await assert.rejects(
    publishFrontend(fixture),
    /SETUP_PREBUILT_FRONTEND_ASSET_BINDING_MISSING/u,
  );

  assert.equal(
    await fs.readFile(path.join(fixture.publishedDirectory, "index.html"), "utf8"),
    "previous working frontend\n",
  );
  assert.equal(await fs.lstat(fixture.transactionRoot).catch(() => null), null);
});

test("a verified frontend tree is swapped in and leaves no publication transaction", async (t) => {
  const fixture = await createFrontendPublicationFixture(t, "bonni-frontend-publish-success-");
  await fs.writeFile(path.join(fixture.publishedDirectory, "index.html"), "old frontend\n");
  await writeValidFrontend(fixture.buildDirectory, "index-current");

  await publishFrontend(fixture);

  const marker = await verifyPrebuiltFrontend(fixture.publishedDirectory);
  assert.ok(marker.files.some((entry) => entry.path === "assets/index-current.js"));
  assert.match(
    await fs.readFile(path.join(fixture.publishedDirectory, "index.html"), "utf8"),
    /index-current\.js\?core=0\.1\.19/u,
  );
  assert.equal(await fs.lstat(fixture.transactionRoot).catch(() => null), null);
});

test("an update builds from state-internal frontend staging without touching the live Rollup tree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-frontend-update-staging-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemDirectory = path.join(root, "SYSTEM");
  const backendDirectory = path.join(systemDirectory, "backend");
  const frontendDirectory = path.join(systemDirectory, "frontend");
  const workspaceDirectory = path.join(systemDirectory, ".bonni-source-update", "f");
  const liveRollupFile = path.join(
    frontendDirectory,
    "node_modules",
    "@rollup",
    "rollup-win32-x64-msvc",
    "rollup.win32-x64-msvc.node",
  );
  const liveBuildDirectory = path.join(frontendDirectory, "dist");
  const publishedDirectory = path.join(backendDirectory, "public", "system");
  const orphanedStagingDirectory = path.join(workspaceDirectory, "crashed-previous-run");

  await fs.mkdir(path.join(frontendDirectory, "src"), { recursive: true });
  await fs.mkdir(path.dirname(liveRollupFile), { recursive: true });
  await fs.mkdir(backendDirectory, { recursive: true });
  await fs.writeFile(path.join(frontendDirectory, "package.json"), "{}\n");
  await fs.writeFile(path.join(frontendDirectory, "package-lock.json"), "{}\n");
  await fs.writeFile(path.join(frontendDirectory, "src", "main.jsx"), "export {};\n");
  await fs.writeFile(liveRollupFile, "live native Rollup binary\n");
  await writeValidFrontend(liveBuildDirectory, "live-old");
  await fs.mkdir(path.join(orphanedStagingDirectory, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(orphanedStagingDirectory, "node_modules", "stale-rollup.node"),
    "stale build\n",
  );

  const staged = await stageFrontendSourceForUpdate({
    systemDirectory,
    frontendDirectory,
    workspaceDirectory,
  });

  assert.equal(staged.sourceDirectory.startsWith(`${workspaceDirectory}${path.sep}`), true);
  assert.equal(await fs.lstat(orphanedStagingDirectory).catch(() => null), null);
  assert.equal(
    await fs.readFile(path.join(staged.sourceDirectory, "src", "main.jsx"), "utf8"),
    "export {};\n",
  );
  assert.equal(await fs.lstat(path.join(staged.sourceDirectory, "node_modules")).catch(() => null), null);
  assert.equal(await fs.lstat(staged.buildDirectory).catch(() => null), null);

  const updateStages = createSetupStages("source", {
    frontendDirectory: staged.sourceDirectory,
  });
  const updateFrontendStages = updateStages.filter(([label]) => label.startsWith("Frontend"));
  assert.equal(updateFrontendStages.length, 2);
  assert.equal(
    updateFrontendStages.every(([, cwd]) => cwd === staged.sourceDirectory),
    true,
  );
  assert.equal(
    updateFrontendStages.every(([, cwd]) => cwd !== frontendDirectory),
    true,
  );

  const normalStages = createSetupStages("source", { frontendDirectory });
  assert.equal(
    normalStages.filter(([label]) => label.startsWith("Frontend")).every(([, cwd]) => cwd === frontendDirectory),
    true,
  );

  await writeValidFrontend(staged.buildDirectory, "isolated-current");
  await publishFrontend({
    systemDirectory,
    backendDirectory,
    buildDirectory: staged.buildDirectory,
    publishedDirectory,
  });

  assert.equal(await fs.readFile(liveRollupFile, "utf8"), "live native Rollup binary\n");
  assert.match(
    await fs.readFile(path.join(liveBuildDirectory, "index.html"), "utf8"),
    /live-old\.js/u,
  );
  const marker = await verifyPrebuiltFrontend(publishedDirectory);
  assert.ok(marker.files.some((entry) => entry.path === "assets/isolated-current.js"));

  assert.equal(await cleanupStagedFrontendBuild({
    systemDirectory,
    workspaceDirectory,
    stagingDirectory: staged.sourceDirectory,
  }), true);
  assert.equal(await fs.lstat(staged.sourceDirectory).catch(() => null), null);
});

test("frontend staging cleanup retries transient Windows locks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-frontend-staging-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemDirectory = path.join(root, "SYSTEM");
  const workspaceDirectory = path.join(systemDirectory, ".bonni-source-update", "f");
  const stagingDirectory = path.join(workspaceDirectory, "interrupted-run");
  await fs.mkdir(path.join(stagingDirectory, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(stagingDirectory, "node_modules", "locked.node"), "locked\n");

  let removeAttempts = 0;
  const waits = [];
  const fileSystem = {
    async rm(target, options) {
      removeAttempts += 1;
      if (removeAttempts <= 2) {
        const error = new Error("temporary Windows lock");
        error.code = removeAttempts === 1 ? "EPERM" : "EBUSY";
        throw error;
      }
      await fs.rm(target, options);
    },
    async rmdir(target) {
      await fs.rmdir(target);
    },
  };

  assert.equal(await cleanupStagedFrontendBuild({
    systemDirectory,
    workspaceDirectory,
    stagingDirectory,
    fileSystem,
    retryDelays: [1, 2],
    wait: async (milliseconds) => waits.push(milliseconds),
  }), true);
  assert.equal(removeAttempts, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(await fs.lstat(stagingDirectory).catch(() => null), null);
});

test("orphan staging discovery retries a transient Windows workspace lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-frontend-orphan-scan-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemDirectory = path.join(root, "SYSTEM");
  const workspaceDirectory = path.join(systemDirectory, ".bonni-source-update", "f");
  const stagingDirectory = path.join(workspaceDirectory, "crashed-run");
  await fs.mkdir(stagingDirectory, { recursive: true });
  await fs.writeFile(path.join(stagingDirectory, "partial.txt"), "partial\n");

  let inspectAttempts = 0;
  const waits = [];
  const fileSystem = {
    async lstat(target) {
      inspectAttempts += 1;
      if (inspectAttempts <= 2) {
        const error = new Error("temporary workspace lock");
        error.code = inspectAttempts === 1 ? "EACCES" : "EPERM";
        throw error;
      }
      return fs.lstat(target);
    },
    async readdir(target, options) {
      return fs.readdir(target, options);
    },
    async rm(target, options) {
      await fs.rm(target, options);
    },
    async rmdir(target) {
      await fs.rmdir(target);
    },
  };

  assert.equal(await cleanupOrphanedFrontendBuilds({
    systemDirectory,
    workspaceDirectory,
    fileSystem,
    retryDelays: [1, 2],
    wait: async (milliseconds) => waits.push(milliseconds),
  }), true);
  assert.equal(inspectAttempts, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(await fs.lstat(stagingDirectory).catch(() => null), null);
});

test("update frontend staging rejects linked source entries and removes its partial copy", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-frontend-unsafe-staging-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemDirectory = path.join(root, "SYSTEM");
  const frontendDirectory = path.join(systemDirectory, "frontend");
  const workspaceDirectory = path.join(systemDirectory, ".bonni-source-update", "f");
  const externalSource = path.join(root, "external.jsx");
  await fs.mkdir(path.join(frontendDirectory, "src"), { recursive: true });
  await fs.writeFile(path.join(frontendDirectory, "package.json"), "{}\n");
  await fs.writeFile(externalSource, "export {};\n");
  await fs.symlink(externalSource, path.join(frontendDirectory, "src", "linked.jsx"));

  await assert.rejects(
    stageFrontendSourceForUpdate({
      systemDirectory,
      frontendDirectory,
      workspaceDirectory,
    }),
    /SETUP_FRONTEND_SOURCE_TREE_UNSAFE:src\/linked\.jsx/u,
  );

  assert.equal(await fs.lstat(workspaceDirectory).catch(() => null), null);
});

test("the shipped prebuilt frontend is exactly bound to Core 0.1.19+a and contains no 0.1.18 cache identity", async (t) => {
  const backendRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const published = path.join(backendRoot, "public", "system");
  if (!(await fs.lstat(path.join(published, "index.html")).catch(() => null))?.isFile()) {
    t.skip("Das reine Entwicklungs-Quellpaket enthaelt bewusst kein vorgebautes Frontend.");
    return;
  }
  const index = await fs.readFile(path.join(published, "index.html"), "utf8");
  const marker = await verifyPrebuiltFrontend(published);
  const scriptMatches = [...index.matchAll(/\bsrc=["']\/(assets\/index-[^"'?]+\.js)\?core=0\.1\.19\+a["']/gu)].map((match) => match[1]);
  const styleMatches = [...index.matchAll(/\bhref=["']\/(assets\/index-[^"'?]+\.css)\?core=0\.1\.19\+a["']/gu)].map((match) => match[1]);
  assert.equal(scriptMatches.length, 1, "Der gebundene Core-Entry muss genau ein JavaScript-Bundle referenzieren.");
  assert.equal(styleMatches.length, 1, "Der gebundene Core-Entry muss genau ein Stylesheet referenzieren.");
  assert.ok(marker.files.some((file) => file.path === scriptMatches[0]));
  assert.ok(marker.files.some((file) => file.path === styleMatches[0]));
  const asset = await fs.readFile(path.join(published, ...scriptMatches[0].split("/")), "utf8");
  assert.equal(marker.coreVersion, "0.1.19+a");
  assert.equal((asset.match(/0\.1\.18/gu) || []).length, 0);
  assert.ok((asset.match(/0\.1\.19/gu) || []).length >= 1);
  assert.doesNotMatch(index, /\?core=0\.1\.18/u);
});

test("technical cleanup preserves cache-bound prebuilt assets and removes only stale generated entries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-prebuilt-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(
    path.join(root, "index.html"),
    '<link rel="stylesheet" href="/assets/index-current.css?core=0.1.19"><script type="module" src="/assets/index-current.js?core=0.1.19"></script>',
  );
  await fs.writeFile(path.join(assets, "index-current.css"), "body{}\n");
  await fs.writeFile(path.join(assets, "index-current.js"), "export {};\n");
  await fs.writeFile(path.join(assets, "index-stale.js"), "export {};\n");

  const removed = await cleanupFrontendDist(root);

  assert.deepEqual(removed, [path.join(assets, "index-stale.js")]);
  assert.equal(await fs.readFile(path.join(assets, "index-current.css"), "utf8"), "body{}\n");
  assert.equal(await fs.readFile(path.join(assets, "index-current.js"), "utf8"), "export {};\n");
});
