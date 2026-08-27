import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const SOURCE_UPDATE_SCHEMA = "bonni.local-source-update/v1";
export const SOURCE_UPDATE_PAYLOAD_LAYOUT = "content-addressed-delta-v1";
export const SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT = "content-addressed-repair-v1";
const LEGACY_SOURCE_UPDATE_PAYLOAD_LAYOUT = "tree-full-v1";

const MANIFEST_NAME = "bonni-source-update.json";
const UPDATE_STATUS = "UNPUBLISHED_TEST_UPDATE";
const UPDATE_CHANNEL = "development";
const LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA = "bonni.local-source-deployment-lifecycle/v1";
const LOCAL_DEPLOYMENT_HOLD_DAYS = 14;
const LOCAL_DEPLOYMENT_HOLD_MS = LOCAL_DEPLOYMENT_HOLD_DAYS * 24 * 60 * 60_000;
const MAX_FILES = 20_000;
const MAX_CLEANUP_CANDIDATES = MAX_FILES * 2;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const ALLOWED_BACKEND_START_SCRIPTS = new Set([
  "npm run maintenance:cleanup && npm run auth:ensure-jwt && node scripts/runtime/start-backend.mjs",
  "node scripts/runtime/run-host-backend-entry.mjs start",
]);
const MANAGED_COMPONENT_PATHS = new Set([
  "SYSTEM/backend",
  "SYSTEM/frontend",
  "SYSTEM/app/kontorapp",
]);
const ESSENTIAL_COMPONENT_FILES = new Map([
  ["SYSTEM/backend", [
    "SYSTEM/backend/package-lock.json",
    "SYSTEM/backend/package.json",
    "SYSTEM/backend/scripts/setup/local-source-update.mjs",
    "SYSTEM/backend/scripts/setup/local-source-update-gate.mjs",
    "SYSTEM/backend/scripts/setup/local-source-update-supervisor.mjs",
    "SYSTEM/backend/scripts/setup/prebuilt-frontend.mjs",
    "SYSTEM/backend/scripts/setup/setup-system.mjs",
    "SYSTEM/backend/scripts/setup/update-system.mjs",
    "SYSTEM/backend/scripts/runtime/local-source-update-start-gate.mjs",
    "SYSTEM/backend/scripts/runtime/run-host-backend-entry.mjs",
    "SYSTEM/backend/scripts/runtime/runtime-mode-exclusion.mjs",
    "SYSTEM/backend/scripts/runtime/start-backend.mjs",
  ]],
  ["SYSTEM/frontend", [
    "SYSTEM/frontend/package-lock.json",
    "SYSTEM/frontend/package.json",
  ]],
  ["SYSTEM/app/kontorapp", [
    "SYSTEM/app/kontorapp/backend/package-lock.json",
    "SYSTEM/app/kontorapp/backend/package.json",
    "SYSTEM/app/kontorapp/frontend/package-lock.json",
    "SYSTEM/app/kontorapp/frontend/package.json",
    "SYSTEM/app/kontorapp/package-lock.json",
    "SYSTEM/app/kontorapp/package.json",
    "SYSTEM/app/kontorapp/manifest.ts",
  ]],
]);
const ESSENTIAL_FILE_KEYS = new Set(
  [...ESSENTIAL_COMPONENT_FILES.values()].flat().map((filePath) => windowsPathKey(filePath)),
);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const DATABASE_FILE = /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/iu;
const SECRET_FILE = /\.(?:key|pem|p12|pfx|jwk|secret|secrets)$/iu;
const GENERATED_DIRECTORY_NAMES = new Set([
  "node_modules", "dist", "build", "coverage", "cache", "caches", ".cache",
  ".eslintcache", ".stylelintcache", ".vite", ".turbo", ".parcel-cache",
  ".next", ".nuxt", ".svelte-kit", ".git", ".bonni-source-update",
]);

export function sourceUpdatePayloadObjectName(sha256) {
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    fail("SOURCE_UPDATE_PAYLOAD_HASH_INVALID", String(sha256));
  }
  return `${sha256}.bin`;
}

