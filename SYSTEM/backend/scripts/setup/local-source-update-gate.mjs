import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPendingLocalSourceUpdate } from "./local-source-update.mjs";
import { assertContainerRuntimeActivationInactive } from "../runtime/runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const configuredProductRoot = String(process.env.BONNI_PRODUCT_ROOT || "").trim();
if (configuredProductRoot && (configuredProductRoot.includes("\u0000") || !path.isAbsolute(configuredProductRoot))) {
  throw new Error("BONNI_PRODUCT_ROOT_INVALID");
}
const productRoot = configuredProductRoot || path.resolve(backendRoot, "../..");

await assertContainerRuntimeActivationInactive({ productRoot });

// `npm start` now launches the separate local supervisor. A merely waiting
// package must therefore no longer block the web backend: the administrator
// needs the Control Center in order to approve it. The supervisor itself keeps
// the backend stopped while an already started transaction is being recovered.
// Direct development starts remain strict because they are not supervised.
if (process.env.npm_lifecycle_event === "prestart") {
  console.info("[bonni-update] Lokaler Update-Supervisor übernimmt ausstehende Testupdates.");
} else {
  try {
    await assertNoPendingLocalSourceUpdate({ productRoot });
  } catch (error) {
    console.error("[bonni-update] Ein Testupdate ist noch nicht vollständig eingerichtet.");
    console.error("[bonni-update] Bitte Bonni Core mit npm start über den Update-Supervisor starten.");
    console.error(error);
    process.exitCode = 1;
  }
}
