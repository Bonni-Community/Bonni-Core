import crypto, { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { parseEd25519SpkiPublicKey } from "../../src/system/update-runner/trusted-keys.mjs";

export const UPDATE_PACKAGE_SCHEMA = "bonni.update/v2";
export const LEGACY_UPDATE_PACKAGE_SCHEMA = "bonni.update/v1";
export const UPDATE_PACKAGE_MANIFEST_NAME = "UPDATE-MANIFEST.json";
export const UPDATE_PACKAGE_COMPONENTS = Object.freeze([
  "SYSTEM",
  "WINDOWS",
  "LINUX",
  "CONTAINER",
]);
export const UPDATE_PACKAGE_INCLUDED_APPS = Object.freeze([
  "STUEBERLAPP",
  "KONTORAPP",
  "HOCKETAPP",
  "KASSENAPP",
]);

const COMPONENT_SET = new Set(UPDATE_PACKAGE_COMPONENTS);
export const UPDATE_PACKAGE_SIGNATURE_SCOPES = Object.freeze([
  "RELEASE",
  ...UPDATE_PACKAGE_COMPONENTS,
  ...UPDATE_PACKAGE_INCLUDED_APPS.map((app) => `APP:${app}`),
]);
const SIGNATURE_SCOPE_SET = new Set(UPDATE_PACKAGE_SIGNATURE_SCOPES);
const INCLUDED_APP_SET = new Set(UPDATE_PACKAGE_INCLUDED_APPS);
const UPDATE_SIGNATURE_DOMAIN = "BONNI_UPDATE_MANIFEST_V2";
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const PLATFORM_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const INCLUDED_APP_TOKEN = /^[A-Z][A-Z0-9_-]{1,63}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/u;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAXIMUM_TIMESTAMP_FUTURE_SKEW_MS = 24 * 60 * 60_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_NOTES_BYTES = 64 * 1024;
const MAX_DISCOVERY_ENTRIES = 100_000;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;

export class UpdatePackageManifestError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "UpdatePackageManifestError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new UpdatePackageManifestError(code, detail);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("UPDATE_PACKAGE_INVALID_OBJECT", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UPDATE_PACKAGE_UNKNOWN_FIELD", `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("UPDATE_PACKAGE_REQUIRED_FIELD_MISSING", `${label}.${key}`);
  }
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

export function canonicalizeUpdatePackageSignedPayload(value) {
  return stableStringify(parseV2SignedPayload(value));
}

function signatureBytes(signed, scope) {
  if (!SIGNATURE_SCOPE_SET.has(scope)) fail("UPDATE_PACKAGE_SIGNATURE_SCOPE_INVALID", String(scope));
  return Buffer.from(
    `${UPDATE_SIGNATURE_DOMAIN}\n${scope}\n${stableStringify(signed)}\n`,
    "utf8",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathCollisionKey(value) {
  return value.normalize("NFC").toLowerCase();
}

function pathsOverlap(left, right) {
  const leftKey = pathCollisionKey(left);
  const rightKey = pathCollisionKey(right);
  return leftKey === rightKey
    || leftKey.startsWith(`${rightKey}/`)
    || rightKey.startsWith(`${leftKey}/`);
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    fail("UPDATE_PACKAGE_PATH_INVALID", label);
  }
  if (value !== value.normalize("NFC")) fail("UPDATE_PACKAGE_PATH_NOT_NORMALIZED", label);
  if (
    value.includes("\\")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("//")
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail("UPDATE_PACKAGE_PATH_UNSAFE", `${label}:${value}`);

  const segments = value.split("/");
  for (const segment of segments) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || Buffer.byteLength(segment, "utf8") > 255
      || WINDOWS_INVALID_PATH_CHARACTER.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)
    ) fail("UPDATE_PACKAGE_PATH_UNSAFE", `${label}:${value}`);
  }
  return segments.join("/");
}

function validateCanonicalTimestamp(value) {
  if (
    typeof value !== "string"
    || !CANONICAL_UTC_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) fail("UPDATE_PACKAGE_CREATED_AT_INVALID");
  if (Date.parse(value) > Date.now() + MAXIMUM_TIMESTAMP_FUTURE_SKEW_MS) {
    fail("UPDATE_PACKAGE_CREATED_AT_IN_FUTURE");
  }
  return value;
}

function canonicalizeFiles(value, label = "manifest.files") {
  if (!Array.isArray(value)) fail("UPDATE_PACKAGE_FILES_INVALID", label);

  const files = value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    assertExactKeys(
      entry,
      new Set(["path", "sizeBytes", "sha256"]),
      new Set(["path", "sizeBytes", "sha256"]),
      entryLabel,
    );
    const filePath = normalizeRelativePath(entry.path, `${entryLabel}.path`);
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      fail("UPDATE_PACKAGE_FILE_SIZE_INVALID", filePath);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
      fail("UPDATE_PACKAGE_FILE_HASH_INVALID", filePath);
    }
    return { path: filePath, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  }).sort((left, right) => bytewiseCompare(left.path, right.path));

  const collisionOrder = [...files].sort((left, right) => {
    const keyOrder = bytewiseCompare(pathCollisionKey(left.path), pathCollisionKey(right.path));
    return keyOrder || bytewiseCompare(left.path, right.path);
  });
  const usedPaths = new Map();
  for (const file of collisionOrder) {
    const collisionKey = pathCollisionKey(file.path);
    const duplicate = usedPaths.get(collisionKey);
    if (duplicate) fail("UPDATE_PACKAGE_FILE_PATH_OVERLAP", `${duplicate}:${file.path}`);
    const segments = collisionKey.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = usedPaths.get(segments.slice(0, length).join("/"));
      if (ancestor) fail("UPDATE_PACKAGE_FILE_PATH_OVERLAP", `${ancestor}:${file.path}`);
    }
    usedPaths.set(collisionKey, file.path);
  }
  return files;
}

export function computePayloadTreeSha256(files) {
  return sha256(stableStringify(canonicalizeFiles(files, "files")));
}

function parsePayloads(rawPayloads, labelPrefix = "manifest.payloads") {
  if (!Array.isArray(rawPayloads) || !rawPayloads.length) {
    fail("UPDATE_PACKAGE_PAYLOAD_REQUIRED");
  }
  if (rawPayloads.length > UPDATE_PACKAGE_COMPONENTS.length) {
    fail("UPDATE_PACKAGE_PAYLOAD_COUNT_INVALID");
  }

  const usedComponents = new Set();
  const payloadPaths = [];
  const payloads = rawPayloads.map((entry, index) => {
    const label = `${labelPrefix}[${index}]`;
    assertExactKeys(
      entry,
      new Set([
        "component",
        "platform",
        "version",
        "path",
        "fileCount",
        "totalBytes",
        "treeSha256",
        "files",
      ]),
      new Set([
        "component",
        "version",
        "path",
        "fileCount",
        "totalBytes",
        "treeSha256",
        "files",
      ]),
      label,
    );
    if (typeof entry.component !== "string" || !COMPONENT_SET.has(entry.component)) {
      fail("UPDATE_PACKAGE_COMPONENT_UNKNOWN", String(entry.component));
    }
    if (usedComponents.has(entry.component)) {
      fail("UPDATE_PACKAGE_COMPONENT_DUPLICATE", entry.component);
    }
    usedComponents.add(entry.component);

    let platform;
    if (Object.hasOwn(entry, "platform")) {
      if (typeof entry.platform !== "string" || !PLATFORM_TOKEN.test(entry.platform)) {
        fail("UPDATE_PACKAGE_PLATFORM_INVALID", `${entry.component}:${String(entry.platform)}`);
      }
      platform = entry.platform;
    }
    if (typeof entry.version !== "string" || !VERSION_TOKEN.test(entry.version)) {
      fail("UPDATE_PACKAGE_VERSION_INVALID", entry.component);
    }
    const payloadPath = normalizeRelativePath(entry.path, `${label}.path`);
    const expectedPath = `PAYLOAD/${entry.component}`;
    if (payloadPath !== expectedPath) {
      fail("UPDATE_PACKAGE_PAYLOAD_PATH_INVALID", `${payloadPath}:${expectedPath}`);
    }
    for (const previous of payloadPaths) {
      if (pathsOverlap(previous, payloadPath)) {
        fail("UPDATE_PACKAGE_PAYLOAD_PATH_OVERLAP", `${previous}:${payloadPath}`);
      }
    }
    payloadPaths.push(payloadPath);

    const files = canonicalizeFiles(entry.files, `${label}.files`);
    if (!files.length) fail("UPDATE_PACKAGE_PAYLOAD_EMPTY", entry.component);
    if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount !== files.length) {
      fail("UPDATE_PACKAGE_FILE_COUNT_MISMATCH", entry.component);
    }
    let totalBytes = 0;
    for (const file of files) {
      totalBytes += file.sizeBytes;
      if (!Number.isSafeInteger(totalBytes)) fail("UPDATE_PACKAGE_TOTAL_BYTES_INVALID", entry.component);
    }
    if (!Number.isSafeInteger(entry.totalBytes) || entry.totalBytes !== totalBytes) {
      fail("UPDATE_PACKAGE_TOTAL_BYTES_MISMATCH", entry.component);
    }
    if (typeof entry.treeSha256 !== "string" || !SHA256_HEX.test(entry.treeSha256)) {
      fail("UPDATE_PACKAGE_TREE_HASH_INVALID", entry.component);
    }
    const treeSha256 = sha256(stableStringify(files));
    if (entry.treeSha256 !== treeSha256) {
      fail("UPDATE_PACKAGE_TREE_HASH_MISMATCH", entry.component);
    }

    return {
      component: entry.component,
      ...(platform === undefined ? {} : { platform }),
      version: entry.version,
      path: payloadPath,
      fileCount: files.length,
      totalBytes,
      treeSha256,
      files,
    };
  });
  return payloads.sort((left, right) => (
    UPDATE_PACKAGE_COMPONENTS.indexOf(left.component)
    - UPDATE_PACKAGE_COMPONENTS.indexOf(right.component)
  ));
}

function parseLegacyV1Manifest(raw) {
  assertExactKeys(
    raw,
    new Set(["schema", "updateId", "createdAt", "payloads"]),
    new Set(["schema", "updateId", "createdAt", "payloads"]),
    "manifest",
  );
  if (raw.schema !== LEGACY_UPDATE_PACKAGE_SCHEMA) fail("UPDATE_PACKAGE_SCHEMA_UNSUPPORTED");
  if (typeof raw.updateId !== "string" || !UPDATE_ID.test(raw.updateId)) {
    fail("UPDATE_PACKAGE_UPDATE_ID_INVALID");
  }
  const createdAt = validateCanonicalTimestamp(raw.createdAt);
  return {
    schema: LEGACY_UPDATE_PACKAGE_SCHEMA,
    updateId: raw.updateId,
    createdAt,
    payloads: parsePayloads(raw.payloads),
  };
}

function parseV2SignedPayload(raw) {
  assertExactKeys(
    raw,
    new Set([
      "updateId", "channel", "releaseSequence", "createdAt", "payloads",
      "releaseNotes", "includedApps",
    ]),
    new Set(["updateId", "channel", "releaseSequence", "createdAt", "payloads"]),
    "manifest.signed",
  );
  if (typeof raw.updateId !== "string" || !UPDATE_ID.test(raw.updateId)) {
    fail("UPDATE_PACKAGE_UPDATE_ID_INVALID");
  }
  if (!new Set(["stable", "development"]).has(raw.channel)) {
    fail("UPDATE_PACKAGE_CHANNEL_INVALID", String(raw.channel));
  }
  if (!Number.isSafeInteger(raw.releaseSequence) || raw.releaseSequence < 1) {
    fail("UPDATE_PACKAGE_RELEASE_SEQUENCE_INVALID");
  }
  let releaseNotes;
  if (Object.hasOwn(raw, "releaseNotes")) {
    if (
      typeof raw.releaseNotes !== "string"
      || !raw.releaseNotes.trim()
      || raw.releaseNotes !== raw.releaseNotes.normalize("NFC")
      || Buffer.byteLength(raw.releaseNotes, "utf8") > MAX_RELEASE_NOTES_BYTES
      || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(raw.releaseNotes)
    ) fail("UPDATE_PACKAGE_RELEASE_NOTES_INVALID");
    releaseNotes = raw.releaseNotes;
  }
  let includedApps;
  if (Object.hasOwn(raw, "includedApps")) {
    if (!Array.isArray(raw.includedApps) || !raw.includedApps.length || raw.includedApps.length > 64) {
      fail("UPDATE_PACKAGE_INCLUDED_APPS_INVALID");
    }
    const used = new Set();
    includedApps = raw.includedApps.map((entry) => {
      if (
        typeof entry !== "string"
        || !INCLUDED_APP_TOKEN.test(entry)
        || !INCLUDED_APP_SET.has(entry)
        || used.has(entry)
      ) {
        fail("UPDATE_PACKAGE_INCLUDED_APP_INVALID", String(entry));
      }
      used.add(entry);
      return entry;
    }).sort(bytewiseCompare);
    for (let index = 1; index < raw.includedApps.length; index += 1) {
      if (bytewiseCompare(raw.includedApps[index - 1], raw.includedApps[index]) >= 0) {
        fail("UPDATE_PACKAGE_INCLUDED_APPS_ORDER_INVALID");
      }
    }
  }
  const payloads = parsePayloads(raw.payloads, "manifest.signed.payloads");
  if (includedApps && !payloads.some((payload) => payload.component === "SYSTEM")) {
    fail("UPDATE_PACKAGE_INCLUDED_APPS_REQUIRE_SYSTEM");
  }
  return {
    updateId: raw.updateId,
    channel: raw.channel,
    releaseSequence: raw.releaseSequence,
    createdAt: validateCanonicalTimestamp(raw.createdAt),
    payloads,
    ...(releaseNotes === undefined ? {} : { releaseNotes }),
    ...(includedApps === undefined ? {} : { includedApps }),
  };
}

function parseV2Signatures(raw) {
  if (!Array.isArray(raw) || raw.length > UPDATE_PACKAGE_SIGNATURE_SCOPES.length * 4) {
    fail("UPDATE_PACKAGE_SIGNATURES_INVALID");
  }
  const identities = new Set();
  return raw.map((entry, index) => {
    const label = `manifest.signatures[${index}]`;
    assertExactKeys(
      entry,
      new Set(["algorithm", "keyId", "scope", "value"]),
      new Set(["algorithm", "keyId", "scope", "value"]),
      label,
    );
    if (entry.algorithm !== "Ed25519") fail("UPDATE_PACKAGE_SIGNATURE_ALGORITHM_INVALID", label);
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)) {
      fail("UPDATE_PACKAGE_SIGNATURE_KEY_ID_INVALID", label);
    }
    if (typeof entry.scope !== "string" || !SIGNATURE_SCOPE_SET.has(entry.scope)) {
      fail("UPDATE_PACKAGE_SIGNATURE_SCOPE_INVALID", label);
    }
    if (typeof entry.value !== "string" || !ED25519_SIGNATURE_BASE64.test(entry.value)) {
      fail("UPDATE_PACKAGE_SIGNATURE_ENCODING_INVALID", label);
    }
    const signature = Buffer.from(entry.value, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== entry.value) {
      fail("UPDATE_PACKAGE_SIGNATURE_ENCODING_INVALID", label);
    }
    const identity = `${entry.scope}\0${entry.keyId}`;
    if (identities.has(identity)) fail("UPDATE_PACKAGE_SIGNATURE_DUPLICATE", identity);
    identities.add(identity);
    return {
      algorithm: "Ed25519",
      keyId: entry.keyId,
      scope: entry.scope,
      value: entry.value,
    };
  }).sort((left, right) => (
    bytewiseCompare(left.scope, right.scope) || bytewiseCompare(left.keyId, right.keyId)
  ));
}

export function parseUpdatePackageManifest(raw) {
  if (!isPlainObject(raw)) fail("UPDATE_PACKAGE_INVALID_OBJECT", "manifest");
  if (raw.schema === LEGACY_UPDATE_PACKAGE_SCHEMA) return parseLegacyV1Manifest(raw);
  assertExactKeys(
    raw,
    new Set(["schema", "signed", "signatures"]),
    new Set(["schema", "signed", "signatures"]),
    "manifest",
  );
  if (raw.schema !== UPDATE_PACKAGE_SCHEMA) fail("UPDATE_PACKAGE_SCHEMA_UNSUPPORTED");
  return {
    schema: UPDATE_PACKAGE_SCHEMA,
    signed: parseV2SignedPayload(raw.signed),
    signatures: parseV2Signatures(raw.signatures),
  };
}

function asEd25519PrivateKey(value) {
  let key;
  try {
    key = value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
  } catch (error) {
    fail("UPDATE_PACKAGE_PRIVATE_KEY_INVALID", error?.message || "invalid key");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("UPDATE_PACKAGE_PRIVATE_KEY_INVALID", "Ed25519 required");
  }
  return key;
}

function asEd25519PublicKey(value) {
  try {
    return parseEd25519SpkiPublicKey(value);
  } catch (error) {
    fail("UPDATE_PACKAGE_TRUSTED_KEY_INVALID", error?.message || "invalid key");
  }
}

export function signUpdatePackageManifest(signedInput, signers) {
  const signed = parseV2SignedPayload(signedInput);
  if (!Array.isArray(signers)) fail("UPDATE_PACKAGE_SIGNERS_INVALID");
  const signatures = signers.map((signer, index) => {
    const label = `signers[${index}]`;
    assertExactKeys(
      signer,
      new Set(["keyId", "scope", "privateKey"]),
      new Set(["keyId", "scope", "privateKey"]),
      label,
    );
    if (typeof signer.keyId !== "string" || !KEY_ID.test(signer.keyId)) {
      fail("UPDATE_PACKAGE_SIGNATURE_KEY_ID_INVALID", label);
    }
    if (typeof signer.scope !== "string" || !SIGNATURE_SCOPE_SET.has(signer.scope)) {
      fail("UPDATE_PACKAGE_SIGNATURE_SCOPE_INVALID", label);
    }
    return {
      algorithm: "Ed25519",
      keyId: signer.keyId,
      scope: signer.scope,
      value: crypto.sign(
        null,
        signatureBytes(signed, signer.scope),
        asEd25519PrivateKey(signer.privateKey),
      ).toString("base64"),
    };
  });
  return parseUpdatePackageManifest({ schema: UPDATE_PACKAGE_SCHEMA, signed, signatures });
}

export function createUnsignedDevelopmentUpdatePackageManifest(signedInput) {
  const signed = parseV2SignedPayload(signedInput);
  if (signed.channel !== "development") fail("UPDATE_PACKAGE_UNSIGNED_STABLE_FORBIDDEN");
  return parseUpdatePackageManifest({ schema: UPDATE_PACKAGE_SCHEMA, signed, signatures: [] });
}

export function createLegacyV1ManualBootstrapUpdatePackageManifest(input) {
  assertExactKeys(
    input,
    new Set(["updateId", "createdAt", "payloads"]),
    new Set(["updateId", "createdAt", "payloads"]),
    "legacy-bootstrap-manifest",
  );
  return parseLegacyV1Manifest({
    schema: LEGACY_UPDATE_PACKAGE_SCHEMA,
    updateId: input.updateId,
    createdAt: input.createdAt,
    payloads: input.payloads,
  });
}

async function lstatOrNull(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state) fail(code, target);
  if (state.isSymbolicLink() || !state.isDirectory()) fail("UPDATE_PACKAGE_DIRECTORY_UNSAFE", target);
  return state;
}

function assertContained(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  fail("UPDATE_PACKAGE_PATH_ESCAPES_ROOT", target);
}

async function hashRegularFile(file, payloadRoot, relativePath) {
  assertContained(payloadRoot, file);
  const pathState = await fs.lstat(file);
  if (pathState.isSymbolicLink() || !pathState.isFile()) {
    fail("UPDATE_PACKAGE_FILE_TYPE_UNSAFE", relativePath);
  }

  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile()) fail("UPDATE_PACKAGE_FILE_TYPE_UNSAFE", relativePath);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || before.ino !== after.ino
      || before.dev !== after.dev
    ) fail("UPDATE_PACKAGE_FILE_CHANGED_DURING_VERIFICATION", relativePath);
    return { path: relativePath, sizeBytes: before.size, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof UpdatePackageManifestError) throw error;
    if (error?.code === "ELOOP") fail("UPDATE_PACKAGE_FILE_TYPE_UNSAFE", relativePath);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function listPayloadFiles(payloadRoot, relativeDirectory = "") {
  const absoluteDirectory = relativeDirectory
    ? path.join(payloadRoot, ...relativeDirectory.split("/"))
    : payloadRoot;
  assertContained(payloadRoot, absoluteDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => bytewiseCompare(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(
      relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      "payload.file",
    );
    const absolutePath = path.join(payloadRoot, ...relativePath.split("/"));
    assertContained(payloadRoot, absolutePath);
    const state = await fs.lstat(absolutePath);
    if (state.isSymbolicLink()) fail("UPDATE_PACKAGE_SYMLINK_REJECTED", relativePath);
    if (state.isDirectory()) files.push(...await listPayloadFiles(payloadRoot, relativePath));
    else if (state.isFile()) files.push(await hashRegularFile(absolutePath, payloadRoot, relativePath));
    else fail("UPDATE_PACKAGE_FILE_TYPE_UNSAFE", relativePath);
  }
  return files;
}

async function assertPayloadEnvelope(packageRoot) {
  const payloadRoot = path.join(packageRoot, "PAYLOAD");
  await assertPlainDirectory(payloadRoot, "UPDATE_PACKAGE_PAYLOAD_DIRECTORY_MISSING");
  const entries = await fs.readdir(payloadRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!COMPONENT_SET.has(entry.name)) {
      fail("UPDATE_PACKAGE_PAYLOAD_ENTRY_UNKNOWN", `PAYLOAD/${entry.name}`);
    }
    const state = await fs.lstat(path.join(payloadRoot, entry.name));
    if (state.isSymbolicLink() || !state.isDirectory()) {
      fail("UPDATE_PACKAGE_DIRECTORY_UNSAFE", `PAYLOAD/${entry.name}`);
    }
  }
  return payloadRoot;
}

function assertExactFileBinding(expected, actual, component) {
  const canonicalActual = canonicalizeFiles(actual, `${component}.actualFiles`);
  if (canonicalActual.length !== expected.fileCount) {
    fail("UPDATE_PACKAGE_ACTUAL_FILE_COUNT_MISMATCH", component);
  }
  const totalBytes = canonicalActual.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== expected.totalBytes) {
    fail("UPDATE_PACKAGE_ACTUAL_TOTAL_BYTES_MISMATCH", component);
  }
  if (sha256(stableStringify(canonicalActual)) !== expected.treeSha256) {
    fail("UPDATE_PACKAGE_ACTUAL_TREE_HASH_MISMATCH", component);
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const declared = expected.files[index];
    const observed = canonicalActual[index];
    if (
      declared.path !== observed.path
      || declared.sizeBytes !== observed.sizeBytes
      || declared.sha256 !== observed.sha256
    ) fail("UPDATE_PACKAGE_FILE_BINDING_MISMATCH", `${component}:${declared.path}:${observed.path}`);
  }
}

function trustedKeyEntry(trustedKeys, keyId) {
  if (!trustedKeys) return undefined;
  if (trustedKeys instanceof Map) return trustedKeys.get(keyId);
  if (!isPlainObject(trustedKeys) || !Object.hasOwn(trustedKeys, keyId)) return undefined;
  return trustedKeys[keyId];
}

function parseTrustedKeyEntry(raw, keyId) {
  assertExactKeys(
    raw,
    new Set(["publicKey", "scopes"]),
    new Set(["publicKey", "scopes"]),
    `trustedKeys.${keyId}`,
  );
  if (!Array.isArray(raw.scopes) || !raw.scopes.length) {
    fail("UPDATE_PACKAGE_TRUSTED_KEY_SCOPE_INVALID", keyId);
  }
  const scopes = new Set();
  for (const scope of raw.scopes) {
    if (typeof scope !== "string" || !SIGNATURE_SCOPE_SET.has(scope) || scopes.has(scope)) {
      fail("UPDATE_PACKAGE_TRUSTED_KEY_SCOPE_INVALID", keyId);
    }
    scopes.add(scope);
  }
  return { publicKey: asEd25519PublicKey(raw.publicKey), scopes };
}

export function verifyUpdatePackageAuthenticity(manifestInput, options = {}) {
  const manifest = parseUpdatePackageManifest(manifestInput);
  const verificationMode = options.verificationMode || "production";
  if (!new Set(["production", "development", "manual-bootstrap"]).has(verificationMode)) {
    fail("UPDATE_PACKAGE_VERIFICATION_MODE_INVALID", String(verificationMode));
  }

  if (manifest.schema === LEGACY_UPDATE_PACKAGE_SCHEMA) {
    if (verificationMode !== "manual-bootstrap" || options.allowLegacyV1ManualBootstrap !== true) {
      fail("UPDATE_PACKAGE_LEGACY_BOOTSTRAP_REQUIRES_EXPLICIT_POLICY");
    }
    if (options.packageSource !== "local") {
      fail("UPDATE_PACKAGE_LEGACY_BOOTSTRAP_REQUIRES_LOCAL_SOURCE");
    }
    return {
      manifest,
      authenticated: false,
      legacyManualBootstrap: true,
      verifiedScopes: [],
    };
  }

  const { signed } = manifest;
  if (signed.channel === "development") {
    if (verificationMode !== "development") {
      fail("UPDATE_PACKAGE_DEVELOPMENT_FORBIDDEN");
    }
    const runtimeMode = String(options.nodeEnv || process.env.NODE_ENV || "production")
      .trim()
      .toLowerCase();
    if (!new Set(["development", "test"]).has(runtimeMode)) {
      fail("UPDATE_PACKAGE_DEVELOPMENT_RUNTIME_FORBIDDEN");
    }
    if (options.allowUnsignedDevelopment !== true) {
      fail("UPDATE_PACKAGE_DEVELOPMENT_REQUIRES_EXPLICIT_POLICY");
    }
    if (options.packageSource !== "local") {
      fail("UPDATE_PACKAGE_DEVELOPMENT_REQUIRES_LOCAL_SOURCE");
    }
    if (manifest.signatures.length) {
      fail("UPDATE_PACKAGE_DEVELOPMENT_SIGNATURES_FORBIDDEN");
    }
    return {
      manifest,
      authenticated: false,
      legacyManualBootstrap: false,
      verifiedScopes: [],
    };
  }

  if (verificationMode !== "production") fail("UPDATE_PACKAGE_STABLE_REQUIRES_PRODUCTION_POLICY");
  if (!Number.isSafeInteger(options.lastAcceptedReleaseSequence)
    || options.lastAcceptedReleaseSequence < 0) {
    fail("UPDATE_PACKAGE_ROLLBACK_STATE_REQUIRED");
  }
  if (signed.releaseSequence <= options.lastAcceptedReleaseSequence) {
    fail(
      "UPDATE_PACKAGE_RELEASE_SEQUENCE_ROLLBACK",
      `${signed.releaseSequence}:${options.lastAcceptedReleaseSequence}`,
    );
  }

  const declaredScopes = new Set(signed.payloads.map((payload) => payload.component));
  const declaredAppScopes = new Set((signed.includedApps || []).map((app) => `APP:${app}`));
  const requiredScopes = new Set(["RELEASE", ...declaredScopes, ...declaredAppScopes]);
  const verifiedScopes = new Set();
  for (const signature of manifest.signatures) {
    if (
      signature.scope !== "RELEASE"
      && !declaredScopes.has(signature.scope)
      && !declaredAppScopes.has(signature.scope)
    ) {
      fail("UPDATE_PACKAGE_SIGNATURE_SCOPE_NOT_DECLARED", signature.scope);
    }
    const rawTrusted = trustedKeyEntry(options.trustedKeys, signature.keyId);
    if (!rawTrusted) continue;
    const trusted = parseTrustedKeyEntry(rawTrusted, signature.keyId);
    if (!trusted.scopes.has(signature.scope)) {
      fail("UPDATE_PACKAGE_TRUSTED_KEY_SCOPE_MISMATCH", `${signature.keyId}:${signature.scope}`);
    }
    const signatureBytesValue = Buffer.from(signature.value, "base64");
    if (!crypto.verify(
      null,
      signatureBytes(signed, signature.scope),
      trusted.publicKey,
      signatureBytesValue,
    )) fail("UPDATE_PACKAGE_SIGNATURE_INVALID", `${signature.keyId}:${signature.scope}`);
    verifiedScopes.add(signature.scope);
  }
  for (const scope of requiredScopes) {
    if (!verifiedScopes.has(scope)) fail("UPDATE_PACKAGE_TRUSTED_SIGNATURE_REQUIRED", scope);
  }

  return {
    manifest,
    authenticated: true,
    legacyManualBootstrap: false,
    verifiedScopes: [...verifiedScopes].sort(bytewiseCompare),
  };
}

export async function verifyUpdatePackageManifest({ packageRoot, manifest, ...policy }) {
  if (typeof packageRoot !== "string" || !packageRoot) fail("UPDATE_PACKAGE_ROOT_INVALID");
  const resolvedPackageRoot = path.resolve(packageRoot);
  await assertPlainDirectory(resolvedPackageRoot, "UPDATE_PACKAGE_ROOT_MISSING");
  const authenticity = verifyUpdatePackageAuthenticity(manifest, policy);
  const parsedManifest = authenticity.manifest;
  await assertPayloadEnvelope(resolvedPackageRoot);

  const payloads = parsedManifest.schema === UPDATE_PACKAGE_SCHEMA
    ? parsedManifest.signed.payloads
    : parsedManifest.payloads;

  const declaredByComponent = new Map(
    payloads.map((payload) => [payload.component, payload]),
  );
  for (const component of UPDATE_PACKAGE_COMPONENTS) {
    const componentRoot = path.join(resolvedPackageRoot, "PAYLOAD", component);
    const state = await lstatOrNull(componentRoot);
    const declared = declaredByComponent.get(component);
    if (!state) {
      if (declared) fail("UPDATE_PACKAGE_DECLARED_PAYLOAD_MISSING", component);
      continue;
    }
    if (state.isSymbolicLink() || !state.isDirectory()) {
      fail("UPDATE_PACKAGE_DIRECTORY_UNSAFE", `PAYLOAD/${component}`);
    }
    const files = await listPayloadFiles(componentRoot);
    if (!declared) {
      if (files.length) fail("UPDATE_PACKAGE_UNDECLARED_PAYLOAD_NOT_EMPTY", component);
      continue;
    }
    assertExactFileBinding(declared, files, component);
  }

  return {
    packageRoot: resolvedPackageRoot,
    manifest: parsedManifest,
    authenticated: authenticity.authenticated,
    legacyManualBootstrap: authenticity.legacyManualBootstrap,
    verifiedScopes: authenticity.verifiedScopes,
  };
}

export async function findSingleUpdatePackageManifest(searchRoot) {
  if (typeof searchRoot !== "string" || !searchRoot) fail("UPDATE_PACKAGE_SEARCH_ROOT_INVALID");
  const resolvedSearchRoot = path.resolve(searchRoot);
  await assertPlainDirectory(resolvedSearchRoot, "UPDATE_PACKAGE_SEARCH_ROOT_MISSING");
  const candidates = [];
  let visitedEntries = 0;

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DISCOVERY_ENTRIES) fail("UPDATE_PACKAGE_DISCOVERY_LIMIT_EXCEEDED");
      const absolutePath = path.join(directory, entry.name);
      const state = await fs.lstat(absolutePath);
      if (entry.name === UPDATE_PACKAGE_MANIFEST_NAME) {
        if (state.isSymbolicLink() || !state.isFile()) {
          fail("UPDATE_PACKAGE_MANIFEST_FILE_UNSAFE", absolutePath);
        }
        candidates.push(absolutePath);
        continue;
      }
      if (state.isSymbolicLink()) continue;
      if (state.isDirectory()) await visit(absolutePath);
    }
  }

  await visit(resolvedSearchRoot);
  if (!candidates.length) fail("UPDATE_PACKAGE_MANIFEST_NOT_FOUND", UPDATE_PACKAGE_MANIFEST_NAME);
  if (candidates.length !== 1) {
    fail("UPDATE_PACKAGE_MULTIPLE_MANIFESTS", String(candidates.length));
  }
  return candidates[0];
}

export async function readAndVerifyUpdatePackageManifest(searchRoot, policy = {}) {
  const manifestPath = await findSingleUpdatePackageManifest(searchRoot);
  const state = await fs.lstat(manifestPath);
  if (!state.isFile() || state.isSymbolicLink() || state.size > MAX_MANIFEST_BYTES) {
    fail("UPDATE_PACKAGE_MANIFEST_FILE_UNSAFE", manifestPath);
  }
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof UpdatePackageManifestError) throw error;
    fail("UPDATE_PACKAGE_MANIFEST_JSON_INVALID", manifestPath);
  }
  const packageRoot = path.dirname(manifestPath);
  const verified = await verifyUpdatePackageManifest({ packageRoot, manifest: raw, ...policy });
  return { ...verified, manifestPath };
}
