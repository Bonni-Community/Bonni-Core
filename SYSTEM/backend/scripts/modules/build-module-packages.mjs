#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.argv[2] || process.env.BONNI_PROJECT_ROOT || "..");
const moduleRoots = ["app", "addons", "plugins", "bridges"]
  .map((directory) => path.join(projectRoot, directory));
const skippedDirectories = new Set([
  ".cache",
  ".git",
  ".vite",
  "coverage",
  "dist",
  "legal-source",
  "licenses",
  "node_modules",
]);

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectPackageFiles(directory, root) {
  const realDirectory = await fs.realpath(directory);
  if (!isInside(root, realDirectory)) {
    throw new Error(`MODULE_BUILD_PATH_OUTSIDE_ROOT:${directory}`);
  }

  const packages = [];
  const entries = await fs.readdir(realDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(realDirectory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      packages.push(...await collectPackageFiles(entryPath, root));
    } else if (entry.isFile() && entry.name === "package.json") {
      packages.push(entryPath);
    }
  }
  return packages;
}

function runNpm(cwd, args) {
  return new Promise((resolve, reject) => {
    const npmCli = String(process.env.npm_execpath || "").trim();
    const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const invocationArgs = npmCli ? [npmCli, ...args] : args;
    const child = spawn(command, invocationArgs, {
      cwd,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`MODULE_BUILD_NPM_FAILED:${cwd}:${args.join(" ")}:${code ?? signal ?? "unknown"}`));
    });
  });
}

const packageFiles = [];
for (const root of moduleRoots) {
  const stats = await fs.stat(root).catch(() => null);
  if (!stats?.isDirectory()) continue;
  const realRoot = await fs.realpath(root);
  packageFiles.push(...await collectPackageFiles(realRoot, realRoot));
}

for (const packageFile of packageFiles.sort()) {
  const packageRoot = path.dirname(packageFile);
  const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (!String(packageJson?.scripts?.build || "").trim()) continue;

  const lockFile = path.join(packageRoot, "package-lock.json");
  const hasLockFile = await fs.access(lockFile, fsConstants.R_OK).then(() => true, () => false);
  await runNpm(
    packageRoot,
    hasLockFile
      ? ["ci", "--include=dev"]
      : ["install", "--include=dev"],
  );
  await runNpm(packageRoot, ["run", "build"]);

  if (path.basename(packageRoot) === "backend") {
    await runNpm(packageRoot, ["prune", "--omit=dev"]);
  } else {
    await fs.rm(path.join(packageRoot, "node_modules"), { recursive: true, force: true });
  }
}

console.info(`[module-build] ${packageFiles.length} package.json-Datei(en) geprüft.`);
