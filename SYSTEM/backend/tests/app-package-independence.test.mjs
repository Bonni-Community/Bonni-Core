import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const systemRoot = path.resolve(backendRoot, "..");
const appRoot = path.join(systemRoot, "app");
const appDirectories = (await fs.readdir(appRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

test("das Core-Setup besitzt den Build- und Legal-Lebenszyklus der Fach-Apps", async () => {
  const setupSource = await fs.readFile(
    path.join(backendRoot, "scripts", "setup", "setup-system.mjs"),
    "utf8",
  );

  assert.match(setupSource, /database:bootstrap/);
  assert.match(setupSource, /"ci",\s*\n?\s*"--include=dev"/u);
  assert.doesNotMatch(setupSource, /"install",\s*\n?\s*"--include=dev"/u);
  assert.match(setupSource, /modules:build/);
  assert.match(setupSource, /modules:verify/);
  assert.match(setupSource, /modules:sync-legal-payloads/);

  const moduleBuilder = await fs.readFile(
    path.join(backendRoot, "scripts", "modules", "build-module-packages.mjs"),
    "utf8",
  );
  assert.match(moduleBuilder, /process\.env\.npm_execpath/u);
  assert.match(moduleBuilder, /process\.platform === "win32" \? "npm\.cmd"/u);
  assert.match(setupSource, /modules:repair:kontorapp/);
  assert.ok(
    setupSource.indexOf("modules:sync-legal-payloads") < setupSource.indexOf("modules:repair:kontorapp"),
    "Kontor-Repair muss nach dem zentralen Legal-Import laufen",
  );
});

test("jede Fach-App ist entweder ein Core-gesteuertes Quellpaket oder ein minimales Runtimepaket", async () => {
  for (const directory of appDirectories) {
    const packageRoot = path.join(appRoot, directory);
    const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    const hasBackendSource = (await fs.lstat(path.join(packageRoot, "backend", "src")).catch(() => null))?.isDirectory() === true;
    const hasFrontendSource = (await fs.lstat(path.join(packageRoot, "frontend", "src")).catch(() => null))?.isDirectory() === true;

    assert.equal(packageJson.bonniCoreModule, true, `${directory}: bonniCoreModule fehlt`);
    if (hasBackendSource || hasFrontendSource) {
      assert.equal(typeof packageJson.scripts?.setup, "string", `${directory}: Setup-Guard fehlt`);
      assert.equal(typeof packageJson.scripts?.build, "string", `${directory}: build fehlt`);
      assert.equal(typeof packageJson.scripts?.["integrate:prepare"], "string", `${directory}: integrate:prepare fehlt`);
      assert.equal(typeof packageJson.scripts?.["integrate:finalize"], "string", `${directory}: integrate:finalize fehlt`);
      continue;
    }
    assert.equal(packageJson.scripts, undefined, `${directory}: Runtimepaket darf keine Skripte enthalten`);
    assert.equal(packageJson.dependencies, undefined, `${directory}: Runtimepaket darf keine Abhängigkeiten enthalten`);
    assert.equal(packageJson.devDependencies, undefined, `${directory}: Runtimepaket darf keine Build-Abhängigkeiten enthalten`);
    assert.equal(
      (await fs.lstat(path.join(packageRoot, "backend", "dist", "registerFeatureModule.js")).catch(() => null))?.isFile(),
      true,
      `${directory}: vorgebautes Backend fehlt`,
    );
    assert.equal(
      (await fs.lstat(path.join(packageRoot, "frontend", "dist")).catch(() => null))?.isDirectory(),
      true,
      `${directory}: vorgebautes Frontend fehlt`,
    );
  }
});

test("der zentrale Prisma-Assembler kennt keine fest verdrahtete Fach-App", async () => {
  const assemblySource = await fs.readFile(
    path.join(backendRoot, "scripts", "modules", "assemble-module-prisma.ts"),
    "utf8",
  );

  assert.match(assemblySource, /listModuleManifests/);
  for (const directory of appDirectories) {
    assert.doesNotMatch(assemblySource, new RegExp(`app\\.${directory}`, "i"));
  }
});

test("Fach-App-Prisma dupliziert keine zentralen Identitätsmodelle", async () => {
  const forbiddenModel = /^model\s+(Account|User|Person|Organization)\b/m;

  async function prismaFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !["dist", "node_modules"].includes(entry.name)) {
        files.push(...await prismaFiles(candidate));
      }
      if (entry.isFile() && entry.name.endsWith(".prisma")) files.push(candidate);
    }
    return files;
  }

  for (const file of await prismaFiles(appRoot)) {
    assert.doesNotMatch(
      await fs.readFile(file, "utf8"),
      forbiddenModel,
      `${path.relative(systemRoot, file)} enthält ein zentrales Identitätsmodell`,
    );
  }
});
