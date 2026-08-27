import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupStaleTechnicalData,
} from "../scripts/maintenance/cleanup-stale-technical-data.mjs";

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function createFrontend(systemRoot, relativeRoot, currentHash, oldHash, assetPrefix = "/assets") {
  const dist = path.join(systemRoot, relativeRoot, "frontend", "dist");
  const assets = path.join(dist, "assets");
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(
    path.join(dist, "index.html"),
    `<script type="module" src="${assetPrefix}/index-${currentHash}.js"></script>`
      + `<link rel="stylesheet" href="${assetPrefix}/index-${currentHash}.css">`,
  );
  await fs.writeFile(path.join(assets, `index-${currentHash}.js`), "current-js");
  await fs.writeFile(path.join(assets, `index-${currentHash}.css`), "current-css");
  await fs.writeFile(path.join(assets, `index-${oldHash}.js`), "old-js");
  await fs.writeFile(path.join(assets, `index-${oldHash}.css`), "old-css");
  await fs.writeFile(path.join(assets, "main-bg-keep.png"), "app-data");
  return { assets, currentHash, oldHash };
}

test("startup cleanup removes only unreferenced generated entry assets", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-cleanup-"));

  try {
    const core = await createFrontend(temporaryRoot, ".", "core-new", "core-old");
    await fs.writeFile(path.join(temporaryRoot, "frontend", "package.json"), "{}\n");
    const stueberl = await createFrontend(
      temporaryRoot,
      path.join("app", "stueberlapp"),
      "stueberl-new",
      "stueberl-old",
    );

    const removed = await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(removed.length, 4);
    for (const frontend of [core, stueberl]) {
      assert.equal(await exists(path.join(frontend.assets, `index-${frontend.currentHash}.js`)), true);
      assert.equal(await exists(path.join(frontend.assets, `index-${frontend.currentHash}.css`)), true);
      assert.equal(await exists(path.join(frontend.assets, `index-${frontend.oldHash}.js`)), false);
      assert.equal(await exists(path.join(frontend.assets, `index-${frontend.oldHash}.css`)), false);
      assert.equal(await exists(path.join(frontend.assets, "main-bg-keep.png")), true);
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("startup cleanup preserves current assets behind a feature-module mount path", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-cleanup-mount-"));
  try {
    const meet = await createFrontend(
      temporaryRoot,
      path.join("app", "meetapp"),
      "meet-current",
      "meet-old",
      "/feature-modules/meetapp/assets",
    );

    await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(await exists(path.join(meet.assets, `index-${meet.currentHash}.js`)), true);
    assert.equal(await exists(path.join(meet.assets, `index-${meet.currentHash}.css`)), true);
    assert.equal(await exists(path.join(meet.assets, `index-${meet.oldHash}.js`)), false);
    assert.equal(await exists(path.join(meet.assets, `index-${meet.oldHash}.css`)), false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("startup cleanup removes obsolete versioned module entries before their old assets", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-cleanup-version-"));
  try {
    const moduleRoot = path.join(temporaryRoot, "app", "kontorapp");
    const dist = path.join(moduleRoot, "frontend", "dist");
    const assets = path.join(dist, "assets");
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(moduleRoot, "manifest.ts"), 'runtimeEntry: "/feature-modules/kontorapp/index-0.12.0.html"');
    await fs.writeFile(path.join(dist, "index.html"), '<script src="assets/index-new.js"></script>');
    await fs.writeFile(path.join(dist, "index-0.12.0.html"), '<script src="assets/index-new.js"></script>');
    await fs.writeFile(path.join(dist, "index-0.11.0.html"), '<script src="assets/index-old.js"></script>');
    await fs.writeFile(path.join(assets, "index-new.js"), "new");
    await fs.writeFile(path.join(assets, "index-old.js"), "old");

    await cleanupStaleTechnicalData(temporaryRoot);
    assert.equal(await exists(path.join(dist, "index-0.12.0.html")), true);
    assert.equal(await exists(path.join(dist, "index-0.11.0.html")), false);
    assert.equal(await exists(path.join(assets, "index-new.js")), true);
    assert.equal(await exists(path.join(assets, "index-old.js")), false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("canonical Kontor 0.11+ removes only known legacy source duplicates", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-kontor-cleanup-"));

  try {
    const kontorRoot = path.join(temporaryRoot, "app", "kontorapp");
    const canonicalPrisma = path.join(kontorRoot, "prisma", "domains", "kontorapp", "kontorapp.prisma");
    const legacyPrisma = path.join(kontorRoot, "prisma", "domains", "kontorapp", "meetings.prisma");
    const contract = path.join(kontorRoot, "contracts", "kontorapp-rpc.v1.json");
    const manifest = path.join(kontorRoot, "manifest.ts");
    const legacyWorkspace = path.join(kontorRoot, "frontend", "src", "kontorapp", "WorkSpace", "Member");
    const preservedFile = path.join(kontorRoot, "frontend", "src", "kontorapp", "custom-extension.js");

    await fs.mkdir(path.dirname(canonicalPrisma), { recursive: true });
    await fs.mkdir(path.dirname(contract), { recursive: true });
    await fs.mkdir(legacyWorkspace, { recursive: true });
    await fs.mkdir(path.dirname(preservedFile), { recursive: true });
    await fs.writeFile(canonicalPrisma, "model KontorMeeting { id String @id }");
    await fs.writeFile(legacyPrisma, "model KontorMeeting { id String @id }");
    await fs.writeFile(contract, "{}");
    await fs.writeFile(manifest, 'version: "0.12.0", transport: "opaque-rpc-v1"');
    await fs.writeFile(path.join(legacyWorkspace, "old.jsx"), "legacy");
    await fs.writeFile(preservedFile, "preserve");

    const removed = await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(removed.includes(legacyPrisma), true);
    assert.equal(await exists(legacyPrisma), false);
    assert.equal(await exists(legacyWorkspace), false);
    assert.equal(await exists(canonicalPrisma), true);
    assert.equal(await exists(preservedFile), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("legacy Kontor files are untouched until every canonical marker is present", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-kontor-cleanup-guard-"));

  try {
    const legacyPrisma = path.join(
      temporaryRoot,
      "app",
      "kontorapp",
      "prisma",
      "domains",
      "kontorapp",
      "meetings.prisma",
    );
    await fs.mkdir(path.dirname(legacyPrisma), { recursive: true });
    await fs.writeFile(legacyPrisma, "model KontorMeeting { id String @id }");

    const removed = await cleanupStaleTechnicalData(temporaryRoot);

    assert.deepEqual(removed, []);
    assert.equal(await exists(legacyPrisma), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function createCanonicalKontor(systemRoot) {
  const kontorRoot = path.join(systemRoot, "app", "kontorapp");
  const prisma = path.join(kontorRoot, "prisma", "domains", "kontorapp", "kontorapp.prisma");
  const contract = path.join(kontorRoot, "contracts", "kontorapp-rpc.v1.json");
  await fs.mkdir(path.dirname(prisma), { recursive: true });
  await fs.mkdir(path.dirname(contract), { recursive: true });
  await fs.writeFile(prisma, "model KontorRecord { key String @id }");
  await fs.writeFile(contract, "{}");
  await fs.writeFile(path.join(kontorRoot, "manifest.ts"), 'key: "app.kontorapp", version: "0.13.0", transport: "opaque-rpc-v1"');
}

test("canonical KontorApp removes the replaced VereinsApp package directory", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-vereinsapp-cleanup-"));
  try {
    await createCanonicalKontor(temporaryRoot);
    const legacyRoot = path.join(temporaryRoot, "app", "vereinsapp");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "manifest.ts"), 'const manifest = { key: "app.vereinsapp", version: "0.2.0" };');
    await fs.writeFile(path.join(legacyRoot, "legacy-code.js"), "old package");

    const removed = await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(removed.includes(legacyRoot), true);
    assert.equal(await exists(legacyRoot), false);
    assert.equal(await exists(path.join(temporaryRoot, "app", "kontorapp", "manifest.ts")), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("cleanup never removes an unknown package merely named vereinsapp", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-vereinsapp-guard-"));
  try {
    await createCanonicalKontor(temporaryRoot);
    const unrelatedRoot = path.join(temporaryRoot, "app", "vereinsapp");
    await fs.mkdir(unrelatedRoot, { recursive: true });
    await fs.writeFile(path.join(unrelatedRoot, "manifest.ts"), 'const manifest = { key: "app.some-other-package", version: "1.0.0" };');

    await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(await exists(unrelatedRoot), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("startup cleanup removes failed dependency folders but preserves application data", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-install-cleanup-"));
  try {
    const backendFailure = path.join(temporaryRoot, "backend", "node_modules.failed");
    const frontendFailure = path.join(temporaryRoot, "frontend", "node_modules.failed");
    const businessData = path.join(temporaryRoot, "storage", "business", "records.json");
    const technicalUserData = path.join(temporaryRoot, "storage", "technical-users.json");

    await fs.mkdir(backendFailure, { recursive: true });
    await fs.mkdir(frontendFailure, { recursive: true });
    await fs.mkdir(path.dirname(businessData), { recursive: true });
    await fs.writeFile(path.join(backendFailure, "partial-package.js"), "failed");
    await fs.writeFile(path.join(frontendFailure, "partial-package.js"), "failed");
    await fs.writeFile(businessData, "[]");
    await fs.writeFile(technicalUserData, "[]");

    const removed = await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(removed.includes(backendFailure), true);
    assert.equal(removed.includes(frontendFailure), true);
    assert.equal(await exists(backendFailure), false);
    assert.equal(await exists(frontendFailure), false);
    assert.equal(await exists(businessData), true);
    assert.equal(await exists(technicalUserData), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("before-build cleanup removes generated Core and source-module dist trees in every supported container", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-build-cleanup-"));
  try {
    const generatedDirectories = [
      path.join(temporaryRoot, "backend", "dist"),
      path.join(temporaryRoot, "frontend", "dist"),
    ];
    const preservedFiles = [
      path.join(temporaryRoot, "backend", "node_modules", "runtime-package.js"),
      path.join(temporaryRoot, "frontend", "node_modules", "vite", "index.js"),
      path.join(temporaryRoot, "backend", "data", "local.json"),
      path.join(temporaryRoot, "storage", "business", "records.json"),
      path.join(temporaryRoot, "logs", "system.log"),
    ];

    await fs.mkdir(path.join(temporaryRoot, "backend", "src"), { recursive: true });
    await fs.mkdir(path.join(temporaryRoot, "frontend", "src"), { recursive: true });
    await fs.writeFile(path.join(temporaryRoot, "backend", "package.json"), "{}\n");
    await fs.writeFile(path.join(temporaryRoot, "frontend", "package.json"), "{}\n");

    const containers = [
      "app",
      "apps",
      "addons",
      "add-on",
      "addon",
      "plugins",
      "plug-in",
      "plugin",
      "bridges",
      "bridge",
    ];
    for (const [index, container] of containers.entries()) {
      const moduleRoot = path.join(temporaryRoot, container, `module-${index}`);
      for (const packageDirectory of ["backend", "frontend"]) {
        const packageRoot = path.join(moduleRoot, packageDirectory);
        const dist = path.join(packageRoot, "dist");
        const source = path.join(packageRoot, "src", "index.js");
        const dependency = path.join(packageRoot, "node_modules", "keep.js");
        await fs.mkdir(dist, { recursive: true });
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.mkdir(path.dirname(dependency), { recursive: true });
        await fs.writeFile(path.join(packageRoot, "package.json"), "{}\n");
        await fs.writeFile(source, "source\n");
        await fs.writeFile(path.join(dist, "obsolete.js"), "old-build\n");
        await fs.writeFile(dependency, "runtime-dependency\n");
        generatedDirectories.push(dist);
        preservedFiles.push(source);
        preservedFiles.push(dependency);
      }
    }

    for (const directory of generatedDirectories.slice(0, 2)) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "obsolete.js"), "old-build\n");
    }
    for (const file of preservedFiles.slice(0, 5)) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "preserve\n");
    }

    const removed = await cleanupStaleTechnicalData(temporaryRoot, { beforeBuild: true });

    for (const directory of generatedDirectories) {
      assert.equal(await exists(directory), false, `generated dist must be removed: ${directory}`);
      assert.equal(removed.includes(directory), true, `removed result must contain: ${directory}`);
    }
    for (const file of preservedFiles) {
      assert.equal(await exists(file), true, `non-generated file must be preserved: ${file}`);
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("before-build cleanup protects prebuilt Core and runtime-only module payloads", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-prebuilt-build-cleanup-"));
  try {
    const coreBackendDist = path.join(temporaryRoot, "backend", "dist");
    const prebuiltCoreSourceDist = path.join(temporaryRoot, "frontend", "dist");
    const publishedCore = path.join(temporaryRoot, "backend", "public", "system");
    const runtimeModule = path.join(temporaryRoot, "plugins", "runtime-only");
    const runtimeBackendDist = path.join(runtimeModule, "backend", "dist");
    const runtimeFrontendDist = path.join(runtimeModule, "frontend", "dist");

    for (const [directory, file] of [
      [coreBackendDist, "server.js"],
      [prebuiltCoreSourceDist, "index.html"],
      [publishedCore, "index.html"],
      [runtimeBackendDist, "runtime.js"],
      [runtimeFrontendDist, "index.html"],
    ]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, file), "prebuilt\n");
    }
    for (const root of [prebuiltCoreSourceDist, publishedCore]) {
      const assets = path.join(root, "assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(root, "index.html"), '<script src="assets/index-current.js"></script>');
      await fs.writeFile(path.join(assets, "index-current.js"), "current\n");
      await fs.writeFile(path.join(assets, "index-stale.js"), "must-stay\n");
    }
    await fs.writeFile(path.join(runtimeModule, "package.json"), "{}\n");
    await fs.writeFile(path.join(runtimeModule, "backend", "package.json"), "{}\n");
    await fs.writeFile(path.join(runtimeModule, "frontend", "package.json"), "{}\n");

    const removed = await cleanupStaleTechnicalData(temporaryRoot, { beforeBuild: true });

    assert.equal(await exists(coreBackendDist), true);
    assert.equal(removed.includes(coreBackendDist), false);
    assert.equal(await exists(prebuiltCoreSourceDist), true);
    assert.equal(await exists(path.join(prebuiltCoreSourceDist, "assets", "index-stale.js")), true);
    assert.equal(await exists(path.join(publishedCore, "index.html")), true);
    assert.equal(await exists(path.join(publishedCore, "assets", "index-stale.js")), true);
    assert.equal(await exists(runtimeBackendDist), true);
    assert.equal(await exists(runtimeFrontendDist), true);
    assert.equal(await exists(path.join(runtimeModule, "backend", "package.json")), true);
    assert.equal(await exists(path.join(runtimeModule, "frontend", "package.json")), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("ordinary startup cleanup never removes the executable Core backend build", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-startup-build-preserve-"));
  try {
    const server = path.join(temporaryRoot, "backend", "dist", "system", "server", "run-server.js");
    await fs.mkdir(path.dirname(server), { recursive: true });
    await fs.writeFile(server, "export {};\n");

    const removed = await cleanupStaleTechnicalData(temporaryRoot);

    assert.equal(await exists(server), true);
    assert.equal(removed.includes(path.join(temporaryRoot, "backend", "dist")), false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("before-build cleanup never follows a symlinked module container", { skip: process.platform === "win32" }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-symlink-cleanup-"));
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-symlink-outside-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(externalRoot, { recursive: true, force: true }));

  const packageRoot = path.join(externalRoot, "outside-module", "frontend");
  const externalBuild = path.join(packageRoot, "dist", "index.js");
  await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
  await fs.mkdir(path.dirname(externalBuild), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), "{}\n");
  await fs.writeFile(path.join(packageRoot, "src", "index.js"), "source\n");
  await fs.writeFile(externalBuild, "external build\n");
  await fs.symlink(externalRoot, path.join(temporaryRoot, "plugins"), "dir");

  const removed = await cleanupStaleTechnicalData(temporaryRoot, { beforeBuild: true });
  assert.equal(await exists(externalBuild), true);
  assert.equal(removed.length, 0);
});
