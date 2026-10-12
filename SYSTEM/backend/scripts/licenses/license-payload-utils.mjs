import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(value, label) {
  if (!value || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error(`CORE_LICENSE_PATH_INVALID:${label}`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`CORE_LICENSE_PATH_INVALID:${label}`);
  return normalized;
}

export function resolveCentralLicenseRoot({ projectSystemRoot, environment = process.env, explicitRoot } = {}) {
  const configured = String(explicitRoot || environment.BONNI_LICENSE_ROOT || "").trim();
  const configuredModuleRoot = String(environment.BONNI_MODULE_LICENSE_ROOT || "").trim();
  if (configuredModuleRoot) {
    const moduleRoot = path.resolve(configuredModuleRoot);
    if (path.basename(moduleRoot) !== "modules") throw new Error("CENTRAL_LICENSE_MODULE_ROOT_INVALID");
    const derivedCentralRoot = path.dirname(moduleRoot);
    if (configured && path.resolve(configured) !== derivedCentralRoot) {
      throw new Error("CENTRAL_LICENSE_STORAGE_ROOT_MISMATCH");
    }
    if (!configured) return derivedCentralRoot;
  }
  if (configured) return path.resolve(configured);
  if (!projectSystemRoot) throw new Error("CENTRAL_LICENSE_PROJECT_ROOT_REQUIRED");
  return path.join(path.resolve(projectSystemRoot), "licenses");
}

export async function assertAbsolutePathWithoutSymlinks(absolute, { allowMissingTail = true } = {}) {
  const resolved = path.resolve(absolute);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let missing = false;
  for (const part of parts) {
    current = path.join(current, part);
    if (missing) continue;
    const state = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) {
      if (!allowMissingTail) throw new Error(`CORE_LICENSE_PATH_MISSING:${current}`);
      missing = true;
      continue;
    }
    if (state.isSymbolicLink()) throw new Error(`CORE_LICENSE_SYMLINK_DENIED:${current}`);
  }
  return resolved;
}

export async function atomicJson(file, value, mode = 0o644) {
  const parent = path.dirname(file);
  // Check once before mkdir so a pre-existing parent symlink cannot be used to
  // create directories outside the central catalog, then check the materialized
  // path again before the atomic rename.
  await assertAbsolutePathWithoutSymlinks(parent);
  await fs.mkdir(parent, { recursive: true });
  await assertAbsolutePathWithoutSymlinks(parent, { allowMissingTail: false });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function exactObjectFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function validateCoreReceipt(receipt, version) {
  if (!exactObjectFields(receipt, [
    "schemaVersion",
    "product",
    "version",
    "projectLicense",
    "files",
    "treeSha256",
  ])) throw new Error("CORE_LICENSE_RECEIPT_SHAPE_INVALID");
  if (
    receipt.schemaVersion !== "bonni.platform-legal-receipt/v1"
    || receipt.product !== "bonni-core"
    || receipt.version !== version
    || typeof receipt.projectLicense !== "string"
    || !Array.isArray(receipt.files)
    || !SHA256.test(String(receipt.treeSha256 || ""))
  ) throw new Error("CORE_LICENSE_RECEIPT_INVALID");

  const seen = new Set();
  let previous = "";
  for (const entry of receipt.files) {
    if (!exactObjectFields(entry, ["path", "bytes", "sha256"])) {
      throw new Error("CORE_LICENSE_RECEIPT_ENTRY_SHAPE_INVALID");
    }
    const relative = safeRelativePath(entry.path, "receipt.files.path");
    if (relative === "RECEIPT.json" || seen.has(relative)) {
      throw new Error("CORE_LICENSE_RECEIPT_ENTRY_PATH_INVALID");
    }
    if (previous && previous.localeCompare(relative, "en") >= 0) {
      throw new Error("CORE_LICENSE_RECEIPT_ENTRY_ORDER_INVALID");
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(String(entry.sha256 || ""))) {
      throw new Error("CORE_LICENSE_RECEIPT_ENTRY_INVALID");
    }
    seen.add(relative);
    previous = relative;
  }
  const treeSha256 = sha256(
    receipt.files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n"),
  );
  if (treeSha256 !== receipt.treeSha256) throw new Error("CORE_LICENSE_RECEIPT_TREE_HASH_INVALID");
  return receipt;
}

async function collectExactTree(root) {
  const files = [];
  async function walk(relative) {
    const directory = relative ? path.join(root, ...relative.split("/")) : root;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (childRelative === "RECEIPT.json") continue;
      if (entry.isSymbolicLink()) throw new Error(`CORE_LICENSE_SYMLINK_DENIED:${childRelative}`);
      if (entry.isDirectory()) await walk(childRelative);
      else if (entry.isFile()) {
        const content = await fs.readFile(path.join(root, ...childRelative.split("/")));
        files.push({ path: childRelative, bytes: content.byteLength, sha256: sha256(content) });
      } else throw new Error(`CORE_LICENSE_FILE_TYPE_INVALID:${childRelative}`);
    }
  }
  await walk("");
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

export async function verifyCoreLicenseVersion(versionRoot, expectedVersion = path.basename(versionRoot)) {
  if (!SAFE_VERSION.test(expectedVersion)) throw new Error("CORE_LICENSE_VERSION_INVALID");
  await assertAbsolutePathWithoutSymlinks(versionRoot, { allowMissingTail: false });
  const rootState = await fs.lstat(versionRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error("CORE_LICENSE_ROOT_INVALID");
  const receiptFile = path.join(versionRoot, "RECEIPT.json");
  const receiptState = await fs.lstat(receiptFile);
  if (!receiptState.isFile() || receiptState.isSymbolicLink()) throw new Error("CORE_LICENSE_RECEIPT_INVALID");
  const receipt = validateCoreReceipt(JSON.parse(await fs.readFile(receiptFile, "utf8")), expectedVersion);
  const actual = await collectExactTree(versionRoot);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.files)) throw new Error("CORE_LICENSE_EXACT_TREE_MISMATCH");
  return receipt;
}

