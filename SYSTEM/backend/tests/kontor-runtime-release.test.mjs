import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const systemRoot = path.resolve(backendRoot, "..");
const appRoot = path.join(systemRoot, "app", "kontorapp");

test("KontorApp 0.19.2 is a Core 0.1.19-owned non-standalone package", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  const manifest = await fs.readFile(path.join(appRoot, "manifest.ts"), "utf8");
  const hasSource = (await fs.lstat(path.join(appRoot, "backend", "src")).catch(() => null))?.isDirectory() === true
    || (await fs.lstat(path.join(appRoot, "frontend", "src")).catch(() => null))?.isDirectory() === true;
  assert.equal(pkg.version, "0.19.2");
  assert.equal(pkg.bonniCoreModule, true);
  if (hasSource) assert.equal(pkg.engines.node, ">=22");
  assert.match(manifest, /version: "0\.19\.2"/u);
  assert.match(manifest, /minimumCoreVersion: "0\.1\.19"/u);
  assert.match(manifest, /standalone: false/u);
  assert.match(manifest, /buildOwner: "core"/u);
  assert.match(manifest, /coreBuildRequired: true/u);
  if (hasSource) {
    const setupGuard = await fs.readFile(path.join(appRoot, "scripts", "runtime-only-release.mjs"), "utf8");
    assert.match(setupGuard, /KONTORAPP_CORE_OWNED_SETUP/u);
    assert.doesNotMatch(pkg.scripts.setup, /npm\s+--prefix\s+backend\s+(?:ci|install)|build:core/u);
  } else {
    assert.equal(pkg.scripts, undefined);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.equal(
      (await fs.lstat(path.join(appRoot, "backend", "dist", "registerFeatureModule.js")).catch(() => null))?.isFile(),
      true,
    );
    assert.equal((await fs.lstat(path.join(appRoot, "frontend", "dist")).catch(() => null))?.isDirectory(), true);
  }
});

