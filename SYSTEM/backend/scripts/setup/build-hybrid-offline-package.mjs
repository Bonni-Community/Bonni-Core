import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  UPDATE_PACKAGE_MANIFEST_NAME,
  computePayloadTreeSha256,
  createLegacyV1ManualBootstrapUpdatePackageManifest,
  createUnsignedDevelopmentUpdatePackageManifest,
  signUpdatePackageManifest,
  verifyUpdatePackageManifest,
} from "./update-package-manifest.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(SCRIPT_DIRECTORY, "../../../../..");
const PAYLOAD_DIRECTORY_NAME = "PAYLOAD";
const PAYLOAD_COMPONENTS = Object.freeze(["SYSTEM", "WINDOWS", "LINUX", "CONTAINER"]);
const POPULATED_COMPONENTS = Object.freeze(["SYSTEM", "WINDOWS"]);
const EMPTY_COMPONENTS = Object.freeze(["LINUX", "CONTAINER"]);
const IMAGE_MANIFEST_SCHEMA = "bonni.offline-full-image/v1";
const IMAGE_PROGRAM_ROOTS = Object.freeze(["backend", "frontend"]);
const BUILD_LOCK_NAME = ".bonni-hybrid-build.lock";
const STAGE_PREFIX = ".bonni-hybrid-stage-";
const BACKUP_PREFIX = ".bonni-hybrid-backup-";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAXIMUM_TIMESTAMP_FUTURE_SKEW_MS = 24 * 60 * 60_000;
const WINDOWS_VERSION_SCHEMA = "bonni.windows-version/v1";
const VERSION_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const MANIFEST_FORMATS = new Set(["v2", "legacy-v1-manual-bootstrap"]);

function createManifestVerificationPolicy(channel, releaseSequence, signers, manifestFormat) {
  if (manifestFormat === "legacy-v1-manual-bootstrap") {
    return {
      verificationMode: "manual-bootstrap",
      allowLegacyV1ManualBootstrap: true,
      packageSource: "local",
    };
  }
  if (channel === "development") {
    return {
      verificationMode: "development",
      nodeEnv: "development",
      allowUnsignedDevelopment: true,
      packageSource: "local",
    };
  }
  const trustedKeys = {};
  for (const signer of signers) {
    let privateKey;
    try {
      privateKey = signer.privateKey instanceof crypto.KeyObject
        ? signer.privateKey
        : crypto.createPrivateKey(signer.privateKey);
    } catch (error) {
      throw new Error("HYBRID_SIGNER_PRIVATE_KEY_INVALID", { cause: error });
    }
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("HYBRID_SIGNER_PRIVATE_KEY_INVALID");
    }
    const publicKey = crypto.createPublicKey(privateKey);
    const existing = trustedKeys[signer.keyId];
    if (existing) {
      const existingDer = existing.publicKey.export({ type: "spki", format: "der" });
      const currentDer = publicKey.export({ type: "spki", format: "der" });
      if (!existingDer.equals(currentDer)) throw new Error("HYBRID_SIGNER_KEY_ID_COLLISION");
      if (!existing.scopes.includes(signer.scope)) existing.scopes.push(signer.scope);
    } else {
      trustedKeys[signer.keyId] = { publicKey, scopes: [signer.scope] };
    }
  }
  return {
    verificationMode: "production",
    trustedKeys,
    lastAcceptedReleaseSequence: releaseSequence - 1,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function legacyStableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(legacyStableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${legacyStableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalCreatedAt(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_PATTERN.test(value)) {
    throw new Error("HYBRID_IMAGE_CREATED_AT_INVALID");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("HYBRID_IMAGE_CREATED_AT_INVALID");
  }
}

function sanitizeUpdateIdPart(value) {
  const sanitized = String(value)
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("+", "-")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  if (!sanitized) throw new Error("HYBRID_UPDATE_ID_INVALID");
  return sanitized;
}

function createUpdateId(version, createdAt, payloads) {
  assertCanonicalCreatedAt(createdAt);
  if (typeof version !== "string" || !version) throw new Error("HYBRID_IMAGE_VERSION_INVALID");
  if (!Array.isArray(payloads) || payloads.length === 0) throw new Error("HYBRID_PAYLOAD_IDENTITY_MISSING");

  const identities = payloads.map((payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.component !== "string" || !payload.component) {
      throw new Error("HYBRID_PAYLOAD_IDENTITY_INVALID");
    }
    if (typeof payload.version !== "string" || !VERSION_TOKEN_PATTERN.test(payload.version)) {
      throw new Error("HYBRID_PAYLOAD_VERSION_INVALID");
    }
    if (!SHA256_PATTERN.test(payload.treeSha256)) throw new Error("HYBRID_TREE_SHA256_INVALID");
    if (!Number.isSafeInteger(payload.fileCount) || payload.fileCount < 0) {
      throw new Error("HYBRID_PAYLOAD_FILE_COUNT_INVALID");
    }
    if (!Number.isSafeInteger(payload.totalBytes) || payload.totalBytes < 0) {
      throw new Error("HYBRID_PAYLOAD_TOTAL_BYTES_INVALID");
    }
    const identity = {
      component: payload.component,
      version: payload.version,
      treeSha256: payload.treeSha256,
      fileCount: payload.fileCount,
      totalBytes: payload.totalBytes,
    };
    if (Object.hasOwn(payload, "platform")) {
      if (typeof payload.platform !== "string" || !payload.platform) {
        throw new Error("HYBRID_PAYLOAD_PLATFORM_INVALID");
      }
      identity.platform = payload.platform;
    }
    return identity;
  }).sort((left, right) => {
    const componentOrder = compareText(left.component, right.component);
    if (componentOrder) return componentOrder;
    const platformOrder = compareText(left.platform || "", right.platform || "");
    if (platformOrder) return platformOrder;
    return compareText(stableStringify(left), stableStringify(right));
  });

  const identitySha256 = sha256(stableStringify({ version, createdAt, payloads: identities }));
  const compactTimestamp = createdAt.replace(/[-:.]/gu, "").toLowerCase();
  const versionLabel = sanitizeUpdateIdPart(version).slice(0, 24).replace(/[._-]+$/gu, "");
  return `bonni-core-${versionLabel}-${compactTimestamp}-${identitySha256.slice(0, 16)}`;
}

async function readJson(file, errorCode) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
}