async function readCatalogReceipt(root, family, key, version) {
  const relative = `${family}/${key}/${version}/RECEIPT.json`;
  const receiptFile = path.join(root, ...relative.split("/"));
  const state = await fs.lstat(receiptFile);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error("LICENSE_RECEIPT_INVALID");
  const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  if (!SHA256.test(String(receipt.treeSha256 || ""))) throw new Error("LICENSE_RECEIPT_INVALID");
  if (family === "platform") {
    if (receipt.product !== key || receipt.version !== version) throw new Error("LICENSE_RECEIPT_IDENTITY_MISMATCH");
  } else if (receipt.moduleKey !== key || receipt.moduleVersion !== version) {
    throw new Error("LICENSE_RECEIPT_IDENTITY_MISMATCH");
  }
  return { relative, receipt };
}

async function scanFamily(root, family) {
  const familyRoot = path.join(root, family);
  const familyState = await fs.lstat(familyRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!familyState) return [];
  if (!familyState.isDirectory() || familyState.isSymbolicLink()) throw new Error("LICENSE_FAMILY_ROOT_INVALID");
  const result = [];
  const keys = await fs.readdir(familyRoot, { withFileTypes: true });
  keys.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const keyEntry of keys) {
    if (!keyEntry.isDirectory() || keyEntry.isSymbolicLink() || !SAFE_KEY.test(keyEntry.name)) {
      throw new Error(`LICENSE_KEY_DIRECTORY_INVALID:${keyEntry.name}`);
    }
    const keyRoot = path.join(familyRoot, keyEntry.name);
    const versions = await fs.readdir(keyRoot, { withFileTypes: true });
    versions.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink() || !SAFE_VERSION.test(versionEntry.name)) {
        throw new Error(`LICENSE_VERSION_DIRECTORY_INVALID:${versionEntry.name}`);
      }
      const { relative, receipt } = await readCatalogReceipt(root, family, keyEntry.name, versionEntry.name);
      result.push({
        type: family === "platform" ? "platform" : "module",
        key: keyEntry.name,
        version: versionEntry.name,
        receipt: relative,
        treeSha256: receipt.treeSha256,
      });
    }
  }
  return result;
}

export async function rebuildLicenseCatalog(licenseRoot, { generatedAt = new Date().toISOString() } = {}) {
  const root = path.resolve(licenseRoot);
  await assertAbsolutePathWithoutSymlinks(root);
  await fs.mkdir(root, { recursive: true });
  await assertAbsolutePathWithoutSymlinks(root, { allowMissingTail: false });
  const entries = [
    ...await scanFamily(root, "platform"),
    ...await scanFamily(root, "modules"),
  ].sort((left, right) => `${left.type}:${left.key}:${left.version}`.localeCompare(`${right.type}:${right.key}:${right.version}`, "en"));
  const catalog = { schemaVersion: "bonni.license-catalog/v1", generatedAt, entries };
  await atomicJson(path.join(root, "catalog.json"), catalog);
  return catalog;
}

export async function copyCoreLicenseVersion({ seedRoot, licenseRoot, version }) {
  if (!SAFE_VERSION.test(version)) throw new Error("CORE_LICENSE_VERSION_INVALID");
  const sourceRoot = path.join(path.resolve(seedRoot), "platform", "bonni-core", version);
  const sourceReceipt = await verifyCoreLicenseVersion(sourceRoot, version);
  const destinationRoot = path.join(path.resolve(licenseRoot), "platform", "bonni-core", version);
  if (path.resolve(sourceRoot) === path.resolve(destinationRoot)) {
    return { created: false, targetRoot: destinationRoot, receipt: sourceReceipt };
  }
  await assertAbsolutePathWithoutSymlinks(path.dirname(destinationRoot));
  const existing = await fs.lstat(destinationRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    const stored = await verifyCoreLicenseVersion(destinationRoot, version);
    if (JSON.stringify(stored) !== JSON.stringify(sourceReceipt)) throw new Error("CORE_LICENSE_SEED_CONFLICT");
    return { created: false, targetRoot: destinationRoot, receipt: stored };
  }

  const parent = path.dirname(destinationRoot);
  await fs.mkdir(parent, { recursive: true });
  await assertAbsolutePathWithoutSymlinks(parent, { allowMissingTail: false });
  const temporary = path.join(parent, `.${version}.seed-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(temporary, { mode: 0o755 });
    for (const file of sourceReceipt.files) {
      const source = path.join(sourceRoot, ...file.path.split("/"));
      const destination = path.join(temporary, ...file.path.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      await fs.chmod(destination, 0o444).catch(() => undefined);
    }
    await fs.copyFile(path.join(sourceRoot, "RECEIPT.json"), path.join(temporary, "RECEIPT.json"));
    await fs.chmod(path.join(temporary, "RECEIPT.json"), 0o444).catch(() => undefined);
    await verifyCoreLicenseVersion(temporary, version);
    await fs.rename(temporary, destinationRoot);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (await fs.lstat(destinationRoot).catch(() => null)) {
      const stored = await verifyCoreLicenseVersion(destinationRoot, version);
      if (JSON.stringify(stored) === JSON.stringify(sourceReceipt)) {
        return { created: false, targetRoot: destinationRoot, receipt: stored };
      }
    }
    throw error;
  }
  return { created: true, targetRoot: destinationRoot, receipt: sourceReceipt };
}

export function validCoreLicenseVersion(value) {
  return typeof value === "string" && SAFE_VERSION.test(value);
}