test("Kontor backend build has one main bundle and a replaceable lib-fints boundary", async () => {
  if (!(await fs.lstat(path.join(appRoot, "backend", "src")).catch(() => null))?.isDirectory()) return;
  const source = await fs.readFile(path.join(appRoot, "backend", "scripts", "build.mjs"), "utf8");
  const runtimeVerifier = await fs.readFile(path.join(appRoot, "backend", "scripts", "verify-runtime-dependencies.mjs"), "utf8");
  const backendPackage = JSON.parse(await fs.readFile(path.join(appRoot, "backend", "package.json"), "utf8"));
  const backendLock = JSON.parse(await fs.readFile(path.join(appRoot, "backend", "package-lock.json"), "utf8"));
  const verifier = await fs.readFile(path.join(appRoot, "scripts", "verify-runtime-release.mjs"), "utf8");
  assert.equal(backendPackage.scripts?.build, "node scripts/build.mjs");
  assert.equal(backendPackage.scripts?.["verify:runtime"], "node scripts/verify-runtime-dependencies.mjs");
  assert.equal(backendPackage.devDependencies?.esbuild, "0.21.5");
  assert.equal(backendLock.packages?.[""]?.devDependencies?.esbuild, "0.21.5");
  assert.equal(backendLock.packages?.["node_modules/esbuild"]?.version, "0.21.5");
  assert.match(source, /import \{ build \} from "esbuild"/u);
  assert.doesNotMatch(source, /frontend["'], "node_modules["'], "esbuild/u);
  assert.match(runtimeVerifier, /KONTOR_RUNTIME_DEPENDENCY_NOT_MODULE_LOCAL/u);
  assert.match(runtimeVerifier, /contracts-export-zip-worker\.js/u);
  assert.match(source, /modules["'], ["']kontorapp-runtime\.js/u);
  assert.match(source, /vendor["'], ["']lib-fints-runtime\.js/u);
  assert.match(source, /target: "node22"/u);
  assert.match(source, /external: \["lib-fints"\]/u);
  assert.match(source, /workers/u);
  assert.match(source, /legal-source/u);
  assert.match(source, /KONTOR_FINTS_VENDOR_EXPORT_INVALID/u);
  assert.match(source, /workerResult/u);
  assert.match(source, /KONTOR_WORKER_ROUNDTRIP_INVALID/u);
  assert.match(source, /KONTOR_RUNTIME_BARE_IMPORT/u);
  assert.match(source, /verify-runtime-dependencies\.mjs/u);
  assert.match(source, /relative === "licenses"/u);
  assert.match(verifier, /KONTOR_RUNTIME_RELEASE_BARE_IMPORT/u);
  assert.match(verifier, /relative === "licenses"/u);
  assert.match(verifier, /fresh-extract\.txt/u);
});

test("Core image verifies prebuilt frontend and copies only staged module runtimes plus central legal store", async () => {
  const dockerfile = await fs.readFile(path.join(backendRoot, "Dockerfile"), "utf8");
  const staging = await fs.readFile(path.join(backendRoot, "scripts", "modules", "stage-module-runtime-packages.ts"), "utf8");
  assert.match(dockerfile, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /prebuilt-frontend\.mjs --verify public\/system/u);
  assert.match(dockerfile, /modules:sync-legal-payloads/u);
  assert.match(dockerfile, /modules:stage-runtime/u);
  assert.match(dockerfile, /\/app\/runtime-packages\/app \/app\/app/u);
  assert.match(dockerfile, /\/app\/licenses \/app\/licenses/u);
  assert.doesNotMatch(dockerfile, /system-frontend-build/u);
  for (const forbidden of ["node_modules", "legal-source", "backend/src", "frontend/src"]) {
    assert.doesNotMatch(staging, new RegExp(`required\\.add\\([^)]*${forbidden.replace("/", "\\/")}`, "u"));
  }
});

test("manifest legal payload validation fails closed on unsafe paths", async () => {
  const { validateModuleManifest } = await import("../dist/platform/module-manager/manifests/manifest.service.js");
  const base = {
    key: "app.example",
    kind: "app",
    name: "Example",
    version: "1.0.0",
    legal: {
      schemaVersion: "bonni.module-legal/v1",
      notices: "THIRD_PARTY_NOTICES.md",
      payloadRoots: ["backend/dist/licenses"],
      treeSha256: "0".repeat(64),
      fileCount: 1,
    },
  };
  assert.equal(validateModuleManifest(base).ok, true);
  assert.equal(validateModuleManifest({ ...base, legal: { ...base.legal, notices: "../NOTICE" } }).ok, false);
  assert.equal(validateModuleManifest({ ...base, legal: { ...base.legal, payloadRoots: ["/tmp/licenses"] } }).ok, false);
});

test("module install and Kontor repair both pass through the central legal hook", async () => {
  const install = await fs.readFile(
    path.join(backendRoot, "src", "platform", "module-manager", "install", "module-install.service.ts"),
    "utf8",
  );
  const repair = await fs.readFile(path.join(backendRoot, "scripts", "modules", "repair-kontorapp-runtime.ts"), "utf8");
  assert.match(install, /module-legal-storage\.service/u);
  assert.equal((install.match(/installModuleLegalPayload\(manifest\)/gu) || []).length, 2);
  assert.match(repair, /installModulePackage\(MODULE_KEY\)/u);
  for (const route of [
    "accounting/closings",
    "procurement/rules",
    "procurement/cases?limit=1",
    "accounting/contributions",
    "accounting/contribution-runs/__core_repair_smoke__?limit=1",
    "accounting/collection-exports?limit=1",
    "accounting/collection-exports/__core_repair_smoke__?itemLimit=1&historyLimit=1",
    "accounting/member-accounts?limit=1",
    "accounting/member-accounts/__core_repair_smoke__/transactions?limit=1",
    "accounting/datev/settings",
    "accounting/year-end/2026/workspace",
  ]) {
    assert.ok(repair.includes(route), `repair smoke route is missing: ${route}`);
  }
});

test("Phase 10 DATEV and year-end mutation routes stay registered in the Core RPC contract", async () => {
  const rpc = JSON.parse(await fs.readFile(
    path.join(appRoot, "contracts", "kontorapp-rpc.v1.json"),
    "utf8",
  ));
  const registered = new Set(rpc.routes.map((route) => `${route.method} ${route.path}`));
  for (const route of [
    "POST /accounting/datev/exports/preview",
    "POST /accounting/datev/exports",
    "POST /accounting/year-end/{year}/tax-advisor-packages/preview",
    "POST /accounting/year-end/{year}/tax-advisor-packages",
    "POST /accounting/year-end/{year}/annual-files/preview",
    "POST /accounting/year-end/{year}/annual-files",
  ]) {
    assert.ok(registered.has(route), `Phase 10 RPC route is missing: ${route}`);
  }
});
