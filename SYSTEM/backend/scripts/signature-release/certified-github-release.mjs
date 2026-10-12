import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { assembleApprovedReleaseRequest } from "../development/assemble-approved-release.mjs";
import { collectDevelopmentTree } from "../development/release-assembly.mjs";
import { readApprovedDevelopmentChain } from "../setup/development-package-store.mjs";
import { extractUpdateZip } from "../setup/safe-update-zip.mjs";
import {
  UPDATE_PACKAGE_COMPONENTS,
  UPDATE_PACKAGE_MANIFEST_NAME,
  computePayloadTreeSha256,
  readAndVerifyUpdatePackageManifest,
  signRegistryUpdatePackageManifest,
  signUpdatePackageManifest,
  verifyUpdatePackageManifest,
} from "../setup/update-package-manifest.mjs";
import {
  BONNI_APP_REGISTRY_FILE_NAME,
  appIdFromDirectory,
  appManifestScope,
  appTrustScope,
  createBonniAppRegistry,
  createBonniAppRegistryBinding,
  readBonniAppRegistryFile,
  serializeBonniAppRegistry,
} from "../setup/app-registry.mjs";
import {
  keyForScope,
  publicTrustExport,
  unlockBonniKeystore,
} from "./bonni-keystore.mjs";
import {
  assertDeveloperBuildAuthorized,
  assertDeveloperGitHubRequestAuthorizedForProfile,
} from "../setup/developer-build-capability.mjs";
import {
  getLocalSecretVaultStatus,
  withLocalSecretVaultEntry,
} from "../setup/local-secret-vault.mjs";

export const CERTIFIED_GITHUB_RELEASE_REQUEST_SCHEMA = "bonni.github-release-request/v1";
export const CERTIFIED_GITHUB_RELEASE_SEQUENCE_SCHEMA = "bonni.github-release-sequence/v1";

const UPDATE_COMPONENT_SET = new Set(UPDATE_PACKAGE_COMPONENTS);
const APPLICATION_COMPONENT = /^[A-Z][A-Z0-9._-]{1,63}$/u;
const MAX_RELEASE_COMPONENTS = UPDATE_PACKAGE_COMPONENTS.length + 128;
const COMPONENT_ROOTS = Object.freeze({
  SYSTEM: "SYSTEM",
  WINDOWS: "WINDOWS",
  LINUX: "LINUX",
  CONTAINER: "CONTAINER",
});
const VERSION = /^(\d+\.\d+\.\d+)(?:\+?([a-z]))$/u;
const CANONICAL_REQUEST_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_FILE_EXTENSION = /\.(?:bonni|jwk|key|kdbx|p12|pfx|pkcs8)$/iu;
const SECRET_FILE_BASENAME = /^(?:credentials?|secrets?)(?:\.json)?$|^(?:id_(?:dsa|ecdsa|ed25519|rsa)|(?:private|master)[._-]?key(?:\.pem)?)$/iu;
const SECRET_DOTFILE_BASENAME = /^(?:\.env|\.git-credentials|\.netrc|\.npmrc|\.pypirc)$/iu;
const SECRET_BEARING_PATH = /(?:^|\/)(?:\.aws\/(?:config|credentials)|\.azure\/(?:accessTokens|azureProfile)\.json|\.config\/gcloud\/application_default_credentials\.json|\.docker\/config\.json|\.kube\/config)$/iu;
const PRIVATE_KEY_BLOCK = /(?:^|\r?\n)-----BEGIN (?:(?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----\r?\n/u;
const KNOWN_CREDENTIAL_TOKEN = /(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{10,255})/u;
const UNQUOTED_CREDENTIAL_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*[:=]\s*(["'`])([^\r\n]{1,2048}?)\2/gmu;
const QUOTED_CREDENTIAL_ASSIGNMENT = /(["'])([A-Za-z_][A-Za-z0-9_.-]{0,127})\1\s*:\s*(["'`])([^\r\n]{1,2048}?)\3/gmu;
const CONFIG_CREDENTIAL_ASSIGNMENT = /(?:^|\r?\n)\s*(?:-\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*[:=]\s*([^\s#"'`][^\r\n#]{0,2047})/gmu;
const SAFE_CREDENTIAL_PLACEHOLDER = /^(?:\*{3,}|\[REDACTED\]|<REDACTED>|REDACTED|\$\{[A-Z][A-Z0-9_]*(?::[-?][^}\r\n]*)?\}|<[A-Z][A-Z0-9_-]*>)$/u;
const DOCUMENTED_ENV_EXAMPLE = "backend/.env.example";
const DOCUMENTED_RUNTIME_COMPOSE = "backend/docker-compose.runtime.yml";
const SECRET_SCAN_OVERLAP_BYTES = 8 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_BYTES = 64 * 1024;
const MAX_KEYSTORE_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const COMPONENT_PLATFORMS = Object.freeze({
  LINUX: new Set(["linux-x86", "linux-x64", "linux-armv7", "linux-arm64"]),
  CONTAINER: new Set(["linux-x86", "linux-x64", "linux-armv7", "linux-arm64"]),
});
const MAX_APPLICATION_PACKAGE_JSON_BYTES = MAX_REQUEST_BYTES;
const MAX_APPLICATION_VERSION_LENGTH = 128;
// SemVer 2.0.0 without a leading "v", whitespace, leading zeroes or partial
// versions. Bonni's package metadata is intentionally stricter than the
// product release label (which also accepts the visible 0.1.20h spelling).
const STRICT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export class CertifiedGitHubReleaseError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "CertifiedGitHubReleaseError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new CertifiedGitHubReleaseError(code, detail, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("CERTIFIED_RELEASE_INVALID_OBJECT", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("CERTIFIED_RELEASE_REQUEST_UNKNOWN_FIELD", `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("CERTIFIED_RELEASE_REQUEST_FIELD_REQUIRED", `${label}.${key}`);
  }
}

function assertDocumentKeys(value, exactKeys, code) {
  if (
    !isPlainObject(value)
    || Object.keys(value).sort().join("\0") !== [...exactKeys].sort().join("\0")
  ) fail(code);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => bytewiseCompare(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function pathIsWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail(code, target);
  return state;
}

async function ensurePlainDirectory(target, parent) {
  if (!pathIsWithin(parent, target)) fail("CERTIFIED_RELEASE_DIRECTORY_ESCAPES_ROOT", target);
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  let current = path.resolve(parent);
  await assertPlainDirectory(current, "CERTIFIED_RELEASE_PRODUCT_ROOT_UNSAFE");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const state = await lstatOrNull(current);
    if (!state) await fs.mkdir(current, { mode: 0o700 });
    await assertPlainDirectory(current, "CERTIFIED_RELEASE_DIRECTORY_UNSAFE");
  }
}

function normalizeVersion(value, label) {
  if (typeof value !== "string") fail("CERTIFIED_RELEASE_VERSION_INVALID", label);
  const match = VERSION.exec(value.trim().toLowerCase());
  if (!match) fail("CERTIFIED_RELEASE_VERSION_INVALID", label);
  return Object.freeze({
    visible: `${match[1]}${match[2]}`,
    technical: `${match[1]}+${match[2]}`,
  });
}

function canonicalRequestTimestamp(value) {
  if (
    typeof value !== "string"
    || !CANONICAL_REQUEST_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
  ) fail("CERTIFIED_RELEASE_REQUESTED_AT_INVALID");
  const canonical = new Date(Date.parse(value)).toISOString();
  if (Date.parse(canonical) > Date.now() + 24 * 60 * 60_000) {
    fail("CERTIFIED_RELEASE_REQUESTED_AT_IN_FUTURE");
  }
  return canonical;
}

function normalizeComponents(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_RELEASE_COMPONENTS) {
    fail("CERTIFIED_RELEASE_COMPONENTS_INVALID");
  }
  const used = new Set();
  for (const value of raw) {
    if (
      typeof value !== "string"
      || (!UPDATE_COMPONENT_SET.has(value) && !APPLICATION_COMPONENT.test(value))
      || used.has(value)
    ) {
      fail("CERTIFIED_RELEASE_COMPONENT_INVALID", String(value));
    }
    used.add(value);
  }
  if ([...used].some((entry) => !UPDATE_COMPONENT_SET.has(entry)) && !used.has("SYSTEM")) {
    fail("CERTIFIED_RELEASE_APPLICATION_REQUIRES_SYSTEM");
  }
  return [
    ...UPDATE_PACKAGE_COMPONENTS.filter((entry) => used.has(entry)),
    ...[...used].filter((entry) => !UPDATE_COMPONENT_SET.has(entry)).sort(bytewiseCompare),
  ];
}

function normalizeRelativeRequestPath(value, label) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.normalize("NFC")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail("CERTIFIED_RELEASE_REQUEST_PATH_INVALID", label);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("CERTIFIED_RELEASE_REQUEST_PATH_INVALID", label);
  }
  return segments.join("/");
}

export function parseCertifiedGitHubReleaseRequest(raw, { productRoot } = {}) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "requestedAt", "version", "windowsVersion", "components",
      "description", "keyStore", "developmentChain", "outputDirectory",
    ]),
    new Set([
      "schema", "requestedAt", "version", "windowsVersion", "components",
      "description", "keyStore", "developmentChain", "outputDirectory",
    ]),
    "request",
  );
  if (raw.schema !== CERTIFIED_GITHUB_RELEASE_REQUEST_SCHEMA) {
    fail("CERTIFIED_RELEASE_REQUEST_SCHEMA_UNSUPPORTED", String(raw.schema));
  }
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("CERTIFIED_RELEASE_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  const version = normalizeVersion(raw.version, "request.version");
  const components = normalizeComponents(raw.components);
  const selected = new Set(components);
  let windowsVersion = null;
  if (selected.has("WINDOWS")) {
    if (raw.windowsVersion === null) fail("CERTIFIED_RELEASE_WINDOWS_VERSION_REQUIRED");
    windowsVersion = normalizeVersion(raw.windowsVersion, "request.windowsVersion");
  } else if (raw.windowsVersion !== null) {
    fail("CERTIFIED_RELEASE_WINDOWS_VERSION_WITHOUT_COMPONENT");
  }
  if (
    typeof raw.description !== "string"
    || !raw.description.trim()
    || Buffer.byteLength(raw.description.trim(), "utf8") > MAX_DESCRIPTION_BYTES
    || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(raw.description)
  ) fail("CERTIFIED_RELEASE_DESCRIPTION_INVALID");
  if (typeof raw.keyStore !== "string" || !path.isAbsolute(raw.keyStore) || /[\u0000-\u001f\u007f]/u.test(raw.keyStore)) {
    fail("CERTIFIED_RELEASE_KEYSTORE_PATH_INVALID");
  }
  const developmentChain = normalizeRelativeRequestPath(raw.developmentChain, "request.developmentChain");
  if (developmentChain !== "RUN_DEV/APPROVED-CHAIN.json") {
    fail("CERTIFIED_RELEASE_DEVELOPMENT_CHAIN_PATH_INVALID", developmentChain);
  }
  const outputDirectory = normalizeRelativeRequestPath(raw.outputDirectory, "request.outputDirectory");
  if (!(outputDirectory === "GITHUB/READY" || outputDirectory.startsWith("GITHUB/READY/"))) {
    fail("CERTIFIED_RELEASE_OUTPUT_DIRECTORY_INVALID", outputDirectory);
  }
  const resolvedDevelopmentChain = path.resolve(resolvedProductRoot, ...developmentChain.split("/"));
  const resolvedOutputDirectory = path.resolve(resolvedProductRoot, ...outputDirectory.split("/"));
  if (
    !pathIsWithin(resolvedProductRoot, resolvedDevelopmentChain)
    || !pathIsWithin(resolvedProductRoot, resolvedOutputDirectory)
  ) fail("CERTIFIED_RELEASE_REQUEST_PATH_ESCAPES_PRODUCT_ROOT");
  return Object.freeze({
    schema: CERTIFIED_GITHUB_RELEASE_REQUEST_SCHEMA,
    requestedAt: canonicalRequestTimestamp(raw.requestedAt),
    version,
    windowsVersion,
    components: Object.freeze(components),
    description: raw.description.trim().normalize("NFC"),
    keyStore: path.resolve(raw.keyStore),
    developmentChain,
    resolvedDevelopmentChain,
    outputDirectory,
    resolvedOutputDirectory,
    productRoot: resolvedProductRoot,
  });
}

