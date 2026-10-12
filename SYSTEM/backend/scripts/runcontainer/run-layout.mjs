import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const RUN_LAYOUT_VERSION = 2;
export const RUN_LAYOUT_RECEIPT_SCHEMA = "bonni.run-layout";
export const RUN_LAYOUT_RECEIPT_SCHEMA_VERSION = 1;
export const RUN_LAYOUT_RECEIPT_FILE = "layout-receipt.json";

export const RUN_LAYOUT_ENVIRONMENT = Object.freeze({
  runInstallRoot: "BONNI_RUN_INSTALL_ROOT",
  runSystemRoot: "BONNI_RUN_SYSTEM_ROOT",
  programSlotsRoot: "BONNI_PROGRAM_SLOTS_ROOT",
  runtimeStateRoot: "BONNI_RUNTIME_STATE_ROOT",
  legacyProgramSlotsRoot: "RUNCONTAINER_ROOT",
  legacyRuntimeStateRoot: "RUN_SYSTEM_ROOT",
});

const RECEIPT_PATH_FIELDS = Object.freeze([
  "systemRoot",
  "updateRoot",
  "runInstallRoot",
  "runInstallWorkspaceRoot",
  "runInstallStateRoot",
  "runSystemRoot",
  "programSlotsRoot",
  "controllerRoot",
  "runtimeStateRoot",
  "backupRoot",
  "previousBackupRoot",
  "receiptPath",
]);
const TOP_LEVEL_PATH_FIELDS = Object.freeze([
  "systemRoot",
  "updateRoot",
  "runInstallRoot",
  "runSystemRoot",
  "backupRoot",
]);
const MAXIMUM_RECEIPT_BYTES = 1024 * 1024;

export class RunLayoutError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "RunLayoutError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new RunLayoutError(code, detail);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function equalDigest(left, right) {
  if (!/^[a-f0-9]{64}$/u.test(String(left)) || !/^[a-f0-9]{64}$/u.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalAbsolutePath(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0")) fail("RUN_LAYOUT_PATH_INVALID", label);
  return path.resolve(raw);
}

function environmentPath(environment, name, fallback) {
  if (!own(environment, name)) return { value: fallback, source: "default" };
  const raw = String(environment[name] ?? "").trim();
  if (!raw) fail("RUN_LAYOUT_ENV_PATH_EMPTY", name);
  return { value: path.resolve(raw), source: name };
}

function environmentPathWithLegacy(environment, currentName, legacyName, fallback) {
  if (own(environment, currentName)) return environmentPath(environment, currentName, fallback);
  if (own(environment, legacyName)) return environmentPath(environment, legacyName, fallback);
  return { value: fallback, source: "default" };
}

function portableAbsolute(value) {
  return canonicalAbsolutePath(value, "receipt-path").split(path.sep).join("/").normalize("NFC");
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "object-required");
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((entry, index) => entry !== canonical[index])) {
    fail(code, actual.join(","));
  }
}

/**
 * Produces a deterministic comparison key for paths that must stay distinct on
 * Windows. It intentionally also folds trailing dots/spaces, which Win32 path
 * lookup normally ignores. Running this check on every host prevents a package
 * prepared on Linux from introducing a collision on its Windows destination.
 */
export function windowsCaseFoldPath(value) {
  const absolute = canonicalAbsolutePath(value, "windows-case-fold");
  let normalized = absolute.replaceAll("\\", "/").normalize("NFKC");
  const prefix = normalized.startsWith("//") ? "//" : normalized.startsWith("/") ? "/" : "";
  normalized = normalized.replace(/^\/+|\/+$/gu, "");
  const components = normalized
    .split(/\/+/u)
    .filter(Boolean)
    .map((entry) => entry.replace(/[. ]+$/gu, ""));
  return `${prefix}${components.join("/")}`.toLocaleLowerCase("en-US");
}

function foldedPathIsInside(parent, candidate, allowEqual = false) {
  const parentKey = windowsCaseFoldPath(parent).replace(/\/+$/u, "");
  const candidateKey = windowsCaseFoldPath(candidate).replace(/\/+$/u, "");
  return (allowEqual && parentKey === candidateKey) || candidateKey.startsWith(`${parentKey}/`);
}

function assertStrictChild(parent, child, label) {
  if (!foldedPathIsInside(parent, child, false)) fail("RUN_LAYOUT_CHILD_PATH_INVALID", label);
}