async function assertDirectory(directory, errorCode) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode);
}

async function assertRegularFile(file, errorCode) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(errorCode);
}

async function readWindowsVersion(windowsRoot) {
  const versionFile = path.join(windowsRoot, "VERSION.json");
  await assertRegularFile(versionFile, "HYBRID_WINDOWS_VERSION_MISSING");
  const raw = await readJson(versionFile, "HYBRID_WINDOWS_VERSION_INVALID");
  if (
    !raw
    || typeof raw !== "object"
    || Array.isArray(raw)
    || Object.keys(raw).sort(compareText).join("\0") !== "schema\0version"
    || raw.schema !== WINDOWS_VERSION_SCHEMA
    || typeof raw.version !== "string"
    || !VERSION_TOKEN_PATTERN.test(raw.version)
  ) throw new Error("HYBRID_WINDOWS_VERSION_INVALID");
  return raw.version;
}

async function copyDirectoryStrict(sourceRoot, targetRoot) {
  await assertDirectory(sourceRoot, "HYBRID_SOURCE_DIRECTORY_INVALID");
  await fs.mkdir(targetRoot, { recursive: true });

  async function copyDirectory(sourceDirectory, targetDirectory) {
    const entries = (await fs.readdir(sourceDirectory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const source = path.join(sourceDirectory, entry.name);
      const target = path.join(targetDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("HYBRID_SOURCE_SYMLINK_REJECTED");
      if (entry.isDirectory()) {
        await fs.mkdir(target, { recursive: false });
        await copyDirectory(source, target);
        continue;
      }
      if (!entry.isFile()) throw new Error("HYBRID_SOURCE_ENTRY_TYPE_REJECTED");
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
  }

  await copyDirectory(sourceRoot, targetRoot);
}

async function collectDirectoryShape(root) {
  await assertDirectory(root, "HYBRID_PAYLOAD_DIRECTORY_INVALID");
  const directories = [];
  const files = [];

  async function collect(directory, prefix = "") {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("HYBRID_PAYLOAD_SYMLINK_REJECTED");
      if (entry.isDirectory()) {
        directories.push(relative);
        await collect(absolute, relative);
        continue;
      }
      if (!entry.isFile()) throw new Error("HYBRID_PAYLOAD_ENTRY_TYPE_REJECTED");
      const bytes = await fs.readFile(absolute);
      files.push({ path: relative, sizeBytes: bytes.length, sha256: sha256(bytes) });
    }
  }

  await collect(root);
  directories.sort(compareText);
  files.sort((left, right) => compareText(left.path, right.path));
  return { directories, files };
}

async function collectLegacyImageShape(root) {
  await assertDirectory(root, "HYBRID_IMAGE_SYSTEM_MISSING");
  const directories = [];
  const files = [];

  async function collect(directory, prefix = "") {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const state = await fs.lstat(absolute);
      if (state.isSymbolicLink()) throw new Error("HYBRID_IMAGE_SYMLINK_REJECTED");
      if (state.isDirectory()) {
        directories.push(relative);
        await collect(absolute, relative);
        continue;
      }
      if (!state.isFile()) throw new Error("HYBRID_IMAGE_ENTRY_TYPE_REJECTED");
      const bytes = await fs.readFile(absolute);
      files.push({ path: relative, sizeBytes: bytes.length, sha256: sha256(bytes) });
    }
  }

  await collect(root);
  return { directories, files };
}

function canonicalizeShape(shape) {
  return {
    directories: [...shape.directories].sort(compareText),
    files: [...shape.files].sort((left, right) => compareText(left.path, right.path)),
  };
}

async function verifyImageManifest(packageRoot) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const imageManifestFile = path.join(resolvedPackageRoot, "IMAGE-MANIFEST.json");
  const imageSystemRoot = path.join(resolvedPackageRoot, "IMAGE", "SYSTEM");
  await assertDirectory(resolvedPackageRoot, "HYBRID_PACKAGE_ROOT_INVALID");
  await assertRegularFile(imageManifestFile, "HYBRID_IMAGE_MANIFEST_INVALID");
  await assertDirectory(imageSystemRoot, "HYBRID_IMAGE_SYSTEM_MISSING");

  let manifestBytes;
  let manifest;
  try {
    manifestBytes = await fs.readFile(imageManifestFile);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("HYBRID_IMAGE_MANIFEST_INVALID", { cause: error });
  }
  const expectedKeys = ["createdAt", "fileCount", "files", "schema", "totalBytes", "treeSha256", "version"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).sort(compareText).join("\0") !== expectedKeys.join("\0")) {
    throw new Error("HYBRID_IMAGE_MANIFEST_MISMATCH");
  }
  if (manifest.schema !== IMAGE_MANIFEST_SCHEMA || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("HYBRID_IMAGE_MANIFEST_MISMATCH");
  }
  assertCanonicalCreatedAt(manifest.createdAt);
  if (Date.parse(manifest.createdAt) > Date.now() + MAXIMUM_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new Error("HYBRID_IMAGE_CREATED_AT_IN_FUTURE");
  }

  const legacyShape = await collectLegacyImageShape(imageSystemRoot);
  const totalBytes = legacyShape.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes)
    || manifest.fileCount !== legacyShape.files.length
    || manifest.totalBytes !== totalBytes
    || manifest.treeSha256 !== sha256(legacyStableStringify(legacyShape.files))
    || legacyStableStringify(manifest.files) !== legacyStableStringify(legacyShape.files)) {
    throw new Error("HYBRID_IMAGE_MANIFEST_MISMATCH");
  }

  for (const programRoot of IMAGE_PROGRAM_ROOTS) {
    let packageJson;
    let packageLock;
    try {
      packageJson = JSON.parse(await fs.readFile(path.join(imageSystemRoot, programRoot, "package.json"), "utf8"));
      packageLock = JSON.parse(await fs.readFile(path.join(imageSystemRoot, programRoot, "package-lock.json"), "utf8"));
    } catch (error) {
      throw new Error("HYBRID_IMAGE_VERSION_MISMATCH", { cause: error });
    }
    if (packageJson?.version !== manifest.version
      || packageLock?.version !== manifest.version
      || packageLock?.packages?.[""]?.version !== manifest.version) {
      throw new Error("HYBRID_IMAGE_VERSION_MISMATCH");
    }
  }

  return {
    manifest,
    manifestBytes,
    shape: canonicalizeShape(legacyShape),
  };
}