async function readRegularJson(file, code, maximumBytes = MAX_REQUEST_BYTES) {
  const state = await lstatOrNull(file);
  if (
    !state
    || !state.isFile()
    || state.isSymbolicLink()
    || state.nlink > 1
    || state.size <= 0
    || state.size > maximumBytes
  ) fail(code, file);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (cause) {
    if (cause instanceof CertifiedGitHubReleaseError) throw cause;
    fail(code, file, { cause });
  }
}

export async function readCertifiedGitHubReleaseRequest(requestFile, { productRoot } = {}) {
  if (typeof requestFile !== "string" || !path.isAbsolute(requestFile)) {
    fail("CERTIFIED_RELEASE_REQUEST_FILE_ABSOLUTE_REQUIRED");
  }
  const raw = await readRegularJson(path.resolve(requestFile), "CERTIFIED_RELEASE_REQUEST_FILE_INVALID");
  return parseCertifiedGitHubReleaseRequest(raw, { productRoot });
}

function trustedKeysFromKeystore(releaseKey, componentKeys, appKeys) {
  const trusted = new Map();
  trusted.set(releaseKey.keyId, {
    publicKey: releaseKey.publicKeyPem,
    scopes: ["RELEASE"],
  });
  for (const [component, key] of componentKeys) {
    trusted.set(key.keyId, { publicKey: key.publicKeyPem, scopes: [component] });
  }
  for (const [app, key] of appKeys) {
    trusted.set(key.keyId, { publicKey: key.publicKeyPem, scopes: [appManifestScope(app)] });
  }
  return trusted;
}

async function unlockReleaseKeys(request, masterPassword) {
  const state = await lstatOrNull(request.keyStore);
  if (
    !state
    || !state.isFile()
    || state.isSymbolicLink()
    || state.nlink > 1
    || state.size <= 0
    || state.size > MAX_KEYSTORE_BYTES
  ) fail("CERTIFIED_RELEASE_KEYSTORE_UNSAFE", request.keyStore);
  const unlocked = await unlockBonniKeystore(await fs.readFile(request.keyStore), masterPassword);
  const releaseKey = keyForScope(unlocked, "release-set");
  const componentKeys = new Map();
  for (const component of request.components.filter((entry) => UPDATE_COMPONENT_SET.has(entry))) {
    componentKeys.set(component, keyForScope(unlocked, `component:${component}`));
  }
  const appKeys = new Map();
  for (const app of request.components.filter((entry) => !UPDATE_COMPONENT_SET.has(entry))) {
    appKeys.set(app, keyForScope(unlocked, appTrustScope(app)));
  }
  return { unlocked, releaseKey, componentKeys, appKeys };
}