function assertTopLevelSeparation(layout) {
  for (let leftIndex = 0; leftIndex < TOP_LEVEL_PATH_FIELDS.length; leftIndex += 1) {
    const leftName = TOP_LEVEL_PATH_FIELDS[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < TOP_LEVEL_PATH_FIELDS.length; rightIndex += 1) {
      const rightName = TOP_LEVEL_PATH_FIELDS[rightIndex];
      const left = layout[leftName];
      const right = layout[rightName];
      if (foldedPathIsInside(left, right, true) || foldedPathIsInside(right, left, true)) {
        fail("RUN_LAYOUT_ROOT_OVERLAP", `${leftName}:${rightName}`);
      }
    }
  }
}

export function assertRunLayoutPathContract(layout) {
  if (!layout || typeof layout !== "object") fail("RUN_LAYOUT_INVALID", "object-required");
  if (layout.version !== RUN_LAYOUT_VERSION) fail("RUN_LAYOUT_VERSION_UNSUPPORTED", String(layout.version));
  for (const [field, value] of [
    ["productRoot", layout.productRoot],
    ...RECEIPT_PATH_FIELDS.map((entry) => [entry, layout[entry]]),
  ]) {
    const raw = String(value ?? "");
    if (!path.isAbsolute(raw) || path.resolve(raw) !== raw) fail("RUN_LAYOUT_PATH_NOT_RESOLVED", field);
  }

  const seen = new Map();
  for (const field of RECEIPT_PATH_FIELDS.filter((entry) => entry !== "receiptPath")) {
    const key = windowsCaseFoldPath(layout[field]);
    const prior = seen.get(key);
    if (prior) fail("RUN_LAYOUT_WINDOWS_PATH_COLLISION", `${prior}:${field}`);
    seen.set(key, field);
  }

  assertTopLevelSeparation(layout);
  assertStrictChild(layout.runInstallRoot, layout.runInstallWorkspaceRoot, "runInstallWorkspaceRoot");
  assertStrictChild(layout.runInstallRoot, layout.runInstallStateRoot, "runInstallStateRoot");
  assertStrictChild(layout.runSystemRoot, layout.controllerRoot, "controllerRoot");
  assertStrictChild(layout.runSystemRoot, layout.receiptPath, "receiptPath");
  assertStrictChild(layout.backupRoot, layout.previousBackupRoot, "previousBackupRoot");

  for (const [field, target] of [
    ["programSlotsRoot", layout.programSlotsRoot],
    ["runtimeStateRoot", layout.runtimeStateRoot],
  ]) {
    for (const owner of ["systemRoot", "updateRoot", "runInstallRoot", "backupRoot"]) {
      if (foldedPathIsInside(layout[owner], target, true)) {
        fail("RUN_LAYOUT_OWNERSHIP_OVERLAP", `${owner}:${field}`);
      }
    }
  }
  return layout;
}

export function resolveRunLayout(options = {}) {
  const environment = options.environment ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const productRoot = canonicalAbsolutePath(
    options.productRoot ?? environment.BONNI_PROJECT_ROOT ?? path.resolve(cwd, "../.."),
    "productRoot",
  );
  const runInstall = environmentPath(
    environment,
    RUN_LAYOUT_ENVIRONMENT.runInstallRoot,
    path.join(productRoot, "RUN_INSTALL"),
  );
  const runSystem = environmentPath(
    environment,
    RUN_LAYOUT_ENVIRONMENT.runSystemRoot,
    path.join(productRoot, "RUN_SYSTEM"),
  );
  const programSlots = environmentPathWithLegacy(
    environment,
    RUN_LAYOUT_ENVIRONMENT.programSlotsRoot,
    RUN_LAYOUT_ENVIRONMENT.legacyProgramSlotsRoot,
    path.join(runSystem.value, "program-slots"),
  );
  const runtimeState = environmentPathWithLegacy(
    environment,
    RUN_LAYOUT_ENVIRONMENT.runtimeStateRoot,
    RUN_LAYOUT_ENVIRONMENT.legacyRuntimeStateRoot,
    path.join(runSystem.value, "runtime"),
  );
  const backupRoot = path.join(productRoot, "BACKUP");
  const layout = {
    version: RUN_LAYOUT_VERSION,
    productRoot,
    systemRoot: path.join(productRoot, "SYSTEM"),
    updateRoot: path.join(productRoot, "UPDATE"),
    runInstallRoot: runInstall.value,
    runInstallWorkspaceRoot: path.join(runInstall.value, "workspace"),
    runInstallStateRoot: path.join(runInstall.value, "state"),
    runSystemRoot: runSystem.value,
    programSlotsRoot: programSlots.value,
    controllerRoot: path.join(runSystem.value, "controller"),
    runtimeStateRoot: runtimeState.value,
    backupRoot,
    previousBackupRoot: path.join(backupRoot, "PREVIOUS"),
    receiptPath: path.join(runSystem.value, RUN_LAYOUT_RECEIPT_FILE),
    sources: Object.freeze({
      runInstallRoot: runInstall.source,
      runSystemRoot: runSystem.source,
      programSlotsRoot: programSlots.source,
      runtimeStateRoot: runtimeState.source,
    }),
  };
  assertRunLayoutPathContract(layout);
  return Object.freeze(layout);
}

