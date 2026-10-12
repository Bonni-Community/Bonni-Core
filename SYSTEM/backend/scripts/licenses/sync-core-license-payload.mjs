import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  resolveCentralLicenseRoot,
  validCoreLicenseVersion,
  verifyCoreLicenseVersion,
} from "./license-payload-utils.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptRoot, "../..");
const systemRoot = path.resolve(backendRoot, "..");
async function run(script, arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptRoot, script), ...arguments_], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`CORE_LICENSE_SYNC_FAILED:${script}:${code}`)));
  });
}

export async function detectRequiredCoreLicensePredecessor(projectSystemRoot = systemRoot) {
  const activeManifest = path.join(projectSystemRoot, ".bonni-source-update", "active-manifest.json");
  const source = await fs.readFile(activeManifest, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return null;
  let active;
  try { active = JSON.parse(source); } catch { throw new Error("CORE_LICENSE_ACTIVE_MANIFEST_INVALID"); }
  const version = active?.versions?.coreVersion;
  if (!validCoreLicenseVersion(version)) throw new Error("CORE_LICENSE_ACTIVE_VERSION_INVALID");
  return version;
}

export async function syncCoreLicensePayload({
  projectSystemRoot = systemRoot,
  environment = process.env,
} = {}) {
  const resolvedSystemRoot = path.resolve(projectSystemRoot);
  const resolvedBackendRoot = path.join(resolvedSystemRoot, "backend");
  const version = JSON.parse(await fs.readFile(path.join(resolvedBackendRoot, "package.json"), "utf8")).version;
  if (!validCoreLicenseVersion(version)) throw new Error("CORE_LICENSE_VERSION_INVALID");
  const licenseRoot = resolveCentralLicenseRoot({ projectSystemRoot: resolvedSystemRoot, environment });
  const predecessor = await detectRequiredCoreLicensePredecessor(resolvedSystemRoot);
  if (predecessor && predecessor !== version) {
    try {
      await verifyCoreLicenseVersion(
        path.join(licenseRoot, "platform", "bonni-core", predecessor),
        predecessor,
      );
    } catch (error) {
      throw new Error(`CORE_LICENSE_PREDECESSOR_EVIDENCE_MISSING:${predecessor}`, { cause: error });
    }
  }

  for (const component of ["backend", "frontend"]) {
    const packageRoot = path.join(resolvedSystemRoot, component);
    await run("build-core-license-component.mjs", [
      "--package-root", packageRoot,
      "--output-root", path.join(licenseRoot, "platform", "bonni-core", version, component),
      "--component", component,
      "--version", version,
    ]);
  }
  await run("finalize-core-license-payload.mjs", [
    "--license-root", licenseRoot,
    "--version", version,
    "--notice", path.join(resolvedBackendRoot, "legal", "BONNI_CORE_LICENSE_NOTICE.md"),
  ]);
  return { licenseRoot, version, predecessor };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await syncCoreLicensePayload();
