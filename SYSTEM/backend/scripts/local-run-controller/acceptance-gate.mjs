import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = 1;
const KIND = "bonni-local-cutover-acceptance";
const DEFAULT_TTL_MS = 60_000;
const MAX_ATTEMPTS = 2;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export class AcceptanceGateError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "AcceptanceGateError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new AcceptanceGateError(code, detail);
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

function receiptChecksum(base) {
  return sha256(stableStringify(base));
}

function exactText(value, label, maximum = 240) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\u0000\r\n]/u.test(text)) {
    fail("ACCEPTANCE_GATE_BINDING_INVALID", label);
  }
  return text;
}

function manifestSha256(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) fail("ACCEPTANCE_GATE_MANIFEST_INVALID");
  return normalized;
}

function proxyGeneration(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) fail("ACCEPTANCE_GATE_PROXY_GENERATION_INVALID");
  return generation;
}

function ttlMilliseconds(value = DEFAULT_TTL_MS) {
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) {
    fail("ACCEPTANCE_GATE_TTL_INVALID");
  }
  return ttlMs;
}

function instant(value, label) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) fail("ACCEPTANCE_GATE_TIME_INVALID", label);
  return date;
}

function tokenBytes(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length < 32) fail("ACCEPTANCE_GATE_TOKEN_ENTROPY_INSUFFICIENT");
    return value;
  }
  const token = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{43,}$/u.test(token)) fail("ACCEPTANCE_GATE_TOKEN_INVALID");
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length < 32) fail("ACCEPTANCE_GATE_TOKEN_ENTROPY_INSUFFICIENT");
  return decoded;
}

