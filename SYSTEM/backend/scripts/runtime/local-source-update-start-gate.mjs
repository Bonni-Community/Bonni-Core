import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertContainerRuntimeActivationInactive } from "./runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const productRoot = path.resolve(backendRoot, "../..");

async function isHostProductTree() {
  const expected = path.join(productRoot, "SYSTEM", "backend");
  const state = await fs.lstat(expected).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("LOCAL_HOST_BACKEND_PRODUCT_TREE_INVALID");
  }
  return await fs.realpath(expected) === await fs.realpath(backendRoot);
}

export function shouldRunLocalSourceUpdateGate(environment = process.env) {
  return String(environment.NODE_ENV || "").trim().toLowerCase() !== "production";
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  // In a closed runtime image /app contains no host activation marker, while
  // every host-side entry sees the persistent product-root latch. This check
  // therefore rejects accidental host Core starts before cleanup/auth/DB work
  // without relying on a spoofable environment bypass.
  if (await isHostProductTree()) {
    await assertContainerRuntimeActivationInactive({ productRoot });
  }
  if (shouldRunLocalSourceUpdateGate()) {
    const localGate = path.join(backendRoot, "scripts", "setup", "local-source-update-gate.mjs");
    await import(pathToFileURL(localGate).href);
  } else {
    console.info("[bonni-start] Production verwendet ausschließlich den signierten OCI-Updatepfad.");
  }
}