export function resolveLegacyRunLayout(options = {}) {
  const environment = options.environment ?? process.env;
  const productRoot = canonicalAbsolutePath(
    options.productRoot
      ?? environment.BONNI_PROJECT_ROOT
      ?? path.resolve(options.cwd ?? process.cwd(), "../.."),
    "productRoot",
  );
  const programSlots = environmentPath(
    environment,
    RUN_LAYOUT_ENVIRONMENT.legacyProgramSlotsRoot,
    path.join(productRoot, "RUN"),
  );
  const runtimeState = environmentPath(
    environment,
    RUN_LAYOUT_ENVIRONMENT.legacyRuntimeStateRoot,
    path.join(productRoot, "run_system"),
  );
  return Object.freeze({
    version: 1,
    productRoot,
    programSlotsRoot: programSlots.value,
    runtimeStateRoot: runtimeState.value,
    sources: Object.freeze({
      programSlotsRoot: programSlots.source,
      runtimeStateRoot: runtimeState.source,
    }),
  });
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function assertNoSymlinkPath(target, label = "path") {
  const resolved = canonicalAbsolutePath(target, label);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    const stat = await lstatOrNull(cursor);
    if (!stat) return resolved;
    if (stat.isSymbolicLink()) fail("RUN_LAYOUT_SYMLINK_FORBIDDEN", `${label}:${cursor}`);
  }
  return resolved;
}

export async function assertRunLayoutSafe(layout) {
  assertRunLayoutPathContract(layout);
  await assertNoSymlinkPath(layout.productRoot, "productRoot");
  for (const field of RECEIPT_PATH_FIELDS) await assertNoSymlinkPath(layout[field], field);
  return layout;
}

function receiptPaths(layout) {
  return Object.fromEntries(RECEIPT_PATH_FIELDS.map((field) => [field, portableAbsolute(layout[field])]));
}

function receiptPayload(receipt) {
  return {
    schema: receipt.schema,
    schemaVersion: receipt.schemaVersion,
    layoutVersion: receipt.layoutVersion,
    layoutId: receipt.layoutId,
    createdAt: receipt.createdAt,
    productRoot: receipt.productRoot,
    paths: receipt.paths,
  };
}

export function createRunLayoutReceipt(layout, options = {}) {
  assertRunLayoutPathContract(layout);
  const paths = receiptPaths(layout);
  const productRoot = portableAbsolute(layout.productRoot);
  const identity = sha256(stableStringify({ layoutVersion: RUN_LAYOUT_VERSION, productRoot, paths }));
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    fail("RUN_LAYOUT_RECEIPT_TIME_INVALID", String(createdAt));
  }
  const payload = {
    schema: RUN_LAYOUT_RECEIPT_SCHEMA,
    schemaVersion: RUN_LAYOUT_RECEIPT_SCHEMA_VERSION,
    layoutVersion: RUN_LAYOUT_VERSION,
    layoutId: `layout-v2-${identity.slice(0, 32)}`,
    createdAt,
    productRoot,
    paths,
  };
  return Object.freeze({
    ...payload,
    paths: Object.freeze(paths),
    checksum: Object.freeze({ algorithm: "sha256", value: sha256(stableStringify(payload)) }),
  });
}

