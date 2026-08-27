import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SOURCE_UPDATE_PAYLOAD_LAYOUT,
  SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT,
  SOURCE_UPDATE_SCHEMA,
  sourceUpdatePayloadObjectName,
} from "./local-source-update.mjs";

const MANIFEST_NAME = "bonni-source-update.json";
const UPDATE_STATUS = "UNPUBLISHED_TEST_UPDATE";
const UPDATE_CHANNEL = "development";
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const DATABASE_FILE = /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/iu;
const SECRET_FILE = /\.(?:key|pem|p12|pfx|jwk|secret|secrets)$/iu;

const COMPONENTS = Object.freeze([
  Object.freeze({ key: "bonni-core-backend", path: "SYSTEM/backend", mode: "managed" }),
  Object.freeze({ key: "bonni-core-frontend", path: "SYSTEM/frontend", mode: "managed" }),
  Object.freeze({ key: "app.kontorapp", path: "SYSTEM/app/kontorapp", mode: "managed" }),
]);
const ESSENTIAL_FILES = [
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
  "SYSTEM/frontend/package-lock.json",
  "SYSTEM/frontend/package.json",
  "SYSTEM/app/kontorapp/backend/package-lock.json",
  "SYSTEM/app/kontorapp/backend/package.json",
  "SYSTEM/app/kontorapp/frontend/package-lock.json",
  "SYSTEM/app/kontorapp/frontend/package.json",
  "SYSTEM/app/kontorapp/package-lock.json",
  "SYSTEM/app/kontorapp/package.json",
  "SYSTEM/app/kontorapp/manifest.ts",
];

const GENERATED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "cache",
  "caches",
  ".cache",
  ".eslintcache",
  ".stylelintcache",
  ".vite",
  ".turbo",
  ".parcel-cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".git",
  ".bonni-source-update",
]);

const PROTECTED_ROOTS = [
  "system/backend/archives",
  "system/backend/backups",
  "system/backend/data",
  "system/backend/docs",
  "system/backend/logs",
  "system/backend/run_system",
  "system/backend/storage",
  "system/backend/uploads",
  "system/backend/updates",
  "system/backend/public/system",
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
];

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function windowsPathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isInsideOrEqual(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isPathInside(relativePath, rootPath) {
  return relativePath === rootPath || relativePath.startsWith(`${rootPath}/`);
}

function assertVersion(value, label) {
  if (typeof value !== "string" || !VERSION.test(value)) {
    fail("LOCAL_SOURCE_UPDATE_INVALID_VERSION", label);
  }
  return value;
}

function releaseNotesText(value, label, minimum, maximum) {
  if (typeof value !== "string") fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", label);
  const normalized = value.trim();
  const length = [...normalized].length;
  if (
    length < minimum
    || length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", label);
  }
  return normalized;
}

function normalizeReleaseNotes(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID");
  }
  if (Object.keys(value).some((key) => !["title", "summary", "changes"].includes(key))) {
    fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", "unknown-field");
  }
  if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > 12) {
    fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", "changes");
  }
  return {
    title: releaseNotesText(value.title, "title", 3, 100),
    summary: releaseNotesText(value.summary, "summary", 3, 480),
    changes: value.changes.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", `changes.${index}`);
      }
      if (Object.keys(entry).some((key) => !["type", "title", "detail"].includes(key))) {
        fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", `changes.${index}.unknown-field`);
      }
      if (!["security", "fix", "improvement", "information"].includes(entry.type)) {
        fail("LOCAL_SOURCE_UPDATE_RELEASE_NOTES_INVALID", `changes.${index}.type`);
      }
      return {
        type: entry.type,
        title: releaseNotesText(entry.title, `changes.${index}.title`, 3, 100),
        detail: releaseNotesText(entry.detail, `changes.${index}.detail`, 3, 320),
      };
    }),
  };
}

function assertUpdateId(value) {
  if (typeof value !== "string" || !UPDATE_ID.test(value)) {
    fail("LOCAL_SOURCE_UPDATE_INVALID_ID", String(value || ""));
  }
  assertManifestPath(value);
  return value;
}

