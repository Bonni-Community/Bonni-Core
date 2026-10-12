import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLocalSourceUpdateLock,
  applyLocalSourceUpdate,
  finalizeLocalSourceUpdate,
  isLocalSourceDeploymentRollback,
  preflightLocalSourceUpdate,
} from "./local-source-update.mjs";
import { assertDockerRuntimeActivationInactive } from "../runtime/runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const configuredProductRoot = String(process.env.BONNI_PRODUCT_ROOT || "").trim();
if (configuredProductRoot && (configuredProductRoot.includes("\u0000") || !path.isAbsolute(configuredProductRoot))) {
  throw new Error("BONNI_PRODUCT_ROOT_INVALID");
}
const productRoot = configuredProductRoot || path.resolve(backendRoot, "../..");
const setupScript = path.join(scriptDirectory, "setup-system.mjs");
const expectedUpdateId = String(process.env.BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_ID || "").trim() || null;
const expectedManifestSha256 = String(
  process.env.BONNI_LOCAL_SOURCE_UPDATE_EXPECTED_MANIFEST_SHA256 || "",
).trim() || null;
const operation = process.argv.includes("--preflight")
  ? "preflight"
  : process.argv.includes("--finalize")
    ? "finalize"
    : "install";
const deferFinalize = process.env.BONNI_UPDATE_DEFER_FINALIZE === "1";

function applicationEnvironment(environment = process.env) {
  const blocked = new Set([
    "BONNI_LOCAL_HOST_BACKEND_LEASE_OWNER_PID",
    "BONNI_LOCAL_HOST_BACKEND_LEASE_TOKEN",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!blocked.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

if (process.argv.includes("--preflight") && process.argv.includes("--finalize")) {
  throw new Error("SOURCE_UPDATE_OPERATION_INVALID");
}

if (Boolean(expectedUpdateId) !== Boolean(expectedManifestSha256)) {
  throw new Error("SOURCE_UPDATE_EXPECTED_PROOF_INCOMPLETE");
}

function runUpdatedSetup(transaction) {
  console.log("\n[bonni-update] Aktualisierte Einrichtung in einem neuen Prozess starten.");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [setupScript], {
      cwd: backendRoot,
      env: {
        ...applicationEnvironment(),
        BONNI_PROGRAM_ROOT: path.resolve(backendRoot, "../.."),
        BONNI_PROJECT_ROOT: path.resolve(backendRoot, "../.."),
        BONNI_PRODUCT_ROOT: productRoot,
        BONNI_SETUP_MODE: "update",
        BONNI_LOCAL_SOURCE_UPDATE_ID: transaction.updateId,
        BONNI_LOCAL_SOURCE_UPDATE_HANDOFF: transaction.handoffToken,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `SOURCE_UPDATE_SETUP_FAILED:${signal ? `signal-${signal}` : `exit-${code}`}`,
      ));
    });
  });
}

let releaseLock;
try {
  // The persistent container-runtime latch and the local update command lock
  // form a two-sided start protocol. Checking on both sides of the atomic
  // local lock closes runtime:start <-> npm run update races without trusting
  // a caller-controlled invocation environment variable.
  await assertDockerRuntimeActivationInactive({ productRoot });
  releaseLock = await acquireLocalSourceUpdateLock({ productRoot });
  await assertDockerRuntimeActivationInactive({ productRoot });
  if (operation === "preflight") {
    console.log("[bonni-update] Vollständige Vorprüfung bei laufendem Bonni Core.");
    const result = await preflightLocalSourceUpdate({
      productRoot,
      expectedUpdateId,
      expectedManifestSha256,
    });
    console.log(`[bonni-update] Vorprüfung für ${result.updateId} erfolgreich (${result.operationCount ?? 0} Dateioperationen).`);
  } else {
    console.log("[bonni-update] Lokales, unveröffentlichtes Testupdate prüfen.");
    const transaction = await applyLocalSourceUpdate({
      productRoot,
      expectedUpdateId,
      expectedManifestSha256,
    });
    if (transaction.alreadyCompleted) {
      console.log(`[bonni-update] ${transaction.updateId} war bereits vollständig installiert; die identische Paketkopie wurde sicher entfernt.`);
    } else if (operation === "finalize") {
      await finalizeLocalSourceUpdate({ productRoot, transaction });
      console.log(`[bonni-update] ${transaction.updateId} wurde nach dem erfolgreichen Neustart verbindlich abgeschlossen.`);
    } else {
      console.log(`[bonni-update] Programmdateien für ${transaction.updateId} sicher übernommen.`);
      if (transaction.phase !== "committed") await runUpdatedSetup(transaction);
      else console.log("[bonni-update] Einrichtung war bereits erfolgreich; Abschluss wird fortgesetzt.");
      const rollbackMustFinalizeBeforeRestart = deferFinalize
        && await isLocalSourceDeploymentRollback({ productRoot, transaction });
      if (rollbackMustFinalizeBeforeRestart) {
        await finalizeLocalSourceUpdate({
          productRoot,
          transaction,
          preserveCompletedPackage: true,
        });
        console.log("[bonni-update] Der gesicherte Vorgängerstand wurde vor dem Neustart verbindlich aktiviert.");
      } else if (deferFinalize) {
        console.log("[bonni-update] Abschluss wartet auf den strikten Neustart- und Gesundheitscheck.");
      } else {
        await finalizeLocalSourceUpdate({ productRoot, transaction });
      }
    }
  }
  if (operation !== "preflight") {
    console.log(deferFinalize && operation === "install"
      ? "[bonni-update] Installation erfolgreich; Healthcheck und Abschluss folgen im Control Center."
      : "[bonni-update] Aktualisierung erfolgreich abgeschlossen.");
    if (!deferFinalize) console.log("[bonni-update] Systemstart: npm start");
  }
} catch (error) {
  console.error("\n[bonni-update] Aktualisierung abgebrochen.");
  console.error(error);
  console.error("[bonni-update] Das Updatepaket bleibt für einen erneuten Lauf mit npm run update erhalten.");
  process.exitCode = 1;
} finally {
  await releaseLock?.();
}
