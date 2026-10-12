import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAbsolutePathWithoutSymlinks,
  copyCoreLicenseVersion,
  rebuildLicenseCatalog,
  resolveCentralLicenseRoot,
  validCoreLicenseVersion,
  verifyCoreLicenseVersion,
} from "../licenses/license-payload-utils.mjs";

async function finalizedPredecessorCleanupRecorded(licenseRoot, version) {
  await assertAbsolutePathWithoutSymlinks(licenseRoot);
  const auditFile = path.join(licenseRoot, "cleanup-history.json");
  const state = await fs.lstat(auditFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isFile() || state.isSymbolicLink()) {
    throw new Error("CORE_LICENSE_CLEANUP_HISTORY_INVALID");
  }
  let history;
  try {
    history = JSON.parse(await fs.readFile(auditFile, "utf8"));
  } catch (error) {
    throw new Error("CORE_LICENSE_CLEANUP_HISTORY_INVALID", { cause: error });
  }
  if (!Array.isArray(history)) throw new Error("CORE_LICENSE_CLEANUP_HISTORY_INVALID");
  const operationId = crypto.createHash("sha256")
    .update(`platform\0bonni-core\0${version}\0lifecycle-finalized`)
    .digest("hex");
  return history.some((entry) => (
    entry?.schemaVersion === "bonni.license-cleanup/v1"
    && entry.operationId === operationId
    && entry.type === "platform"
    && entry.key === "bonni-core"
    && entry.version === version
    && entry.reason === "lifecycle-finalized"
    && (entry.treeSha256 === null || /^[a-f0-9]{64}$/u.test(String(entry.treeSha256 || "")))
    && !Number.isNaN(Date.parse(String(entry.deletedAt || "")))
  ));
}

function exactSeedEntry(version) {
  return {
    type: "platform",
    key: "bonni-core",
    version,
    receipt: `platform/bonni-core/${version}/RECEIPT.json`,
  };
}

async function verifyImageSeed(seedRoot, version) {
  const catalog = JSON.parse(await fs.readFile(path.join(seedRoot, "catalog.json"), "utf8"));
  if (catalog?.schemaVersion !== "bonni.license-catalog/v1" || !Array.isArray(catalog.entries)) {
    throw new Error("CORE_LICENSE_SEED_CATALOG_INVALID");
  }
  const expected = exactSeedEntry(version);
  if (
    catalog.entries.length !== 1
    || Object.entries(expected).some(([key, value]) => catalog.entries[0]?.[key] !== value)
  ) throw new Error("CORE_LICENSE_SEED_NOT_CORE_ONLY");
  const receipt = await verifyCoreLicenseVersion(
    path.join(seedRoot, "platform", "bonni-core", version),
    version,
  );
  if (catalog.entries[0].treeSha256 !== receipt.treeSha256) {
    throw new Error("CORE_LICENSE_SEED_CATALOG_HASH_MISMATCH");
  }
  return receipt;
}