export async function ensureCertifiedReleasePublicTrust(productRoot, unlocked) {
  const trustDirectory = path.join(productRoot, "RUN_INSTALL", "trust");
  await ensurePlainDirectory(trustDirectory, productRoot);
  const trustFile = path.join(trustDirectory, "UPDATE-PUBLIC-TRUST.json");
  const publicTrust = publicTrustExport(unlocked);
  const coreTrustIdentity = (value) => stableStringify({
    schema: value?.schema,
    storeId: value?.storeId,
    createdAt: value?.createdAt,
    keys: Array.isArray(value?.keys)
      ? value.keys.filter((entry) => typeof entry?.scope === "string" && !entry.scope.startsWith("app:"))
      : [],
  });
  const existing = await lstatOrNull(trustFile);
  if (existing) {
    const observed = await readRegularJson(
      trustFile,
      "CERTIFIED_RELEASE_PUBLIC_TRUST_INVALID",
      MAX_REQUEST_BYTES,
    );
    if (coreTrustIdentity(observed) !== coreTrustIdentity(publicTrust)) {
      fail("CERTIFIED_RELEASE_PUBLIC_TRUST_CONFLICT", trustFile);
    }
    return Object.freeze({ trustFile, initialized: false, publicTrust: observed });
  }
  let handle;
  try {
    handle = await fs.open(trustFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(publicTrust, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      const observed = await readRegularJson(
        trustFile,
        "CERTIFIED_RELEASE_PUBLIC_TRUST_INVALID",
        MAX_REQUEST_BYTES,
      );
      if (coreTrustIdentity(observed) !== coreTrustIdentity(publicTrust)) {
        fail("CERTIFIED_RELEASE_PUBLIC_TRUST_CONFLICT", trustFile);
      }
      return Object.freeze({ trustFile, initialized: false, publicTrust: observed });
    }
    throw cause;
  } finally {
    await handle?.close();
  }
  return Object.freeze({ trustFile, initialized: true, publicTrust });
}

function normalizedCredentialName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isCredentialName(value) {
  return /(?:^|_)(?:access_key|api_key|auth_token|client_secret|credential|credentials|database_url|master_key|passwd|passphrase|password|private_key(?:_pem)?|secret|token)$/u
    .test(normalizedCredentialName(value));
}

function isDocumentedSafeCredentialValue(relativePath, name, value) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:null|undefined)$/u.test(trimmed)) return true;
  if (SAFE_CREDENTIAL_PLACEHOLDER.test(trimmed)) return true;
  const normalizedName = normalizedCredentialName(name);
  if (
    relativePath === DOCUMENTED_ENV_EXAMPLE
    && normalizedName === "database_url"
    && /^postgres(?:ql)?:\/\/[^:\s/]+:<[A-Z][A-Z0-9_-]*>@(?:127\.0\.0\.1|localhost):[0-9]{2,5}\/[A-Za-z0-9_-]+$/u.test(trimmed)
  ) return true;
  return relativePath === DOCUMENTED_RUNTIME_COMPOSE
    && /^(?:database_url|server_database_url)$/u.test(normalizedName)
    && /^postgres(?:ql)?:\/\/\$\{POSTGRES_USER(?::-[^}\r\n]*)?\}:\$\{POSTGRES_PASSWORD(?::[-?][^}\r\n]*)?\}@[^\s]+$/u.test(trimmed);
}

function unsafeCredentialAssignment(contents, relativePath) {
  const assignmentScannable = /\.(?:conf|config|ini|json|properties|toml)$/iu.test(relativePath)
    || relativePath === DOCUMENTED_ENV_EXAMPLE;
  if (!assignmentScannable) return null;
  for (const [expression, nameIndex, valueIndex] of [
    [UNQUOTED_CREDENTIAL_ASSIGNMENT, 1, 3],
    [QUOTED_CREDENTIAL_ASSIGNMENT, 2, 4],
  ]) {
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(contents)) !== null) {
      if (
        isCredentialName(match[nameIndex])
        && !isDocumentedSafeCredentialValue(relativePath, match[nameIndex], match[valueIndex])
      ) return match[nameIndex];
    }
  }
  CONFIG_CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  let match;
  while ((match = CONFIG_CREDENTIAL_ASSIGNMENT.exec(contents)) !== null) {
    if (
      isCredentialName(match[1])
      && !isDocumentedSafeCredentialValue(relativePath, match[1], match[2])
    ) return match[1];
  }
  return null;
}

async function assertFileHasNoSecretContent(absolutePath, relativePath) {
  let overlap = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(absolutePath, { highWaterMark: 64 * 1024 })) {
      const combined = Buffer.concat([overlap, chunk]);
      const contents = combined.toString("utf8");
      if (PRIVATE_KEY_BLOCK.test(contents)) {
        fail("CERTIFIED_RELEASE_PRIVATE_KEY_FORBIDDEN", relativePath);
      }
      if (KNOWN_CREDENTIAL_TOKEN.test(contents)) {
        fail("CERTIFIED_RELEASE_CREDENTIAL_TOKEN_FORBIDDEN", relativePath);
      }
      if (unsafeCredentialAssignment(contents, relativePath)) {
        fail("CERTIFIED_RELEASE_CREDENTIAL_ASSIGNMENT_FORBIDDEN", relativePath);
      }
      const retainedBytes = Math.min(SECRET_SCAN_OVERLAP_BYTES, combined.length);
      const nextOverlap = Buffer.from(combined.subarray(combined.length - retainedBytes));
      overlap.fill(0);
      combined.fill(0);
      overlap = nextOverlap;
    }
  } finally {
    overlap.fill(0);
  }
}

async function assertNoSecretMaterial(root, inventory, keyStore) {
  const resolvedKeyStore = await fs.realpath(keyStore).catch(() => path.resolve(keyStore));
  for (const entry of inventory.files) {
    const absolutePath = path.join(root, ...entry.path.split("/"));
    const basename = path.posix.basename(entry.path);
    const lowerBasename = basename.toLowerCase();
    const environmentSecret = lowerBasename.startsWith(".env")
      && entry.path !== DOCUMENTED_ENV_EXAMPLE;
    if (
      path.resolve(absolutePath) === resolvedKeyStore
      || environmentSecret
      || SECRET_DOTFILE_BASENAME.test(basename)
      || SECRET_BEARING_PATH.test(entry.path)
      || SECRET_FILE_EXTENSION.test(basename)
      || SECRET_FILE_BASENAME.test(basename)
    ) {
      fail("CERTIFIED_RELEASE_SECRET_FILE_FORBIDDEN", entry.path);
    }
    await assertFileHasNoSecretContent(absolutePath, entry.path);
  }
}