function fail(code, detail = "") {
  const suffix = detail ? `:${detail}` : "";
  throw new Error(`${code}${suffix}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail("SOURCE_UPDATE_INVALID_OBJECT", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("SOURCE_UPDATE_UNKNOWN_FIELD", `${label}.${key}`);
  }
}

function normalizeManifestPath(value, label = "path") {
  if (typeof value !== "string" || !value || value.length > 512) {
    fail("SOURCE_UPDATE_INVALID_PATH", label);
  }
  if (
    value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes(":")
    || /[<>"|?*]/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("SOURCE_UPDATE_UNSAFE_PATH", value);
  }

  const segments = value.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) {
    fail("SOURCE_UPDATE_UNSAFE_PATH", value);
  }
  return segments.join("/");
}

function windowsPathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pathInside(relativePath, rootPath) {
  return relativePath === rootPath || relativePath.startsWith(`${rootPath}/`);
}

function componentForPath(relativePath, components) {
  return components.find((component) => pathInside(relativePath, component.path)) || null;
}

function isProtectedPath(relativePath) {
  const lower = windowsPathKey(relativePath);
  const segments = lower.split("/");
  const basename = segments.at(-1) || "";

  if (basename.startsWith(".env") && basename !== ".env.example") return true;
  if (DATABASE_FILE.test(basename) || SECRET_FILE.test(basename)) return true;
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "secrets.json", "secret.json"].includes(basename)) {
    return true;
  }
  if (segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) return true;
  for (let index = 0; index <= segments.length - 3; index += 1) {
    if (
      segments[index] === "prisma"
      && segments[index + 1] === "domains"
      && segments[index + 2] === "assembled"
    ) return true;
  }

  return [
    "system/backend/archives",
    "system/backend/backups",
    "system/backend/data",
    "system/backend/docs",
    "system/backend/logs",
    "system/backend/run_system",
    "system/backend/storage",
    "system/backend/uploads",
    "system/backend/prisma/domains/assembled",
    "system/backend/public/system",
    "system/backend/updates",
    "system/backend/config/update/keys",
    "system/backend/config/update/trusted-keys",
    "system/backend/config/secrets",
    "system/backend/config/keys",
    "system/backend/secrets",
    "system/backend/keys",
    "system/frontend/uploads",
    "system/frontend/public/uploads",
    "system/app/kontorapp/backend/archives",
    "system/app/kontorapp/backend/backups",
    "system/app/kontorapp/backend/data",
    "system/app/kontorapp/backend/logs",
    "system/app/kontorapp/backend/secrets",
    "system/app/kontorapp/backend/keys",
    "system/app/kontorapp/backend/storage",
    "system/app/kontorapp/backend/uploads",
    "system/app/kontorapp/frontend/uploads",
    "system/app/kontorapp/frontend/public/uploads",
  ].some((protectedRoot) => pathInside(lower, protectedRoot));
}

function assertManagedAndUnprotected(relativePath, components, label) {
  if (!componentForPath(relativePath, components)) {
    fail("SOURCE_UPDATE_PATH_OUTSIDE_MANAGED_COMPONENT", `${label}:${relativePath}`);
  }
  if (isProtectedPath(relativePath)) {
    fail("SOURCE_UPDATE_PROTECTED_PATH", `${label}:${relativePath}`);
  }
}

function validateVersionObject(value, label) {
  assertExactKeys(value, new Set(["coreVersion", "kontorAppVersion"]), label);
  for (const key of ["coreVersion", "kontorAppVersion"]) {
    if (typeof value[key] !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value[key])) {
      fail("SOURCE_UPDATE_INVALID_VERSION", `${label}.${key}`);
    }
  }
  return { coreVersion: value.coreVersion, kontorAppVersion: value.kontorAppVersion };
}

function releaseNotesText(value, label, minimum, maximum) {
  if (typeof value !== "string") fail("SOURCE_UPDATE_RELEASE_NOTES_INVALID", label);
  const normalized = value.trim();
  const length = [...normalized].length;
  if (
    length < minimum
    || length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    fail("SOURCE_UPDATE_RELEASE_NOTES_INVALID", label);
  }
  return normalized;
}

function validateReleaseNotes(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, new Set(["title", "summary", "changes"]), "manifest.releaseNotes");
  if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > 12) {
    fail("SOURCE_UPDATE_RELEASE_NOTES_INVALID", "changes");
  }
  return {
    title: releaseNotesText(value.title, "title", 3, 100),
    summary: releaseNotesText(value.summary, "summary", 3, 480),
    changes: value.changes.map((entry, index) => {
      assertExactKeys(entry, new Set(["type", "title", "detail"]), `manifest.releaseNotes.changes[${index}]`);
      if (!["security", "fix", "improvement", "information"].includes(entry.type)) {
        fail("SOURCE_UPDATE_RELEASE_NOTES_INVALID", `changes.${index}.type`);
      }
      return {
        type: entry.type,
        title: releaseNotesText(entry.title, `changes.${index}.title`, 3, 100),
        detail: releaseNotesText(entry.detail, `changes.${index}.detail`, 3, 320),
      };
    }),
  };
}

function validateCompletedUpdateMetadata(value, label = "history-receipt.updateMetadata") {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, new Set(["from", "to", "components", "counts", "repair"]), label);
  const from = validateVersionObject(value.from, `${label}.from`);
  const to = validateVersionObject(value.to, `${label}.to`);
  if (!Array.isArray(value.components) || !value.components.length || value.components.length > 3) {
    fail("SOURCE_UPDATE_COMPLETED_METADATA_INVALID", `${label}.components`);
  }
  const componentKeys = new Set();
  const componentPaths = new Set();
  const components = value.components.map((entry, index) => {
    assertExactKeys(entry, new Set(["key", "path", "mode"]), `${label}.components[${index}]`);
    if (typeof entry.key !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(entry.key)) {
      fail("SOURCE_UPDATE_COMPLETED_METADATA_INVALID", `${label}.components[${index}].key`);
    }
    const componentPath = normalizeManifestPath(entry.path, `${label}.components[${index}].path`);
    const pathKey = windowsPathKey(componentPath);
    if (
      !MANAGED_COMPONENT_PATHS.has(componentPath)
      || entry.mode !== "managed"
      || componentKeys.has(entry.key)
      || componentPaths.has(pathKey)
    ) fail("SOURCE_UPDATE_COMPLETED_METADATA_INVALID", componentPath);
    componentKeys.add(entry.key);
    componentPaths.add(pathKey);
    return { key: entry.key, path: componentPath, mode: "managed" };
  });
  assertExactKeys(value.counts, new Set(["files", "inventory", "delete"]), `${label}.counts`);
  const counts = {
    files: Number(value.counts.files),
    inventory: Number(value.counts.inventory),
    delete: Number(value.counts.delete),
  };
  if (
    !Object.values(counts).every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= MAX_FILES)
    || counts.files > counts.inventory
    || typeof value.repair !== "boolean"
  ) fail("SOURCE_UPDATE_COMPLETED_METADATA_INVALID", label);
  return { from, to, components, counts, repair: value.repair };
}

function completedUpdateMetadataFromManifest(manifest) {
  return {
    from: manifest.from,
    to: manifest.to,
    components: manifest.components,
    counts: {
      files: manifest.payloadLayout === SOURCE_UPDATE_PAYLOAD_LAYOUT
        ? manifest.files.filter((entry) => entry.expectedPreviousSha256 !== entry.sha256).length
        : manifest.files.length,
      inventory: manifest.files.length,
      delete: manifest.delete.length,
    },
    repair: manifest.payloadLayout === SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
  };
}

function validateManifest(raw) {
  assertExactKeys(raw, new Set([
    "schemaVersion",
    "status",
    "updateId",
    "channel",
    "payloadLayout",
    "requires",
    "releaseNotes",
    "from",
    "to",
    "components",
    "files",
    "delete",
  ]), "manifest");

  if (raw.schemaVersion !== SOURCE_UPDATE_SCHEMA) fail("SOURCE_UPDATE_SCHEMA_UNSUPPORTED");
  const payloadLayout = raw.payloadLayout === undefined
    ? LEGACY_SOURCE_UPDATE_PAYLOAD_LAYOUT
    : raw.payloadLayout;
  if (![
    LEGACY_SOURCE_UPDATE_PAYLOAD_LAYOUT,
    SOURCE_UPDATE_PAYLOAD_LAYOUT,
    SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
  ].includes(payloadLayout)) {
    fail("SOURCE_UPDATE_PAYLOAD_LAYOUT_UNSUPPORTED");
  }
  if (raw.status !== UPDATE_STATUS || raw.channel !== UPDATE_CHANNEL) {
    fail("SOURCE_UPDATE_NOT_A_DEVELOPMENT_PACKAGE");
  }
  if (typeof raw.updateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(raw.updateId)) {
    fail("SOURCE_UPDATE_INVALID_ID");
  }
  normalizeManifestPath(raw.updateId, "manifest.updateId");

  const from = validateVersionObject(raw.from, "manifest.from");
  const to = validateVersionObject(raw.to, "manifest.to");
  const releaseNotes = validateReleaseNotes(raw.releaseNotes);
  let requires = null;
  if (raw.requires !== null && raw.requires !== undefined) {
    assertExactKeys(raw.requires, new Set(["updateId", "manifestSha256"]), "manifest.requires");
    if (
      typeof raw.requires.updateId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(raw.requires.updateId)
      || typeof raw.requires.manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(raw.requires.manifestSha256)
    ) {
      fail("SOURCE_UPDATE_REQUIRED_PREDECESSOR_INVALID");
    }
    requires = {
      updateId: normalizeManifestPath(raw.requires.updateId, "manifest.requires.updateId"),
      manifestSha256: raw.requires.manifestSha256,
    };
  }
  if (!Array.isArray(raw.components) || !raw.components.length) {
    fail("SOURCE_UPDATE_COMPONENTS_REQUIRED");
  }

  const componentKeys = new Set();
  const componentPaths = new Set();
  const components = raw.components.map((entry, index) => {
    assertExactKeys(entry, new Set(["key", "path", "mode"]), `manifest.components[${index}]`);
    if (typeof entry.key !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(entry.key)) {
      fail("SOURCE_UPDATE_INVALID_COMPONENT_KEY", String(entry.key));
    }
    const componentPath = normalizeManifestPath(entry.path, `manifest.components[${index}].path`);
    if (!MANAGED_COMPONENT_PATHS.has(componentPath) || entry.mode !== "managed") {
      fail("SOURCE_UPDATE_COMPONENT_NOT_ALLOWED", componentPath);
    }
    const key = windowsPathKey(componentPath);
    if (componentKeys.has(entry.key) || componentPaths.has(key)) {
      fail("SOURCE_UPDATE_DUPLICATE_COMPONENT", entry.key);
    }
    componentKeys.add(entry.key);
    componentPaths.add(key);
    return { key: entry.key, path: componentPath, mode: "managed" };
  });
  if (
    from.coreVersion !== to.coreVersion
    && !components.some((component) => component.path === "SYSTEM/backend")
  ) {
    fail("SOURCE_UPDATE_CORE_VERSION_CHANGE_WITHOUT_BACKEND");
  }
  if (
    from.kontorAppVersion !== to.kontorAppVersion
    && !components.some((component) => component.path === "SYSTEM/app/kontorapp")
  ) {
    fail("SOURCE_UPDATE_KONTOR_VERSION_CHANGE_WITHOUT_KONTOR");
  }

  if (!Array.isArray(raw.files) || raw.files.length > MAX_FILES) {
    fail("SOURCE_UPDATE_INVALID_FILE_COUNT");
  }
  if (!Array.isArray(raw.delete) || raw.delete.length > MAX_FILES) {
    fail("SOURCE_UPDATE_INVALID_DELETE_COUNT");
  }

  let totalBytes = 0;
  const usedPaths = new Map();
  const files = raw.files.map((entry, index) => {
    assertExactKeys(entry, new Set([
      "path",
      "sizeBytes",
      "sha256",
      "expectedPreviousSha256",
    ]), `manifest.files[${index}]`);
    const filePath = normalizeManifestPath(entry.path, `manifest.files[${index}].path`);
    assertManagedAndUnprotected(filePath, components, "file");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_FILE_BYTES) {
      fail("SOURCE_UPDATE_INVALID_FILE_SIZE", filePath);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      fail("SOURCE_UPDATE_INVALID_HASH", filePath);
    }
    if (!Object.hasOwn(entry, "expectedPreviousSha256")) {
      fail("SOURCE_UPDATE_PREVIOUS_HASH_REQUIRED", filePath);
    }
    if (
      entry.expectedPreviousSha256 !== null
      && (typeof entry.expectedPreviousSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.expectedPreviousSha256))
    ) {
      fail("SOURCE_UPDATE_INVALID_PREVIOUS_HASH", filePath);
    }
    const pathKey = windowsPathKey(filePath);
    if (usedPaths.has(pathKey)) fail("SOURCE_UPDATE_PATH_COLLISION", `${usedPaths.get(pathKey)}:${filePath}`);
    usedPaths.set(pathKey, filePath);
    totalBytes += entry.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail("SOURCE_UPDATE_PACKAGE_TOO_LARGE");
    return {
      path: filePath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      expectedPreviousSha256: entry.expectedPreviousSha256,
      payloadObject: payloadLayout === LEGACY_SOURCE_UPDATE_PAYLOAD_LAYOUT
        ? filePath
        : payloadLayout === SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT
          ? sourceUpdatePayloadObjectName(entry.sha256)
          : entry.expectedPreviousSha256 === entry.sha256
            ? null
            : sourceUpdatePayloadObjectName(entry.sha256),
    };
  });
  if ([SOURCE_UPDATE_PAYLOAD_LAYOUT, SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT].includes(payloadLayout)) {
    for (let index = 1; index < files.length; index += 1) {
      if (bytewiseCompare(files[index - 1].path, files[index].path) >= 0) {
        fail("SOURCE_UPDATE_FILE_ORDER_INVALID", files[index].path);
      }
    }
  }
  const declaredFileKeys = new Set(files.map((entry) => windowsPathKey(entry.path)));
  for (const component of components) {
    for (const essentialPath of ESSENTIAL_COMPONENT_FILES.get(component.path) || []) {
      if (!declaredFileKeys.has(windowsPathKey(essentialPath))) {
        fail("SOURCE_UPDATE_ESSENTIAL_FILE_MISSING", essentialPath);
      }
    }
  }

  const deletions = raw.delete.map((entry, index) => {
    assertExactKeys(entry, new Set(["path", "expectedSha256", "reason"]), `manifest.delete[${index}]`);
    const targetPath = normalizeManifestPath(entry.path, `manifest.delete[${index}].path`);
    assertManagedAndUnprotected(targetPath, components, "delete");
    if (ESSENTIAL_FILE_KEYS.has(windowsPathKey(targetPath))) {
      fail("SOURCE_UPDATE_ESSENTIAL_FILE_DELETE_REJECTED", targetPath);
    }
    if (typeof entry.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.expectedSha256)) {
      fail("SOURCE_UPDATE_INVALID_DELETE_HASH", targetPath);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim() || entry.reason.length > 240) {
      fail("SOURCE_UPDATE_INVALID_DELETE_REASON", targetPath);
    }
    const pathKey = windowsPathKey(targetPath);
    if (usedPaths.has(pathKey)) fail("SOURCE_UPDATE_PATH_COLLISION", `${usedPaths.get(pathKey)}:${targetPath}`);
    usedPaths.set(pathKey, targetPath);
    return { path: targetPath, expectedSha256: entry.expectedSha256, reason: entry.reason.trim() };
  });

  return {
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    status: UPDATE_STATUS,
    updateId: raw.updateId,
    channel: UPDATE_CHANNEL,
    payloadLayout,
    requires,
    releaseNotes,
    from,
    to,
    components,
    files,
    delete: deletions,
  };
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

async function readJson(file, errorCode) {
  let source;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch {
    fail(errorCode, file);
  }
}

async function writeJsonAtomic(file, value) {
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectory(parent);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncRegularFile(file) {
  // Windows implements fsync through FlushFileBuffers, which requires a
  // handle with write access. A read-only handle therefore fails with EPERM
  // even though the file itself is writable. Keep the narrower read-only
  // handle on other platforms and retain the durability barrier everywhere.
  const flags = process.platform === "win32" ? "r+" : "r";
  const handle = await fs.open(file, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSafeExistingTarget(productRoot, relativePath) {
  const resolvedRoot = path.resolve(productRoot);
  const target = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) fail("SOURCE_UPDATE_PATH_ESCAPE", relativePath);

  const rootState = await fs.lstat(resolvedRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) fail("SOURCE_UPDATE_UNSAFE_PRODUCT_ROOT");
  const realRoot = await fs.realpath(resolvedRoot);
  const comparablePath = (value) => {
    const normalized = path.resolve(value).normalize("NFC");
    return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  };

  let cursor = resolvedRoot;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const state = await fs.lstat(cursor).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) break;
    if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile())) {
      fail("SOURCE_UPDATE_UNSAFE_TARGET", relativePath);
    }
    if (state.isFile() && state.nlink > 1) fail("SOURCE_UPDATE_HARDLINK_TARGET", relativePath);
    if (index < segments.length - 1 && !state.isDirectory()) {
      fail("SOURCE_UPDATE_TARGET_PARENT_NOT_DIRECTORY", relativePath);
    }
    const realCursor = await fs.realpath(cursor);
    const expectedRealCursor = path.join(realRoot, ...segments.slice(0, index + 1));
    if (comparablePath(realCursor) !== comparablePath(expectedRealCursor)) {
      fail("SOURCE_UPDATE_TARGET_ALIAS_REJECTED", relativePath);
    }
  }
  return target;
}

async function walkDirectory(root, visitor, relative = "") {
  const entries = await fs.readdir(path.join(root, ...relative.split("/").filter(Boolean)), { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(root, ...childRelative.split("/"));
    const state = await fs.lstat(child);
    if (state.isSymbolicLink()) fail("SOURCE_UPDATE_SYMLINK_REJECTED", childRelative);
    if (state.isDirectory()) {
      await walkDirectory(root, visitor, childRelative);
      continue;
    }
    if (!state.isFile()) fail("SOURCE_UPDATE_SPECIAL_FILE_REJECTED", childRelative);
    if (state.nlink > 1) fail("SOURCE_UPDATE_HARDLINK_REJECTED", childRelative);
    await visitor(childRelative, child, state);
  }
}

async function updateEntryFingerprint(target) {
  const hash = createHash("sha256");
  const visit = async (absolutePath, relativePath) => {
    const state = await fs.lstat(absolutePath);
    if (state.isSymbolicLink()) fail("SOURCE_UPDATE_CLEANUP_SYMLINK_REJECTED", relativePath);
    if (!state.isDirectory() && !state.isFile()) {
      fail("SOURCE_UPDATE_CLEANUP_SPECIAL_FILE_REJECTED", relativePath);
    }
    if (state.isFile() && state.nlink > 1) {
      fail("SOURCE_UPDATE_CLEANUP_HARDLINK_REJECTED", relativePath);
    }
    const contentSha256 = state.isFile() ? await sha256File(absolutePath) : null;
    if (state.isFile()) {
      const verifiedState = await fs.lstat(absolutePath);
      if (
        !verifiedState.isFile()
        || verifiedState.isSymbolicLink()
        || verifiedState.nlink > 1
        || verifiedState.size !== state.size
        || verifiedState.mtimeMs !== state.mtimeMs
        || verifiedState.ctimeMs !== state.ctimeMs
        || verifiedState.dev !== state.dev
        || verifiedState.ino !== state.ino
      ) {
        fail("SOURCE_UPDATE_CLEANUP_ENTRY_CHANGED", relativePath);
      }
    }
    hash.update(`${JSON.stringify({
      path: relativePath,
      type: state.isDirectory() ? "directory" : "file",
      size: state.size,
      contentSha256,
      mtimeMs: state.mtimeMs,
      ctimeMs: state.ctimeMs,
      birthtimeMs: state.birthtimeMs,
      dev: String(state.dev),
      ino: String(state.ino),
      mode: state.mode,
      nlink: state.nlink,
    })}\n`);
    if (!state.isDirectory()) return;
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      await visit(path.join(absolutePath, entry.name), childRelative);
    }
  };
  await visit(target, "");
  return hash.digest("hex");
}

function normalizeCleanupCandidates(value, {
  packagePath = null,
  transactionPath = null,
} = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CLEANUP_CANDIDATES) {
    fail("SOURCE_UPDATE_CLEANUP_CANDIDATES_INVALID");
  }
  const reservedPaths = new Set([
    "UPDATE/inbox",
    "UPDATE/.bonni-work",
    packagePath,
    transactionPath,
  ].filter(Boolean));
  const usedPaths = new Set();
  return value.map((entry, index) => {
    assertExactKeys(entry, new Set(["path", "fingerprint"]), `cleanupCandidates[${index}]`);
    const candidatePath = normalizeManifestPath(entry.path, `cleanupCandidates[${index}].path`);
    const segments = candidatePath.split("/");
    const isDirectUpdateEntry = segments.length === 2
      && segments[0] === "UPDATE"
      && !["inbox", ".bonni-work"].includes(segments[1]);
    const isContainerChild = segments.length === 3
      && segments[0] === "UPDATE"
      && ["inbox", ".bonni-work"].includes(segments[1]);
    const pathKey = windowsPathKey(candidatePath);
    if (
      (!isDirectUpdateEntry && !isContainerChild)
      || reservedPaths.has(candidatePath)
      || usedPaths.has(pathKey)
      || typeof entry.fingerprint !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)
    ) {
      fail("SOURCE_UPDATE_CLEANUP_CANDIDATE_INVALID", candidatePath);
    }
    usedPaths.add(pathKey);
    return { path: candidatePath, fingerprint: entry.fingerprint };
  });
}

async function captureUpdateCleanupCandidates(productRoot, packagePath) {
  const updateRoot = path.join(path.resolve(productRoot), "UPDATE");
  await assertRealDirectory(updateRoot, "SOURCE_UPDATE_UNSAFE_UPDATE_ROOT");
  const candidates = [];
  const capture = async (relativePath) => {
    if (relativePath === packagePath) return;
    let canonical;
    try {
      canonical = normalizeCleanupCandidates([{
        path: relativePath,
        fingerprint: "0".repeat(64),
      }], { packagePath })[0].path;
      const target = await assertSafeExistingTarget(productRoot, canonical);
      candidates.push({
        path: canonical,
        fingerprint: await updateEntryFingerprint(target),
      });
    } catch {
      // Unknown or unsafe entries are intentionally not scheduled for deletion.
      // A successful update must never turn cleanup into a broad filesystem wipe.
    }
  };

  const entries = await fs.readdir(updateRoot, { withFileTypes: true });
  entries.sort((left, right) => bytewiseCompare(left.name, right.name));
  for (const entry of entries) {
    if (!["inbox", ".bonni-work"].includes(entry.name)) {
      await capture(`UPDATE/${entry.name}`);
      continue;
    }
    const container = path.join(updateRoot, entry.name);
    const state = await fs.lstat(container);
    if (!state.isDirectory() || state.isSymbolicLink()) continue;
    const children = await fs.readdir(container, { withFileTypes: true });
    children.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const child of children) {
      await capture(`UPDATE/${entry.name}/${child.name}`);
    }
  }
  return normalizeCleanupCandidates(candidates, { packagePath });
}

async function assertRealDirectory(directory, errorCode) {
  const resolved = path.resolve(directory);
  const state = await fs.lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state?.isDirectory() || state.isSymbolicLink()) fail(errorCode, resolved);
  const real = await fs.realpath(resolved);
  const comparable = (value) => process.platform === "win32"
    ? value.toLocaleLowerCase("en-US")
    : value;
  if (comparable(path.resolve(real)) !== comparable(resolved)) fail(errorCode, resolved);
  return resolved;
}

async function findPackage(updateRoot) {
  const manifests = [];
  const state = await fs.lstat(updateRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) fail("SOURCE_UPDATE_PACKAGE_NOT_FOUND", "UPDATE");
  await assertRealDirectory(updateRoot, "SOURCE_UPDATE_UNSAFE_UPDATE_ROOT");

  await walkDirectory(updateRoot, async (relativePath, absolutePath) => {
    if (path.posix.basename(relativePath) === MANIFEST_NAME) manifests.push(absolutePath);
  });
  if (!manifests.length) fail("SOURCE_UPDATE_PACKAGE_NOT_FOUND", MANIFEST_NAME);
  if (manifests.length !== 1) fail("SOURCE_UPDATE_MULTIPLE_PACKAGES", String(manifests.length));

  const manifestPath = manifests[0];
  const packageRoot = path.dirname(manifestPath);
  if (path.resolve(packageRoot) === path.resolve(updateRoot)) fail("SOURCE_UPDATE_PACKAGE_MUST_BE_NESTED");
  await assertRealDirectory(packageRoot, "SOURCE_UPDATE_UNSAFE_PACKAGE_ROOT");
  return { manifestPath, packageRoot };
}

async function validatePayload({ packageRoot, manifest }) {
  const payloadRoot = path.join(packageRoot, "payload");
  const payloadState = await fs.lstat(payloadRoot).catch(() => null);
  if (!payloadState) fail("SOURCE_UPDATE_PAYLOAD_MISSING");
  await assertRealDirectory(payloadRoot, "SOURCE_UPDATE_UNSAFE_PAYLOAD_ROOT");

  const declared = new Map();
  for (const entry of manifest.files.filter((candidate) => candidate.payloadObject)) {
    const key = windowsPathKey(entry.payloadObject);
    const existing = declared.get(key);
    if (existing && (existing.sha256 !== entry.sha256 || existing.sizeBytes !== entry.sizeBytes)) {
      fail("SOURCE_UPDATE_PAYLOAD_HASH_COLLISION", entry.path);
    }
    if (!existing) declared.set(key, entry);
  }
  const seen = new Set();
  await walkDirectory(payloadRoot, async (relativePath, absolutePath, state) => {
    const canonical = normalizeManifestPath(relativePath, "payload");
    const key = windowsPathKey(canonical);
    const declaredEntry = declared.get(key);
    if (!declaredEntry || declaredEntry.payloadObject !== canonical) {
      fail("SOURCE_UPDATE_UNDECLARED_PAYLOAD_FILE", canonical);
    }
    if (seen.has(key)) fail("SOURCE_UPDATE_PAYLOAD_PATH_COLLISION", canonical);
    seen.add(key);
    if (state.size !== declaredEntry.sizeBytes) fail("SOURCE_UPDATE_SIZE_MISMATCH", canonical);
    const hash = await sha256File(absolutePath);
    if (hash !== declaredEntry.sha256) fail("SOURCE_UPDATE_HASH_MISMATCH", canonical);
  });
  for (const entry of declared.values()) {
    if (!seen.has(windowsPathKey(entry.payloadObject))) {
      fail("SOURCE_UPDATE_PAYLOAD_FILE_MISSING", entry.path);
    }
  }
  return payloadRoot;
}

async function ensureSafeStateRoot(productRoot) {
  const resolvedProductRoot = path.resolve(productRoot);
  const relativeStateRoot = "SYSTEM/.bonni-source-update";
  const stateRoot = await assertSafeExistingTarget(resolvedProductRoot, relativeStateRoot);
  const state = await fs.lstat(stateRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) await fs.mkdir(stateRoot, { recursive: true });
  const verifiedStateRoot = await assertSafeExistingTarget(resolvedProductRoot, relativeStateRoot);
  const verifiedState = await fs.lstat(verifiedStateRoot);
  if (!verifiedState.isDirectory() || verifiedState.isSymbolicLink()) {
    fail("SOURCE_UPDATE_UNSAFE_STATE_ROOT");
  }
  return verifiedStateRoot;
}

async function stateFileTarget(productRoot, relativeToState) {
  const canonical = normalizeManifestPath(relativeToState, "state-file");
  await ensureSafeStateRoot(productRoot);
  const productRelative = `SYSTEM/.bonni-source-update/${canonical}`;
  const target = await assertSafeExistingTarget(productRoot, productRelative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertSafeExistingTarget(productRoot, productRelative);
  return target;
}

async function readStateJson(productRoot, relativeToState, errorCode) {
  return readJson(await stateFileTarget(productRoot, relativeToState), errorCode);
}

async function writeStateJson(productRoot, relativeToState, value) {
  return writeJsonAtomic(await stateFileTarget(productRoot, relativeToState), value);
}

async function removeStateFile(productRoot, relativeToState) {
  await fs.rm(await stateFileTarget(productRoot, relativeToState), { force: true });
}

async function readPending(productRoot) {
  return readStateJson(productRoot, "pending-update.json", "SOURCE_UPDATE_PENDING_STATE_INVALID");
}

async function readVerifiedCommitState(productRoot, pending) {
  const active = await readStateJson(
    productRoot,
    "active-manifest.json",
    "SOURCE_UPDATE_ACTIVE_STATE_INVALID",
  );
  normalizeActiveState(active);
  const receipt = await readStateJson(
    productRoot,
    `history/${pending.updateId}.json`,
    "SOURCE_UPDATE_HISTORY_INVALID",
  );
  if (
    active?.updateId !== pending.updateId
    || active?.manifestSha256 !== pending.manifestSha256
    || receipt?.status !== "COMPLETED"
    || receipt?.manifestSha256 !== pending.manifestSha256
  ) {
    fail("SOURCE_UPDATE_COMMIT_STATE_INVALID");
  }
  return { active, receipt };
}

async function verifyPending(productRoot, pending) {
  if (
    !isPlainObject(pending)
    || pending.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || typeof pending.updateId !== "string"
    || !["applied", "committed"].includes(pending.phase)
    || typeof pending.handoffToken !== "string"
    || !/^[a-f0-9]{64}$/u.test(pending.handoffToken)
  ) {
    fail("SOURCE_UPDATE_PENDING_STATE_INVALID");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  const packagePath = normalizeManifestPath(pending.packagePath, "pending.packagePath");
  const transactionPath = normalizeManifestPath(pending.transactionPath, "pending.transactionPath");
  const packageRoot = path.resolve(resolvedProductRoot, ...packagePath.split("/"));
  const transactionRoot = path.resolve(resolvedProductRoot, ...transactionPath.split("/"));
  const updateRoot = path.join(resolvedProductRoot, "UPDATE");
  if (!packageRoot.startsWith(`${path.resolve(updateRoot)}${path.sep}`)) {
    fail("SOURCE_UPDATE_PENDING_PACKAGE_INVALID");
  }
  if (!transactionRoot.startsWith(`${path.resolve(updateRoot)}${path.sep}`)) {
    fail("SOURCE_UPDATE_PENDING_TRANSACTION_INVALID");
  }
  const cleanupCandidates = normalizeCleanupCandidates(pending.cleanupCandidates, {
    packagePath,
    transactionPath,
  });

  if (pending.phase === "committed") {
    const { active, receipt } = await readVerifiedCommitState(resolvedProductRoot, pending);
    return {
      ...pending,
      cleanupCandidates,
      active,
      receipt,
      packageRoot,
      transactionRoot,
      committed: true,
    };
  }

  const packageState = await fs.lstat(packageRoot).catch(() => null);
  if (!packageState?.isDirectory() || packageState.isSymbolicLink()) {
    fail("SOURCE_UPDATE_PENDING_PACKAGE_MISSING");
  }
  await assertSafeExistingTarget(resolvedProductRoot, packagePath);
  await assertSafeExistingTarget(resolvedProductRoot, transactionPath);
  await assertRealDirectory(transactionRoot, "SOURCE_UPDATE_UNSAFE_TRANSACTION_ROOT");
  const manifestPath = path.join(packageRoot, MANIFEST_NAME);
  const raw = await readJson(manifestPath, "SOURCE_UPDATE_MANIFEST_INVALID");
  if (!raw) fail("SOURCE_UPDATE_PENDING_PACKAGE_MISSING");
  const manifest = validateManifest(raw);
  if (manifest.updateId !== pending.updateId) fail("SOURCE_UPDATE_PENDING_ID_MISMATCH");
  const manifestHash = await sha256File(manifestPath);
  if (manifestHash !== pending.manifestSha256) fail("SOURCE_UPDATE_PENDING_MANIFEST_CHANGED");
  const journal = await readJson(
    path.join(transactionRoot, "journal.json"),
    "SOURCE_UPDATE_JOURNAL_INVALID",
  );
  if (
    !journal
    || !["applying", "applied", "committed"].includes(journal.status)
  ) {
    fail("SOURCE_UPDATE_JOURNAL_INVALID");
  }
  assertJournalContract(journal, transactionPath);
  const journalCleanupCandidates = normalizeCleanupCandidates(journal.cleanupCandidates, {
    packagePath,
    transactionPath,
  });
  if (
    journal.updateId !== pending.updateId
    || journal.manifestSha256 !== pending.manifestSha256
    || journal.packagePath !== packagePath
    || journal.handoffToken !== pending.handoffToken
    || JSON.stringify(journalCleanupCandidates) !== JSON.stringify(cleanupCandidates)
  ) {
    fail("SOURCE_UPDATE_JOURNAL_PENDING_MISMATCH");
  }
  await validateJournalOperations(journal, manifest, transactionRoot);
  if (journal.status === "committed") {
    const { active, receipt } = await readVerifiedCommitState(resolvedProductRoot, pending);
    const committedPending = {
      ...pending,
      cleanupCandidates,
      phase: "committed",
      committedAt: journal.committedAt || receipt.completedAt,
    };
    await writeStateJson(resolvedProductRoot, "pending-update.json", committedPending);
    return {
      ...committedPending,
      active,
      receipt,
      packageRoot,
      transactionRoot,
      committed: true,
    };
  }
  for (const entry of manifest.files) {
    const target = await assertSafeExistingTarget(productRoot, entry.path);
    const state = await existingRegularFile(target, entry.path);
    if (!state || state.size !== entry.sizeBytes || await sha256File(target) !== entry.sha256) {
      fail("SOURCE_UPDATE_PENDING_TARGET_CHANGED", entry.path);
    }
  }
  for (const entry of manifest.delete) {
    const target = await assertSafeExistingTarget(productRoot, entry.path);
    const state = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (state) fail("SOURCE_UPDATE_PENDING_DELETE_REAPPEARED", entry.path);
  }
  for (const operation of journal.operations) {
    if (!isPlainObject(operation) || !["write", "delete"].includes(operation.action)) {
      fail("SOURCE_UPDATE_JOURNAL_INVALID_OPERATION");
    }
    const operationPath = normalizeManifestPath(operation.path, "journal.operations.path");
    assertManagedAndUnprotected(operationPath, manifest.components, "journal");
    if (operation.action !== "delete") continue;
    const target = await assertSafeExistingTarget(productRoot, operationPath);
    const state = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (state) fail("SOURCE_UPDATE_PENDING_DELETE_REAPPEARED", operationPath);
  }
  await assertInstalledBootstrapContract(productRoot, manifest.to.coreVersion);
  return {
    ...pending,
    cleanupCandidates,
    manifest,
    manifestPath,
    packageRoot,
    transactionRoot,
    journal,
  };
}

async function assertInstalledBootstrapContract(productRoot, targetCoreVersion) {
  const packageJson = await readJson(
    path.join(path.resolve(productRoot), "SYSTEM", "backend", "package.json"),
    "SOURCE_UPDATE_BACKEND_PACKAGE_INVALID",
  );
  const packageLock = await readJson(
    path.join(path.resolve(productRoot), "SYSTEM", "backend", "package-lock.json"),
    "SOURCE_UPDATE_BACKEND_LOCK_INVALID",
  );
  const normalizedScripts = Object.fromEntries(
    Object.entries(packageJson?.scripts || {}).map(([key, value]) => [
      key,
      typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : value,
    ]),
  );
  if (
    packageJson?.version !== targetCoreVersion
    || packageLock?.version !== targetCoreVersion
    || packageLock?.packages?.[""]?.version !== targetCoreVersion
    || normalizedScripts.setup !== "node scripts/setup/setup-system.mjs"
    || normalizedScripts.update !== "node scripts/setup/update-system.mjs"
    || normalizedScripts.prestart !== "node scripts/runtime/local-source-update-start-gate.mjs"
    || normalizedScripts.predev !== "node scripts/setup/local-source-update-gate.mjs"
    || !ALLOWED_BACKEND_START_SCRIPTS.has(normalizedScripts.start)
  ) {
    fail("SOURCE_UPDATE_BOOTSTRAP_CONTRACT_INVALID");
  }
}

function assertJournalContract(journal, transactionPath) {
  if (
    !isPlainObject(journal)
    || journal.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || typeof journal.updateId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(journal.updateId)
    || !["backing-up", "prepared", "applying", "applied", "committed", "rollback-failed"].includes(journal.status)
    || !Array.isArray(journal.operations)
    || journal.operations.length > MAX_FILES * 2
    || typeof journal.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(journal.manifestSha256)
    || typeof journal.handoffToken !== "string"
    || !/^[a-f0-9]{64}$/u.test(journal.handoffToken)
    || journal.packagePath !== `UPDATE/inbox/${journal.updateId}`
    || journal.transactionPath !== `UPDATE/.bonni-work/${journal.updateId}`
    || journal.transactionPath !== transactionPath
  ) {
    fail("SOURCE_UPDATE_JOURNAL_INVALID");
  }
  normalizeCleanupCandidates(journal.cleanupCandidates, {
    packagePath: journal.packagePath,
    transactionPath,
  });
}

async function readJournalManifest(productRoot, journal) {
  const packageRoot = await assertSafeExistingTarget(productRoot, journal.packagePath);
  const packageState = await fs.lstat(packageRoot).catch(() => null);
  if (!packageState?.isDirectory() || packageState.isSymbolicLink()) {
    fail("SOURCE_UPDATE_RECOVERY_PACKAGE_MISSING", journal.updateId);
  }
  const manifestPath = path.join(packageRoot, MANIFEST_NAME);
  const rawManifest = await readJson(manifestPath, "SOURCE_UPDATE_MANIFEST_INVALID");
  if (!rawManifest) fail("SOURCE_UPDATE_RECOVERY_PACKAGE_MISSING", journal.updateId);
  const manifest = validateManifest(rawManifest);
  if (
    manifest.updateId !== journal.updateId
    || await sha256File(manifestPath) !== journal.manifestSha256
  ) {
    fail("SOURCE_UPDATE_RECOVERY_MANIFEST_MISMATCH", journal.updateId);
  }
  return manifest;
}

async function validateJournalOperations(journal, manifest, transactionRoot) {
  const manifestFiles = new Set(manifest.files.map((entry) => windowsPathKey(entry.path)));
  const usedPaths = new Set();
  for (let index = 0; index < journal.operations.length; index += 1) {
    const operation = journal.operations[index];
    if (
      !isPlainObject(operation)
      || !["write", "delete"].includes(operation.action)
      || typeof operation.existed !== "boolean"
    ) {
      fail("SOURCE_UPDATE_JOURNAL_INVALID_OPERATION", String(index));
    }
    const operationPath = normalizeManifestPath(operation.path, `journal.operations[${index}].path`);
    assertManagedAndUnprotected(operationPath, manifest.components, "journal");
    const pathKey = windowsPathKey(operationPath);
    if (usedPaths.has(pathKey)) fail("SOURCE_UPDATE_JOURNAL_DUPLICATE_OPERATION", operationPath);
    usedPaths.add(pathKey);
    if (operation.action === "write" && !manifestFiles.has(pathKey)) {
      fail("SOURCE_UPDATE_JOURNAL_WRITE_NOT_IN_MANIFEST", operationPath);
    }
    if (operation.action === "delete" && !operation.existed) {
      fail("SOURCE_UPDATE_JOURNAL_INVALID_DELETE", operationPath);
    }
    if (
      operation.existed
      ? (typeof operation.previousSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(operation.previousSha256))
      : operation.previousSha256 !== null
    ) {
      fail("SOURCE_UPDATE_JOURNAL_INVALID_PREVIOUS_HASH", operationPath);
    }
    const expectedBackupPath = `backup/${String(index).padStart(6, "0")}.bin`;
    if (operation.backupPath !== expectedBackupPath) {
      fail("SOURCE_UPDATE_JOURNAL_INVALID_BACKUP_PATH", operationPath);
    }
    if (!operation.existed) continue;
    const backup = path.join(transactionRoot, ...expectedBackupPath.split("/"));
    const backupState = await fs.lstat(backup).catch(() => null);
    if (
      !backupState?.isFile()
      || backupState.isSymbolicLink()
      || backupState.nlink > 1
      || await sha256File(backup) !== operation.previousSha256
    ) {
      fail("SOURCE_UPDATE_ROLLBACK_BACKUP_INVALID", operationPath);
    }
  }
}

async function rollbackJournal(productRoot, journal, transactionRoot, manifest) {
  await validateJournalOperations(journal, manifest, transactionRoot);
  const manifestFiles = new Map(
    manifest.files.map((entry) => [windowsPathKey(entry.path), entry]),
  );
  const conflicts = [];
  const rollbackPlan = [];
  for (const operation of [...journal.operations].reverse()) {
    const target = await assertSafeExistingTarget(productRoot, operation.path);
    const state = await existingRegularFile(target, operation.path);
    const currentHash = state ? await sha256File(target) : null;
    if (operation.action === "write") {
      const installedHash = manifestFiles.get(windowsPathKey(operation.path))?.sha256;
      if (operation.existed && currentHash === operation.previousSha256) continue;
      if (!operation.existed && currentHash === null) continue;
      if (operation.existed && currentHash === null) {
        // A process may have stopped between replacement steps in an older
        // updater. The verified backup is authoritative for this transaction.
      } else if (currentHash !== installedHash) {
        conflicts.push(operation.path);
        continue;
      }
    } else {
      if (currentHash === operation.previousSha256) continue;
      if (currentHash !== null) {
        conflicts.push(operation.path);
        continue;
      }
    }
    rollbackPlan.push({ operation, expectedCurrentHash: currentHash });
  }
  if (conflicts.length) fail("SOURCE_UPDATE_ROLLBACK_CONFLICT", conflicts.join(","));

  const recoveryCriticalPaths = new Set([
    "SYSTEM/backend/package-lock.json",
    "SYSTEM/backend/package.json",
    "SYSTEM/backend/scripts/setup/local-source-update.mjs",
    "SYSTEM/backend/scripts/setup/local-source-update-gate.mjs",
    "SYSTEM/backend/scripts/setup/local-source-update-supervisor.mjs",
    "SYSTEM/backend/scripts/setup/prebuilt-frontend.mjs",
    "SYSTEM/backend/scripts/setup/setup-system.mjs",
    "SYSTEM/backend/scripts/setup/update-system.mjs",
    "SYSTEM/backend/scripts/runtime/local-source-update-start-gate.mjs",
    "SYSTEM/backend/scripts/runtime/run-host-backend-entry.mjs",
    "SYSTEM/backend/scripts/runtime/runtime-mode-exclusion.mjs",
    "SYSTEM/backend/scripts/runtime/start-backend.mjs",
  ].map(windowsPathKey));
  rollbackPlan.sort((left, right) => (
    Number(recoveryCriticalPaths.has(windowsPathKey(left.operation.path)))
    - Number(recoveryCriticalPaths.has(windowsPathKey(right.operation.path)))
  ));

  for (const { operation, expectedCurrentHash } of rollbackPlan) {
    const target = await assertSafeExistingTarget(productRoot, operation.path);
    const state = await existingRegularFile(target, operation.path);
    const currentHash = state ? await sha256File(target) : null;
    if (currentHash !== expectedCurrentHash) {
      fail("SOURCE_UPDATE_ROLLBACK_CONFLICT", operation.path);
    }
    if (operation.existed) {
      const backup = path.join(transactionRoot, operation.backupPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(
        path.dirname(target),
        `.bonni-rollback-${randomBytes(16).toString("hex")}.tmp`,
      );
      try {
        await fs.copyFile(backup, temporary, fsConstants.COPYFILE_EXCL);
        const temporaryState = await fs.lstat(temporary);
        if (!temporaryState.isFile() || temporaryState.nlink > 1) {
          fail("SOURCE_UPDATE_ROLLBACK_TEMP_UNSAFE", operation.path);
        }
        await syncRegularFile(temporary);
        await fs.rename(temporary, target);
        await syncDirectory(path.dirname(target));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    } else {
      await fs.rm(target, { force: true });
      await syncDirectory(path.dirname(target));
    }
  }
}

async function recoverIncompleteTransactions(productRoot) {
  const workRoot = path.join(path.resolve(productRoot), "UPDATE", ".bonni-work");
  const workState = await fs.lstat(workRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!workState) return false;
  await assertRealDirectory(path.join(path.resolve(productRoot), "UPDATE"), "SOURCE_UPDATE_UNSAFE_UPDATE_ROOT");
  await assertRealDirectory(workRoot, "SOURCE_UPDATE_UNSAFE_WORK_ROOT");
  const entries = await fs.readdir(workRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail("SOURCE_UPDATE_UNSAFE_WORK_ENTRY", entry.name);
    }
    const transactionRoot = path.join(workRoot, entry.name);
    await assertRealDirectory(transactionRoot, "SOURCE_UPDATE_UNSAFE_TRANSACTION_ROOT");
    const journal = await readJson(path.join(transactionRoot, "journal.json"), "SOURCE_UPDATE_JOURNAL_INVALID");
    if (!journal) {
      const packageRoot = path.join(path.resolve(productRoot), "UPDATE", "inbox", entry.name);
      const manifest = await readJson(path.join(packageRoot, MANIFEST_NAME), "SOURCE_UPDATE_MANIFEST_INVALID");
      if (!manifest || validateManifest(manifest).updateId !== entry.name) {
        fail("SOURCE_UPDATE_ORPHANED_WORK_INVALID", entry.name);
      }
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    const transactionPath = path.relative(path.resolve(productRoot), transactionRoot).split(path.sep).join("/");
    assertJournalContract(journal, transactionPath);
    if (["backing-up", "prepared"].includes(journal.status)) {
      await readJournalManifest(productRoot, journal);
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    if (["applied", "committed"].includes(journal.status)) {
      const active = await readStateJson(productRoot, "active-manifest.json", "SOURCE_UPDATE_ACTIVE_STATE_INVALID");
      const receipt = await readStateJson(
        productRoot,
        `history/${journal.updateId}.json`,
        "SOURCE_UPDATE_HISTORY_INVALID",
      );
      if (
        active?.updateId === journal.updateId
        && active?.manifestSha256 === journal.manifestSha256
        && receipt?.status === "COMPLETED"
        && receipt?.manifestSha256 === journal.manifestSha256
      ) {
        await writeStateJson(productRoot, "pending-update.json", {
          schemaVersion: SOURCE_UPDATE_SCHEMA,
          updateId: journal.updateId,
          manifestSha256: journal.manifestSha256,
          packagePath: journal.packagePath,
          transactionPath: journal.transactionPath,
          phase: "committed",
          handoffToken: journal.handoffToken,
          appliedAt: journal.appliedAt,
          committedAt: journal.committedAt || receipt.completedAt,
          cleanupCandidates: normalizeCleanupCandidates(journal.cleanupCandidates, {
            packagePath: journal.packagePath,
            transactionPath: journal.transactionPath,
          }),
        });
        return true;
      }
    }
    const manifest = await readJournalManifest(productRoot, journal);
    await rollbackJournal(productRoot, journal, transactionRoot, manifest);
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
  return false;
}

async function existingRegularFile(target, relativePath) {
  const state = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return null;
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
    fail("SOURCE_UPDATE_TARGET_NOT_REGULAR_FILE", relativePath);
  }
  return state;
}

function normalizeActiveState(active) {
  if (!active) return { components: [], files: [] };
  if (
    active.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || !Array.isArray(active.components)
    || !Array.isArray(active.files)
  ) {
    fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID");
  }

  const componentPaths = new Set();
  const components = active.components.map((component, index) => {
    if (!isPlainObject(component) || component.mode !== "managed" || typeof component.key !== "string") {
      fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID", `components[${index}]`);
    }
    const componentPath = normalizeManifestPath(component.path, `active.components[${index}].path`);
    if (!MANAGED_COMPONENT_PATHS.has(componentPath)) {
      fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID", componentPath);
    }
    const key = windowsPathKey(componentPath);
    if (componentPaths.has(key)) fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID", componentPath);
    componentPaths.add(key);
    return { key: component.key, path: componentPath, mode: "managed" };
  });

  const filePaths = new Set();
  const files = active.files.map((entry, index) => {
    if (!isPlainObject(entry)) fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID", `files[${index}]`);
    const activePath = normalizeManifestPath(entry.path, `active.files[${index}].path`);
    if (
      !componentForPath(activePath, components)
      || isProtectedPath(activePath)
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !Number.isSafeInteger(entry.sizeBytes)
      || entry.sizeBytes < 0
    ) {
      fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID", activePath);
    }
    const key = windowsPathKey(activePath);
    if (filePaths.has(key)) fail("SOURCE_UPDATE_ACTIVE_STATE_INVALID", activePath);
    filePaths.add(key);
    return { path: activePath, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  });

  return { components, files };
}

async function readCompletedHistoryReceipt(productRoot, updateId) {
  const historyProbe = await stateFileTarget(productRoot, "history/.history-probe");
  const historyRoot = path.dirname(historyProbe);
  const requestedName = windowsPathKey(`${updateId}.json`);
  const entries = await fs.readdir(historyRoot, { withFileTypes: true });
  const matches = entries.filter((entry) => windowsPathKey(entry.name) === requestedName);
  if (!matches.length) return null;
  if (matches.length !== 1 || !matches[0].isFile() || matches[0].isSymbolicLink()) {
    fail("SOURCE_UPDATE_COMPLETED_RECEIPT_INVALID", updateId);
  }
  const receipt = await readStateJson(
    productRoot,
    `history/${matches[0].name}`,
    "SOURCE_UPDATE_COMPLETED_RECEIPT_INVALID",
  );
  assertExactKeys(receipt, new Set([
    "schemaVersion",
    "updateId",
    "manifestSha256",
    "completedAt",
    "versions",
    "components",
    "files",
    "localDeploymentLifecycle",
    "releaseNotes",
    "updateMetadata",
    "status",
  ]), "history-receipt");
  if (
    receipt.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || receipt.status !== "COMPLETED"
    || receipt.updateId !== updateId
    || typeof receipt.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256)
    || typeof receipt.completedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.completedAt))
  ) {
    fail("SOURCE_UPDATE_COMPLETED_RECEIPT_INVALID", updateId);
  }
  validateVersionObject(receipt.versions, "history-receipt.versions");
  validateLocalDeploymentLifecycleMarker(
    receipt.localDeploymentLifecycle,
    "history-receipt.localDeploymentLifecycle",
  );
  validateReleaseNotes(receipt.releaseNotes);
  const updateMetadata = validateCompletedUpdateMetadata(receipt.updateMetadata);
  if (updateMetadata && !sameVersionObject(updateMetadata.to, receipt.versions)) {
    fail("SOURCE_UPDATE_COMPLETED_METADATA_INVALID", updateId);
  }
  normalizeActiveState(receipt);
  return receipt;
}

function validateLocalDeploymentLifecycleMarker(value, label) {
  if (value === undefined) return null;
  assertExactKeys(value, new Set(["schemaVersion", "mode", "required"]), label);
  if (
    value.schemaVersion !== LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA
    || value.mode !== "local-source"
    || value.required !== true
  ) fail("SOURCE_UPDATE_LOCAL_DEPLOYMENT_MARKER_INVALID", label);
  return value;
}

function sameLocalDeploymentLifecycleMarker(left, right) {
  const normalizedLeft = validateLocalDeploymentLifecycleMarker(
    left?.localDeploymentLifecycle,
    "active-left.localDeploymentLifecycle",
  );
  const normalizedRight = validateLocalDeploymentLifecycleMarker(
    right?.localDeploymentLifecycle,
    "active-right.localDeploymentLifecycle",
  );
  return Boolean(normalizedLeft) === Boolean(normalizedRight);
}

function sameVersionObject(left, right) {
  return left?.coreVersion === right?.coreVersion
    && left?.kontorAppVersion === right?.kontorAppVersion;
}

function sameManagedSnapshot(left, right) {
  if (!sameLocalDeploymentLifecycleMarker(left, right)) return false;
  const normalizedLeft = normalizeActiveState(left);
  const normalizedRight = normalizeActiveState(right);
  if (normalizedLeft.components.length !== normalizedRight.components.length) return false;
  if (normalizedLeft.files.length !== normalizedRight.files.length) return false;

  const rightComponents = new Map(normalizedRight.components.map((component) => [
    windowsPathKey(component.path),
    component,
  ]));
  for (const component of normalizedLeft.components) {
    const other = rightComponents.get(windowsPathKey(component.path));
    if (!other || other.key !== component.key || other.mode !== component.mode) return false;
  }

  const rightFiles = new Map(normalizedRight.files.map((entry) => [
    windowsPathKey(entry.path),
    entry,
  ]));
  for (const entry of normalizedLeft.files) {
    const other = rightFiles.get(windowsPathKey(entry.path));
    if (!other || other.sizeBytes !== entry.sizeBytes || other.sha256 !== entry.sha256) return false;
  }
  return true;
}

function assertCompletedReceiptMatchesManifest(receipt, manifest, { completedRollback = false } = {}) {
  if (!sameVersionObject(receipt.versions, manifest.to)) {
    fail("SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH", manifest.updateId);
  }
  if (
    Boolean(validateLocalDeploymentLifecycleMarker(
      receipt.localDeploymentLifecycle,
      "history-receipt.localDeploymentLifecycle",
    )) !== (manifestRequestsLocalDeploymentHold(manifest) && !completedRollback)
  ) fail("SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH", manifest.updateId);

  const expectedMetadata = completedUpdateMetadataFromManifest(manifest);
  const recordedMetadata = validateCompletedUpdateMetadata(receipt.updateMetadata);
  if (recordedMetadata && (
    !sameVersionObject(recordedMetadata.from, expectedMetadata.from)
    || !sameVersionObject(recordedMetadata.to, expectedMetadata.to)
    || recordedMetadata.repair !== expectedMetadata.repair
    || recordedMetadata.counts.files !== expectedMetadata.counts.files
    || recordedMetadata.counts.inventory !== expectedMetadata.counts.inventory
    || recordedMetadata.counts.delete !== expectedMetadata.counts.delete
    || recordedMetadata.components.length !== expectedMetadata.components.length
    || recordedMetadata.components.some((component) => {
      const expected = expectedMetadata.components.find((entry) => windowsPathKey(entry.path) === windowsPathKey(component.path));
      return !expected || expected.key !== component.key || expected.mode !== component.mode;
    })
  )) fail("SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH", manifest.updateId);

  const normalizedReceipt = normalizeActiveState(receipt);
  const receiptComponents = new Map(normalizedReceipt.components.map((component) => [
    windowsPathKey(component.path),
    component,
  ]));
  for (const component of manifest.components) {
    const recorded = receiptComponents.get(windowsPathKey(component.path));
    if (!recorded || recorded.key !== component.key || recorded.mode !== component.mode) {
      fail("SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH", manifest.updateId);
    }
  }

  const manifestFiles = new Map(manifest.files.map((entry) => [windowsPathKey(entry.path), entry]));
  const recordedManagedFiles = normalizedReceipt.files.filter((entry) => (
    componentForPath(entry.path, manifest.components)
  ));
  if (recordedManagedFiles.length !== manifest.files.length) {
    fail("SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH", manifest.updateId);
  }
  for (const recorded of recordedManagedFiles) {
    const declared = manifestFiles.get(windowsPathKey(recorded.path));
    if (
      !declared
      || declared.sizeBytes !== recorded.sizeBytes
      || declared.sha256 !== recorded.sha256
    ) {
      fail("SOURCE_UPDATE_COMPLETED_RECEIPT_MISMATCH", manifest.updateId);
    }
  }
}

async function assertCompletedStateConsistent(productRoot, manifest, receipt) {
  const completedRollback = await isCompletedLocalSourceDeploymentRollback({
    productRoot,
    transaction: {
      updateId: receipt.updateId,
      manifestSha256: receipt.manifestSha256,
    },
  });
  assertCompletedReceiptMatchesManifest(receipt, manifest, { completedRollback });

  const active = await readStateJson(
    productRoot,
    "active-manifest.json",
    "SOURCE_UPDATE_ACTIVE_STATE_INVALID",
  );
  if (
    !active
    || active.schemaVersion !== SOURCE_UPDATE_SCHEMA
    || typeof active.updateId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(active.updateId)
    || typeof active.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(active.manifestSha256)
    || typeof active.completedAt !== "string"
    || !Number.isFinite(Date.parse(active.completedAt))
  ) {
    fail("SOURCE_UPDATE_COMPLETED_STATE_INCONSISTENT", manifest.updateId);
  }
  validateVersionObject(active.versions, "active.versions");
  validateLocalDeploymentLifecycleMarker(
    active.localDeploymentLifecycle,
    "active.localDeploymentLifecycle",
  );
  normalizeActiveState(active);

  const activeReceipt = await readCompletedHistoryReceipt(productRoot, active.updateId);
  if (
    !activeReceipt
    || activeReceipt.manifestSha256 !== active.manifestSha256
    || activeReceipt.completedAt !== active.completedAt
    || !sameVersionObject(activeReceipt.versions, active.versions)
    || !sameManagedSnapshot(activeReceipt, active)
  ) {
    fail("SOURCE_UPDATE_COMPLETED_STATE_INCONSISTENT", manifest.updateId);
  }

  for (const entry of normalizeActiveState(active).files) {
    const target = await assertSafeExistingTarget(productRoot, entry.path);
    const state = await existingRegularFile(target, entry.path);
    if (!state || state.size !== entry.sizeBytes || await sha256File(target) !== entry.sha256) {
      fail("SOURCE_UPDATE_COMPLETED_STATE_INCONSISTENT", `${manifest.updateId}:${entry.path}`);
    }
  }
}

async function planOperations({ productRoot, manifest, active }) {
  const normalizedActive = normalizeActiveState(active);
  const activeFiles = new Map(normalizedActive.files.map((entry) => [windowsPathKey(entry.path), entry]));
  const repairMode = manifest.payloadLayout === SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT;

  const operations = [];
  const newPaths = new Set(manifest.files.map((entry) => windowsPathKey(entry.path)));
  const deletionMap = new Map(manifest.delete.map((entry) => [windowsPathKey(entry.path), entry]));

  for (const component of manifest.components) {
    for (const essentialPath of ESSENTIAL_COMPONENT_FILES.get(component.path) || []) {
      const key = windowsPathKey(essentialPath);
      if (activeFiles.has(key) && !newPaths.has(key)) {
        fail("SOURCE_UPDATE_ESSENTIAL_FILE_MISSING", essentialPath);
      }
    }
  }

  for (const oldEntry of activeFiles.values()) {
    if (newPaths.has(windowsPathKey(oldEntry.path))) continue;
    if (!componentForPath(oldEntry.path, manifest.components)) continue;
    assertManagedAndUnprotected(oldEntry.path, manifest.components, "managed-delete");
    const existingDeletion = deletionMap.get(windowsPathKey(oldEntry.path));
    if (existingDeletion && existingDeletion.expectedSha256 !== oldEntry.sha256) {
      fail("SOURCE_UPDATE_DELETE_BASELINE_ACTIVE_MISMATCH", oldEntry.path);
    }
    if (!existingDeletion) {
      deletionMap.set(windowsPathKey(oldEntry.path), {
        path: oldEntry.path,
        expectedSha256: oldEntry.sha256,
        reason: "Im neuen verwalteten Quellstand nicht mehr enthalten.",
      });
    }
  }

  for (const entry of manifest.files) {
    const target = await assertSafeExistingTarget(productRoot, entry.path);
    const state = await existingRegularFile(target, entry.path);
    const oldManaged = activeFiles.get(windowsPathKey(entry.path));
    if (oldManaged && entry.expectedPreviousSha256 !== oldManaged.sha256) {
      fail("SOURCE_UPDATE_BASELINE_ACTIVE_MISMATCH", entry.path);
    }
    if (state) {
      const currentHash = await sha256File(target);
      if (repairMode && currentHash === entry.sha256 && state.size === entry.sizeBytes) continue;
      if (oldManaged && currentHash !== oldManaged.sha256) {
        fail("SOURCE_UPDATE_LOCAL_MODIFICATION_CONFLICT", entry.path);
      }
      if (!oldManaged && (entry.expectedPreviousSha256 === null || currentHash !== entry.expectedPreviousSha256)) {
        fail("SOURCE_UPDATE_PREVIOUS_HASH_CONFLICT", entry.path);
      }
      if (currentHash === entry.sha256 && state.size === entry.sizeBytes) continue;
    } else if (oldManaged && !repairMode) {
      fail("SOURCE_UPDATE_MANAGED_FILE_MISSING", entry.path);
    } else if (!oldManaged && entry.expectedPreviousSha256 !== null) {
      fail("SOURCE_UPDATE_PREVIOUS_FILE_MISSING", entry.path);
    }
    operations.push({
      action: "write",
      path: entry.path,
      entry,
      existed: Boolean(state),
      previousSha256: state ? await sha256File(target) : null,
    });
  }

  for (const deletion of deletionMap.values()) {
    const target = await assertSafeExistingTarget(productRoot, deletion.path);
    const state = await existingRegularFile(target, deletion.path);
    if (!state) continue;
    const currentHash = await sha256File(target);
    const oldManaged = activeFiles.get(windowsPathKey(deletion.path));
    if (oldManaged && deletion.expectedSha256 !== oldManaged.sha256) {
      fail("SOURCE_UPDATE_DELETE_BASELINE_ACTIVE_MISMATCH", deletion.path);
    }
    if (currentHash !== deletion.expectedSha256) {
      fail("SOURCE_UPDATE_DELETE_CONFLICT", deletion.path);
    }
    operations.push({
      action: "delete",
      path: deletion.path,
      existed: true,
      previousSha256: currentHash,
    });
  }

  return operations;
}

async function applyOperations({ productRoot, payloadRoot, transactionRoot, operations, journal }) {
  const backupRoot = path.join(transactionRoot, "backup");
  await fs.mkdir(backupRoot, { recursive: true });

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    operation.backupPath = `backup/${String(index).padStart(6, "0")}.bin`;
  }
  journal.status = "backing-up";
  await writeJsonAtomic(path.join(transactionRoot, "journal.json"), journal);

  for (const operation of operations) {
    if (!operation.existed) continue;
    const target = await assertSafeExistingTarget(productRoot, operation.path);
    await fs.copyFile(
      target,
      path.join(transactionRoot, operation.backupPath),
      fsConstants.COPYFILE_EXCL,
    );
    const backup = path.join(transactionRoot, operation.backupPath);
    if (await sha256File(backup) !== operation.previousSha256) {
      fail("SOURCE_UPDATE_BACKUP_SOURCE_CHANGED", operation.path);
    }
    await syncRegularFile(backup);
  }
  await syncDirectory(backupRoot);

  journal.status = "prepared";
  await writeJsonAtomic(path.join(transactionRoot, "journal.json"), journal);
  journal.status = "applying";
  await writeJsonAtomic(path.join(transactionRoot, "journal.json"), journal);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const target = await assertSafeExistingTarget(productRoot, operation.path);
    const currentState = await existingRegularFile(target, operation.path);
    const currentHash = currentState ? await sha256File(target) : null;
    if (
      (operation.existed && currentHash !== operation.previousSha256)
      || (!operation.existed && currentHash !== null)
    ) {
      fail("SOURCE_UPDATE_TARGET_CHANGED_DURING_APPLY", operation.path);
    }
    if (operation.action === "delete") {
      await fs.rm(target, { force: true });
      await syncDirectory(path.dirname(target));
      continue;
    }

    if (!operation.entry?.payloadObject) {
      fail("SOURCE_UPDATE_PAYLOAD_OBJECT_MISSING", operation.path);
    }
    const source = path.join(payloadRoot, ...operation.entry.payloadObject.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await assertSafeExistingTarget(productRoot, operation.path);
    const temporary = path.join(
      path.dirname(target),
      `.bonni-update-${randomBytes(16).toString("hex")}.tmp`,
    );
    try {
      await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
      const temporaryState = await fs.lstat(temporary);
      if (
        !temporaryState.isFile()
        || temporaryState.nlink > 1
        || temporaryState.size !== operation.entry.sizeBytes
        || await sha256File(temporary) !== operation.entry.sha256
      ) {
        fail("SOURCE_UPDATE_TEMP_UNSAFE", operation.path);
      }
      await syncRegularFile(temporary);
      await fs.rename(temporary, target);
      await syncDirectory(path.dirname(target));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

function assertDevelopmentEnvironment() {
  const mode = String(process.env.NODE_ENV || "").trim().toLocaleLowerCase("en-US");
  if (mode === "production") fail("SOURCE_UPDATE_DISABLED_IN_PRODUCTION");
}

export async function applyLocalSourceUpdate({
  productRoot,
  expectedUpdateId = null,
  expectedManifestSha256 = null,
  preflightOnly = false,
}) {
  assertDevelopmentEnvironment();
  if (
    (expectedUpdateId !== null && (typeof expectedUpdateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(expectedUpdateId)))
    || (expectedManifestSha256 !== null && (typeof expectedManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)))
    || Boolean(expectedUpdateId) !== Boolean(expectedManifestSha256)
  ) {
    fail("SOURCE_UPDATE_EXPECTED_PROOF_INVALID");
  }
  const assertExpectedProof = (updateId, manifestSha256) => {
    if (
      expectedUpdateId !== null
      && (updateId !== expectedUpdateId || manifestSha256 !== expectedManifestSha256)
    ) {
      fail("SOURCE_UPDATE_EXPECTED_PROOF_MISMATCH", updateId);
    }
  };
  const resolvedProductRoot = path.resolve(productRoot);
  const pending = await readPending(resolvedProductRoot);
  if (pending) {
    const verifiedPending = await verifyPending(resolvedProductRoot, pending);
    assertExpectedProof(verifiedPending.updateId, verifiedPending.manifestSha256);
    return verifiedPending;
  }

  const recoveredCommit = preflightOnly
    ? null
    : await recoverIncompleteTransactions(resolvedProductRoot);
  if (recoveredCommit) {
    const recoveredPending = await readPending(resolvedProductRoot);
    const verifiedPending = await verifyPending(resolvedProductRoot, recoveredPending);
    assertExpectedProof(verifiedPending.updateId, verifiedPending.manifestSha256);
    return verifiedPending;
  }
  const updateRoot = path.join(resolvedProductRoot, "UPDATE");
  const { manifestPath, packageRoot } = await findPackage(updateRoot);
  const rawManifest = await readJson(manifestPath, "SOURCE_UPDATE_MANIFEST_INVALID");
  const manifest = validateManifest(rawManifest);
  const manifestSha256 = await sha256File(manifestPath);
  assertExpectedProof(manifest.updateId, manifestSha256);
  const payloadRoot = await validatePayload({ packageRoot, manifest });

  const packagePath = path.relative(resolvedProductRoot, packageRoot).split(path.sep).join("/");
  if (packagePath !== `UPDATE/inbox/${manifest.updateId}`) {
    fail("SOURCE_UPDATE_PACKAGE_LOCATION_INVALID", packagePath);
  }
  const cleanupCandidates = preflightOnly
    ? []
    : await captureUpdateCleanupCandidates(resolvedProductRoot, packagePath);
  const completedReceipt = await readCompletedHistoryReceipt(resolvedProductRoot, manifest.updateId);
  if (completedReceipt) {
    if (completedReceipt.manifestSha256 !== manifestSha256) {
      fail("SOURCE_UPDATE_ID_COLLISION", manifest.updateId);
    }
    await assertCompletedStateConsistent(resolvedProductRoot, manifest, completedReceipt);
    if (!preflightOnly) {
      await cleanupCompletedUpdateRoot({
        productRoot: resolvedProductRoot,
        packagePath,
        cleanupCandidates,
      });
    }
    return {
      schemaVersion: SOURCE_UPDATE_SCHEMA,
      updateId: manifest.updateId,
      manifestSha256,
      packagePath,
      phase: "already-completed",
      alreadyCompleted: true,
      receipt: completedReceipt,
    };
  }

  const backendPackage = await readJson(
    path.join(resolvedProductRoot, "SYSTEM", "backend", "package.json"),
    "SOURCE_UPDATE_BACKEND_PACKAGE_INVALID",
  );
  if (!backendPackage || backendPackage.version !== manifest.from.coreVersion) {
    fail("SOURCE_UPDATE_CORE_VERSION_MISMATCH", `${backendPackage?.version || "missing"}:${manifest.from.coreVersion}`);
  }
  const kontorPackagePath = path.join(
    resolvedProductRoot,
    "SYSTEM",
    "app",
    "kontorapp",
    "package.json",
  );
  const kontorPackage = await readJson(
    kontorPackagePath,
    "SOURCE_UPDATE_KONTOR_PACKAGE_INVALID",
  );
  const updatesKontor = manifest.components.some(
    (component) => component.path === "SYSTEM/app/kontorapp",
  );
  if (updatesKontor || kontorPackage) {
    if (!kontorPackage || kontorPackage.version !== manifest.from.kontorAppVersion) {
      fail(
        "SOURCE_UPDATE_KONTOR_VERSION_MISMATCH",
        `${kontorPackage?.version || "missing"}:${manifest.from.kontorAppVersion}`,
      );
    }
  }

  const active = await readStateJson(resolvedProductRoot, "active-manifest.json", "SOURCE_UPDATE_ACTIVE_STATE_INVALID");
  if (
    manifest.requires
    && (
      active?.updateId !== manifest.requires.updateId
      || active?.manifestSha256 !== manifest.requires.manifestSha256
    )
  ) {
    fail("SOURCE_UPDATE_REQUIRED_PREDECESSOR_MISSING", manifest.requires.updateId);
  }
  const operations = await planOperations({ productRoot: resolvedProductRoot, manifest, active });
  if (preflightOnly) {
    return Object.freeze({
      schemaVersion: SOURCE_UPDATE_SCHEMA,
      updateId: manifest.updateId,
      manifestSha256,
      packagePath,
      phase: "preflight",
      alreadyCompleted: false,
      operationCount: operations.length,
    });
  }
  const transactionRoot = path.join(updateRoot, ".bonni-work", manifest.updateId);
  await fs.rm(transactionRoot, { recursive: true, force: true });
  await fs.mkdir(transactionRoot, { recursive: true });

  const appliedAt = new Date().toISOString();
  const handoffToken = randomBytes(32).toString("hex");
  const journal = {
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    updateId: manifest.updateId,
    status: "prepared",
    createdAt: new Date().toISOString(),
    appliedAt,
    handoffToken,
    operations,
    cleanupCandidates,
  };
  const transactionPath = path.relative(resolvedProductRoot, transactionRoot).split(path.sep).join("/");
  journal.manifestSha256 = manifestSha256;
  journal.packagePath = packagePath;
  journal.transactionPath = transactionPath;
  const pendingState = {
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    updateId: manifest.updateId,
    manifestSha256,
    packagePath,
    transactionPath,
    phase: "applied",
    handoffToken,
    appliedAt,
    cleanupCandidates,
  };

  let verifiedTransaction;
  try {
    await applyOperations({
      productRoot: resolvedProductRoot,
      payloadRoot,
      transactionRoot,
      operations,
      journal,
    });
    await assertInstalledBootstrapContract(resolvedProductRoot, manifest.to.coreVersion);
    await writeStateJson(resolvedProductRoot, "pending-update.json", pendingState);
    journal.status = "applied";
    journal.appliedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(transactionRoot, "journal.json"), journal);
    verifiedTransaction = await verifyPending(resolvedProductRoot, pendingState);
  } catch (error) {
    await removeStateFile(resolvedProductRoot, "pending-update.json");
    if (["applying", "applied"].includes(journal.status)) {
      try {
        await rollbackJournal(resolvedProductRoot, journal, transactionRoot, manifest);
      } catch (rollbackError) {
        journal.status = "rollback-failed";
        journal.rollbackFailedAt = new Date().toISOString();
        journal.rollbackError = String(rollbackError?.message || rollbackError);
        await writeJsonAtomic(path.join(transactionRoot, "journal.json"), journal).catch(() => {});
        throw new AggregateError(
          [error, rollbackError],
          "SOURCE_UPDATE_ROLLBACK_FAILED:Journal und Sicherung bleiben erhalten",
        );
      }
    }
    await fs.rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }

  return verifiedTransaction;
}

export async function preflightLocalSourceUpdate(options) {
  return applyLocalSourceUpdate({ ...options, preflightOnly: true });
}

async function removeInternalDirectory(productRoot, relativePath, requiredPrefix) {
  const canonical = normalizeManifestPath(relativePath, "internal-directory");
  if (!pathInside(canonical, requiredPrefix) || canonical === requiredPrefix) {
    fail("SOURCE_UPDATE_INTERNAL_DIRECTORY_INVALID", canonical);
  }
  const target = await assertSafeExistingTarget(productRoot, canonical);
  const state = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("SOURCE_UPDATE_INTERNAL_DIRECTORY_UNSAFE", canonical);
  }
  await fs.rm(target, { recursive: true, force: true });
  await syncDirectory(path.dirname(target));
}

async function removeMatchingCleanupCandidate(productRoot, candidate) {
  const [normalized] = normalizeCleanupCandidates([candidate]);
  let target;
  try {
    target = await assertSafeExistingTarget(productRoot, normalized.path);
    const state = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) return true;
    if (await updateEntryFingerprint(target) !== normalized.fingerprint) return false;
  } catch {
    // The path changed or became unsafe after installation. Treat it as new
    // pending/diagnostic data and preserve it instead of deleting broadly.
    return false;
  }
  await fs.rm(target, { recursive: true, force: true });
  await syncDirectory(path.dirname(target));
  return true;
}

async function removeEmptyUpdateContainer(productRoot, relativePath) {
  const target = await assertSafeExistingTarget(productRoot, relativePath);
  const state = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("SOURCE_UPDATE_INTERNAL_DIRECTORY_UNSAFE", relativePath);
  }
  if ((await fs.readdir(target)).length) return;
  try {
    await fs.rmdir(target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
}

async function cleanupCompletedUpdateRoot({
  productRoot,
  packagePath,
  transactionPath = null,
  cleanupCandidates = [],
}) {
  const normalizedCandidates = normalizeCleanupCandidates(cleanupCandidates, {
    packagePath,
    transactionPath,
  });
  await removeInternalDirectory(productRoot, packagePath, "UPDATE");
  if (transactionPath) {
    await removeInternalDirectory(productRoot, transactionPath, "UPDATE/.bonni-work");
  }
  for (const candidate of normalizedCandidates) {
    await removeMatchingCleanupCandidate(productRoot, candidate);
  }
  await removeEmptyUpdateContainer(productRoot, "UPDATE/inbox");
  await removeEmptyUpdateContainer(productRoot, "UPDATE/.bonni-work");
}

async function copyRollbackPayloadObject({ source, payloadRoot, sha256, sizeBytes }) {
  const objectName = sourceUpdatePayloadObjectName(sha256);
  const destination = path.join(payloadRoot, objectName);
  const existing = await fs.lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (
      !existing.isFile()
      || existing.isSymbolicLink()
      || existing.nlink > 1
      || existing.size !== sizeBytes
      || await sha256File(destination) !== sha256
    ) fail("SOURCE_UPDATE_ROLLBACK_PAYLOAD_COLLISION", objectName);
    return;
  }
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const copied = await fs.lstat(destination);
  if (
    !copied.isFile()
    || copied.isSymbolicLink()
    || copied.nlink > 1
    || copied.size !== sizeBytes
    || await sha256File(destination) !== sha256
  ) fail("SOURCE_UPDATE_ROLLBACK_PAYLOAD_INVALID", objectName);
  await syncRegularFile(destination);
}

function localDeploymentLifecyclePath() {
  return "deployment-lifecycle.json";
}

async function readLocalDeploymentLifecycle(productRoot) {
  return readStateJson(
    productRoot,
    localDeploymentLifecyclePath(),
    "SOURCE_UPDATE_LOCAL_DEPLOYMENT_LIFECYCLE_INVALID",
  );
}

async function prepareLocalSourceRollbackHold({
  productRoot,
  verified,
  previousActive,
  activatedAt,
}) {
  const manifest = verified.manifest;
  const rollbackUpdateId = `${manifest.updateId}-rollback`;
  if (rollbackUpdateId.length > 80) fail("SOURCE_UPDATE_ROLLBACK_ID_TOO_LONG", rollbackUpdateId);

  const existingLifecycle = await readLocalDeploymentLifecycle(productRoot).catch((error) => {
    if (String(error?.message || "").includes("ENOENT")) return null;
    throw error;
  });
  if (existingLifecycle?.blocksUpdates === true && existingLifecycle?.status !== "finalized") {
    fail("SOURCE_UPDATE_LOCAL_DEPLOYMENT_HOLD_ALREADY_ACTIVE", String(existingLifecycle.holdId || "unknown"));
  }

  const generation = Number.isSafeInteger(existingLifecycle?.generation)
    ? existingLifecycle.generation + 1
    : 1;
  const holdId = `local-${Date.now()}-${randomBytes(12).toString("hex")}`;
  const holdRelativeRoot = `deployment-holds/${holdId}`;
  const holdMarker = await stateFileTarget(productRoot, `deployment-holds/${holdId}.placeholder`);
  const holdRoot = path.join(path.dirname(holdMarker), holdId);
  const stagingRoot = `${holdRoot}.staging-${randomBytes(8).toString("hex")}`;
  const packageRoot = path.join(stagingRoot, "package");
  const payloadRoot = path.join(packageRoot, "payload");
  await fs.mkdir(payloadRoot, { recursive: true });

  try {
    const operationsByPath = new Map(
      verified.journal.operations.map((operation) => [windowsPathKey(operation.path), operation]),
    );
    const rollbackFiles = [];
    const rollbackDelete = [];

    for (const entry of manifest.files) {
      if (entry.expectedPreviousSha256 === null) {
        rollbackDelete.push({
          path: entry.path,
          expectedSha256: entry.sha256,
          reason: "Beim Rückfall wird die durch das Update hinzugefügte Datei entfernt.",
        });
        continue;
      }

      const changed = entry.expectedPreviousSha256 !== entry.sha256;
      let sizeBytes = entry.sizeBytes;
      if (changed) {
        const operation = operationsByPath.get(windowsPathKey(entry.path));
        if (!operation?.existed || operation.previousSha256 !== entry.expectedPreviousSha256) {
          fail("SOURCE_UPDATE_ROLLBACK_BACKUP_MISSING", entry.path);
        }
        const backup = path.join(verified.transactionRoot, operation.backupPath);
        const backupState = await fs.lstat(backup);
        sizeBytes = backupState.size;
        await copyRollbackPayloadObject({
          source: backup,
          payloadRoot,
          sha256: entry.expectedPreviousSha256,
          sizeBytes,
        });
      }
      rollbackFiles.push({
        path: entry.path,
        sizeBytes,
        sha256: entry.expectedPreviousSha256,
        expectedPreviousSha256: entry.sha256,
      });
    }

    const declaredDeletes = new Map(
      manifest.delete.map((entry) => [windowsPathKey(entry.path), entry]),
    );
    // The apply plan also deletes previously managed files that are omitted by
    // the new complete component inventory. Those implicit deletions are just
    // as rollback-relevant as explicit manifest.delete entries, so derive the
    // reverse restore set from the verified journal rather than from the
    // manifest's explicit delete list alone.
    for (const operation of verified.journal.operations) {
      if (operation.action !== "delete") continue;
      const declaredDelete = declaredDeletes.get(windowsPathKey(operation.path));
      if (
        !operation.existed
        || typeof operation.previousSha256 !== "string"
        || (declaredDelete && operation.previousSha256 !== declaredDelete.expectedSha256)
      ) {
        fail("SOURCE_UPDATE_ROLLBACK_BACKUP_MISSING", operation.path);
      }
      const backup = path.join(verified.transactionRoot, operation.backupPath);
      const backupState = await fs.lstat(backup);
      await copyRollbackPayloadObject({
        source: backup,
        payloadRoot,
        sha256: operation.previousSha256,
        sizeBytes: backupState.size,
      });
      rollbackFiles.push({
        path: operation.path,
        sizeBytes: backupState.size,
        sha256: operation.previousSha256,
        expectedPreviousSha256: null,
      });
    }

    rollbackFiles.sort((left, right) => bytewiseCompare(left.path, right.path));
    rollbackDelete.sort((left, right) => bytewiseCompare(left.path, right.path));
    const rollbackManifest = {
      schemaVersion: SOURCE_UPDATE_SCHEMA,
      status: UPDATE_STATUS,
      updateId: rollbackUpdateId,
      channel: UPDATE_CHANNEL,
      payloadLayout: SOURCE_UPDATE_PAYLOAD_LAYOUT,
      requires: {
        updateId: verified.updateId,
        manifestSha256: verified.manifestSha256,
      },
      releaseNotes: {
        title: "Zur vorherigen Bonni-Core-Version zurückkehren",
        summary: `Der gesicherte Programmstand ${manifest.from.coreVersion} wird wiederhergestellt. Die gemeinsame Datenbank und Nutzdaten bleiben unverändert.`,
        changes: [{
          type: "information",
          title: `Bonni Core ${manifest.from.coreVersion} wiederherstellen`,
          detail: "Ausschließlich die während des Updates verwalteten Programmdateien werden auf den geprüften Vorgängerstand zurückgesetzt.",
        }],
      },
      from: manifest.to,
      to: manifest.from,
      components: manifest.components.map(({ key, path: componentPath, mode }) => ({
        key,
        path: componentPath,
        mode,
      })),
      files: rollbackFiles,
      delete: rollbackDelete,
    };
    validateManifest(rollbackManifest);
    const manifestPath = path.join(packageRoot, MANIFEST_NAME);
    await fs.writeFile(manifestPath, `${JSON.stringify(rollbackManifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await syncRegularFile(manifestPath);
    const rollbackManifestSha256 = await sha256File(manifestPath);
    await writeJsonAtomic(path.join(stagingRoot, "previous-active-manifest.json"), previousActive);
    await writeJsonAtomic(path.join(stagingRoot, "hold.json"), {
      schemaVersion: LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA,
      holdId,
      generation,
      rollbackUpdateId,
      rollbackManifestSha256,
    });
    await fs.rename(stagingRoot, holdRoot);
    await syncDirectory(path.dirname(holdRoot));

    const holdUntil = new Date(Date.parse(activatedAt) + LOCAL_DEPLOYMENT_HOLD_MS).toISOString();
    return {
      schemaVersion: LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA,
      protocol: "bonni-deployment-lifecycle/1",
      mode: "local-source",
      status: "holding",
      state: "holding",
      generation,
      holdId,
      holdDays: LOCAL_DEPLOYMENT_HOLD_DAYS,
      activatedAt,
      holdUntil,
      previousVersion: manifest.from.coreVersion,
      targetVersion: manifest.to.coreVersion,
      activeVersion: manifest.to.coreVersion,
      sourceUpdateId: verified.updateId,
      sourceManifestSha256: verified.manifestSha256,
      rollbackUpdateId,
      rollbackManifestSha256,
      holdPath: holdRelativeRoot,
      blocksUpdates: true,
      followUpdatesBlocked: true,
      canFinalize: true,
      canRollback: true,
      blockReason: `Bonni Core ${manifest.to.coreVersion} wird noch ${LOCAL_DEPLOYMENT_HOLD_DAYS} Tage durch den Anwender geprüft.`,
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function isLocalSourceDeploymentRollback({ productRoot, transaction }) {
  const lifecycle = await readLocalDeploymentLifecycle(path.resolve(productRoot)).catch(() => null);
  return Boolean(
    lifecycle
    && lifecycle.schemaVersion === LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA
    && lifecycle.status === "rolling-back"
    && transaction?.updateId === lifecycle.rollbackUpdateId
    && transaction?.manifestSha256 === lifecycle.rollbackManifestSha256,
  );
}

async function isCompletedLocalSourceDeploymentRollback({ productRoot, transaction }) {
  const lifecycle = await readLocalDeploymentLifecycle(path.resolve(productRoot)).catch(() => null);
  return Boolean(
    lifecycle
    && lifecycle.schemaVersion === LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA
    && ["rolling-back", "rolled-back"].includes(lifecycle.status)
    && transaction?.updateId === lifecycle.rollbackUpdateId
    && transaction?.manifestSha256 === lifecycle.rollbackManifestSha256,
  );
}

async function completeLocalSourceDeploymentRollback({ productRoot, verified, completedAt }) {
  const lifecycle = await readLocalDeploymentLifecycle(productRoot).catch(() => null);
  if (
    !lifecycle
    || lifecycle.schemaVersion !== LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA
    || lifecycle.status !== "rolling-back"
    || verified.updateId !== lifecycle.rollbackUpdateId
    || verified.manifestSha256 !== lifecycle.rollbackManifestSha256
  ) return null;

  const previousActive = await readStateJson(
    productRoot,
    `${lifecycle.holdPath}/previous-active-manifest.json`,
    "SOURCE_UPDATE_ROLLBACK_PREVIOUS_ACTIVE_INVALID",
  );
  normalizeActiveState(previousActive);
  await writeStateJson(productRoot, "active-manifest.json", previousActive);
  const completedLifecycle = {
    ...lifecycle,
    status: "rolled-back",
    state: "rolled-back",
    generation: lifecycle.generation + 1,
    activeVersion: lifecycle.previousVersion,
    rolledBackAt: completedAt,
    blocksUpdates: false,
    followUpdatesBlocked: false,
    canFinalize: false,
    canRollback: false,
    blockReason: null,
  };
  await writeStateJson(productRoot, localDeploymentLifecyclePath(), completedLifecycle);
  await removeInternalDirectory(
    productRoot,
    `SYSTEM/.bonni-source-update/${lifecycle.holdPath}`,
    "SYSTEM/.bonni-source-update/deployment-holds",
  );
  return previousActive;
}

function manifestRequestsLocalDeploymentHold(manifest) {
  // Jeder echte Bonni-Core-Versionswechsel erhält denselben 14-Tage-
  // Rückfallvertrag. Das gilt auch für veröffentlichte Versionen wie 0.1.20,
  // deren Versionsname keine lokale +a/+b-Buildrevision enthält.
  return manifest.from.coreVersion !== manifest.to.coreVersion;
}

export async function finalizeLocalSourceUpdate({
  productRoot,
  transaction,
  preserveCompletedPackage = false,
}) {
  const resolvedProductRoot = path.resolve(productRoot);
  const pending = await readPending(resolvedProductRoot);
  if (!pending || pending.updateId !== transaction?.updateId) fail("SOURCE_UPDATE_PENDING_STATE_MISMATCH");
  const verified = await verifyPending(resolvedProductRoot, pending);

  if (verified.committed) {
    await cleanupCompletedUpdateRoot({
      productRoot: resolvedProductRoot,
      packagePath: pending.packagePath,
      transactionPath: pending.transactionPath,
      cleanupCandidates: verified.cleanupCandidates,
    });
    await removeStateFile(resolvedProductRoot, "pending-update.json");
    console.info(`[bonni-update] Update ${verified.updateId} wurde vollständig übernommen.`);
    return verified.active;
  }

  const installedBackendPackage = await readJson(
    path.join(resolvedProductRoot, "SYSTEM", "backend", "package.json"),
    "SOURCE_UPDATE_BACKEND_PACKAGE_INVALID",
  );
  if (installedBackendPackage?.version !== verified.manifest.to.coreVersion) {
    fail(
      "SOURCE_UPDATE_CORE_TARGET_VERSION_MISMATCH",
      `${installedBackendPackage?.version || "missing"}:${verified.manifest.to.coreVersion}`,
    );
  }
  const installedKontorPackage = await readJson(
    path.join(resolvedProductRoot, "SYSTEM", "app", "kontorapp", "package.json"),
    "SOURCE_UPDATE_KONTOR_PACKAGE_INVALID",
  );
  const updatesKontor = verified.manifest.components.some(
    (component) => component.path === "SYSTEM/app/kontorapp",
  );
  if (updatesKontor || installedKontorPackage) {
    if (installedKontorPackage?.version !== verified.manifest.to.kontorAppVersion) {
      fail(
        "SOURCE_UPDATE_KONTOR_TARGET_VERSION_MISMATCH",
        `${installedKontorPackage?.version || "missing"}:${verified.manifest.to.kontorAppVersion}`,
      );
    }
  }

  for (const entry of verified.manifest.files) {
    const target = await assertSafeExistingTarget(resolvedProductRoot, entry.path);
    const state = await existingRegularFile(target, entry.path);
    if (!state || state.size !== entry.sizeBytes || await sha256File(target) !== entry.sha256) {
      fail("SOURCE_UPDATE_INSTALLED_FILE_CHANGED", entry.path);
    }
  }
  for (const entry of verified.manifest.delete) {
    const target = await assertSafeExistingTarget(resolvedProductRoot, entry.path);
    const state = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (state) fail("SOURCE_UPDATE_DELETED_FILE_REAPPEARED", entry.path);
  }

  const completedAt = new Date().toISOString();
  const previousActiveState = await readStateJson(
    resolvedProductRoot,
    "active-manifest.json",
    "SOURCE_UPDATE_ACTIVE_STATE_INVALID",
  );
  const previousActive = normalizeActiveState(previousActiveState);
  const currentComponentPaths = new Set(
    verified.manifest.components.map((component) => windowsPathKey(component.path)),
  );
  const preservedComponents = previousActive.components.filter(
    (component) => !currentComponentPaths.has(windowsPathKey(component.path)),
  );
  const preservedFiles = previousActive.files.filter((entry) => (
    !verified.manifest.components.some((component) => pathInside(entry.path, component.path))
  ));
  // A generated rollback package must remain readable by the updater restored
  // with the previous code version. Therefore its active/history receipt uses
  // the previous schema and does not introduce the new lifecycle marker.
  const rollbackTransaction = await isLocalSourceDeploymentRollback({
    productRoot: resolvedProductRoot,
    transaction: verified,
  });
  const active = {
    schemaVersion: SOURCE_UPDATE_SCHEMA,
    updateId: verified.updateId,
    manifestSha256: verified.manifestSha256,
    completedAt,
    versions: verified.manifest.to,
    ...(!rollbackTransaction && manifestRequestsLocalDeploymentHold(verified.manifest) ? {
      localDeploymentLifecycle: {
        schemaVersion: LOCAL_DEPLOYMENT_LIFECYCLE_SCHEMA,
        mode: "local-source",
        required: true,
      },
    } : {}),
    components: [...preservedComponents, ...verified.manifest.components]
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
    files: [
      ...preservedFiles,
      ...verified.manifest.files.map(({ path: filePath, sizeBytes, sha256 }) => ({
        path: filePath,
        sizeBytes,
        sha256,
      })),
    ].sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  let preparedLifecycle = null;
  if (!rollbackTransaction && manifestRequestsLocalDeploymentHold(verified.manifest)) {
    preparedLifecycle = await prepareLocalSourceRollbackHold({
      productRoot: resolvedProductRoot,
      verified,
      previousActive: previousActiveState,
      activatedAt: completedAt,
    });
  }

  await writeStateJson(resolvedProductRoot, "active-manifest.json", active);
  await writeStateJson(resolvedProductRoot, `history/${verified.updateId}.json`, {
    ...active,
    ...(verified.manifest.releaseNotes ? { releaseNotes: verified.manifest.releaseNotes } : {}),
    updateMetadata: completedUpdateMetadataFromManifest(verified.manifest),
    status: "COMPLETED",
  });
  verified.journal.status = "committed";
  verified.journal.committedAt = completedAt;
  await writeJsonAtomic(path.join(verified.transactionRoot, "journal.json"), verified.journal);
  const committedPending = {
    ...pending,
    phase: "committed",
    committedAt: completedAt,
    cleanupCandidates: verified.cleanupCandidates,
  };
  await writeStateJson(resolvedProductRoot, "pending-update.json", committedPending);
  if (preparedLifecycle) {
    await writeStateJson(resolvedProductRoot, localDeploymentLifecyclePath(), preparedLifecycle);
  }
  const restoredActive = rollbackTransaction
    ? await completeLocalSourceDeploymentRollback({
        productRoot: resolvedProductRoot,
        verified,
        completedAt,
      })
    : null;
  if (!preserveCompletedPackage) {
    await cleanupCompletedUpdateRoot({
      productRoot: resolvedProductRoot,
      packagePath: pending.packagePath,
      transactionPath: pending.transactionPath,
      cleanupCandidates: verified.cleanupCandidates,
    });
  } else {
    await removeInternalDirectory(resolvedProductRoot, pending.transactionPath, "UPDATE/.bonni-work");
  }
  await removeStateFile(resolvedProductRoot, "pending-update.json");
  console.info(`[bonni-update] Update ${verified.updateId} wurde vollständig übernommen.`);
  return restoredActive || active;
}

export async function assertNoPendingLocalSourceUpdate({ productRoot }) {
  const resolvedProductRoot = path.resolve(productRoot);
  const pending = await readPending(resolvedProductRoot);
  if (pending) {
    fail("SOURCE_UPDATE_SETUP_PENDING_USE_NPM_RUN_UPDATE", pending.updateId);
  }
  const workRoot = path.join(resolvedProductRoot, "UPDATE", ".bonni-work");
  const workEntries = await fs.readdir(workRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (workEntries.some((entry) => entry.isDirectory() || entry.isSymbolicLink())) {
    fail("SOURCE_UPDATE_INCOMPLETE_TRANSACTION_USE_NPM_RUN_UPDATE");
  }
  try {
    const staged = await findPackage(path.join(resolvedProductRoot, "UPDATE"));
    fail("SOURCE_UPDATE_PACKAGE_WAITING_USE_NPM_RUN_UPDATE", path.basename(staged.packageRoot));
  } catch (error) {
    if (String(error?.message || "").startsWith("SOURCE_UPDATE_PACKAGE_NOT_FOUND:")) return;
    throw error;
  }
}

export async function assertPendingLocalSourceUpdate({ productRoot, updateId, handoffToken }) {
  const resolvedProductRoot = path.resolve(productRoot);
  const pending = await readPending(resolvedProductRoot);
  if (
    !pending
    || pending.phase !== "applied"
    || pending.updateId !== updateId
    || pending.handoffToken !== handoffToken
  ) {
    fail("SOURCE_UPDATE_SETUP_HANDOFF_INVALID");
  }
  return verifyPending(resolvedProductRoot, pending);
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireLocalSourceUpdateLock({ productRoot }) {
  const lockFile = await stateFileTarget(productRoot, "update-command.lock");
  const ownerToken = randomBytes(32).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt: new Date().toISOString(),
      })}\n`);
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const currentLockFile = await stateFileTarget(productRoot, "update-command.lock");
        const currentOwner = await readJson(currentLockFile, "SOURCE_UPDATE_LOCK_INVALID");
        if (currentOwner?.ownerToken !== ownerToken || currentOwner?.pid !== process.pid) {
          fail("SOURCE_UPDATE_LOCK_OWNERSHIP_LOST");
        }
        await fs.rm(currentLockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = await readJson(lockFile, "SOURCE_UPDATE_LOCK_INVALID").catch(() => null);
      const lockState = await fs.lstat(lockFile).catch(() => null);
      const createdAt = Date.parse(lock?.createdAt || "");
      const age = Date.now() - (Number.isFinite(createdAt) ? createdAt : lockState?.mtimeMs || Date.now());
      const ownerIsDead = lock && !processExists(lock.pid);
      const malformedAndStale = !lock && age > 30 * 60 * 1000;
      if (attempt === 0 && (ownerIsDead || malformedAndStale)) {
        await fs.rm(lockFile, { force: true });
        continue;
      }
      fail("SOURCE_UPDATE_ALREADY_RUNNING");
    }
  }
  fail("SOURCE_UPDATE_ALREADY_RUNNING");
}
