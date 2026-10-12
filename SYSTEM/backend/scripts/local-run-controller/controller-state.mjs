import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const RECEIPT_KIND = "bonni-local-proxy-target";
const RECEIPT_FILE = "active-target.json";
const PREVIOUS_RECEIPT_FILE = "active-target.previous.json";

export class LocalRunControllerError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "LocalRunControllerError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new LocalRunControllerError(code, detail);
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

function checksum(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail("LOCAL_RUN_CONTROLLER_PORT_INVALID", label);
  }
  return port;
}

function assertLoopback(host, label) {
  const normalized = String(host || "").trim().toLowerCase();
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(normalized)) {
    fail("LOCAL_RUN_CONTROLLER_NON_LOOPBACK_FORBIDDEN", label);
  }
  return normalized;
}

function validateTarget(target) {
  if (!target || target.slotRole !== "active") {
    fail("LOCAL_RUN_CONTROLLER_TARGET_ROLE_FORBIDDEN", String(target?.slotRole || "missing"));
  }
  const slotId = String(target.slotId || "").trim();
  if (!slotId || slotId.length > 160 || /[\u0000\r\n]/u.test(slotId)) {
    fail("LOCAL_RUN_CONTROLLER_SLOT_ID_INVALID");
  }
  const receiptSha256 = target.receiptSha256 === null || target.receiptSha256 === undefined
    ? null
    : String(target.receiptSha256).trim().toLowerCase();
  if (receiptSha256 !== null && !/^[a-f0-9]{64}$/u.test(receiptSha256)) {
    fail("LOCAL_RUN_CONTROLLER_SLOT_RECEIPT_INVALID");
  }
  return {
    host: assertLoopback(target.host || "127.0.0.1", "target"),
    port: parsePort(target.port, "target"),
    slotRole: "active",
    slotId,
    receiptSha256,
  };
}

function validateReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== RECEIPT_KIND) {
    fail("LOCAL_RUN_CONTROLLER_TARGET_RECEIPT_INVALID");
  }
  const { checksum: actualChecksum, ...base } = receipt;
  if (!/^[a-f0-9]{64}$/u.test(String(actualChecksum || "")) || checksum(base) !== actualChecksum) {
    fail("LOCAL_RUN_CONTROLLER_TARGET_RECEIPT_INTEGRITY_FAILED");
  }
  if (!Number.isSafeInteger(receipt.generation) || receipt.generation < 1) {
    fail("LOCAL_RUN_CONTROLLER_GENERATION_INVALID");
  }
  if (receipt.previousGeneration !== null
      && (!Number.isSafeInteger(receipt.previousGeneration)
        || receipt.previousGeneration < 1
        || receipt.previousGeneration >= receipt.generation)) {
    fail("LOCAL_RUN_CONTROLLER_PREVIOUS_GENERATION_INVALID");
  }
  assertLoopback(receipt.public?.host, "public");
  parsePort(receipt.public?.port, "public");
  validateTarget(receipt.target);
  return receipt;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const state = await lstatOrNull(cursor);
    if (!state) return;
    if (state.isSymbolicLink()) fail("LOCAL_RUN_CONTROLLER_STATE_PATH_SYMLINK_FORBIDDEN", cursor);
  }
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

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  await assertNoSymlinkComponents(directory);
  await fs.mkdir(directory, { recursive: true });
  await assertNoSymlinkComponents(directory);
  const directoryState = await fs.lstat(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    fail("LOCAL_RUN_CONTROLLER_STATE_ROOT_UNSAFE");
  }
  const existing = await lstatOrNull(file);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    fail("LOCAL_RUN_CONTROLLER_STATE_FILE_UNSAFE", path.basename(file));
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readReceiptFile(file) {
  const state = await lstatOrNull(file);
  if (!state) return null;
  if (!state.isFile() || state.isSymbolicLink()) {
    fail("LOCAL_RUN_CONTROLLER_STATE_FILE_UNSAFE", path.basename(file));
  }
  try {
    return validateReceipt(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof LocalRunControllerError) throw error;
    fail("LOCAL_RUN_CONTROLLER_TARGET_RECEIPT_INVALID", path.basename(file));
  }
}