async function copyInventory(sourceRoot, targetRoot, inventory) {
  await fs.mkdir(targetRoot, { recursive: false, mode: 0o700 });
  for (const entry of inventory.files) {
    const source = path.join(sourceRoot, ...entry.path.split("/"));
    const target = path.join(targetRoot, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    await fs.chmod(target, 0o644).catch(() => {});
    const copied = await fs.lstat(target);
    if (
      !copied.isFile()
      || copied.isSymbolicLink()
      || copied.size !== entry.sizeBytes
      || await sha256File(target) !== entry.sha256
    ) fail("CERTIFIED_RELEASE_PAYLOAD_COPY_MISMATCH", entry.path);
  }
}

async function readComponentVersion(component, root, request) {
  if (component === "SYSTEM") {
    const backend = await readRegularJson(
      path.join(root, "backend", "package.json"),
      "CERTIFIED_RELEASE_SYSTEM_VERSION_INVALID",
    );
    const frontend = await readRegularJson(
      path.join(root, "frontend", "package.json"),
      "CERTIFIED_RELEASE_SYSTEM_VERSION_INVALID",
    );
    const backendVersion = normalizeVersion(backend?.version, "SYSTEM/backend/package.json");
    const frontendVersion = normalizeVersion(frontend?.version, "SYSTEM/frontend/package.json");
    if (
      backendVersion.technical !== request.version.technical
      || frontendVersion.technical !== request.version.technical
    ) fail("CERTIFIED_RELEASE_SYSTEM_VERSION_MISMATCH");
    return Object.freeze({ version: request.version.technical, platform: "any" });
  }
  if (component === "WINDOWS") {
    const versionFile = await readRegularJson(
      path.join(root, "VERSION.json"),
      "CERTIFIED_RELEASE_WINDOWS_VERSION_FILE_INVALID",
    );
    if (!isPlainObject(versionFile)) {
      fail("CERTIFIED_RELEASE_WINDOWS_VERSION_FILE_INVALID");
    }
    const windowsVersionKeys = Object.keys(versionFile).sort().join("\0");
    const compactVersionKeys = ["schema", "version"].sort().join("\0");
    const displayVersionKeys = ["schema", "version", "displayVersion"].sort().join("\0");
    if (windowsVersionKeys !== compactVersionKeys && windowsVersionKeys !== displayVersionKeys) {
      fail("CERTIFIED_RELEASE_WINDOWS_VERSION_FILE_INVALID");
    }
    if (versionFile.schema !== "bonni.windows-version/v1") {
      fail("CERTIFIED_RELEASE_WINDOWS_VERSION_SCHEMA_INVALID");
    }
    const observed = normalizeVersion(versionFile.version, "WINDOWS/VERSION.json");
    if (Object.hasOwn(versionFile, "displayVersion")) {
      const display = normalizeVersion(
        versionFile.displayVersion,
        "WINDOWS/VERSION.json.displayVersion",
      );
      if (display.technical !== observed.technical) {
        fail("CERTIFIED_RELEASE_WINDOWS_DISPLAY_VERSION_MISMATCH");
      }
    }
    if (observed.technical !== request.windowsVersion.technical) {
      fail("CERTIFIED_RELEASE_WINDOWS_VERSION_MISMATCH");
    }
    return Object.freeze({ version: request.windowsVersion.technical, platform: "windows-any" });
  }
  const expectedSchema = `bonni.${component.toLowerCase()}-version/v1`;
  const versionFile = await readRegularJson(
    path.join(root, "VERSION.json"),
    `CERTIFIED_RELEASE_${component}_VERSION_FILE_INVALID`,
  );
  assertDocumentKeys(
    versionFile,
    new Set(["schema", "version", "platform"]),
    `CERTIFIED_RELEASE_${component}_VERSION_FILE_INVALID`,
  );
  if (versionFile.schema !== expectedSchema) {
    fail(`CERTIFIED_RELEASE_${component}_VERSION_SCHEMA_INVALID`);
  }
  const observed = normalizeVersion(versionFile.version, `${component}/VERSION.json`);
  if (!COMPONENT_PLATFORMS[component]?.has(versionFile.platform)) {
    fail(`CERTIFIED_RELEASE_${component}_PLATFORM_INVALID`);
  }
  return Object.freeze({ version: observed.technical, platform: versionFile.platform });
}

async function assertSafeApplicationTree(applicationRoot) {
  let fileCount = 0;
  const pending = [applicationRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (cause) {
      fail("CERTIFIED_RELEASE_APPLICATION_UNSAFE", directory, { cause });
    }
    names.sort(bytewiseCompare);
    for (const name of names) {
      if (
        typeof name !== "string"
        || !name
        || name !== name.normalize("NFC")
        || name === "."
        || name === ".."
        || /[\\/\u0000-\u001f\u007f]/u.test(name)
      ) fail("CERTIFIED_RELEASE_APPLICATION_UNSAFE", path.join(directory, String(name)));
      const entry = path.join(directory, name);
      const state = await lstatOrNull(entry);
      if (!state || state.isSymbolicLink()) {
        fail("CERTIFIED_RELEASE_APPLICATION_UNSAFE", entry);
      }
      if (state.isDirectory()) {
        pending.push(entry);
        continue;
      }
      if (!state.isFile() || state.nlink !== 1) {
        fail("CERTIFIED_RELEASE_APPLICATION_UNSAFE", entry);
      }
      fileCount += 1;
    }
  }
  if (fileCount < 1) fail("CERTIFIED_RELEASE_APPLICATION_EMPTY", applicationRoot);
}

async function assertApplicationPackageJson(applicationRoot, component) {
  const packageFile = path.join(applicationRoot, "package.json");
  const packageJson = await readRegularJson(
    packageFile,
    "CERTIFIED_RELEASE_APPLICATION_PACKAGE_JSON_INVALID",
    MAX_APPLICATION_PACKAGE_JSON_BYTES,
  );
  if (
    !isPlainObject(packageJson)
    || typeof packageJson.name !== "string"
    || !packageJson.name.trim()
    || packageJson.name !== packageJson.name.trim()
    || packageJson.name !== packageJson.name.normalize("NFC")
    || Buffer.byteLength(packageJson.name, "utf8") > 128
    || /[\u0000-\u001f\u007f]/u.test(packageJson.name)
    || typeof packageJson.version !== "string"
    || packageJson.version.length > MAX_APPLICATION_VERSION_LENGTH
    || !STRICT_SEMVER.test(packageJson.version)
  ) fail("CERTIFIED_RELEASE_APPLICATION_VERSION_INVALID", component);
  return Object.freeze({ name: packageJson.name, version: packageJson.version });
}

async function discoverReleaseApplications(systemRoot) {
  const appContainer = path.join(systemRoot, "app");
  const containerState = await lstatOrNull(appContainer);
  if (!containerState) return Object.freeze([]);
  if (!containerState.isDirectory() || containerState.isSymbolicLink()) {
    fail("CERTIFIED_RELEASE_APPLICATION_CONTAINER_UNSAFE", appContainer);
  }
  let names;
  try {
    names = await fs.readdir(appContainer);
  } catch (cause) {
    fail("CERTIFIED_RELEASE_APPLICATION_CONTAINER_UNSAFE", appContainer, { cause });
  }
  names.sort(bytewiseCompare);
  const applications = [];
  for (const directory of names) {
    let id;
    try {
      id = appIdFromDirectory(directory);
    } catch (cause) {
      fail("CERTIFIED_RELEASE_APPLICATION_ID_INVALID", directory, { cause });
    }
    const applicationRoot = path.join(appContainer, directory);
    const applicationState = await lstatOrNull(applicationRoot);
    if (!applicationState || !applicationState.isDirectory() || applicationState.isSymbolicLink()) {
      fail("CERTIFIED_RELEASE_APPLICATION_UNSAFE", applicationRoot);
    }
    await assertSafeApplicationTree(applicationRoot);
    const packageMetadata = await assertApplicationPackageJson(applicationRoot, id);
    const inventory = await collectDevelopmentTree(applicationRoot);
    if (!inventory.files.length) fail("CERTIFIED_RELEASE_APPLICATION_EMPTY", id);
    applications.push(Object.freeze({
      id,
      directory,
      applicationRoot,
      displayName: packageMetadata.name,
      version: packageMetadata.version,
      inventory,
    }));
  }
  return Object.freeze(applications);
}

function registryEntryForApplication(application, key) {
  return Object.freeze({
    id: application.id,
    directory: application.directory,
    displayName: application.displayName,
    keyId: key.keyId,
    algorithm: "Ed25519",
    publicKeyPem: key.publicKeyPem,
    fingerprintSha256: key.fingerprintSha256,
  });
}

function sameRegistryEntry(left, right) {
  return stableStringify(left) === stableStringify(right);
}

async function writeExclusiveRegistrySource(file, bytes, productRoot) {
  const parent = path.dirname(file);
  await ensurePlainDirectory(parent, productRoot);
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (cause) {
    if (cause?.code !== "EEXIST") throw cause;
  } finally {
    await handle?.close();
  }
}

async function prepareReleaseAppRegistry({ systemRoot, request, appKeys }) {
  const applications = await discoverReleaseApplications(systemRoot);
  const selectedApps = request.components
    .filter((entry) => !UPDATE_COMPONENT_SET.has(entry))
    .sort(bytewiseCompare);
  const observedIds = applications.map((entry) => entry.id).sort(bytewiseCompare);
  if (stableStringify(observedIds) !== stableStringify(selectedApps)) {
    const missing = selectedApps.find((entry) => !observedIds.includes(entry));
    const unselected = observedIds.find((entry) => !selectedApps.includes(entry));
    if (missing) fail("CERTIFIED_RELEASE_APPLICATION_MISSING", missing);
    fail("CERTIFIED_RELEASE_APPLICATION_NOT_SELECTED", unselected || "unknown");
  }

  const sourceFile = path.join(request.productRoot, "SIGNATUR", "TRUST", BONNI_APP_REGISTRY_FILE_NAME);
  const stagedFile = path.join(systemRoot, BONNI_APP_REGISTRY_FILE_NAME);
  const sourceState = await lstatOrNull(sourceFile);
  const stagedState = await lstatOrNull(stagedFile);
  let source;
  if (sourceState) {
    source = await readBonniAppRegistryFile(sourceFile);
  } else if (stagedState) {
    source = await readBonniAppRegistryFile(stagedFile);
    await writeExclusiveRegistrySource(sourceFile, source.bytes, request.productRoot);
    const published = await readBonniAppRegistryFile(sourceFile);
    if (!published.bytes.equals(source.bytes)) {
      fail("CERTIFIED_RELEASE_APP_REGISTRY_CONCURRENT_CHANGE");
    }
    source = published;
  } else {
    const apps = applications.map((application) => {
      const key = appKeys.get(application.id);
      if (!key) fail("CERTIFIED_RELEASE_APPLICATION_KEY_MISSING", application.id);
      return registryEntryForApplication(application, key);
    });
    const registry = createBonniAppRegistry({
      registryId: "bonni-official",
      sequence: 1,
      apps,
    });
    const bytes = serializeBonniAppRegistry(registry);
    await writeExclusiveRegistrySource(sourceFile, bytes, request.productRoot);
    source = await readBonniAppRegistryFile(sourceFile);
    if (!source.bytes.equals(bytes)) {
      fail("CERTIFIED_RELEASE_APP_REGISTRY_CONCURRENT_CHANGE");
    }
  }
  if (stagedState) {
    const staged = await readBonniAppRegistryFile(stagedFile);
    if (staged.registry.registryId !== source.registry.registryId) {
      fail("CERTIFIED_RELEASE_APP_REGISTRY_IDENTITY_MISMATCH");
    }
    const same = staged.bytes.equals(source.bytes);
    if (!same) {
      const nextById = new Map(source.registry.apps.map((entry) => [entry.id, entry]));
      for (const existing of staged.registry.apps) {
        const next = nextById.get(existing.id);
        if (!next || !sameRegistryEntry(existing, next)) {
          fail("CERTIFIED_RELEASE_APP_REGISTRY_IDENTITY_CHANGED", existing.id);
        }
      }
      const addedApps = source.registry.apps.length - staged.registry.apps.length;
      const sequenceDelta = source.registry.sequence - staged.registry.sequence;
      if (addedApps < 1 || sequenceDelta !== addedApps) {
        fail("CERTIFIED_RELEASE_APP_REGISTRY_SEQUENCE_INVALID");
      }
    }
  }

  const registryById = new Map(source.registry.apps.map((entry) => [entry.id, entry]));
  for (const application of applications) {
    const registered = registryById.get(application.id);
    if (!registered || registered.directory !== application.directory) {
      fail("CERTIFIED_RELEASE_APPLICATION_NOT_REGISTERED", application.id);
    }
    const key = appKeys.get(application.id);
    if (
      !key
      || key.keyId !== registered.keyId
      || key.fingerprintSha256 !== registered.fingerprintSha256
      || key.publicKeyPem !== registered.publicKeyPem
    ) fail("CERTIFIED_RELEASE_APPLICATION_KEY_MISMATCH", application.id);
  }

  await fs.writeFile(stagedFile, source.bytes, { mode: 0o600 });
  const readBack = await readBonniAppRegistryFile(stagedFile);
  if (!readBack.bytes.equals(source.bytes)) fail("CERTIFIED_RELEASE_APP_REGISTRY_WRITEBACK_MISMATCH");
  return Object.freeze({
    sourceFile,
    registry: readBack.registry,
    bytes: readBack.bytes,
    binding: createBonniAppRegistryBinding(readBack.registry, readBack.bytes),
    applications,
  });
}

export async function assertCompleteApplicationSelection(systemRoot, components, registry = undefined) {
  const applications = await discoverReleaseApplications(systemRoot);
  const selectedApps = components.filter((entry) => !UPDATE_COMPONENT_SET.has(entry)).sort(bytewiseCompare);
  const observedIds = applications.map((entry) => entry.id).sort(bytewiseCompare);
  if (stableStringify(observedIds) !== stableStringify(selectedApps)) {
    fail("CERTIFIED_RELEASE_APPLICATION_SELECTION_MISMATCH");
  }
  if (registry) {
    const registered = new Map(registry.apps.map((entry) => [entry.id, entry.directory]));
    for (const application of applications) {
      if (registered.get(application.id) !== application.directory) {
        fail("CERTIFIED_RELEASE_APPLICATION_NOT_REGISTERED", application.id);
      }
    }
  }
  return Object.freeze(selectedApps);
}

function payloadDescriptor(component, version, platform, inventory) {
  const files = inventory.files.map(({ path: filePath, sizeBytes, sha256: fileSha256 }) => ({
    path: filePath,
    sizeBytes,
    sha256: fileSha256,
  }));
  return Object.freeze({
    component,
    platform,
    version,
    path: `PAYLOAD/${component}`,
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    treeSha256: computePayloadTreeSha256(files),
    files,
  });
}

function appReleaseDescriptor(application) {
  const files = application.inventory.files.map(({ path: filePath, sizeBytes, sha256: fileSha256 }) => ({
    path: filePath,
    sizeBytes,
    sha256: fileSha256,
  }));
  return Object.freeze({
    id: application.id,
    version: application.version,
    path: `app/${application.directory}`,
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    treeSha256: computePayloadTreeSha256(files),
  });
}

function normalizeAppliedPackages(value) {
  if (!Array.isArray(value) || !value.length) fail("CERTIFIED_RELEASE_APPROVED_CHAIN_EMPTY");
  return value.map((entry) => {
    if (
      !isPlainObject(entry)
      || typeof entry.candidateId !== "string"
      || typeof entry.packageSha256 !== "string"
      || !SHA256.test(entry.packageSha256)
      || !new Set(["approved", "rejected", "failed"]).has(entry.status)
      || !new Set(["approved", "explicit-dependency"]).has(entry.includedAs)
      || (entry.includedAs === "approved" && entry.status !== "approved")
    ) fail("CERTIFIED_RELEASE_UNCONFIRMED_DEVELOPMENT_CHAIN", String(entry?.candidateId || ""));
    return Object.freeze({
      candidateId: entry.candidateId,
      packageSha256: entry.packageSha256,
      status: entry.status,
      includedAs: entry.includedAs,
      dependencyOf: entry.dependencyOf || null,
    });
  });
}

function versionedDevelopmentBaseRoot(productRoot, baseVersion) {
  return path.join(productRoot, "RUN_DEV", "BASES", baseVersion, "SYSTEM");
}

export async function resolveCertifiedDevelopmentBase({
  request,
  readApprovedChain = readApprovedDevelopmentChain,
} = {}) {
  const chain = await readApprovedChain({
    productRoot: request.productRoot,
    verifyPackages: true,
    required: true,
  });
  if (!chain) fail("CERTIFIED_RELEASE_APPROVED_CHAIN_MISSING");
  const baseVersion = normalizeVersion(chain.baseVersion, "developmentChain.baseVersion");
  const targetVersion = normalizeVersion(chain.targetVersion, "developmentChain.targetVersion");
  if (targetVersion.technical !== request.version.technical) {
    fail("CERTIFIED_RELEASE_DEVELOPMENT_TARGET_VERSION_MISMATCH");
  }
  const baseEnvelopeRoot = path.dirname(versionedDevelopmentBaseRoot(
    request.productRoot,
    baseVersion.technical,
  ));
  const baseRoot = path.join(baseEnvelopeRoot, "SYSTEM");
  for (const directory of [
    path.join(request.productRoot, "RUN_DEV"),
    path.join(request.productRoot, "RUN_DEV", "BASES"),
    baseEnvelopeRoot,
    baseRoot,
  ]) {
    await assertPlainDirectory(directory, "CERTIFIED_RELEASE_DEVELOPMENT_BASE_UNSAFE");
  }
  const receipt = await readRegularJson(
    path.join(baseEnvelopeRoot, "BASE.json"),
    "CERTIFIED_RELEASE_DEVELOPMENT_BASE_RECEIPT_INVALID",
  );
  assertDocumentKeys(
    receipt,
    new Set(["schema", "version", "system"]),
    "CERTIFIED_RELEASE_DEVELOPMENT_BASE_RECEIPT_INVALID",
  );
  assertDocumentKeys(
    receipt.system,
    new Set(["fileCount", "totalBytes", "treeSha256"]),
    "CERTIFIED_RELEASE_DEVELOPMENT_BASE_RECEIPT_INVALID",
  );
  const inventory = await collectDevelopmentTree(baseRoot);
  const totalBytes = inventory.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (
    receipt.schema !== "bonni.development-base/v1"
    || receipt.version !== baseVersion.technical
    || receipt.system.fileCount !== inventory.files.length
    || receipt.system.totalBytes !== totalBytes
    || receipt.system.treeSha256 !== inventory.treeSha256
    || chain.baseTreeSha256 !== inventory.treeSha256
  ) fail("CERTIFIED_RELEASE_DEVELOPMENT_BASE_RECEIPT_MISMATCH");
  return Object.freeze({ chain, baseRoot, baseVersion: baseVersion.technical, inventory });
}

export async function assembleCertifiedSystemFromApprovedChain({
  request,
  stagingRoot,
  readApprovedChain = readApprovedDevelopmentChain,
  assembleApproved = assembleApprovedReleaseRequest,
} = {}) {
  const base = await resolveCertifiedDevelopmentBase({ request, readApprovedChain });
  const result = await assembleApproved({
    schema: "bonni.development-release-assembly-request/v1",
    component: "SYSTEM",
    productRoot: request.productRoot,
    baseRoot: base.baseRoot,
    stagingRoot,
    expectedFinalRoot: path.join(request.productRoot, "RUN_DEV", "CURRENT"),
  });
  if (
    result?.baseTreeSha256 !== base.chain.baseTreeSha256
    || result?.finalTreeSha256 !== base.chain.finalTreeSha256
  ) fail("CERTIFIED_RELEASE_DEVELOPMENT_ASSEMBLY_CHAIN_MISMATCH");
  const observedChain = await readApprovedChain({
    productRoot: request.productRoot,
    verifyPackages: true,
    required: true,
  });
  if (
    observedChain?.chainSha256 !== base.chain.chainSha256
    || observedChain?.baseTreeSha256 !== base.chain.baseTreeSha256
    || observedChain?.finalTreeSha256 !== base.chain.finalTreeSha256
  ) fail("CERTIFIED_RELEASE_DEVELOPMENT_CHAIN_CHANGED");
  return result;
}

function sequenceLedgerPath(productRoot) {
  return path.join(productRoot, "SIGNATUR", "RELEASE", "SEQUENCE.json");
}

async function writeJsonAtomic(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readNextCertifiedReleaseSequence(productRoot) {
  const releaseStateRoot = path.join(productRoot, "SIGNATUR", "RELEASE");
  await ensurePlainDirectory(releaseStateRoot, productRoot);
  const ledgerFile = sequenceLedgerPath(productRoot);
  const existing = await lstatOrNull(ledgerFile);
  let lastIssuedSequence = 0;
  if (existing) {
    const ledger = await readRegularJson(ledgerFile, "CERTIFIED_RELEASE_SEQUENCE_LEDGER_INVALID");
    assertExactKeys(
      ledger,
      new Set(["schema", "lastIssuedSequence", "updatedAt"]),
      new Set(["schema", "lastIssuedSequence", "updatedAt"]),
      "releaseSequence",
    );
    if (
      ledger.schema !== CERTIFIED_GITHUB_RELEASE_SEQUENCE_SCHEMA
      || !Number.isSafeInteger(ledger.lastIssuedSequence)
      || ledger.lastIssuedSequence < 0
    ) fail("CERTIFIED_RELEASE_SEQUENCE_LEDGER_INVALID");
    lastIssuedSequence = ledger.lastIssuedSequence;
  }
  const releaseSequence = lastIssuedSequence + 1;
  if (!Number.isSafeInteger(releaseSequence)) fail("CERTIFIED_RELEASE_SEQUENCE_EXHAUSTED");
  return Object.freeze({ ledgerFile, previousSequence: lastIssuedSequence, releaseSequence });
}

export async function commitCertifiedReleaseSequence(sequenceState, now = () => new Date()) {
  if (
    !isPlainObject(sequenceState)
    || typeof sequenceState.ledgerFile !== "string"
    || !Number.isSafeInteger(sequenceState.previousSequence)
    || sequenceState.previousSequence < 0
    || sequenceState.releaseSequence !== sequenceState.previousSequence + 1
  ) fail("CERTIFIED_RELEASE_SEQUENCE_STATE_INVALID");
  const existing = await lstatOrNull(sequenceState.ledgerFile);
  let observedPrevious = 0;
  if (existing) {
    const observed = await readRegularJson(
      sequenceState.ledgerFile,
      "CERTIFIED_RELEASE_SEQUENCE_LEDGER_INVALID",
    );
    if (
      observed.schema !== CERTIFIED_GITHUB_RELEASE_SEQUENCE_SCHEMA
      || !Number.isSafeInteger(observed.lastIssuedSequence)
      || observed.lastIssuedSequence < 0
    ) fail("CERTIFIED_RELEASE_SEQUENCE_LEDGER_INVALID");
    observedPrevious = observed.lastIssuedSequence;
  }
  if (observedPrevious !== sequenceState.previousSequence) {
    fail("CERTIFIED_RELEASE_SEQUENCE_STATE_CHANGED");
  }
  await writeJsonAtomic(sequenceState.ledgerFile, {
    schema: CERTIFIED_GITHUB_RELEASE_SEQUENCE_SCHEMA,
    lastIssuedSequence: sequenceState.releaseSequence,
    updatedAt: now().toISOString(),
  });
  return sequenceState.releaseSequence;
}

async function acquireReleaseLock(productRoot) {
  const releaseStateRoot = path.join(productRoot, "SIGNATUR", "RELEASE");
  await ensurePlainDirectory(releaseStateRoot, productRoot);
  const lockFile = path.join(releaseStateRoot, ".certified-release.lock");
  let handle;
  try {
    handle = await fs.open(lockFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (cause) {
    await handle?.close().catch(() => {});
    if (cause?.code === "EEXIST") fail("CERTIFIED_RELEASE_ALREADY_RUNNING");
    throw cause;
  }
  return async () => {
    await handle.close().catch(() => {});
    await fs.rm(lockFile, { force: true });
  };
}

let crcTable;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localZipHeader({ nameBytes, checksum, compressedSize, sizeBytes, method }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(sizeBytes, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralZipHeader({ nameBytes, checksum, compressedSize, sizeBytes, method, offset }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(sizeBytes, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endZipRecord(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

async function buildDeterministicUpdateZip(packageRoot, inventory) {
  if (!inventory.files.length || inventory.files.length > MAX_ZIP_ENTRIES) {
    fail("CERTIFIED_RELEASE_ZIP_ENTRY_LIMIT");
  }
  const totalBytes = inventory.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_UNCOMPRESSED_BYTES) {
    fail("CERTIFIED_RELEASE_ZIP_UNCOMPRESSED_LIMIT");
  }
  const localParts = [];
  const entries = [];
  let offset = 0;
  for (const file of inventory.files) {
    const absolutePath = path.join(packageRoot, ...file.path.split("/"));
    const data = await fs.readFile(absolutePath);
    if (data.length !== file.sizeBytes || sha256(data) !== file.sha256) {
      fail("CERTIFIED_RELEASE_PACKAGE_CHANGED_DURING_ZIP", file.path);
    }
    const deflated = deflateRawSync(data, { level: 9 });
    const useStored = data.length > 0 && data.length / Math.max(deflated.length, 1) > 190;
    const compressed = useStored ? data : deflated;
    const method = useStored ? 0 : 8;
    const nameBytes = Buffer.from(file.path, "utf8");
    const entry = {
      nameBytes,
      checksum: crc32(data),
      compressedSize: compressed.length,
      sizeBytes: data.length,
      method,
      offset,
    };
    const header = localZipHeader(entry);
    localParts.push(header, nameBytes, compressed);
    entries.push(entry);
    offset += header.length + nameBytes.length + compressed.length;
    if (offset > MAX_ZIP_BYTES) fail("CERTIFIED_RELEASE_ZIP_SIZE_LIMIT");
  }
  const centralOffset = offset;
  const centralParts = [];
  for (const entry of entries) {
    const header = centralZipHeader(entry);
    centralParts.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }
  const centralSize = offset - centralOffset;
  const zip = Buffer.concat([...localParts, ...centralParts, endZipRecord(entries.length, centralSize, centralOffset)]);
  if (zip.length > MAX_ZIP_BYTES) fail("CERTIFIED_RELEASE_ZIP_SIZE_LIMIT");
  return zip;
}

async function writeExclusiveSynced(file, data) {
  const state = await lstatOrNull(file);
  if (state) {
    if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
      fail("CERTIFIED_RELEASE_OUTPUT_FILE_UNSAFE", file);
    }
    const existing = await fs.readFile(file);
    if (Buffer.compare(existing, data) === 0) return false;
    fail("CERTIFIED_RELEASE_OUTPUT_ALREADY_EXISTS", file);
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, file);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const raced = await fs.readFile(file).catch(() => null);
      if (!raced || Buffer.compare(raced, data) !== 0) {
        fail("CERTIFIED_RELEASE_OUTPUT_ALREADY_EXISTS", file);
      }
      return false;
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return true;
}

async function verifyExtractedRelease({
  zipFile,
  verificationRoot,
  sourceInventory,
  trustedKeys,
  releaseSequence,
}) {
  await extractUpdateZip(zipFile, verificationRoot);
  const extractedInventory = await collectDevelopmentTree(verificationRoot);
  if (
    extractedInventory.treeSha256 !== sourceInventory.treeSha256
    || stableStringify(extractedInventory.files) !== stableStringify(sourceInventory.files)
  ) fail("CERTIFIED_RELEASE_ZIP_CONTENT_MISMATCH");
  const verified = await readAndVerifyUpdatePackageManifest(verificationRoot, {
    verificationMode: "production",
    lastAcceptedReleaseSequence: releaseSequence - 1,
    trustedKeys,
  });
  return verified;
}

function releaseUpdateId(request, releaseSequence, payloads, developmentPackages) {
  const digest = sha256(stableStringify({
    releaseSequence,
    version: request.version.technical,
    windowsVersion: request.windowsVersion?.technical || null,
    components: request.components,
    description: request.description,
    payloads: payloads.map(({ component, platform, version, treeSha256 }) => ({
      component,
      platform,
      version,
      treeSha256,
    })),
    developmentPackages,
  }));
  return `bonni-${request.version.visible}-r${releaseSequence}-${digest.slice(0, 16)}`;
}

function progress(callback, message) {
  if (typeof callback === "function") callback(message);
}

async function createCertifiedGitHubReleaseCore({
  rawRequest,
  request: parsedRequest,
  productRoot,
  masterPassword,
  releaseSequence: suppliedReleaseSequence = undefined,
  assembleSystem = assembleCertifiedSystemFromApprovedChain,
  onProgress = undefined,
  now = () => new Date(),
} = {}) {
  const request = parsedRequest || parseCertifiedGitHubReleaseRequest(rawRequest, { productRoot });
  await assertPlainDirectory(request.productRoot, "CERTIFIED_RELEASE_PRODUCT_ROOT_UNSAFE");
  const needsSystemAssembly = request.components.includes("SYSTEM");
  if (needsSystemAssembly) {
    const chainState = await lstatOrNull(request.resolvedDevelopmentChain);
    if (!chainState || !chainState.isFile() || chainState.isSymbolicLink() || chainState.nlink > 1) {
      fail("CERTIFIED_RELEASE_APPROVED_CHAIN_MISSING");
    }
  }
  progress(onProgress, "Verschluesselten Bonni-Keystore pruefen ...");
  const { unlocked, releaseKey, componentKeys, appKeys } = await unlockReleaseKeys(request, masterPassword);
  const trustedKeys = trustedKeysFromKeystore(releaseKey, componentKeys, appKeys);

  let releaseLock = async () => {};
  if (suppliedReleaseSequence === undefined) releaseLock = await acquireReleaseLock(request.productRoot);
  const runRoot = path.join(request.productRoot, "GITHUB", "STAGING", `certified-${randomUUID()}`);
  const assembledSystemRoot = path.join(runRoot, "ASSEMBLED-SYSTEM");
  const packageRoot = path.join(runRoot, "PACKAGE");
  const verificationRoot = path.join(runRoot, "VERIFIED-ZIP");
  try {
    await ensurePlainDirectory(path.dirname(runRoot), request.productRoot);
    await fs.mkdir(runRoot, { mode: 0o700 });
    let developmentPackages = [];
    let includedApps = Object.freeze([]);
    let appRegistryState = null;
    let appReleases = Object.freeze([]);
    if (needsSystemAssembly) {
      progress(onProgress, "Bestaetigte Entwicklungsstaende aus sauberer Basis zusammensetzen ...");
      const assembly = await assembleSystem({ request, stagingRoot: assembledSystemRoot });
      developmentPackages = normalizeAppliedPackages(assembly?.appliedPackages);
      // The complete SYSTEM tree stays intact. Its authoritative public app
      // registry is copied into the staged SYSTEM before the tree inventory is
      // built. App versions remain outside the registry and come from each
      // app's package.json, so a version update never changes Core code or the
      // stable app identity.
      appRegistryState = await prepareReleaseAppRegistry({
        systemRoot: assembledSystemRoot,
        request,
        appKeys,
      });
      includedApps = Object.freeze(appRegistryState.applications.map((app) => app.id));
      appReleases = Object.freeze(appRegistryState.applications.map(appReleaseDescriptor));
    } else {
      progress(onProgress, "Ausgewaehlte installierte Plattformkomponenten pruefen ...");
    }

    await fs.mkdir(packageRoot, { mode: 0o700 });
    await fs.mkdir(path.join(packageRoot, "PAYLOAD"), { mode: 0o700 });
    const payloads = [];
    for (const component of UPDATE_PACKAGE_COMPONENTS) {
      if (!request.components.includes(component)) continue;
      const sourceRoot = component === "SYSTEM"
        ? assembledSystemRoot
        : path.join(request.productRoot, COMPONENT_ROOTS[component]);
      await assertPlainDirectory(sourceRoot, `CERTIFIED_RELEASE_${component}_SOURCE_MISSING`);
      const inventory = await collectDevelopmentTree(sourceRoot);
      if (!inventory.files.length) fail("CERTIFIED_RELEASE_PAYLOAD_EMPTY", component);
      await assertNoSecretMaterial(sourceRoot, inventory, request.keyStore);
      const { version, platform } = await readComponentVersion(component, sourceRoot, request);
      const targetRoot = path.join(packageRoot, "PAYLOAD", component);
      await copyInventory(sourceRoot, targetRoot, inventory);
      payloads.push(payloadDescriptor(component, version, platform, inventory));
      progress(onProgress, `${component}: ${inventory.files.length} Dateien geprueft.`);
    }

    let releaseSequence = suppliedReleaseSequence;
    let sequenceState = null;
    if (releaseSequence === undefined) {
      sequenceState = await readNextCertifiedReleaseSequence(request.productRoot);
      releaseSequence = sequenceState.releaseSequence;
    } else if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) {
      fail("CERTIFIED_RELEASE_SEQUENCE_INVALID");
    }
    const updateId = releaseUpdateId(request, releaseSequence, payloads, developmentPackages);
    if (needsSystemAssembly) {
      // Re-bind the contract to the actual bytes that are about to be signed,
      // rather than trusting only the earlier assembled source inspection.
      const copiedSystemRoot = path.join(packageRoot, "PAYLOAD", "SYSTEM");
      const copiedInventory = await collectDevelopmentTree(copiedSystemRoot);
      const systemPayload = payloads.find((payload) => payload.component === "SYSTEM");
      if (
        !systemPayload
        || copiedInventory.treeSha256 !== systemPayload.treeSha256
        || stableStringify(copiedInventory.files) !== stableStringify(systemPayload.files)
      ) fail("CERTIFIED_RELEASE_SYSTEM_PAYLOAD_CHANGED");
      const copiedIncludedApps = await assertCompleteApplicationSelection(
        copiedSystemRoot,
        request.components,
        appRegistryState.registry,
      );
      if (stableStringify(copiedIncludedApps) !== stableStringify(includedApps)) {
        fail("CERTIFIED_RELEASE_APPLICATION_SELECTION_CHANGED");
      }
      const copiedApplications = await discoverReleaseApplications(copiedSystemRoot);
      const copiedAppReleases = copiedApplications.map(appReleaseDescriptor);
      if (stableStringify(copiedAppReleases) !== stableStringify(appReleases)) {
        fail("CERTIFIED_RELEASE_APPLICATION_PAYLOAD_CHANGED");
      }
    }
    const signers = [
      { keyId: releaseKey.keyId, scope: "RELEASE", privateKey: releaseKey.privateKey },
      ...payloads.map((payload) => {
        const key = componentKeys.get(payload.component);
        return { keyId: key.keyId, scope: payload.component, privateKey: key.privateKey };
      }),
      ...includedApps.map((app) => {
        const key = appKeys.get(app);
        return { keyId: key.keyId, scope: appManifestScope(app), privateKey: key.privateKey };
      }),
    ];
    const commonSigned = {
      updateId,
      channel: "stable",
      releaseSequence,
      createdAt: request.requestedAt,
      payloads,
      releaseNotes: request.description,
    };
    const manifest = needsSystemAssembly
      ? signRegistryUpdatePackageManifest({
          ...commonSigned,
          appRegistry: appRegistryState.binding,
          apps: appReleases,
        }, signers)
      : signUpdatePackageManifest(commonSigned, signers);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(packageRoot, UPDATE_PACKAGE_MANIFEST_NAME), manifestBytes, { flag: "wx", mode: 0o600 });

    progress(onProgress, "Signaturen im Produktionsmodus pruefen ...");
    const verifiedStaging = await verifyUpdatePackageManifest({
      packageRoot,
      manifest,
      verificationMode: "production",
      lastAcceptedReleaseSequence: releaseSequence - 1,
      trustedKeys,
    });
    const packageInventory = await collectDevelopmentTree(packageRoot);
    const zip = await buildDeterministicUpdateZip(packageRoot, packageInventory);
    const temporaryZip = path.join(runRoot, `${updateId}.zip`);
    await fs.writeFile(temporaryZip, zip, { flag: "wx", mode: 0o600 });
    progress(onProgress, "Fertige ZIP erneut entpacken und vollstaendig verifizieren ...");
    const verifiedZip = await verifyExtractedRelease({
      zipFile: temporaryZip,
      verificationRoot,
      sourceInventory: packageInventory,
      trustedKeys,
      releaseSequence,
    });

    if (sequenceState) await commitCertifiedReleaseSequence(sequenceState, now);

    const trust = await ensureCertifiedReleasePublicTrust(request.productRoot, unlocked);

    await ensurePlainDirectory(request.resolvedOutputDirectory, request.productRoot);
    const outputFile = path.join(
      request.resolvedOutputDirectory,
      `Bonni-Core-${request.version.visible}-GitHub-r${releaseSequence}.zip`,
    );
    const published = await writeExclusiveSynced(outputFile, zip);
    const zipSha256 = sha256(zip);
    progress(onProgress, `Fertig: ${path.basename(outputFile)} | SHA-256 ${zipSha256}`);
    progress(onProgress, "Es wurde nichts hochgeladen und kein GitHub-Tag erstellt.");
    return Object.freeze({
      outputFile,
      published,
      zipSha256,
      sizeBytes: zip.length,
      updateId,
      releaseSequence,
      version: request.version.visible,
      windowsVersion: request.windowsVersion?.visible || null,
      components: request.components,
      includedApps,
      appRegistry: appRegistryState ? appRegistryState.binding : null,
      apps: appReleases,
      developmentPackages,
      verifiedScopes: verifiedZip.verifiedScopes,
      authenticated: verifiedStaging.authenticated && verifiedZip.authenticated,
      trustFile: trust.trustFile,
      trustInitialized: trust.initialized,
      uploaded: false,
    });
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    await releaseLock().catch(() => {});
  }
}

// This is the only exported production release entry point. The keystore
// password is never accepted directly: it must be read from a community-
// enrolled local vault entry after the signed product capability has been
// checked. The exact parsed request used by both checks is passed unchanged to
// the private release core, so there is no later request-path re-read.
export async function createCertifiedGitHubRelease(options = {}) {
  if (!isPlainObject(options)) fail("CERTIFIED_RELEASE_OPTIONS_INVALID");
  const allowed = new Set([
    "rawRequest",
    "productRoot",
    "vaultEntryId",
    "vaultPassword",
    "onProgress",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("CERTIFIED_RELEASE_DIRECT_CORE_ACCESS_FORBIDDEN", key);
  }
  const {
    rawRequest,
    productRoot,
    vaultEntryId,
    vaultPassword,
    onProgress,
  } = options;
  if (typeof vaultEntryId !== "string" || !vaultEntryId) {
    fail("CERTIFIED_RELEASE_VAULT_ENTRY_REQUIRED");
  }
  if (!(typeof vaultPassword === "string" || Buffer.isBuffer(vaultPassword))) {
    fail("CERTIFIED_RELEASE_VAULT_PASSWORD_REQUIRED");
  }
  const request = parseCertifiedGitHubReleaseRequest(rawRequest, { productRoot });
  const vaultStatus = await getLocalSecretVaultStatus({ productRoot: request.productRoot });
  if (!vaultStatus.configured || typeof vaultStatus.vaultId !== "string") {
    fail("CERTIFIED_RELEASE_VAULT_NOT_CONFIGURED");
  }

  // Fail before any local master secret is decrypted.
  await assertDeveloperBuildAuthorized({
    productRoot: request.productRoot,
    vaultId: vaultStatus.vaultId,
    components: request.components,
  });

  return withLocalSecretVaultEntry({
    productRoot: request.productRoot,
    password: vaultPassword,
    entryId: vaultEntryId,
    purpose: "github-release",
    expectedVaultId: vaultStatus.vaultId,
    requiredPurpose: "developer-area",
  }, async (secret, _entry, vaultContext = {}) => {
    // The second check binds the signed grant to the exact immutable
    // community-enrolled developer profile after authenticated vault unlock,
    // but still before keystore unlock, staging, signing or publication.
    if (typeof assertDeveloperGitHubRequestAuthorizedForProfile !== "function") {
      fail("CERTIFIED_RELEASE_DEVELOPER_PROFILE_BINDING_UNAVAILABLE");
    }
    await assertDeveloperGitHubRequestAuthorizedForProfile({
      productRoot: request.productRoot,
      vaultId: vaultStatus.vaultId,
      developerProfileSha256: vaultContext.developerProfileSha256,
      request,
    });
    let masterPassword = secret.toString("utf8");
    try {
      return await createCertifiedGitHubReleaseCore({
        request,
        masterPassword,
        onProgress,
      });
    } finally {
      masterPassword = null;
    }
  });
}