function assertManifestPath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 512
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes(":")
    || /[<>"|?*]/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("LOCAL_SOURCE_UPDATE_UNSAFE_PATH", String(value));
  }
  const segments = value.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) {
    fail("LOCAL_SOURCE_UPDATE_UNSAFE_PATH", value);
  }
  return value;
}

function containsSequence(segments, sequence) {
  for (let index = 0; index <= segments.length - sequence.length; index += 1) {
    if (sequence.every((segment, offset) => segments[index + offset] === segment)) return true;
  }
  return false;
}

function isExcludedSourcePath(relativePath) {
  const lower = windowsPathKey(relativePath);
  const segments = lower.split("/");
  const basename = segments.at(-1) || "";

  if (basename.startsWith(".env") && basename !== ".env.example") return true;
  if (DATABASE_FILE.test(basename) || SECRET_FILE.test(basename)) return true;
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "secrets.json", "secret.json"].includes(basename)) {
    return true;
  }
  if (segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) return true;
  if (containsSequence(segments, ["prisma", "domains", "assembled"])) return true;
  return PROTECTED_ROOTS.some((protectedRoot) => isPathInside(lower, protectedRoot));
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
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertRealDirectory(directory, code) {
  const state = await lstatOrNull(directory);
  if (!state?.isDirectory() || state.isSymbolicLink()) fail(code, directory);
  return state;
}

async function assertSafeDirectoryPath(directory, { create = false } = {}) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  let missing = false;

  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const state = missing ? null : await lstatOrNull(cursor);
    if (!state) {
      missing = true;
      if (create) await fs.mkdir(cursor);
      continue;
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      fail("LOCAL_SOURCE_UPDATE_UNSAFE_OUTPUT_DIRECTORY", cursor);
    }
  }
  return resolved;
}

async function assertSafeComponentRoot(productRoot, componentPath) {
  let cursor = productRoot;
  for (const segment of componentPath.split("/")) {
    cursor = path.join(cursor, segment);
    await assertRealDirectory(cursor, "LOCAL_SOURCE_UPDATE_COMPONENT_MISSING_OR_UNSAFE");
  }
  return cursor;
}

async function readRegularSourceFile(file, label) {
  const state = await lstatOrNull(file);
  if (!state?.isFile() || state.isSymbolicLink()) {
    fail("LOCAL_SOURCE_UPDATE_SOURCE_FILE_MISSING_OR_UNSAFE", label);
  }
  if (state.nlink > 1) fail("LOCAL_SOURCE_UPDATE_HARDLINK_REJECTED", label);
  return fs.readFile(file, "utf8");
}

