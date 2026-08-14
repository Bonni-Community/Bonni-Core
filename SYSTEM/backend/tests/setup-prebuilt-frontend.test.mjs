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
import { cleanupFrontendDist } from "../scripts/maintenance/cleanup-stale-technical-data.mjs";

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

test("the shipped prebuilt frontend is exactly bound to Core 0.1.19 and contains no 0.1.18 cache identity", async () => {
  const backendRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const published = path.join(backendRoot, "public", "system");
  const index = await fs.readFile(path.join(published, "index.html"), "utf8");
  const marker = await verifyPrebuiltFrontend(published);
  const scriptMatches = [...index.matchAll(/\bsrc=["']\/(assets\/index-[^"'?]+\.js)\?core=0\.1\.19["']/gu)].map((match) => match[1]);
  const styleMatches = [...index.matchAll(/\bhref=["']\/(assets\/index-[^"'?]+\.css)\?core=0\.1\.19["']/gu)].map((match) => match[1]);
  assert.equal(scriptMatches.length, 1, "Der gebundene Core-Entry muss genau ein JavaScript-Bundle referenzieren.");
  assert.equal(styleMatches.length, 1, "Der gebundene Core-Entry muss genau ein Stylesheet referenzieren.");
  assert.ok(marker.files.some((file) => file.path === scriptMatches[0]));
  assert.ok(marker.files.some((file) => file.path === styleMatches[0]));
  const asset = await fs.readFile(path.join(published, ...scriptMatches[0].split("/")), "utf8");
  assert.equal(marker.coreVersion, "0.1.19");
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