export function verifyRunLayoutReceipt(receipt, layout) {
  assertRunLayoutPathContract(layout);
  exactKeys(receipt, [
    "schema",
    "schemaVersion",
    "layoutVersion",
    "layoutId",
    "createdAt",
    "productRoot",
    "paths",
    "checksum",
  ], "RUN_LAYOUT_RECEIPT_SHAPE_INVALID");
  exactKeys(receipt.paths, RECEIPT_PATH_FIELDS, "RUN_LAYOUT_RECEIPT_PATHS_INVALID");
  exactKeys(receipt.checksum, ["algorithm", "value"], "RUN_LAYOUT_RECEIPT_CHECKSUM_INVALID");
  if (receipt.schema !== RUN_LAYOUT_RECEIPT_SCHEMA
    || receipt.schemaVersion !== RUN_LAYOUT_RECEIPT_SCHEMA_VERSION
    || receipt.layoutVersion !== RUN_LAYOUT_VERSION) {
    fail("RUN_LAYOUT_RECEIPT_VERSION_UNSUPPORTED");
  }
  if (receipt.checksum.algorithm !== "sha256") fail("RUN_LAYOUT_RECEIPT_CHECKSUM_ALGORITHM_INVALID");
  if (!Number.isFinite(Date.parse(receipt.createdAt))
    || new Date(receipt.createdAt).toISOString() !== receipt.createdAt) {
    fail("RUN_LAYOUT_RECEIPT_TIME_INVALID", String(receipt.createdAt));
  }
  const expectedDigest = sha256(stableStringify(receiptPayload(receipt)));
  if (!equalDigest(expectedDigest, receipt.checksum.value)) fail("RUN_LAYOUT_RECEIPT_CHECKSUM_MISMATCH");

  const expected = createRunLayoutReceipt(layout, { createdAt: receipt.createdAt });
  if (receipt.layoutId !== expected.layoutId
    || receipt.productRoot !== expected.productRoot
    || stableStringify(receipt.paths) !== stableStringify(expected.paths)) {
    fail("RUN_LAYOUT_RECEIPT_CONTRACT_MISMATCH");
  }
  return receipt;
}