function isRecoverableReceiptError(error) {
  return error instanceof LocalRunControllerError && new Set([
    "LOCAL_RUN_CONTROLLER_TARGET_RECEIPT_INVALID",
    "LOCAL_RUN_CONTROLLER_TARGET_RECEIPT_INTEGRITY_FAILED",
    "LOCAL_RUN_CONTROLLER_GENERATION_INVALID",
    "LOCAL_RUN_CONTROLLER_PREVIOUS_GENERATION_INVALID",
    "LOCAL_RUN_CONTROLLER_PORT_INVALID",
    "LOCAL_RUN_CONTROLLER_NON_LOOPBACK_FORBIDDEN",
    "LOCAL_RUN_CONTROLLER_TARGET_ROLE_FORBIDDEN",
    "LOCAL_RUN_CONTROLLER_SLOT_ID_INVALID",
    "LOCAL_RUN_CONTROLLER_SLOT_RECEIPT_INVALID",
  ]).has(error.code);
}

export function controllerReceiptPaths(options = {}) {
  const stateRoot = path.resolve(options.stateRoot || path.join(process.cwd(), "run_system", "controller"));
  return {
    stateRoot,
    active: path.join(stateRoot, RECEIPT_FILE),
    previous: path.join(stateRoot, PREVIOUS_RECEIPT_FILE),
  };
}

export async function readActiveTargetReceipt(options = {}) {
  const paths = controllerReceiptPaths(options);
  return readReceiptFile(paths.active);
}

/**
 * Commits one generation. The active receipt is the commit point. A verified
 * copy of its predecessor is retained so startup can recover after a damaged
 * receipt without ever guessing that Candidate is publicly routable.
 */
export async function commitActiveTarget(options = {}) {
  const paths = controllerReceiptPaths(options);
  const current = await readReceiptFile(paths.active);
  if (options.expectedGeneration !== undefined
      && Number(options.expectedGeneration) !== Number(current?.generation || 0)) {
    fail(
      "LOCAL_RUN_CONTROLLER_GENERATION_CONFLICT",
      `${options.expectedGeneration}:${current?.generation || 0}`,
    );
  }
  const target = validateTarget(options.target);
  const publicEndpoint = {
    host: assertLoopback(options.publicHost || current?.public?.host || "127.0.0.1", "public"),
    port: parsePort(options.publicPort || current?.public?.port || 4000, "public"),
  };
  if (target.host === publicEndpoint.host && target.port === publicEndpoint.port) {
    fail("LOCAL_RUN_CONTROLLER_PROXY_LOOP_FORBIDDEN");
  }
  const generation = (current?.generation || 0) + 1;
  const base = {
    schemaVersion: SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    generation,
    previousGeneration: current?.generation || null,
    committedAt: new Date().toISOString(),
    public: publicEndpoint,
    target,
  };
  const receipt = { ...base, checksum: checksum(base) };
  if (current) await atomicWriteJson(paths.previous, current);
  await atomicWriteJson(paths.active, receipt);
  return receipt;
}

/** Recover only from a committed target, its committed predecessor, or an
 * explicit bootstrap Active target. Candidate is never considered. */
export async function recoverActiveTarget(options = {}) {
  const paths = controllerReceiptPaths(options);
  try {
    const active = await readReceiptFile(paths.active);
    if (active) return { receipt: active, source: "active" };
  } catch (error) {
    if (!isRecoverableReceiptError(error)) throw error;
  }
  try {
    const previous = await readReceiptFile(paths.previous);
    if (previous) {
      // Restore the last independently committed receipt so a later cutover
      // can advance from the recovered generation instead of repeatedly
      // encountering the damaged primary file.
      await atomicWriteJson(paths.active, previous);
      return { receipt: previous, source: "previous" };
    }
  } catch (error) {
    if (!isRecoverableReceiptError(error)) throw error;
  }
  if (!options.bootstrapTarget) fail("LOCAL_RUN_CONTROLLER_TARGET_UNRECOVERABLE");
  const receipt = await commitActiveTarget({
    stateRoot: paths.stateRoot,
    target: options.bootstrapTarget,
    publicHost: options.publicHost,
    publicPort: options.publicPort,
  });
  return { receipt, source: "bootstrap" };
}
