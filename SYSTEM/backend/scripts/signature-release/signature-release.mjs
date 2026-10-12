import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectCoreDockerArchivePayload } from "../../src/system/update-runner/archive-tags.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SYSTEM_ROOT = path.resolve(SCRIPT_DIRECTORY, "../../..");
const CREATE_RELEASE_SCRIPT = path.resolve(SCRIPT_DIRECTORY, "../update-release/create-release.mjs");
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const PRIVATE_PEM_PATTERN = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED )?PRIVATE KEY-----/gu;
const DEFAULT_CORE_IMAGE_REPOSITORY = "ghcr.io/bonni-community/bonni-core";
const OFFICIAL_RELEASE_BASE_URL = "https://github.com/Bonni-Community/bonni-core/releases/download";

export const RELEASE_TARGETS = Object.freeze({
  core: Object.freeze({
    key: "core",
    label: "Bonni Core",
    productId: "bonni-core",
    keyScope: "core",
    policyDirectory: "core",
    componentDirectory: ".",
    versionFiles: ["backend/package.json", "frontend/package.json"],
    installable: true,
  }),
  kontor: Object.freeze({
    key: "kontor",
    label: "KontorApp",
    productId: "bonni-app-kontor",
    keyScope: "app:kontor",
    policyDirectory: "apps/kontor",
    componentDirectory: "app/kontorapp",
    versionFiles: ["package.json"],
    installable: false,
  }),
  stueberl: Object.freeze({
    key: "stueberl",
    label: "StueberlApp",
    productId: "bonni-app-stueberl",
    keyScope: "app:stueberl",
    policyDirectory: "apps/stueberl",
    componentDirectory: "app/stueberlapp",
    versionFiles: ["package.json"],
    installable: false,
  }),
  hocket: Object.freeze({
    key: "hocket",
    label: "HocketApp",
    productId: "bonni-app-hocket",
    keyScope: "app:hocket",
    policyDirectory: "apps/hocket",
    componentDirectory: "app/hocketapp",
    versionFiles: ["package.json"],
    installable: false,
  }),
});

const TARGET_ALIASES = new Map([
  ["core", "core"],
  ["bonni-core", "core"],
  ["kontor", "kontor"],
  ["kontorapp", "kontor"],
  ["stueberl", "stueberl"],
  ["stüberl", "stueberl"],
  ["stueberlapp", "stueberl"],
  ["stüberlapp", "stueberl"],
  ["hocket", "hocket"],
  ["hocketapp", "hocket"],
]);

const VALUE_OPTIONS = new Set([
  "--signature-root",
  "--system-root",
  "--archive",
  "--image",
  "--output-dir",
  "--title",
  "--description-de",
  "--description-en",
  "--migration",
  "--schema-from",
  "--schema-to",
  "--expires-days",
  "--repository",
  "--artifact-url",
]);