function tokenSha256(value) {
  return sha256(tokenBytes(value));
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function binding(options) {
  return {
    requestId: exactText(options.requestId, "requestId"),
    updateId: exactText(options.updateId, "updateId"),
    manifestSha256: manifestSha256(options.manifestSha256),
    slotId: exactText(options.slotId, "slotId"),
    proxyGeneration: proxyGeneration(options.proxyGeneration),
  };
}

function bindingFromCommittedProxy(options) {
  const receipt = options.proxyReceipt;
  if (!receipt || receipt.kind !== "bonni-local-proxy-target") {
    fail("ACCEPTANCE_GATE_PROXY_RECEIPT_INVALID");
  }
  const { checksum, ...base } = receipt;
  if (!/^[a-f0-9]{64}$/u.test(String(checksum || "")) || receiptChecksum(base) !== checksum) {
    fail("ACCEPTANCE_GATE_PROXY_RECEIPT_INTEGRITY_FAILED");
  }
  if (receipt.target?.slotRole !== "active") fail("ACCEPTANCE_GATE_PROXY_TARGET_NOT_ACTIVE");
  const derived = {
    requestId: options.requestId,
    updateId: options.updateId,
    manifestSha256: options.manifestSha256,
    slotId: receipt.target.slotId,
    proxyGeneration: receipt.generation,
  };
  if (options.slotId !== undefined && String(options.slotId) !== String(derived.slotId)) {
    fail("ACCEPTANCE_GATE_PROXY_BINDING_MISMATCH", "slotId");
  }
  if (options.proxyGeneration !== undefined && Number(options.proxyGeneration) !== Number(derived.proxyGeneration)) {
    fail("ACCEPTANCE_GATE_PROXY_BINDING_MISMATCH", "proxyGeneration");
  }
  return derived;
}

function sameBinding(left, right) {
  return left.requestId === right.requestId
    && left.updateId === right.updateId
    && left.manifestSha256 === right.manifestSha256
    && left.slotId === right.slotId
    && left.proxyGeneration === right.proxyGeneration;
}

function sameRelease(left, right) {
  return left.requestId === right.requestId
    && left.updateId === right.updateId
    && left.manifestSha256 === right.manifestSha256
    && left.slotId === right.slotId;
}

function gateDirectory(options) {
  const stateRoot = path.resolve(String(options.stateRoot || ""));
  if (!options.stateRoot || stateRoot === path.parse(stateRoot).root) fail("ACCEPTANCE_GATE_STATE_ROOT_INVALID");
  const requestId = exactText(options.requestId, "requestId");
  return path.join(stateRoot, "acceptance-gates", sha256(requestId));
}

function pathsFor(options) {
  const root = gateDirectory(options);
  return {
    root,
    receipts: path.join(root, "receipts"),
    current: path.join(root, "current.json"),
    lock: path.join(root, ".transition.lock"),
    staleLocks: path.join(root, "stale-locks"),
  };
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
    if (state.isSymbolicLink()) fail("ACCEPTANCE_GATE_STATE_PATH_UNSAFE", cursor);
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

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLockOwner(lock) {
  try {
    return JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function archiveStaleLock(paths, owner) {
  await fs.mkdir(paths.staleLocks, { recursive: true });
  const suffix = `${Date.now()}-${String(owner?.pid || "unknown")}-${crypto.randomUUID()}`;
  await fs.rename(paths.lock, path.join(paths.staleLocks, `transition-${suffix}`));
}

async function withGateTransitionLock(options, operation) {
  const paths = pathsFor(options);
  const waitMs = Number(options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  const staleMs = Number(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || !Number.isSafeInteger(staleMs) || staleMs < 1) {
    fail("ACCEPTANCE_GATE_LOCK_POLICY_INVALID");
  }
  await assertNoSymlinkComponents(paths.root);
  await fs.mkdir(paths.root, { recursive: true });
  const deadline = Date.now() + waitMs;
  const token = crypto.randomUUID();
  while (true) {
    let created = false;
    try {
      await fs.mkdir(paths.lock);
      created = true;
      await fs.writeFile(path.join(paths.lock, "owner.json"), `${JSON.stringify({
        schemaVersion: 1,
        token,
        hostname: os.hostname(),
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (created) {
        await fs.rm(paths.lock, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const lockState = await lstatOrNull(paths.lock);
      if (!lockState) continue;
      if (!lockState.isDirectory() || lockState.isSymbolicLink()) fail("ACCEPTANCE_GATE_LOCK_UNSAFE");
      const owner = await readLockOwner(paths.lock);
      const ownerTimestamp = owner?.acquiredAt ? new Date(owner.acquiredAt).getTime() : Number.NaN;
      const ownerValid = Boolean(owner
        && owner.hostname
        && Number.isSafeInteger(Number(owner.pid))
        && Number.isFinite(ownerTimestamp));
      const ageMs = Date.now() - (ownerValid ? ownerTimestamp : lockState.mtimeMs);
      const safelyDead = ownerValid
        && owner.hostname === os.hostname()
        && !processAlive(Number(owner.pid));
      const ownerless = !ownerValid;
      if (ageMs >= staleMs && (safelyDead || ownerless)) {
        try {
          await archiveStaleLock(paths, owner);
          continue;
        } catch (archiveError) {
          if (archiveError?.code === "ENOENT") continue;
          throw archiveError;
        }
      }
      if (Date.now() >= deadline) fail("ACCEPTANCE_GATE_TRANSITION_BUSY");
      await wait(10);
    }
  }
  try {
    return await operation();
  } finally {
    const owner = await readLockOwner(paths.lock).catch(() => null);
    if (owner?.token === token) await fs.rm(paths.lock, { recursive: true, force: true });
  }
}

async function atomicWrite(file, document, { exclusive = false } = {}) {
  const directory = path.dirname(file);
  await assertNoSymlinkComponents(directory);
  await fs.mkdir(directory, { recursive: true });
  await assertNoSymlinkComponents(directory);
  const existing = await lstatOrNull(file);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail("ACCEPTANCE_GATE_STATE_FILE_UNSAFE");
  if (exclusive && existing) fail("ACCEPTANCE_GATE_REVISION_CONFLICT", path.basename(file));
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      // The supervisor is the single transition writer. Rename keeps the
      // receipt atomic on Windows/SMB where hard links may be unavailable.
      if (await lstatOrNull(file)) fail("ACCEPTANCE_GATE_REVISION_CONFLICT", path.basename(file));
      await fs.rename(temporary, file);
    } else {
      await fs.rename(temporary, file);
    }
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function validateReceipt(receipt, expectedRevision, previousChecksum, expectedRequestId) {
  if (!receipt || receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== KIND) {
    fail("ACCEPTANCE_GATE_RECEIPT_INVALID", String(expectedRevision));
  }
  const { checksum, ...base } = receipt;
  if (!/^[a-f0-9]{64}$/u.test(String(checksum || "")) || receiptChecksum(base) !== checksum) {
    fail("ACCEPTANCE_GATE_RECEIPT_INTEGRITY_FAILED", String(expectedRevision));
  }
  if (receipt.revision !== expectedRevision || receipt.previousChecksum !== previousChecksum) {
    fail("ACCEPTANCE_GATE_RECEIPT_CHAIN_INVALID", String(expectedRevision));
  }
  if (receipt.binding?.requestId !== expectedRequestId) fail("ACCEPTANCE_GATE_REQUEST_MISMATCH");
  binding(receipt.binding);
  if (!Number.isInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt > MAX_ATTEMPTS) {
    fail("ACCEPTANCE_GATE_ATTEMPT_INVALID");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(receipt.tokenSha256 || ""))) fail("ACCEPTANCE_GATE_TOKEN_HASH_INVALID");
  return receipt;
}

async function readHistory(options) {
  const paths = pathsFor(options);
  const directoryState = await lstatOrNull(paths.receipts);
  if (!directoryState) return { paths, receipts: [], current: null };
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) fail("ACCEPTANCE_GATE_STATE_PATH_UNSAFE");
  const names = (await fs.readdir(paths.receipts)).filter((name) => /^\d{8}\.json$/u.test(name)).sort();
  const receipts = [];
  let previousChecksum = null;
  for (let index = 0; index < names.length; index += 1) {
    const revision = index + 1;
    if (names[index] !== `${String(revision).padStart(8, "0")}.json`) {
      fail("ACCEPTANCE_GATE_RECEIPT_CHAIN_GAP", names[index]);
    }
    const file = path.join(paths.receipts, names[index]);
    const state = await fs.lstat(file);
    if (!state.isFile() || state.isSymbolicLink()) fail("ACCEPTANCE_GATE_STATE_FILE_UNSAFE", names[index]);
    const receipt = validateReceipt(
      JSON.parse(await fs.readFile(file, "utf8")),
      revision,
      previousChecksum,
      exactText(options.requestId, "requestId"),
    );
    receipts.push(receipt);
    previousChecksum = receipt.checksum;
  }
  return { paths, receipts, current: receipts.at(-1) || null };
}

async function appendTransition(options, previous, values) {
  const paths = pathsFor(options);
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    revision: _revision,
    previousChecksum: _previousChecksum,
    recordedAt: _recordedAt,
    checksum: _checksum,
    ...payload
  } = values;
  const base = {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    revision: (previous?.revision || 0) + 1,
    previousChecksum: previous?.checksum || null,
    recordedAt: instant(options.now, "now").toISOString(),
    ...payload,
  };
  const receipt = { ...base, checksum: receiptChecksum(base) };
  const file = path.join(paths.receipts, `${String(receipt.revision).padStart(8, "0")}.json`);
  await atomicWrite(file, receipt, { exclusive: true });
  await atomicWrite(paths.current, receipt);
  return receipt;
}

function publicResult(receipt, token = undefined) {
  return { receipt, ...(token ? { token } : {}) };
}

async function recoverAcceptanceGateUnlocked(options = {}) {
  const history = await readHistory(options);
  if (!history.current) return null;
  // History receipts are authoritative. Repairing current.json is idempotent;
  // receipts are deliberately retained and never removed automatically.
  await atomicWrite(history.paths.current, history.current);
  return history.current;
}

export function recoverAcceptanceGate(options = {}) {
  return withGateTransitionLock(options, () => recoverAcceptanceGateUnlocked(options));
}

async function armAcceptanceGateUnlocked(options = {}) {
  const requestedBinding = binding(options);
  const history = await readHistory(options);
  const token = options.token || newToken();
  const hash = tokenSha256(token);
  if (history.current) {
    if (history.current.state === "armed"
      && history.current.attempt === 1
      && sameBinding(history.current.binding, requestedBinding)
      && history.current.tokenSha256 === hash) {
      return publicResult(history.current, token);
    }
    fail("ACCEPTANCE_GATE_ALREADY_EXISTS", history.current.state);
  }
  const now = instant(options.now, "now");
  const ttlMs = ttlMilliseconds(options.ttlMs);
  const oldActiveSlotId = exactText(options.oldActiveSlotId, "oldActiveSlotId");
  if (oldActiveSlotId === requestedBinding.slotId) fail("ACCEPTANCE_GATE_OLD_ACTIVE_INVALID");
  const receipt = await appendTransition(options, null, {
    event: "armed-after-proxy-commit",
    state: "armed",
    terminal: false,
    rollbackRequired: false,
    attempt: 1,
    maxAttempts: MAX_ATTEMPTS,
    binding: requestedBinding,
    oldActiveSlotId,
    tokenSha256: hash,
    ttlMs,
    armedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + ttlMs).toISOString(),
    firstTimeoutAt: null,
    confirmedAt: null,
  });
  return publicResult(receipt, token);
}

export function armAcceptanceGate(options = {}) {
  return withGateTransitionLock(options, () => armAcceptanceGateUnlocked(options));
}

/** Preferred integration point: use the receipt returned by the successful
 * proxy commit so slot and generation cannot be supplied independently. */
export async function armAcceptanceGateAfterProxyCommit(options = {}) {
  return armAcceptanceGate({ ...options, ...bindingFromCommittedProxy(options) });
}

function assertConfirmation(receipt, options) {
  const requestedBinding = binding(options);
  if (!sameBinding(receipt.binding, requestedBinding)) fail("ACCEPTANCE_GATE_CONFIRMATION_BINDING_MISMATCH");
  const expected = Buffer.from(receipt.tokenSha256, "hex");
  const actual = Buffer.from(tokenSha256(options.token), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    fail("ACCEPTANCE_GATE_CONFIRMATION_TOKEN_MISMATCH");
  }
}

async function evaluateAcceptanceGateUnlocked(options = {}) {
  const current = await recoverAcceptanceGateUnlocked(options);
  if (!current || current.state !== "armed") return current;
  const now = instant(options.now, "now");
  if (now.getTime() < new Date(current.deadlineAt).getTime()) return current;
  if (current.attempt === 1) {
    return appendTransition(options, current, {
      ...current,
      event: "first-timeout-rollback-required",
      state: "rollback-required",
      terminal: false,
      rollbackRequired: true,
      firstTimeoutAt: now.toISOString(),
    });
  }
  return appendTransition(options, current, {
    ...current,
    event: "second-timeout-terminal-old-active",
    state: "failed-old-active",
    terminal: true,
    rollbackRequired: true,
  });
}

export function evaluateAcceptanceGate(options = {}) {
  return withGateTransitionLock(options, () => evaluateAcceptanceGateUnlocked(options));
}

async function confirmAcceptanceGateUnlocked(options = {}) {
  let current = await evaluateAcceptanceGateUnlocked(options);
  if (!current) fail("ACCEPTANCE_GATE_MISSING");
  assertConfirmation(current, options);
  if (current.state === "confirmed") return current;
  if (current.state !== "armed") fail("ACCEPTANCE_GATE_NOT_CONFIRMABLE", current.state);
  const now = instant(options.now, "now");
  current = await appendTransition(options, current, {
    ...current,
    event: "manually-confirmed",
    state: "confirmed",
    terminal: true,
    rollbackRequired: false,
    confirmedAt: now.toISOString(),
  });
  return current;
}

export function confirmAcceptanceGate(options = {}) {
  return withGateTransitionLock(options, () => confirmAcceptanceGateUnlocked(options));
}

function runtimeFailure(options, recordedAt) {
  const code = exactText(options.failureCode || "NEW_ACTIVE_RUNTIME_EXITED", "failureCode", 160);
  const detail = String(options.failureDetail ?? "")
    .replace(/[\u0000\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
  return { code, detail: detail || null, recordedAt: recordedAt.toISOString() };
}

/**
 * Durably converts an unexpected New-Active exit into the rollback state
 * before the Supervisor begins rollback. The full release/slot/generation
 * binding is inherited from the armed receipt and cannot be replaced by the
 * failure reporter.
 */
export function failAcceptanceGate(options = {}) {
  return withGateTransitionLock(options, async () => {
    const current = await recoverAcceptanceGateUnlocked(options);
    if (!current) fail("ACCEPTANCE_GATE_MISSING");
    if (current.state === "rollback-required" || current.state === "failed-old-active") return current;
    if (current.state !== "armed") fail("ACCEPTANCE_GATE_NOT_RUNTIME_FAILABLE", current.state);
    const now = instant(options.now, "now");
    if (current.attempt === 1) {
      return appendTransition(options, current, {
        ...current,
        event: "new-active-runtime-failed-rollback-required",
        state: "rollback-required",
        terminal: false,
        rollbackRequired: true,
        runtimeFailure: runtimeFailure(options, now),
      });
    }
    return appendTransition(options, current, {
      ...current,
      event: "retry-active-runtime-failed-terminal-old-active",
      state: "failed-old-active",
      terminal: true,
      rollbackRequired: true,
      runtimeFailure: runtimeFailure(options, now),
      recoveryDisposition: "old-active-terminal",
    });
  });
}

/** Persist the Monitor grant deadline while Old Active is serving and the
 * operator is deciding whether to consume the sole retry. */
export function bindAcceptanceRetryChoiceDeadline(options = {}) {
  return withGateTransitionLock(options, async () => {
    const current = await recoverAcceptanceGateUnlocked(options);
    if (!current) fail("ACCEPTANCE_GATE_MISSING");
    if (current.state !== "rollback-required" || current.attempt !== 1) {
      fail("ACCEPTANCE_GATE_RETRY_CHOICE_NOT_BINDABLE", current.state);
    }
    const deadline = instant(options.deadlineAt, "retryChoiceDeadlineAt");
    const now = instant(options.now, "now");
    if (deadline.getTime() <= now.getTime()) fail("ACCEPTANCE_GATE_RETRY_CHOICE_DEADLINE_INVALID");
    const deadlineAt = deadline.toISOString();
    if (current.retryChoiceDeadlineAt) {
      if (current.retryChoiceDeadlineAt !== deadlineAt) fail("ACCEPTANCE_GATE_RETRY_CHOICE_DEADLINE_CONFLICT");
      return current;
    }
    return appendTransition(options, current, {
      ...current,
      event: "retry-choice-deadline-bound",
      retryChoiceDeadlineAt: deadlineAt,
    });
  });
}

/**
 * Ends awaiting-retry without starting a retry. RETRY_WINDOW_EXPIRED is
 * accepted only at/after the persistently bound grant deadline; an explicit
 * abandon code may terminate earlier. Old Active is already serving here.
 */
export function expireAcceptanceRetryChoice(options = {}) {
  return withGateTransitionLock(options, async () => {
    const current = await recoverAcceptanceGateUnlocked(options);
    if (!current) fail("ACCEPTANCE_GATE_MISSING");
    if (current.state === "failed-old-active" && current.terminal) return current;
    if (current.state !== "rollback-required" || current.attempt !== 1) {
      fail("ACCEPTANCE_GATE_RETRY_CHOICE_NOT_EXPIRABLE", current.state);
    }
    const now = instant(options.now, "now");
    const code = exactText(options.failureCode || "RETRY_WINDOW_EXPIRED", "failureCode", 160);
    const suppliedDeadline = options.deadlineAt === undefined
      ? null
      : instant(options.deadlineAt, "retryChoiceDeadlineAt").toISOString();
    const deadlineAt = current.retryChoiceDeadlineAt || suppliedDeadline;
    if (!deadlineAt) fail("ACCEPTANCE_GATE_RETRY_CHOICE_DEADLINE_MISSING");
    if (current.retryChoiceDeadlineAt && suppliedDeadline && current.retryChoiceDeadlineAt !== suppliedDeadline) {
      fail("ACCEPTANCE_GATE_RETRY_CHOICE_DEADLINE_CONFLICT");
    }
    if (code === "RETRY_WINDOW_EXPIRED" && now.getTime() < new Date(deadlineAt).getTime()) {
      fail("ACCEPTANCE_GATE_RETRY_CHOICE_NOT_EXPIRED");
    }
    return appendTransition(options, current, {
      ...current,
      event: code === "RETRY_WINDOW_EXPIRED"
        ? "retry-choice-window-expired-old-active"
        : "retry-choice-abandoned-old-active",
      state: "failed-old-active",
      terminal: true,
      rollbackRequired: false,
      attempt: 2,
      retryChoiceDeadlineAt: deadlineAt,
      retryChoiceFailure: runtimeFailure({ ...options, failureCode: code }, now),
      recoveryDisposition: "old-active-terminal",
    });
  });
}

function assertRetryToken(receipt, token) {
  const expected = Buffer.from(String(receipt.retryTokenSha256 || ""), "hex");
  const actual = Buffer.from(tokenSha256(token), "hex");
  if (expected.length !== 32 || actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) {
    fail("ACCEPTANCE_GATE_RETRY_TOKEN_MISMATCH");
  }
}

async function startAcceptanceRetryUnlocked(options = {}) {
  const current = await recoverAcceptanceGateUnlocked(options);
  if (!current) fail("ACCEPTANCE_GATE_MISSING");
  const requestedBinding = binding(options);
  const retryToken = options.retryToken || newToken();
  const retryTokenSha256 = tokenSha256(retryToken);
  if (current.state === "retry-started"
      && current.attempt === 2
      && sameBinding(current.binding, requestedBinding)
      && current.retryTokenSha256 === retryTokenSha256) {
    return { receipt: current, retryToken };
  }
  if (current.state !== "rollback-required" || current.attempt !== 1) {
    fail("ACCEPTANCE_GATE_RETRY_NOT_ALLOWED", current.state);
  }
  if (options.oldActiveRestored !== true) fail("ACCEPTANCE_GATE_OLD_ACTIVE_NOT_RESTORED");
  if (!sameBinding(current.binding, requestedBinding)) fail("ACCEPTANCE_GATE_RETRY_BINDING_INVALID");
  const now = instant(options.now, "now");
  if (current.retryChoiceDeadlineAt
      && now.getTime() >= new Date(current.retryChoiceDeadlineAt).getTime()) {
    await appendTransition(options, current, {
      ...current,
      event: "retry-choice-window-expired-old-active",
      state: "failed-old-active",
      terminal: true,
      rollbackRequired: false,
      attempt: 2,
      retryChoiceFailure: runtimeFailure({ ...options, failureCode: "RETRY_WINDOW_EXPIRED" }, now),
      recoveryDisposition: "old-active-terminal",
    });
    fail("ACCEPTANCE_GATE_RETRY_CHOICE_EXPIRED");
  }
  const receipt = await appendTransition(options, current, {
    ...current,
    event: "single-retry-consumed-before-probe",
    state: "retry-started",
    terminal: false,
    rollbackRequired: false,
    attempt: 2,
    retryStartedAt: now.toISOString(),
    retryTokenSha256,
    recoveryDisposition: "resume-retry-once-or-keep-old-active",
  });
  return { receipt, retryToken };
}

/** Persistently consumes the sole retry before any Candidate probe/cutover. */
export function startAcceptanceRetry(options = {}) {
  return withGateTransitionLock(options, () => startAcceptanceRetryUnlocked(options));
}

async function armAcceptanceRetryUnlocked(options = {}) {
  const current = await recoverAcceptanceGateUnlocked(options);
  if (!current) fail("ACCEPTANCE_GATE_MISSING");
  const requestedBinding = binding(options);
  const token = options.token || newToken();
  const hash = tokenSha256(token);
  if (current.state === "armed" && current.attempt === 2
      && sameBinding(current.binding, requestedBinding) && current.tokenSha256 === hash) {
    return publicResult(current, token);
  }
  if (current.state !== "retry-started" || current.attempt !== 2) {
    fail("ACCEPTANCE_GATE_RETRY_NOT_ALLOWED", current.state);
  }
  assertRetryToken(current, options.retryToken);
  if (!sameRelease(current.binding, requestedBinding)
      || requestedBinding.proxyGeneration <= current.binding.proxyGeneration) {
    fail("ACCEPTANCE_GATE_RETRY_BINDING_INVALID");
  }
  const now = instant(options.now, "now");
  const ttlMs = ttlMilliseconds(options.ttlMs);
  const receipt = await appendTransition(options, current, {
    ...current,
    event: "single-retry-armed-after-proxy-commit",
    state: "armed",
    terminal: false,
    rollbackRequired: false,
    attempt: 2,
    binding: requestedBinding,
    tokenSha256: hash,
    ttlMs,
    armedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + ttlMs).toISOString(),
    confirmedAt: null,
  });
  return publicResult(receipt, token);
}

export function armAcceptanceRetry(options = {}) {
  return withGateTransitionLock(options, () => armAcceptanceRetryUnlocked(options));
}

export async function armAcceptanceRetryAfterProxyCommit(options = {}) {
  return armAcceptanceRetry({ ...options, ...bindingFromCommittedProxy(options) });
}

export function classifyAcceptanceGateRecovery(options = {}) {
  return withGateTransitionLock(options, async () => {
    const current = await recoverAcceptanceGateUnlocked(options);
    if (!current) return { receipt: null, action: "none" };
    if (current.state !== "retry-started") return { receipt: current, action: "continue-state" };
    if (!options.retryToken) return { receipt: current, action: "terminalize-on-old-active" };
    try {
      assertRetryToken(current, options.retryToken);
      return { receipt: current, action: "resume-retry-once" };
    } catch (error) {
      if (!new Set([
        "ACCEPTANCE_GATE_RETRY_TOKEN_MISMATCH",
        "ACCEPTANCE_GATE_TOKEN_INVALID",
        "ACCEPTANCE_GATE_TOKEN_ENTROPY_INSUFFICIENT",
      ]).has(error?.code)) throw error;
      return { receipt: current, action: "terminalize-on-old-active" };
    }
  });
}

export function terminalizeStartedAcceptanceRetry(options = {}) {
  return withGateTransitionLock(options, async () => {
    const current = await recoverAcceptanceGateUnlocked(options);
    if (!current) fail("ACCEPTANCE_GATE_MISSING");
    if (current.state === "failed-old-active" && current.terminal) return current;
    if (current.state !== "retry-started" || current.attempt !== 2) {
      fail("ACCEPTANCE_GATE_RETRY_NOT_TERMINALIZABLE", current.state);
    }
    return appendTransition(options, current, {
      ...current,
      event: "started-retry-abandoned-on-old-active",
      state: "failed-old-active",
      terminal: true,
      rollbackRequired: false,
      recoveryDisposition: "old-active-terminal",
    });
  });
}
