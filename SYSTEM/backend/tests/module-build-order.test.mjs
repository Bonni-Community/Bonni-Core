import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(backendRoot, "scripts", "modules", "build-module-packages.mjs");

function runBuilder(projectRoot, fakeNpm, logFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [builder, projectRoot], {
      env: {
        ...process.env,
        npm_execpath: fakeNpm,
        BONNI_FAKE_NPM_LOG: logFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("Modul-Unterpakete behalten ihre Build-Abhaengigkeiten bis der App-Root fertig ist", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-module-build-order-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const projectRoot = path.join(temporaryRoot, "SYSTEM");
  const moduleRoot = path.join(projectRoot, "app", "hocketapp");
  const backendPackage = path.join(moduleRoot, "backend");
  const frontendPackage = path.join(moduleRoot, "frontend");
  const packageRoots = [moduleRoot, backendPackage, frontendPackage];

  for (const packageRoot of packageRoots) {
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ private: true, scripts: { build: "fixture-build" } }, null, 2)}\n`,
    );
    await fs.writeFile(path.join(packageRoot, "package-lock.json"), "{}\n");
  }

  const logFile = path.join(temporaryRoot, "npm-calls.log");
  const fakeNpm = path.join(temporaryRoot, "fake-npm.mjs");
  await fs.writeFile(fakeNpm, `
import { promises as fs } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const marker = path.join(cwd, "node_modules", ".bonni-build-dependencies");
await fs.appendFile(process.env.BONNI_FAKE_NPM_LOG, cwd + " :: " + args.join(" ") + "\\n");

if (["ci", "install"].includes(args[0])) {
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, "installed\\n");
}

if (args[0] === "run" && args[1] === "build" && path.basename(cwd) === "hocketapp") {
  try {
    await fs.access(path.join(cwd, "frontend", "node_modules", ".bonni-build-dependencies"));
  } catch {
    console.error("FIXTURE_VITE_NOT_FOUND");
    process.exitCode = 42;
  }
}
`);

  const result = await runBuilder(projectRoot, fakeNpm, logFile);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const calls = await fs.readFile(logFile, "utf8");
  const frontendBuild = `${frontendPackage} :: run build`;
  const rootBuild = `${moduleRoot} :: run build`;
  assert.ok(calls.indexOf(frontendBuild) >= 0, calls);
  assert.ok(calls.indexOf(rootBuild) > calls.indexOf(frontendBuild), calls);
  assert.equal(
    await fs.access(path.join(frontendPackage, "node_modules")).then(() => true, () => false),
    false,
    "Frontend-Buildabhaengigkeiten muessen nach allen Builds wieder entfernt werden",
  );
});