function samePath(left, right) {
  const normalize = (value) => {
    const result = path.normalize(path.resolve(value));
    return process.platform === "win32" ? result.toLocaleLowerCase("en-US") : result;
  };
  return normalize(left) === normalize(right);
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function lstatRequired(target, errorCode) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${errorCode}: ${target}`);
    throw error;
  }
}

async function assertNoLinkedPathComponents(target, errorCode) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const remainder = absolute.slice(parsed.root.length);
  for (const segment of remainder.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const state = await lstatRequired(cursor, errorCode);
    if (state.isSymbolicLink()) throw new Error(`${errorCode}_SYMLINK_FORBIDDEN`);
  }
  const real = await fs.realpath(absolute);
  if (!samePath(real, absolute)) throw new Error(`${errorCode}_REALPATH_MISMATCH`);
  return absolute;
}

async function assertSecureDirectory(target, errorCode) {
  const absolute = await assertNoLinkedPathComponents(target, errorCode);
  const state = await lstatRequired(absolute, errorCode);
  if (!state.isDirectory()) throw new Error(`${errorCode}_NOT_DIRECTORY`);
  return absolute;
}

async function assertSecureRegularFile(target, errorCode) {
  const absolute = await assertNoLinkedPathComponents(target, errorCode);
  const state = await lstatRequired(absolute, errorCode);
  if (!state.isFile()) throw new Error(`${errorCode}_NOT_REGULAR_FILE`);
  if (state.nlink > 1) throw new Error(`${errorCode}_HARDLINK_FORBIDDEN`);
  return absolute;
}

function assertSafePrivateKeyRelativePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\\")
    || value.includes(":" )
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    throw new Error("SIGNATURE_POLICY_PRIVATE_KEY_PATH_INVALID");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("SIGNATURE_POLICY_PRIVATE_KEY_PATH_INVALID");
  }
  return segments.join(path.sep);
}

function parsePolicy(contents, definition) {
  let policy;
  try {
    policy = JSON.parse(contents);
  } catch {
    throw new Error("SIGNATURE_POLICY_INVALID_JSON");
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("SIGNATURE_POLICY_INVALID");
  }
  const allowed = new Set(["schemaVersion", "productId", "keyScope", "keyId", "privateKeyRelativePath"]);
  if (Object.keys(policy).some((key) => !allowed.has(key))) {
    throw new Error("SIGNATURE_POLICY_UNKNOWN_FIELD");
  }
  if (policy.schemaVersion !== 1) throw new Error("SIGNATURE_POLICY_SCHEMA_UNSUPPORTED");
  if (policy.productId !== definition.productId) {
    throw new Error(`SIGNATURE_POLICY_PRODUCT_SCOPE_MISMATCH: expected ${definition.productId}`);
  }
  if (policy.keyScope !== definition.keyScope) {
    throw new Error(`SIGNATURE_POLICY_KEY_SCOPE_MISMATCH: expected ${definition.keyScope}`);
  }
  if (typeof policy.keyId !== "string" || !KEY_ID_PATTERN.test(policy.keyId)) {
    throw new Error("SIGNATURE_POLICY_KEY_ID_INVALID");
  }
  return {
    schemaVersion: 1,
    productId: policy.productId,
    keyScope: policy.keyScope,
    keyId: policy.keyId,
    privateKeyRelativePath: assertSafePrivateKeyRelativePath(policy.privateKeyRelativePath),
  };
}

async function loadTargetPolicy(signatureRoot, definition) {
  const scopeDirectory = path.resolve(signatureRoot, definition.policyDirectory);
  if (!isWithin(signatureRoot, scopeDirectory)) throw new Error("SIGNATURE_SCOPE_PATH_ESCAPE");
  await assertSecureDirectory(scopeDirectory, "SIGNATURE_SCOPE_DIRECTORY_MISSING");
  const policyFile = path.join(scopeDirectory, "policy.json");
  await assertSecureRegularFile(policyFile, "SIGNATURE_POLICY_MISSING");
  const policyState = await fs.stat(policyFile);
  if (policyState.size > 64 * 1024) throw new Error("SIGNATURE_POLICY_TOO_LARGE");
  const policy = parsePolicy(await fs.readFile(policyFile, "utf8"), definition);
  const privateKeyFile = path.resolve(scopeDirectory, policy.privateKeyRelativePath);
  if (!isWithin(scopeDirectory, privateKeyFile)) throw new Error("SIGNATURE_PRIVATE_KEY_SCOPE_ESCAPE");
  await assertSecureRegularFile(privateKeyFile, "SIGNATURE_PRIVATE_KEY_MISSING");

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(await fs.readFile(privateKeyFile));
  } catch {
    throw new Error("SIGNATURE_PRIVATE_KEY_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("SIGNATURE_PRIVATE_KEY_REQUIRES_ED25519");
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const publicKeyFingerprint = crypto.createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return { policy, privateKeyFile, publicKeyPem, publicKeyFingerprint };
}

async function ensureSecureChildDirectories(root, segments) {
  const secureRoot = await assertSecureDirectory(root, "PUBLIC_TRUST_PRODUCT_ROOT_MISSING");
  let cursor = secureRoot;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/u.test(segment) || segment === "." || segment === "..") {
      throw new Error("PUBLIC_TRUST_DIRECTORY_NAME_INVALID");
    }
    cursor = path.join(cursor, segment);
    try {
      await fs.mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let state;
    try {
      state = await fs.lstat(cursor);
    } catch {
      throw new Error("PUBLIC_TRUST_DIRECTORY_UNSAFE");
    }
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error("PUBLIC_TRUST_DIRECTORY_UNSAFE");
    }
    const real = await fs.realpath(cursor);
    if (!isWithin(secureRoot, real) || !samePath(real, cursor)) {
      throw new Error("PUBLIC_TRUST_DIRECTORY_UNSAFE");
    }
  }
  return cursor;
}

async function ensureSecureAbsoluteDirectory(target, errorCode) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      await fs.mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const state = await fs.lstat(cursor).catch(() => null);
    if (!state?.isDirectory() || state.isSymbolicLink()) throw new Error(errorCode);
    const real = await fs.realpath(cursor);
    if (!samePath(real, cursor)) throw new Error(errorCode);
  }
  return absolute;
}

async function sha256File(file) {
  const handle = await fs.open(file, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("RELEASE_OUTPUT_CANONICAL_JSON_INVALID");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("RELEASE_OUTPUT_CANONICAL_JSON_INVALID");
}

function assertExactKeys(value, keys, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(errorCode);
}

function verifyManifestSignature(manifest, keyId, publicKey) {
  assertExactKeys(manifest.signature, ["algorithm", "keyId", "value"], "RELEASE_OUTPUT_SIGNATURE_INVALID");
  if (manifest.signature.algorithm !== "Ed25519" || manifest.signature.keyId !== keyId) {
    throw new Error("RELEASE_OUTPUT_SIGNATURE_INVALID");
  }
  const value = String(manifest.signature.value || "");
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(value)) throw new Error("RELEASE_OUTPUT_SIGNATURE_INVALID");
  const signature = Buffer.from(value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== value) {
    throw new Error("RELEASE_OUTPUT_SIGNATURE_INVALID");
  }
  const { signature: _signature, ...payload } = manifest;
  const bytes = Buffer.from(`BONNI_CORE_RELEASE_MANIFEST_V2\n${canonicalJson(payload)}\n`, "utf8");
  if (!crypto.verify(null, bytes, publicKey, signature)) throw new Error("RELEASE_OUTPUT_SIGNATURE_INVALID");
}

async function assertReleaseOutputPreflight(outputDirectory, artifactName) {
  const allowed = new Set([artifactName, "manifest.json"]);
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`RELEASE_OUTPUT_NOT_CLEAN: ${entry.name}`);
    }
    await assertSecureRegularFile(path.join(outputDirectory, entry.name), "RELEASE_OUTPUT_FILE_UNSAFE");
  }
}

async function verifyCreatedCoreRelease(options) {
  const artifactName = `bonni-core-${bonniImageTag(options.version)}.oci`;
  const expectedNames = [artifactName, "manifest.json"].sort();
  const actualEntries = await fs.readdir(options.outputDirectory, { withFileTypes: true });
  if (
    actualEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(actualEntries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedNames)
  ) {
    throw new Error("RELEASE_OUTPUT_FILES_INVALID");
  }
  const archive = await assertSecureRegularFile(
    path.join(options.outputDirectory, artifactName),
    "RELEASE_OUTPUT_ARCHIVE_INVALID",
  );
  const manifestFile = await assertSecureRegularFile(
    path.join(options.outputDirectory, "manifest.json"),
    "RELEASE_OUTPUT_MANIFEST_INVALID",
  );
  const archiveState = await fs.stat(archive);
  const archiveSha256 = await sha256File(archive);
  if (archiveState.size !== options.sourceSize || archiveSha256 !== options.sourceSha256) {
    throw new Error("RELEASE_OUTPUT_ARCHIVE_MISMATCH");
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch {
    throw new Error("RELEASE_OUTPUT_MANIFEST_INVALID");
  }
  assertExactKeys(
    manifest,
    ["schemaVersion", "product", "channel", "version", "artifact", "migration", "issuedAt", "expiresAt", "minimumRunnerVersion", "releaseNotes", "signature"],
    "RELEASE_OUTPUT_MANIFEST_INVALID",
  );
  assertExactKeys(manifest.artifact, ["type", "sizeBytes", "sha256", "source", "imageIdentity"], "RELEASE_OUTPUT_MANIFEST_INVALID");
  assertExactKeys(manifest.artifact.source, ["kind", "url"], "RELEASE_OUTPUT_MANIFEST_INVALID");
  assertExactKeys(manifest.artifact.imageIdentity, ["repository", "digest", "platform"], "RELEASE_OUTPUT_MANIFEST_INVALID");
  assertExactKeys(
    manifest.migration,
    ["required", "strategy", "fromSchemaVersion", "toSchemaVersion", "backwardCompatible"],
    "RELEASE_OUTPUT_MANIFEST_INVALID",
  );
  assertExactKeys(manifest.releaseNotes, ["title", "descriptions"], "RELEASE_OUTPUT_MANIFEST_INVALID");
  assertExactKeys(manifest.releaseNotes.descriptions, ["de", "en"], "RELEASE_OUTPUT_MANIFEST_INVALID");
  const expectedPlatformKeys = options.identity.platform.variant === undefined
    ? ["os", "architecture"]
    : ["os", "architecture", "variant"];
  assertExactKeys(manifest.artifact.imageIdentity.platform, expectedPlatformKeys, "RELEASE_OUTPUT_MANIFEST_INVALID");
  const [repository, digest] = options.image.split("@");
  // The Core image carries the append-only Ops migration chain. Its release
  // creator therefore signs expand-contract by default and rejects `none`.
  const migrationStrategy = options.request.migration || "expand-contract";
  const schemaFrom = options.request.schemaFrom || options.version;
  const schemaTo = options.request.schemaTo || schemaFrom;
  const expiryDays = Number(options.request.expiresDays || 90);
  const issuedAt = new Date(manifest.issuedAt);
  const expiresAt = new Date(manifest.expiresAt);
  const canonicalIssuedAt = !Number.isNaN(issuedAt.getTime()) && issuedAt.toISOString() === manifest.issuedAt;
  const canonicalExpiresAt = !Number.isNaN(expiresAt.getTime()) && expiresAt.toISOString() === manifest.expiresAt;
  if (
    manifest.schemaVersion !== 2
    || manifest.product !== "bonni-core"
    || manifest.channel !== "stable"
    || manifest.version !== options.version
    || manifest.artifact.type !== "oci-image-archive"
    || manifest.artifact.sizeBytes !== archiveState.size
    || manifest.artifact.sha256 !== archiveSha256
    || manifest.artifact.source.kind !== "https"
    || manifest.artifact.source.url !== options.artifactUrl
    || manifest.artifact.imageIdentity.repository !== repository
    || manifest.artifact.imageIdentity.digest !== digest
    || JSON.stringify(manifest.artifact.imageIdentity.platform) !== JSON.stringify(options.identity.platform)
    || manifest.minimumRunnerVersion !== "0.3.0"
    || manifest.migration.required !== (migrationStrategy !== "none")
    || manifest.migration.strategy !== migrationStrategy
    || manifest.migration.fromSchemaVersion !== schemaFrom
    || manifest.migration.toSchemaVersion !== schemaTo
    || manifest.migration.backwardCompatible !== (migrationStrategy !== "offline")
    || manifest.releaseNotes.title !== (options.request.title || `Bonni Core ${visibleBonniVersion(options.version)}`)
    || manifest.releaseNotes.descriptions.de !== (options.request.descriptionDe || `Bonni Core ${visibleBonniVersion(options.version)}`)
    || manifest.releaseNotes.descriptions.en !== (options.request.descriptionEn || `Bonni Core ${visibleBonniVersion(options.version)}`)
    || !Number.isInteger(expiryDays)
    || expiryDays < 1
    || expiryDays > 90
    || !canonicalIssuedAt
    || !canonicalExpiresAt
    || issuedAt.getTime() < options.releaseStartedAt - 5_000
    || issuedAt.getTime() > Date.now() + 5_000
    || expiresAt.getTime() - issuedAt.getTime() !== expiryDays * 24 * 60 * 60_000
  ) {
    throw new Error("RELEASE_OUTPUT_MANIFEST_MISMATCH");
  }
  verifyManifestSignature(manifest, options.keyId, options.publicKey);
  return { archive, manifestFile, manifest };
}

function sameBytes(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function inspectPublicTrustFile(target, expectedContents, keyId) {
  let state;
  try {
    state = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  if (state.isSymbolicLink() || !state.isFile() || state.nlink > 1) {
    throw new Error(`PUBLIC_TRUST_FILE_UNSAFE: ${keyId}`);
  }
  const actualContents = await fs.readFile(target);
  if (!sameBytes(actualContents, expectedContents)) {
    throw new Error(`PUBLIC_TRUST_KEY_ID_CONFLICT: ${keyId}`);
  }
  return "unchanged";
}

async function publishPublicTrustFile(target, contents, keyId, mode = 0o644) {
  const expectedContents = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (await inspectPublicTrustFile(target, expectedContents, keyId) === "unchanged") return "unchanged";

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    try {
      handle = await fs.open(temporary, "wx", mode);
      await handle.writeFile(expectedContents);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    try {
      // A hard link in the same directory publishes the complete temporary file
      // atomically and, unlike rename(), can never replace an existing keyId.
      await fs.link(temporary, target);
    } catch (error) {
      if (error?.code === "EEXIST") {
        await inspectPublicTrustFile(target, expectedContents, keyId);
        return "unchanged";
      }
      if (!["EACCES", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
      // Some Windows/removable filesystems do not support hard links. COPYFILE_EXCL
      // retains the essential no-overwrite guarantee for that case.
      try {
        await fs.copyFile(temporary, target, fsConstants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError?.code !== "EEXIST") throw copyError;
        await inspectPublicTrustFile(target, expectedContents, keyId);
        return "unchanged";
      }
      if (await inspectPublicTrustFile(target, expectedContents, keyId) !== "unchanged") {
        throw new Error(`PUBLIC_TRUST_PUBLISH_INCOMPLETE: ${keyId}`);
      }
    }
    return "created";
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function exportPublicTrust(productRoot, definition, policy, publicKeyPem, publicKeyFingerprint) {
  const trustRoot = await ensureSecureChildDirectories(productRoot, ["GITHUB", "TRUST"]);
  const publicKeyFile = path.join(trustRoot, `${policy.keyId}.pem`);
  const metadataFile = path.join(trustRoot, `${policy.keyId}.json`);
  const metadata = `${JSON.stringify({
    schemaVersion: 1,
    productId: definition.productId,
    keyScope: definition.keyScope,
    keyId: policy.keyId,
    publicKeySha256: publicKeyFingerprint,
    note: "Dieser Fingerabdruck muss vor dem erstmaligen Vertrauen getrennt verglichen werden.",
  }, null, 2)}\n`;

  // Preflight the complete pair before creating a missing companion file. A reused
  // keyId with different key or metadata always fails closed and is never replaced.
  const publicKeyState = await inspectPublicTrustFile(publicKeyFile, publicKeyPem, policy.keyId);
  const metadataState = await inspectPublicTrustFile(metadataFile, metadata, policy.keyId);
  if (publicKeyState !== "unchanged") {
    await publishPublicTrustFile(publicKeyFile, publicKeyPem, policy.keyId);
  }
  if (metadataState !== "unchanged") {
    await publishPublicTrustFile(metadataFile, metadata, policy.keyId);
  }
  return { trustRoot, publicKeyFingerprint };
}

async function readVersionFile(packageFile, label) {
  await assertSecureRegularFile(packageFile, "RELEASE_VERSION_FILE_MISSING");
  let packageData;
  try {
    packageData = JSON.parse(await fs.readFile(packageFile, "utf8"));
  } catch {
    throw new Error(`RELEASE_VERSION_FILE_INVALID: ${label}`);
  }
  const version = String(packageData?.version || "");
  if (!VERSION_PATTERN.test(version)) throw new Error(`RELEASE_VERSION_INVALID: ${label}`);
  return version;
}

export async function detectCurrentVersion(systemRoot, definition) {
  const componentRoot = path.resolve(systemRoot, definition.componentDirectory);
  if (!isWithin(systemRoot, componentRoot)) throw new Error("RELEASE_COMPONENT_PATH_ESCAPE");
  await assertSecureDirectory(componentRoot, "RELEASE_COMPONENT_MISSING");
  const versions = [];
  for (const relativeFile of definition.versionFiles) {
    versions.push(await readVersionFile(path.join(componentRoot, relativeFile), `${definition.label} ${relativeFile}`));
  }
  if (new Set(versions).size !== 1) {
    throw new Error(`RELEASE_VERSION_MISMATCH: ${definition.label}`);
  }
  return versions[0];
}

function sanitizeChildMessage(value, privateKeyFile) {
  return String(value || "")
    .replace(PRIVATE_PEM_PATTERN, "[PRIVATE_KEY_REDACTED]")
    .split(privateKeyFile).join("[PRIVATE_KEY_PATH_REDACTED]")
    .trim();
}

function defaultProcessRunner(command, args, { privateKeyFile, timeoutMs = 30 * 60_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-1024 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(sanitizeChildMessage(error.message, privateKeyFile)));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const safeStdout = sanitizeChildMessage(stdout, privateKeyFile);
      const safeStderr = sanitizeChildMessage(stderr, privateKeyFile);
      if (code === 0) resolve({ code, stdout: safeStdout, stderr: safeStderr });
      else reject(new Error(safeStderr || safeStdout || `RELEASE_PROCESS_FAILED: exit ${code}`));
    });
  });
}

function visibleBonniVersion(value) {
  return String(value || "").replace(/^(\d+\.\d+\.\d+)\+([A-Za-z])$/u, "$1$2");
}

export function bonniImageTag(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([a-z]+))?$/u.exec(version);
  if (!match) throw new Error(`RELEASE_VERSION_NOT_IMAGE_COMPATIBLE: ${version}`);
  const tag = `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}${match[5] ? `-${match[5]}` : ""}`;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(tag)) throw new Error(`RELEASE_IMAGE_TAG_INVALID: ${version}`);
  return tag;
}

function officialArtifactUrl(version) {
  const imageTag = bonniImageTag(version);
  return `${OFFICIAL_RELEASE_BASE_URL}/v${imageTag}/bonni-core-${imageTag}.oci`;
}

function normalizeCoreRepository(value) {
  const repository = String(value || DEFAULT_CORE_IMAGE_REPOSITORY).trim();
  if (!/^[a-z0-9][a-z0-9._:/-]{2,254}$/u.test(repository) || repository.includes("@")) {
    throw new Error("CORE_RELEASE_REPOSITORY_INVALID");
  }
  return repository;
}

function assertCoreArchiveLabels(identity, version) {
  for (const [label, expected] of [
    ["org.bonni.product", "bonni-core"],
    ["org.opencontainers.image.version", version],
    ["org.bonni.runtime.contract", "1"],
  ]) {
    if (identity.labels?.[label] !== expected) {
      throw new Error(`CORE_RELEASE_ARCHIVE_LABEL_INVALID: ${label}`);
    }
  }
}

async function inspectPrebuiltCoreArtifact(options) {
  const archive = await assertSecureRegularFile(options.archive, "CORE_RELEASE_ARCHIVE_MISSING");
  const repository = normalizeCoreRepository(options.repository);
  const imageTag = bonniImageTag(options.version);
  const identity = await inspectCoreDockerArchivePayload(archive, { version: options.version });
  const expectedTag = `${repository}:${imageTag}`;
  if (identity.tags.length !== 1 || identity.tags[0] !== expectedTag) {
    throw new Error(`CORE_RELEASE_ARCHIVE_TAG_INVALID: ${expectedTag}`);
  }
  assertCoreArchiveLabels(identity, options.version);
  const image = `${repository}@${identity.digest}`;
  if (options.image !== undefined && options.image !== image) {
    throw new Error("CORE_RELEASE_IMAGE_IDENTITY_MISMATCH");
  }
  return { archive, image, identity };
}

async function buildCoreOciArtifact(options) {
  const { version, productRoot, privateKeyFile, runner } = options;
  const repository = normalizeCoreRepository(options.repository);
  const tag = bonniImageTag(version);
  const reference = `${repository}:${tag}`;
  const dockerfile = path.join(productRoot, "SYSTEM", "backend", "Dockerfile");
  await assertSecureRegularFile(dockerfile, "CORE_RELEASE_DOCKERFILE_MISSING");
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-core-release-"));
  const archive = path.join(temporaryRoot, `bonni-core-${tag}.oci`);
  try {
    await runner("docker", [
      "build",
      "--file", dockerfile,
      "--tag", reference,
      "--build-arg", `BONNI_CORE_VERSION=${version}`,
      "--build-arg", `BONNI_CORE_REVISION=${options.revision || "local-release"}`,
      productRoot,
    ], { privateKeyFile, cwd: productRoot, timeoutMs: 60 * 60_000 });
    const inspected = await runner("docker", ["image", "inspect", "--format", "{{json .}}", reference], {
      privateKeyFile,
      cwd: productRoot,
      timeoutMs: 60_000,
    });
    let identity;
    try { identity = JSON.parse(inspected.stdout); } catch { throw new Error("CORE_RELEASE_IMAGE_INSPECT_INVALID"); }
    if (!identity || identity.Os !== "linux" || !["amd64", "arm64"].includes(identity.Architecture)) {
      throw new Error("CORE_RELEASE_IMAGE_PLATFORM_INVALID");
    }
    // A docker-save archive is content-addressed by the image config blob. Its
    // immutable identity is therefore always the Docker image ID, not an
    // optional registry RepoDigest left over from an earlier pull/push.
    const digest = String(identity.Id || "");
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("CORE_RELEASE_IMAGE_DIGEST_INVALID");
    await runner("docker", ["image", "save", "--output", archive, reference], {
      privateKeyFile,
      cwd: productRoot,
      timeoutMs: 30 * 60_000,
    });
    await assertSecureRegularFile(archive, "CORE_RELEASE_ARCHIVE_BUILD_FAILED");
    const archiveIdentity = await inspectCoreDockerArchivePayload(archive, { version });
    if (archiveIdentity.tags.length !== 1 || archiveIdentity.tags[0] !== reference || archiveIdentity.digest !== digest) {
      throw new Error("CORE_RELEASE_ARCHIVE_BUILD_IDENTITY_INVALID");
    }
    assertCoreArchiveLabels(archiveIdentity, version);
    return { archive, image: `${repository}@${digest}`, identity: archiveIdentity, temporaryRoot };
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function coreReleaseArguments(options, version, privateKeyFile, keyId, outputDirectory) {
  const args = [
    CREATE_RELEASE_SCRIPT,
    "--archive", options.archive,
    "--image", options.image,
    "--version", version,
    "--private-key", privateKeyFile,
    "--key-id", keyId,
    "--output-dir", outputDirectory,
  ];
  for (const [optionName, optionValue] of [
    ["--title", options.title],
    ["--description-de", options.descriptionDe],
    ["--description-en", options.descriptionEn],
    ["--migration", options.migration],
    ["--schema-from", options.schemaFrom],
    ["--schema-to", options.schemaTo],
    ["--expires-days", options.expiresDays],
    ["--artifact-url", options.artifactUrl],
  ]) {
    if (optionValue !== undefined) args.push(optionName, String(optionValue));
  }
  return args;
}

function safePublicResult(definition, policy, version, state, extra = {}) {
  return {
    target: definition.key,
    label: definition.label,
    productId: definition.productId,
    keyScope: definition.keyScope,
    keyId: policy.keyId,
    version,
    state,
    ...extra,
  };
}

export async function runSignatureRelease(options = {}) {
  const targetKey = TARGET_ALIASES.get(String(options.target || "").toLocaleLowerCase("de-DE"));
  const definition = RELEASE_TARGETS[targetKey];
  if (!definition) throw new Error("RELEASE_TARGET_INVALID: core, kontor, stueberl oder hocket erwartet");

  const rawSignatureRoot = String(options.signatureRoot || "").trim();
  if (!rawSignatureRoot) throw new Error("SIGNATURE_ROOT_REQUIRED: --signature-root oder BONNI_SIGNATURE_ROOT");
  const signatureRoot = await assertSecureDirectory(rawSignatureRoot, "SIGNATURE_ROOT_MISSING");
  const systemRoot = await assertSecureDirectory(options.systemRoot || DEFAULT_SYSTEM_ROOT, "RELEASE_SYSTEM_ROOT_MISSING");
  const { policy, privateKeyFile, publicKeyPem, publicKeyFingerprint } = await loadTargetPolicy(signatureRoot, definition);
  const version = await detectCurrentVersion(systemRoot, definition);

  if (!definition.installable) {
    throw new Error(`APP_RELEASE_NOT_INSTALLABLE_YET: ${definition.label} erzeugt noch kein installierbares Paket.`);
  }

  const hasPrebuiltArchive = Boolean(options.archive);
  if (options.image && !hasPrebuiltArchive) throw new Error("CORE_RELEASE_ARCHIVE_REQUIRED_FOR_IMAGE");
  let prebuiltArtifact;
  if (hasPrebuiltArchive) {
    prebuiltArtifact = await inspectPrebuiltCoreArtifact({
      archive: options.archive,
      image: options.image,
      repository: options.repository,
      version,
    });
  }
  if (options.dryRun) {
    return safePublicResult(definition, policy, version, "dry-run", {
      artifactReady: hasPrebuiltArchive,
      nextStep: hasPrebuiltArchive ? "create-release" : "build-oci-artifact",
      ...(prebuiltArtifact ? { image: prebuiltArtifact.image } : {}),
    });
  }

  const productRoot = path.dirname(systemRoot);
  const imageTag = bonniImageTag(version);
  const artifactName = `bonni-core-${imageTag}.oci`;
  const artifactUrl = options.artifactUrl || officialArtifactUrl(version);
  const outputDirectory = path.resolve(options.outputDirectory || path.join(productRoot, "GITHUB", "RELEASES", "core", imageTag));
  if (isWithin(signatureRoot, outputDirectory) || isWithin(outputDirectory, signatureRoot)) {
    throw new Error("RELEASE_OUTPUT_SIGNATURE_ROOT_OVERLAP_FORBIDDEN");
  }
  await ensureSecureAbsoluteDirectory(outputDirectory, "RELEASE_OUTPUT_DIRECTORY_UNSAFE");
  await assertReleaseOutputPreflight(outputDirectory, artifactName);
  // Public trust is deliberately published first. A conflicting keyId can
  // therefore never leave a newly created, but undistributable release behind.
  const trust = await exportPublicTrust(productRoot, definition, policy, publicKeyPem, publicKeyFingerprint);
  const runner = options.processRunner || defaultProcessRunner;
  let builtArtifact;
  if (!hasPrebuiltArchive) {
    builtArtifact = await buildCoreOciArtifact({
      ...options,
      version,
      productRoot,
      privateKeyFile,
      runner,
    });
  }
  const archive = await assertSecureRegularFile(
    hasPrebuiltArchive ? prebuiltArtifact.archive : builtArtifact.archive,
    "CORE_RELEASE_ARCHIVE_MISSING",
  );
  const image = hasPrebuiltArchive ? prebuiltArtifact.image : builtArtifact.image;
  const identity = hasPrebuiltArchive ? prebuiltArtifact.identity : builtArtifact.identity;
  if (!/^([a-z0-9][a-z0-9._:/-]+)@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error("CORE_RELEASE_IMAGE_IDENTITY_INVALID");
  }
  const sourceState = await fs.stat(archive);
  const sourceSha256 = await sha256File(archive);

  try {
    const releaseStartedAt = Date.now();
    await runner(process.execPath, coreReleaseArguments({
      ...options,
      archive,
      image,
      artifactUrl,
    }, version, privateKeyFile, policy.keyId, outputDirectory), {
      privateKeyFile,
      cwd: path.join(systemRoot, "backend"),
    });
    await verifyCreatedCoreRelease({
      outputDirectory,
      version,
      image,
      identity,
      artifactUrl,
      keyId: policy.keyId,
      publicKey: crypto.createPublicKey(publicKeyPem),
      sourceSize: sourceState.size,
      sourceSha256,
      releaseStartedAt,
      request: options,
    });
  } finally {
    if (builtArtifact) await fs.rm(builtArtifact.temporaryRoot, { recursive: true, force: true });
  }
  return safePublicResult(definition, policy, version, "created", {
    outputDirectory,
    releaseTag: `v${imageTag}`,
    manifestUrl: `${OFFICIAL_RELEASE_BASE_URL}/v${imageTag}/manifest.json`,
    publicKeyFingerprint: trust.publicKeyFingerprint,
  });
}

export function parseSignatureReleaseArguments(argv, env = process.env) {
  const parsed = {
    target: undefined,
    signatureRoot: undefined,
    systemRoot: undefined,
    archive: undefined,
    image: undefined,
    outputDirectory: undefined,
    title: undefined,
    descriptionDe: undefined,
    descriptionEn: undefined,
    migration: undefined,
    schemaFrom: undefined,
    schemaTo: undefined,
    expiresDays: undefined,
    repository: undefined,
    artifactUrl: undefined,
    dryRun: false,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run" || value === "--help" || value === "-h") {
      const property = value === "--dry-run" ? "dryRun" : "help";
      if (seen.has(property)) throw new Error(`RELEASE_ARGUMENT_DUPLICATE: ${value}`);
      parsed[property] = true;
      seen.add(property);
      continue;
    }
    if (VALUE_OPTIONS.has(value)) {
      const optionValue = argv[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw new Error(`RELEASE_ARGUMENT_VALUE_MISSING: ${value}`);
      }
      const property = {
        "--signature-root": "signatureRoot",
        "--system-root": "systemRoot",
        "--archive": "archive",
        "--image": "image",
        "--output-dir": "outputDirectory",
        "--title": "title",
        "--description-de": "descriptionDe",
        "--description-en": "descriptionEn",
        "--migration": "migration",
        "--schema-from": "schemaFrom",
        "--schema-to": "schemaTo",
        "--expires-days": "expiresDays",
        "--repository": "repository",
        "--artifact-url": "artifactUrl",
      }[value];
      if (seen.has(property)) throw new Error(`RELEASE_ARGUMENT_DUPLICATE: ${value}`);
      parsed[property] = optionValue;
      seen.add(property);
      index += 1;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`RELEASE_ARGUMENT_UNKNOWN: ${value}`);
    if (parsed.target) throw new Error("RELEASE_REQUIRES_EXACTLY_ONE_TARGET");
    parsed.target = value;
  }
  if (!parsed.signatureRoot) parsed.signatureRoot = env.BONNI_SIGNATURE_ROOT;
  return parsed;
}

export function signatureReleaseHelp() {
  return [
    "Installierbares, signiertes Bonni-Release vorbereiten",
    "",
    "  npm run release -- core --signature-root X:\\BONNI_SIGNATUR --dry-run",
    "  npm run release -- core --signature-root X:\\BONNI_SIGNATUR",
    "  npm run release -- core --signature-root X:\\BONNI_SIGNATUR --archive <core.oci> --dry-run",
    "  npm run release -- core --signature-root X:\\BONNI_SIGNATUR --archive <core.oci>",
    "",
    "Ohne --archive baut Docker das OCI-Systemimage automatisch.",
    "Mit --archive wird die Image-ID ohne Docker direkt aus dem Archiv geprüft.",
    "Alternativ kann BONNI_SIGNATURE_ROOT auf den USB-Stick zeigen.",
    "Kontor, Stueberl und Hocket besitzen getrennte Schluesselbereiche, sind als installierbare App-Pakete aber noch gesperrt.",
  ].join("\n");
}