function assertByteIdentical(source, copy, component) {
  try {
    assert.deepEqual(copy, source);
  } catch (error) {
    throw new Error(`HYBRID_${component}_COPY_MISMATCH`, { cause: error });
  }
}

function createPayloadManifest(component, version, shape) {
  const totalBytes = shape.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return {
    component,
    version,
    path: `${PAYLOAD_DIRECTORY_NAME}/${component}`,
    fileCount: shape.files.length,
    totalBytes,
    treeSha256: computePayloadTreeSha256(shape.files),
    files: shape.files,
  };
}

function createEvidenceError(code, backupRoot, errors) {
  const error = new Error(code, { cause: new AggregateError(errors, code) });
  error.backupRoot = backupRoot;
  error.preserveBuildEvidence = true;
  return error;
}

async function commitPayload({ packageRoot, stageRoot, verifyCommitted, fileSystem = fs }) {
  const token = crypto.randomUUID();
  const backupRoot = path.join(packageRoot, `${BACKUP_PREFIX}${token}`);
  const payloadTarget = path.join(packageRoot, PAYLOAD_DIRECTORY_NAME);
  const manifestTarget = path.join(packageRoot, UPDATE_PACKAGE_MANIFEST_NAME);
  const stagedPayload = path.join(stageRoot, PAYLOAD_DIRECTORY_NAME);
  const stagedManifest = path.join(stageRoot, UPDATE_PACKAGE_MANIFEST_NAME);
  let previousPayload = false;
  let previousManifest = false;
  let newPayload = false;
  let newManifest = false;

  await fileSystem.mkdir(backupRoot, { recursive: false });
  try {
    try {
      await fileSystem.rename(payloadTarget, path.join(backupRoot, PAYLOAD_DIRECTORY_NAME));
      previousPayload = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fileSystem.rename(manifestTarget, path.join(backupRoot, UPDATE_PACKAGE_MANIFEST_NAME));
      previousManifest = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    await fileSystem.rename(stagedPayload, payloadTarget);
    newPayload = true;
    // The manifest is deliberately published last. Without it, a partial
    // PAYLOAD is not a consumable update package.
    await fileSystem.rename(stagedManifest, manifestTarget);
    newManifest = true;
    await verifyCommitted();
  } catch (operationError) {
    try {
      if (newManifest) {
        await fileSystem.rename(
          manifestTarget,
          path.join(backupRoot, `FAILED-${UPDATE_PACKAGE_MANIFEST_NAME}`),
        );
      }
      if (newPayload) {
        await fileSystem.rename(payloadTarget, path.join(backupRoot, `FAILED-${PAYLOAD_DIRECTORY_NAME}`));
      }
      if (previousPayload) {
        await fileSystem.rename(path.join(backupRoot, PAYLOAD_DIRECTORY_NAME), payloadTarget);
      }
      // Restore the old manifest last as well. A failed PAYLOAD restore must
      // therefore never expose the old manifest against a wrong payload.
      if (previousManifest) {
        await fileSystem.rename(path.join(backupRoot, UPDATE_PACKAGE_MANIFEST_NAME), manifestTarget);
      }
    } catch (restoreError) {
      throw createEvidenceError(
        "HYBRID_PAYLOAD_RESTORE_FAILED",
        backupRoot,
        [operationError, restoreError],
      );
    }
    try {
      await fileSystem.rm(backupRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw createEvidenceError(
        "HYBRID_PAYLOAD_ROLLBACK_CLEANUP_FAILED",
        backupRoot,
        [operationError, cleanupError],
      );
    }
    throw new Error("HYBRID_PAYLOAD_COMMIT_FAILED", { cause: operationError });
  }

  try {
    await fileSystem.rm(backupRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    throw createEvidenceError(
      "HYBRID_PAYLOAD_BACKUP_CLEANUP_FAILED",
      backupRoot,
      [cleanupError],
    );
  }
}

async function acquireBuildLock(packageRoot) {
  const lockRoot = path.join(packageRoot, BUILD_LOCK_NAME);
  try {
    await fs.mkdir(lockRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("HYBRID_BUILD_LOCKED", { cause: error });
    throw error;
  }
  try {
    await fs.writeFile(
      path.join(lockRoot, "owner.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    try {
      await fs.rm(lockRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw createEvidenceError("HYBRID_BUILD_LOCK_INITIALIZATION_FAILED", lockRoot, [error, cleanupError]);
    }
    throw error;
  }
  return lockRoot;
}

async function assertNoRecoveryArtifacts(packageRoot) {
  const entries = await fs.readdir(packageRoot, { withFileTypes: true });
  const recoveryArtifact = entries.find((entry) => (
    entry.name.startsWith(STAGE_PREFIX) || entry.name.startsWith(BACKUP_PREFIX)
  ));
  if (recoveryArtifact) {
    throw new Error(`HYBRID_RECOVERY_ARTIFACT_PRESENT:${recoveryArtifact.name}`);
  }
}

async function buildHybridOfflinePackageLocked({
  packageRoot,
  channel = "development",
  releaseSequence = 1,
  signers = [],
  manifestFormat = "v2",
  _testHooks = {},
}) {
  if (!MANIFEST_FORMATS.has(manifestFormat)) throw new Error("HYBRID_MANIFEST_FORMAT_INVALID");
  const resolvedPackageRoot = path.resolve(packageRoot);
  const imageSystemRoot = path.join(resolvedPackageRoot, "IMAGE", "SYSTEM");
  const windowsRoot = path.join(resolvedPackageRoot, "WINDOWS");
  const imageState = await verifyImageManifest(resolvedPackageRoot);
  const imageManifest = imageState.manifest;
  const systemVersion = imageManifest?.version;
  const createdAt = imageManifest?.createdAt;
  await assertDirectory(windowsRoot, "HYBRID_WINDOWS_MISSING");
  const windowsVersion = await readWindowsVersion(windowsRoot);
  const initialShapes = new Map([
    ["SYSTEM", imageState.shape],
    ["WINDOWS", await collectDirectoryShape(windowsRoot)],
  ]);
  if (initialShapes.get("WINDOWS").files.length === 0) throw new Error("HYBRID_WINDOWS_EMPTY");

  const stageRoot = path.join(resolvedPackageRoot, `${STAGE_PREFIX}${crypto.randomUUID()}`);
  try {
    const stagedPayloadRoot = path.join(stageRoot, PAYLOAD_DIRECTORY_NAME);
    await fs.mkdir(stagedPayloadRoot, { recursive: true });
    await copyDirectoryStrict(imageSystemRoot, path.join(stagedPayloadRoot, "SYSTEM"));
    await copyDirectoryStrict(windowsRoot, path.join(stagedPayloadRoot, "WINDOWS"));
    for (const component of EMPTY_COMPONENTS) {
      await fs.mkdir(path.join(stagedPayloadRoot, component), { recursive: false });
    }

    const payloads = [];
    for (const component of POPULATED_COMPONENTS) {
      const sourceShape = initialShapes.get(component);
      const copyShape = await collectDirectoryShape(path.join(stagedPayloadRoot, component));
      if (sourceShape.files.length === 0) throw new Error(`HYBRID_${component}_EMPTY`);
      assertByteIdentical(sourceShape, copyShape, component);
      const componentVersion = component === "WINDOWS" ? windowsVersion : systemVersion;
      payloads.push(createPayloadManifest(component, componentVersion, copyShape));
    }

    const signed = {
      updateId: createUpdateId(systemVersion, createdAt, payloads),
      channel,
      releaseSequence,
      createdAt,
      payloads,
    };
    const manifest = manifestFormat === "legacy-v1-manual-bootstrap"
      ? createLegacyV1ManualBootstrapUpdatePackageManifest({
        updateId: signed.updateId,
        createdAt: signed.createdAt,
        payloads: signed.payloads,
      })
      : channel === "development"
        ? createUnsignedDevelopmentUpdatePackageManifest(signed)
        : signUpdatePackageManifest(signed, signers);
    const verificationPolicy = createManifestVerificationPolicy(
      channel,
      releaseSequence,
      signers,
      manifestFormat,
    );
    await fs.writeFile(
      path.join(stageRoot, UPDATE_PACKAGE_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await verifyUpdatePackageManifest({ packageRoot: stageRoot, manifest, ...verificationPolicy });
    await _testHooks.beforeCommit?.({ packageRoot: resolvedPackageRoot, stageRoot, manifest });
    await commitPayload({
      packageRoot: resolvedPackageRoot,
      stageRoot,
      verifyCommitted: async () => {
        await _testHooks.beforeFinalVerification?.({ packageRoot: resolvedPackageRoot, manifest });

        const finalImageState = await verifyImageManifest(resolvedPackageRoot);
        if (!finalImageState.manifestBytes.equals(imageState.manifestBytes)) {
          throw new Error("HYBRID_IMAGE_MANIFEST_CHANGED_DURING_BUILD");
        }
        assertByteIdentical(initialShapes.get("SYSTEM"), finalImageState.shape, "SYSTEM_SOURCE_CHANGED");
        const finalWindowsSource = await collectDirectoryShape(windowsRoot);
        assertByteIdentical(initialShapes.get("WINDOWS"), finalWindowsSource, "WINDOWS_SOURCE_CHANGED");

        for (const component of POPULATED_COMPONENTS) {
          const finalPayload = await collectDirectoryShape(
            path.join(resolvedPackageRoot, PAYLOAD_DIRECTORY_NAME, component),
          );
          assertByteIdentical(initialShapes.get(component), finalPayload, `${component}_FINAL_PAYLOAD`);
        }
        await assertRegularFile(
          path.join(resolvedPackageRoot, UPDATE_PACKAGE_MANIFEST_NAME),
          "HYBRID_UPDATE_MANIFEST_FINAL_INVALID",
        );
        const finalManifest = await readJson(
          path.join(resolvedPackageRoot, UPDATE_PACKAGE_MANIFEST_NAME),
          "HYBRID_UPDATE_MANIFEST_FINAL_INVALID",
        );
        try {
          assert.deepEqual(finalManifest, manifest);
        } catch (error) {
          throw new Error("HYBRID_UPDATE_MANIFEST_CHANGED_DURING_BUILD", { cause: error });
        }
        await verifyUpdatePackageManifest({
          packageRoot: resolvedPackageRoot,
          manifest: finalManifest,
          ...verificationPolicy,
        });
      },
    });

    return {
      packageRoot: resolvedPackageRoot,
      manifest,
      components: [...PAYLOAD_COMPONENTS],
    };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

async function buildHybridOfflinePackage({
  packageRoot = DEFAULT_PACKAGE_ROOT,
  channel = "development",
  releaseSequence = 1,
  signers = [],
  manifestFormat = "v2",
  _testHooks = {},
} = {}) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  await assertDirectory(resolvedPackageRoot, "HYBRID_PACKAGE_ROOT_INVALID");
  const lockRoot = await acquireBuildLock(resolvedPackageRoot);
  let preserveBuildEvidence = false;
  try {
    await assertNoRecoveryArtifacts(resolvedPackageRoot);
    return await buildHybridOfflinePackageLocked({
      packageRoot: resolvedPackageRoot,
      channel,
      releaseSequence,
      signers,
      manifestFormat,
      _testHooks,
    });
  } catch (error) {
    preserveBuildEvidence = error?.preserveBuildEvidence === true;
    throw error;
  } finally {
    if (!preserveBuildEvidence) await fs.rm(lockRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  let packageRoot = DEFAULT_PACKAGE_ROOT;
  let manifestFormat = "v2";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("HYBRID_PACKAGE_ROOT_ARGUMENT_MISSING");
      packageRoot = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--legacy-v1-manual-bootstrap") {
      manifestFormat = "legacy-v1-manual-bootstrap";
      continue;
    }
    throw new Error(`HYBRID_UNKNOWN_ARGUMENT:${argument}`);
  }
  return { packageRoot, manifestFormat };
}

async function main() {
  const result = await buildHybridOfflinePackage(parseArguments(process.argv.slice(2)));
  console.log(`[bonni-package] IMAGE bleibt fuer den bisherigen Installer erhalten.`);
  console.log(`[bonni-package] PAYLOAD wurde fuer den kuenftigen Updater erzeugt.`);
  const updateId = result.manifest.schema === "bonni.update/v2"
    ? result.manifest.signed.updateId
    : result.manifest.updateId;
  console.log(`[bonni-package] ${UPDATE_PACKAGE_MANIFEST_NAME}: ${updateId}`);
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedFile === import.meta.url) {
  main().catch((error) => {
    console.error(`[bonni-package] FEHLER: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

export {
  EMPTY_COMPONENTS,
  PAYLOAD_COMPONENTS,
  POPULATED_COMPONENTS,
  buildHybridOfflinePackage,
  collectDirectoryShape,
  commitPayload,
  createUpdateId,
  verifyImageManifest,
};