async function ensureRequiredPredecessor({
  currentAlreadyInstalled,
  licenseRoot,
  predecessorSeedRoot,
  requiredPredecessorVersion,
}) {
  if (!requiredPredecessorVersion) return null;
  const predecessorRoot = path.join(
    licenseRoot,
    "platform",
    "bonni-core",
    requiredPredecessorVersion,
  );
  const predecessorState = await fs.lstat(predecessorRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

  // A present predecessor is evidence, not a repair target. Any drift must stop
  // the transition instead of being hidden by the bundled migration seed.
  if (predecessorState) {
    try {
      return await verifyCoreLicenseVersion(predecessorRoot, requiredPredecessorVersion);
    } catch (error) {
      throw new Error(
        `CORE_LICENSE_PREDECESSOR_EVIDENCE_INVALID:${requiredPredecessorVersion}`,
        { cause: error },
      );
    }
  }

  // The forward container retains its startup environment across restarts.
  // Once lifecycle finalization has deliberately removed the predecessor, that
  // persistent audit is the authority preventing the bundle from resurrecting
  // an expired/accepted Core version.
  if (
    currentAlreadyInstalled
    && await finalizedPredecessorCleanupRecorded(licenseRoot, requiredPredecessorVersion)
  ) return null;

  if (!predecessorSeedRoot) {
    throw new Error(`CORE_LICENSE_PREDECESSOR_EVIDENCE_MISSING:${requiredPredecessorVersion}`);
  }
  try {
    await verifyImageSeed(predecessorSeedRoot, requiredPredecessorVersion);
    const installed = await copyCoreLicenseVersion({
      seedRoot: predecessorSeedRoot,
      licenseRoot,
      version: requiredPredecessorVersion,
    });
    return installed.receipt;
  } catch (error) {
    throw new Error(
      `CORE_LICENSE_PREDECESSOR_SEED_INVALID:${requiredPredecessorVersion}`,
      { cause: error },
    );
  }
}

export async function seedCoreLicenseCatalog({
  seedRoot,
  predecessorSeedRoot = "",
  licenseRoot,
  version,
  requiredPredecessorVersion = "",
  generatedAt,
} = {}) {
  const resolvedSeedRoot = path.resolve(seedRoot || "");
  const resolvedLicenseRoot = path.resolve(licenseRoot || "");
  if (!seedRoot || !licenseRoot || !validCoreLicenseVersion(version)) {
    throw new Error("CORE_LICENSE_SEED_ARGUMENTS_INVALID");
  }
  if (requiredPredecessorVersion && !validCoreLicenseVersion(requiredPredecessorVersion)) {
    throw new Error("CORE_LICENSE_PREDECESSOR_VERSION_INVALID");
  }
  await verifyImageSeed(resolvedSeedRoot, version);
  const currentRoot = path.join(resolvedLicenseRoot, "platform", "bonni-core", version);
  const currentState = await fs.lstat(currentRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const currentAlreadyInstalled = Boolean(currentState);
  if (currentAlreadyInstalled) await verifyCoreLicenseVersion(currentRoot, version);

  // Die Vorgängerlizenz darf nicht aus dem neuen Abhängigkeitsstand abgeleitet
  // werden. Nur ein vorhandener exakter Receipt oder der separat gebündelte,
  // exakt versionsgebundene Vorgänger-Seed ist zulässig.
  if (requiredPredecessorVersion && requiredPredecessorVersion !== version) {
    await ensureRequiredPredecessor({
      currentAlreadyInstalled,
      licenseRoot: resolvedLicenseRoot,
      predecessorSeedRoot: predecessorSeedRoot ? path.resolve(predecessorSeedRoot) : "",
      requiredPredecessorVersion,
    });
  }

  const installed = await copyCoreLicenseVersion({
    seedRoot: resolvedSeedRoot,
    licenseRoot: resolvedLicenseRoot,
    version,
  });
  const catalog = await rebuildLicenseCatalog(
    resolvedLicenseRoot,
    generatedAt ? { generatedAt } : undefined,
  );
  return { ...installed, licenseRoot: resolvedLicenseRoot, catalog };
}

async function main(environment = process.env) {
  const seedRoot = String(environment.BONNI_CORE_LICENSE_SEED_ROOT || "").trim();
  if (!seedRoot) {
    // BONNI_CORE_IMAGE_VERSION is the closed-container marker. A local
    // production-like npm start legitimately uses the SYSTEM/licenses catalog
    // prepared by setup and has no immutable image seed.
    if (String(environment.BONNI_CORE_IMAGE_VERSION || "").trim()) {
      throw new Error("CORE_LICENSE_SEED_ROOT_REQUIRED");
    }
    console.log("[core-license] Kein Image-Seed konfiguriert; lokaler SYSTEM/licenses-Stand bleibt maßgeblich.");
    return;
  }
  const projectSystemRoot = String(environment.BONNI_PROJECT_ROOT || "").trim();
  const licenseRoot = resolveCentralLicenseRoot({ projectSystemRoot, environment });
  const result = await seedCoreLicenseCatalog({
    seedRoot,
    predecessorSeedRoot: String(environment.BONNI_CORE_LICENSE_PREDECESSOR_SEED_ROOT || "").trim(),
    licenseRoot,
    version: String(environment.BONNI_CORE_IMAGE_VERSION || "").trim(),
    requiredPredecessorVersion: String(environment.BONNI_CORE_LICENSE_REQUIRED_PREDECESSOR || "").trim(),
  });
  console.log(
    `[core-license] ${result.receipt.version} ${result.created ? "persistent übernommen" : "persistent geprüft"}; `
    + `${result.catalog.entries.length} Katalogeinträge.`,
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