async function readReceiptFile(file, allowMissing) {
  let handle;
  try {
    const named = await fs.lstat(file);
    if (named.isSymbolicLink() || !named.isFile() || named.nlink !== 1
      || named.size < 2 || named.size > MAXIMUM_RECEIPT_BYTES) {
      fail("RUN_LAYOUT_RECEIPT_FILE_UNSAFE", file);
    }
    handle = await fs.open(file, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
      fail("RUN_LAYOUT_RECEIPT_FILE_RACE", file);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(file).catch(() => null);
    if (!current || current.isSymbolicLink()
      || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) {
      fail("RUN_LAYOUT_RECEIPT_FILE_RACE", file);
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("RUN_LAYOUT_RECEIPT_JSON_INVALID", file);
    }
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readRunLayoutReceipt(layout, options = {}) {
  await assertRunLayoutSafe(layout);
  const receipt = await readReceiptFile(layout.receiptPath, options.allowMissing !== false);
  if (!receipt) return null;
  return verifyRunLayoutReceipt(receipt, layout);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EBADF"]).has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishReceiptWithoutReplacement(temporary, target) {
  try {
    await fs.link(temporary, target);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    if (!new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]).has(error?.code)) throw error;
    try {
      await fs.copyFile(temporary, target, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError?.code === "EEXIST") return false;
      throw copyError;
    }
  }
  return true;
}

export async function writeRunLayoutReceipt(layout, options = {}) {
  await assertRunLayoutSafe(layout);
  await fs.mkdir(layout.runSystemRoot, { recursive: true });
  await assertRunLayoutSafe(layout);

  const existing = await readRunLayoutReceipt(layout, { allowMissing: true });
  if (existing) return { created: false, receipt: existing };

  const receipt = createRunLayoutReceipt(layout, options);
  const temporary = path.join(
    layout.runSystemRoot,
    `.${RUN_LAYOUT_RECEIPT_FILE}.${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const created = await publishReceiptWithoutReplacement(temporary, layout.receiptPath);
    await fs.unlink(temporary).catch(() => undefined);
    await syncDirectory(layout.runSystemRoot);
    const committed = await readRunLayoutReceipt(layout, { allowMissing: false });
    return { created, receipt: committed };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function existingDirectory(target, label) {
  const stat = await lstatOrNull(target);
  if (!stat) return false;
  if (stat.isSymbolicLink()) fail("RUN_LAYOUT_SYMLINK_FORBIDDEN", `${label}:${target}`);
  if (!stat.isDirectory()) fail("RUN_LAYOUT_DIRECTORY_REQUIRED", `${label}:${target}`);
  return true;
}

export async function detectRunLayout(options = {}) {
  const layout = resolveRunLayout(options);
  const legacy = resolveLegacyRunLayout(options);
  await assertRunLayoutSafe(layout);
  await assertNoSymlinkPath(legacy.programSlotsRoot, "legacyProgramSlotsRoot");
  await assertNoSymlinkPath(legacy.runtimeStateRoot, "legacyRuntimeStateRoot");

  const receipt = await readRunLayoutReceipt(layout, { allowMissing: true });
  const [legacyProgram, legacyRuntime] = await Promise.all([
    existingDirectory(legacy.programSlotsRoot, "legacyProgramSlotsRoot"),
    existingDirectory(legacy.runtimeStateRoot, "legacyRuntimeStateRoot"),
  ]);
  const runSystemLegacyCaseConflict = windowsCaseFoldPath(layout.runSystemRoot)
    === windowsCaseFoldPath(legacy.runtimeStateRoot);

  if (receipt) {
    // On a case-insensitive filesystem RUN_SYSTEM and the legacy run_system
    // resolve to the same directory. A committed v2 receipt disambiguates that
    // directory; only an independent legacy RUN tree remains legacy evidence.
    const committedLegacyRuntime = legacyRuntime && !runSystemLegacyCaseConflict;
    const committedLegacyDetected = legacyProgram || committedLegacyRuntime;
    return Object.freeze({
      version: 2,
      kind: "v2",
      state: "committed",
      layout,
      receipt,
      legacy: Object.freeze({
        detected: committedLegacyDetected,
        programSlots: legacyProgram,
        runtimeState: committedLegacyRuntime,
        runSystemCaseConflict: runSystemLegacyCaseConflict,
        paths: legacy,
      }),
    });
  }

  const runSystemRoot = await existingDirectory(layout.runSystemRoot, "runSystemRoot");
  const [runInstall, programSlots, controller, runtimeState] = await Promise.all([
    existingDirectory(layout.runInstallRoot, "runInstallRoot"),
    existingDirectory(layout.programSlotsRoot, "programSlotsRoot"),
    existingDirectory(layout.controllerRoot, "controllerRoot"),
    existingDirectory(layout.runtimeStateRoot, "runtimeStateRoot"),
  ]);
  const distinctV2RunSystemRoot = runSystemRoot && !runSystemLegacyCaseConflict;
  const v2Detected = runInstall
    || (programSlots && layout.sources.programSlotsRoot !== RUN_LAYOUT_ENVIRONMENT.legacyProgramSlotsRoot)
    || controller
    || (runtimeState && layout.sources.runtimeStateRoot !== RUN_LAYOUT_ENVIRONMENT.legacyRuntimeStateRoot)
    || distinctV2RunSystemRoot;
  const legacyDetected = legacyProgram || legacyRuntime;

  if (v2Detected && legacyDetected) {
    return Object.freeze({
      version: null,
      kind: "mixed",
      state: "migration-required",
      layout,
      receipt: null,
      legacy: Object.freeze({
        detected: true,
        programSlots: legacyProgram,
        runtimeState: legacyRuntime,
        runSystemCaseConflict: runSystemLegacyCaseConflict,
        paths: legacy,
      }),
    });
  }
  if (v2Detected) {
    return Object.freeze({ version: 2, kind: "v2", state: "uncommitted", layout, receipt: null, legacy: null });
  }
  if (legacyDetected) {
    return Object.freeze({
      version: 1,
      kind: "v1",
      state: "legacy",
      layout,
      receipt: null,
      legacy: Object.freeze({
        detected: true,
        programSlots: legacyProgram,
        runtimeState: legacyRuntime,
        runSystemCaseConflict: runSystemLegacyCaseConflict,
        paths: legacy,
      }),
    });
  }
  return Object.freeze({ version: null, kind: "uninitialized", state: "absent", layout, receipt: null, legacy: null });
}