async function readTargetVersions(productRoot) {
  const backendPackagePath = path.join(productRoot, "SYSTEM", "backend", "package.json");
  const packageSource = await readRegularSourceFile(backendPackagePath, "SYSTEM/backend/package.json");
  let backendPackage;
  try {
    backendPackage = JSON.parse(packageSource);
  } catch {
    fail("LOCAL_SOURCE_UPDATE_BACKEND_PACKAGE_INVALID");
  }
  const coreVersion = assertVersion(backendPackage?.version, "SYSTEM/backend/package.json#version");

  const kontorManifestPath = path.join(productRoot, "SYSTEM", "app", "kontorapp", "manifest.ts");
  const kontorManifest = await readRegularSourceFile(
    kontorManifestPath,
    "SYSTEM/app/kontorapp/manifest.ts",
  );
  const manifestStart = kontorManifest.search(/\bconst\s+manifest\s*=\s*\{/u);
  if (manifestStart < 0) fail("LOCAL_SOURCE_UPDATE_KONTOR_MANIFEST_INVALID", "manifest-object");
  const manifestSource = kontorManifest.slice(manifestStart);
  if (!/\bkey\s*:\s*["']app\.kontorapp["']/u.test(manifestSource)) {
    fail("LOCAL_SOURCE_UPDATE_KONTOR_MANIFEST_INVALID", "key");
  }
  const kontorVersion = manifestSource.match(/\bversion\s*:\s*["']([^"']+)["']/u)?.[1];
  const validatedKontorVersion = assertVersion(
    kontorVersion,
    "SYSTEM/app/kontorapp/manifest.ts#version",
  );
  const kontorPackageSource = await readRegularSourceFile(
    path.join(productRoot, "SYSTEM", "app", "kontorapp", "package.json"),
    "SYSTEM/app/kontorapp/package.json",
  );
  let kontorPackage;
  try {
    kontorPackage = JSON.parse(kontorPackageSource);
  } catch {
    fail("LOCAL_SOURCE_UPDATE_KONTOR_PACKAGE_INVALID");
  }
  if (kontorPackage?.version !== validatedKontorVersion) {
    fail(
      "LOCAL_SOURCE_UPDATE_KONTOR_VERSION_INCONSISTENT",
      `${String(kontorPackage?.version || "missing")}:${validatedKontorVersion}`,
    );
  }
  return {
    coreVersion,
    kontorAppVersion: validatedKontorVersion,
  };
}

async function collectSourceFiles(productRoot) {
  const collected = [];
  const usedPaths = new Map();
  let totalBytes = 0;

  async function walk(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));

    for (const entry of entries) {
      const relativePath = assertManifestPath(`${relativeDirectory}/${entry.name}`);
      const absolutePath = path.join(directory, entry.name);
      const state = await fs.lstat(absolutePath);
      if (state.isSymbolicLink()) fail("LOCAL_SOURCE_UPDATE_SYMLINK_REJECTED", relativePath);
      if (isExcludedSourcePath(relativePath)) continue;

      if (state.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!state.isFile()) fail("LOCAL_SOURCE_UPDATE_SPECIAL_FILE_REJECTED", relativePath);
      if (state.nlink > 1) fail("LOCAL_SOURCE_UPDATE_HARDLINK_REJECTED", relativePath);
      if (state.size > MAX_FILE_BYTES) fail("LOCAL_SOURCE_UPDATE_FILE_TOO_LARGE", relativePath);

      const pathKey = windowsPathKey(relativePath);
      if (usedPaths.has(pathKey)) {
        fail("LOCAL_SOURCE_UPDATE_PATH_COLLISION", `${usedPaths.get(pathKey)}:${relativePath}`);
      }
      usedPaths.set(pathKey, relativePath);
      totalBytes += state.size;
      if (collected.length + 1 > MAX_FILES) fail("LOCAL_SOURCE_UPDATE_TOO_MANY_FILES");
      if (totalBytes > MAX_TOTAL_BYTES) fail("LOCAL_SOURCE_UPDATE_PACKAGE_TOO_LARGE");
      collected.push({
        absolutePath,
        path: relativePath,
        sizeBytes: state.size,
        sha256: await sha256File(absolutePath),
      });
    }
  }

  for (const component of COMPONENTS) {
    const componentRoot = await assertSafeComponentRoot(productRoot, component.path);
    await walk(componentRoot, component.path);
  }
  collected.sort((left, right) => bytewiseCompare(left.path, right.path));
  return collected;
}

function assertOutputLocation(sourceProduct, outputRoot) {
  if (!isInsideOrEqual(outputRoot, sourceProduct)) return;
  const allowedRoot = path.join(sourceProduct, "UPDATE", ".package-build");
  if (!isInsideOrEqual(outputRoot, allowedRoot)) {
    fail("LOCAL_SOURCE_UPDATE_OUTPUT_INSIDE_SOURCE", outputRoot);
  }
}

