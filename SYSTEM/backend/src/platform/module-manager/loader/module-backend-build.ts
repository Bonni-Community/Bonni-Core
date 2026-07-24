import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const backendBuilds = new Map<string, Promise<boolean>>();
const preparedBackendBuilds = new Set<string>();

function autoBuildModuleBackends() {
  const configured = process.env.BONNI_AUTO_BUILD_MODULE_BACKENDS?.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(configured || "")) return true;
  if (["0", "false", "no", "off"].includes(configured || "")) return false;

  return process.env.NODE_ENV !== "production" && process.env.CI !== "true";
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function backendBuildRoot(packageRoot: string, entryFile: string) {
  let candidate = path.dirname(entryFile);

  while (isInside(packageRoot, candidate)) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (candidate === packageRoot) break;
    candidate = path.dirname(candidate);
  }

  return null;
}

function hasBuildScript(packageRoot: string) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return Boolean(String(packageJson?.scripts?.build || "").trim());
  } catch {
    return false;
  }
}

function runNpm(cwd: string, args: string[]) {
  const npmCache = process.env.BONNI_MODULE_NPM_CACHE?.trim()
    || path.join(tmpdir(), "bonni-core-module-npm-cache");
  mkdirSync(npmCache, { recursive: true });

  // Unter Windows ist npm eine .cmd-Datei. Wenn Core über npm gestartet
  // wurde, führen wir die bekannte npm-CLI direkt mit Node aus. Bei einem
  // direkten VS-Code-Start übernimmt die Windows-Shell den .cmd-Aufruf.
  const npmExecPath = process.env.npm_execpath?.trim();
  const useNpmCli = Boolean(npmExecPath && existsSync(npmExecPath));
  const executable = useNpmCli
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const commandArgs = useNpmCli && npmExecPath
    ? [npmExecPath, ...args]
    : args;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd,
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
      shell: process.platform === "win32" && !useNpmCli,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(
        `MODULE_BACKEND_NPM_FAILED:${args.join(" ")}:${code ?? signal ?? "unknown"}`,
      ));
    });
  });
}

async function installDependencies(cwd: string, args: string[], moduleKey: string) {
  try {
    await runNpm(cwd, args);
  } catch (firstError) {
    console.warn("[module-manager] Dependency installation failed; retrying once", {
      module: moduleKey,
      error: firstError instanceof Error ? firstError.message : String(firstError),
    });
    await runNpm(cwd, args);
  }
}

/**
 * Baut eine lokale Backend-Erweiterung vor ihrem Import. Dabei entsteht kein
 * eigener Server: Das kompilierte Register-Modul wird anschließend direkt in
 * Bonni Cores Express- und Prisma-Laufzeit geladen.
 */
export async function ensureModuleBackendBuild({
  moduleKey,
  packageRoot,
  backendEntry,
}: {
  moduleKey: string;
  packageRoot: string;
  backendEntry: string;
}) {
  const entryFile = path.resolve(packageRoot, backendEntry);
  if (!isInside(packageRoot, entryFile)) {
    throw new Error(`MODULE_BACKEND_ENTRY_OUTSIDE_PACKAGE:${moduleKey}`);
  }

  const hasInstalledEntry = existsSync(entryFile);
  if (!autoBuildModuleBackends()) return hasInstalledEntry;
  if (hasInstalledEntry && preparedBackendBuilds.has(moduleKey)) return true;

  const running = backendBuilds.get(moduleKey);
  if (running) return running;

  const build = (async () => {
    const buildRoot = backendBuildRoot(packageRoot, entryFile);
    if (!buildRoot) {
      if (existsSync(entryFile)) {
        preparedBackendBuilds.add(moduleKey);
        return true;
      }
      throw new Error(`MODULE_BACKEND_PACKAGE_JSON_MISSING:${moduleKey}`);
    }

    if (!hasBuildScript(buildRoot)) {
      if (existsSync(entryFile)) {
        preparedBackendBuilds.add(moduleKey);
        return true;
      }
      throw new Error(`MODULE_BACKEND_BUILD_SCRIPT_MISSING:${moduleKey}`);
    }

    console.info("[module-manager] Preparing backend extension", {
      module: moduleKey,
      buildRoot,
    });

    if (!existsSync(path.join(buildRoot, "node_modules"))) {
      const installCommand = existsSync(path.join(buildRoot, "package-lock.json"))
        ? ["ci", "--no-audit", "--no-fund"]
        : ["install", "--no-audit", "--no-fund"];
      await installDependencies(buildRoot, installCommand, moduleKey);
    }

    await runNpm(buildRoot, ["run", "build"]);
    if (!existsSync(entryFile)) {
      throw new Error(`MODULE_BACKEND_BUILD_OUTPUT_MISSING:${moduleKey}`);
    }

    preparedBackendBuilds.add(moduleKey);
    return true;
  })().finally(() => {
    backendBuilds.delete(moduleKey);
  });

  backendBuilds.set(moduleKey, build);
  return build;
}