async function copyVerifiedFile(entry, payloadRoot, payloadObject) {
  const destination = path.join(payloadRoot, payloadObject);
  await fs.copyFile(entry.absolutePath, destination, constants.COPYFILE_EXCL);

  const outputState = await fs.lstat(destination);
  if (
    !outputState.isFile()
    || outputState.isSymbolicLink()
    || outputState.nlink > 1
    || outputState.size !== entry.sizeBytes
    || await sha256File(destination) !== entry.sha256
  ) {
    fail("LOCAL_SOURCE_UPDATE_OUTPUT_VERIFICATION_FAILED", entry.path);
  }

  await verifyCollectedFile(entry, "LOCAL_SOURCE_UPDATE_SOURCE_CHANGED_DURING_BUILD");
}

async function verifyCollectedFile(entry, errorCode) {
  const sourceState = await fs.lstat(entry.absolutePath);
  if (
    !sourceState.isFile()
    || sourceState.isSymbolicLink()
    || sourceState.nlink > 1
    || sourceState.size !== entry.sizeBytes
    || await sha256File(entry.absolutePath) !== entry.sha256
  ) {
    fail(errorCode, entry.path);
  }
}

export async function createLocalSourceUpdate({
  sourceProduct,
  baselineProduct,
  output,
  updateId,
  fromCoreVersion,
  fromKontorAppVersion,
  requiresUpdateId = null,
  requiresManifestSha256 = null,
  releaseNotes = null,
  payloadMode = "delta",
}) {
  if (typeof sourceProduct !== "string" || !sourceProduct.trim()) {
    fail("LOCAL_SOURCE_UPDATE_ARGUMENT_REQUIRED", "sourceProduct");
  }
  if (typeof baselineProduct !== "string" || !baselineProduct.trim()) {
    fail("LOCAL_SOURCE_UPDATE_ARGUMENT_REQUIRED", "baselineProduct");
  }
  if (typeof output !== "string" || !output.trim()) {
    fail("LOCAL_SOURCE_UPDATE_ARGUMENT_REQUIRED", "output");
  }
  const resolvedSourceProduct = path.resolve(sourceProduct);
  const resolvedBaselineProduct = path.resolve(baselineProduct);
  const resolvedOutput = path.resolve(output);
  const safeUpdateId = assertUpdateId(updateId);
  if (!["delta", "repair"].includes(payloadMode)) {
    fail("LOCAL_SOURCE_UPDATE_PAYLOAD_MODE_INVALID", String(payloadMode));
  }
  const repairMode = payloadMode === "repair";
  const from = {
    coreVersion: assertVersion(fromCoreVersion, "from.coreVersion"),
    kontorAppVersion: assertVersion(fromKontorAppVersion, "from.kontorAppVersion"),
  };
  if (Boolean(requiresUpdateId) !== Boolean(requiresManifestSha256)) {
    fail("LOCAL_SOURCE_UPDATE_REQUIRED_PREDECESSOR_INCOMPLETE");
  }
  const requires = requiresUpdateId
    ? {
      updateId: assertUpdateId(requiresUpdateId),
      manifestSha256: /^[a-f0-9]{64}$/u.test(String(requiresManifestSha256 || ""))
        ? requiresManifestSha256
        : fail("LOCAL_SOURCE_UPDATE_REQUIRED_PREDECESSOR_HASH_INVALID"),
    }
    : null;
  const normalizedReleaseNotes = normalizeReleaseNotes(releaseNotes);

  await assertRealDirectory(resolvedSourceProduct, "LOCAL_SOURCE_UPDATE_PRODUCT_ROOT_INVALID");
  await assertRealDirectory(resolvedBaselineProduct, "LOCAL_SOURCE_UPDATE_BASELINE_ROOT_INVALID");
  assertOutputLocation(resolvedSourceProduct, resolvedOutput);
  assertOutputLocation(resolvedBaselineProduct, resolvedOutput);
  const to = await readTargetVersions(resolvedSourceProduct);
  const baselineVersions = await readTargetVersions(resolvedBaselineProduct);
  if (
    baselineVersions.coreVersion !== from.coreVersion
    || baselineVersions.kontorAppVersion !== from.kontorAppVersion
  ) {
    fail(
      "LOCAL_SOURCE_UPDATE_BASELINE_VERSION_MISMATCH",
      `${baselineVersions.coreVersion}/${baselineVersions.kontorAppVersion}`,
    );
  }
  const allSourceFiles = await collectSourceFiles(resolvedSourceProduct);
  const allBaselineFiles = await collectSourceFiles(resolvedBaselineProduct);
  const allSourceByPath = new Map(
    allSourceFiles.map((entry) => [windowsPathKey(entry.path), entry]),
  );
  const allBaselineByPath = new Map(
    allBaselineFiles.map((entry) => [windowsPathKey(entry.path), entry]),
  );
  const components = COMPONENTS.filter((component) => {
    if (component.path === "SYSTEM/backend" && from.coreVersion !== to.coreVersion) return true;
    if (component.path === "SYSTEM/app/kontorapp" && from.kontorAppVersion !== to.kontorAppVersion) return true;
    const paths = new Set([
      ...allSourceFiles.filter((entry) => isPathInside(entry.path, component.path)).map((entry) => windowsPathKey(entry.path)),
      ...allBaselineFiles.filter((entry) => isPathInside(entry.path, component.path)).map((entry) => windowsPathKey(entry.path)),
    ]);
    return [...paths].some((filePath) => {
      const sourceEntry = allSourceByPath.get(filePath);
      const baselineEntry = allBaselineByPath.get(filePath);
      return !sourceEntry || !baselineEntry || sourceEntry.sha256 !== baselineEntry.sha256;
    });
  });
  if (!components.length) fail("LOCAL_SOURCE_UPDATE_NO_COMPONENT_CHANGES");
  const sourceFiles = allSourceFiles.filter((entry) => (
    components.some((component) => isPathInside(entry.path, component.path))
  ));
  const baselineFiles = allBaselineFiles.filter((entry) => (
    components.some((component) => isPathInside(entry.path, component.path))
  ));
  const baselineByPath = new Map(
    baselineFiles.map((entry) => [windowsPathKey(entry.path), entry]),
  );
  const sourcePaths = new Set(sourceFiles.map((entry) => windowsPathKey(entry.path)));
  for (const essentialPath of ESSENTIAL_FILES.filter((filePath) => (
    components.some((component) => isPathInside(filePath, component.path))
  ))) {
    if (!sourcePaths.has(windowsPathKey(essentialPath))) {
      fail("LOCAL_SOURCE_UPDATE_ESSENTIAL_FILE_MISSING", essentialPath);
    }
  }
  const payloadFiles = new Map();
  const files = sourceFiles.map(({ path: filePath, sizeBytes, sha256, absolutePath }) => {
    const baselineEntry = baselineByPath.get(windowsPathKey(filePath));
    if (baselineEntry && baselineEntry.path !== filePath) {
      fail("LOCAL_SOURCE_UPDATE_BASELINE_PATH_CASE_CONFLICT", `${baselineEntry.path}:${filePath}`);
    }
    if (repairMode || !baselineEntry || baselineEntry.sha256 !== sha256) {
      const payloadObject = sourceUpdatePayloadObjectName(sha256);
      const existing = payloadFiles.get(payloadObject);
      if (existing && existing.sizeBytes !== sizeBytes) {
        fail("LOCAL_SOURCE_UPDATE_PAYLOAD_HASH_COLLISION", filePath);
      }
      if (!existing) {
        payloadFiles.set(payloadObject, {
          absolutePath,
          path: filePath,
          sizeBytes,
          sha256,
          payloadObject,
        });
      }
    }
    return {
      path: filePath,
      sizeBytes,
      sha256,
      expectedPreviousSha256: baselineEntry?.sha256 ?? null,
    };
  });
  const deletions = baselineFiles
    .filter((entry) => !sourcePaths.has(windowsPathKey(entry.path)))
    .map((entry) => ({
      path: entry.path,
      expectedSha256: entry.sha256,
      reason: "Im neuen verwalteten Quellstand nicht mehr enthalten.",
    }));
  const packageRoot = path.join(resolvedOutput, safeUpdateId);
  if (await lstatOrNull(packageRoot)) fail("LOCAL_SOURCE_UPDATE_TARGET_EXISTS", packageRoot);

  await assertSafeDirectoryPath(resolvedOutput, { create: true });
  let ownsPackageRoot = false;
  try {
    await fs.mkdir(packageRoot);
    ownsPackageRoot = true;
    const payloadRoot = path.join(packageRoot, "payload");
    await fs.mkdir(payloadRoot);
    for (const entry of payloadFiles.values()) {
      await copyVerifiedFile(entry, payloadRoot, entry.payloadObject);
    }
    for (const entry of sourceFiles) {
      await verifyCollectedFile(entry, "LOCAL_SOURCE_UPDATE_SOURCE_CHANGED_DURING_BUILD");
    }
    for (const entry of baselineFiles) {
      await verifyCollectedFile(entry, "LOCAL_SOURCE_UPDATE_BASELINE_CHANGED_DURING_BUILD");
    }

    const manifest = {
      schemaVersion: SOURCE_UPDATE_SCHEMA,
      status: UPDATE_STATUS,
      updateId: safeUpdateId,
      channel: UPDATE_CHANNEL,
      payloadLayout: repairMode
        ? SOURCE_UPDATE_REPAIR_PAYLOAD_LAYOUT
        : SOURCE_UPDATE_PAYLOAD_LAYOUT,
      requires,
      ...(normalizedReleaseNotes ? { releaseNotes: normalizedReleaseNotes } : {}),
      from,
      to,
      components: components.map((component) => ({ ...component })),
      files,
      delete: deletions,
    };
    const manifestPath = path.join(packageRoot, MANIFEST_NAME);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { packageRoot, manifestPath, manifest };
  } catch (error) {
    if (ownsPackageRoot) await fs.rm(packageRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseArguments(argumentsList) {
  const values = new Map();
  const allowed = new Set([
    "--source-product",
    "--baseline-product",
    "--output",
    "--update-id",
    "--from-core",
    "--from-kontor",
    "--requires-update-id",
    "--requires-manifest-sha256",
    "--release-notes-file",
    "--payload-mode",
  ]);
  const required = new Set([
    "--source-product",
    "--baseline-product",
    "--output",
    "--update-id",
    "--from-core",
    "--from-kontor",
  ]);
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.startsWith("--")) {
      fail("LOCAL_SOURCE_UPDATE_ARGUMENT_INVALID", String(flag || ""));
    }
    if (values.has(flag)) fail("LOCAL_SOURCE_UPDATE_ARGUMENT_DUPLICATE", flag);
    values.set(flag, value);
  }
  for (const flag of required) {
    if (!values.has(flag)) fail("LOCAL_SOURCE_UPDATE_ARGUMENT_REQUIRED", flag);
  }
  if (values.has("--requires-update-id") !== values.has("--requires-manifest-sha256")) {
    fail("LOCAL_SOURCE_UPDATE_REQUIRED_PREDECESSOR_INCOMPLETE");
  }
  return values;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const releaseNotes = values.has("--release-notes-file")
    ? JSON.parse(await fs.readFile(path.resolve(values.get("--release-notes-file")), "utf8"))
    : null;
  const result = await createLocalSourceUpdate({
    sourceProduct: values.get("--source-product"),
    baselineProduct: values.get("--baseline-product"),
    output: values.get("--output"),
    updateId: values.get("--update-id"),
    fromCoreVersion: values.get("--from-core"),
    fromKontorAppVersion: values.get("--from-kontor"),
    requiresUpdateId: values.get("--requires-update-id"),
    requiresManifestSha256: values.get("--requires-manifest-sha256"),
    releaseNotes,
    payloadMode: values.get("--payload-mode") || "delta",
  });
  console.info(`[bonni-package] Unveröffentlichtes Test-Update erstellt: ${result.packageRoot}`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error("[bonni-package] Erstellung fehlgeschlagen", error);
    process.exitCode = 1;
  });
}
