import { createHmac, timingSafeEqual } from "node:crypto";

export const WINDOWS_CONTROL_STOP_SCHEMA = "bonni.windows-control-stop/v1";
export const WINDOWS_CONTROL_STOP_RESPONSE_SCHEMA = "bonni.windows-control-stop-response/v1";
export const WINDOWS_CONTROL_STOP_ACTION = "stop";
export const WINDOWS_CONTROL_STOP_MAX_CLOCK_SKEW_MS = 30_000;

// A signed request can remain valid for at most twice the permitted clock skew:
// it may be accepted at the earliest edge of its window and replayed at the
// latest edge. Keep only that bounded window, and fail closed rather than evict
// a nonce which could still authenticate a replay.
const WINDOWS_CONTROL_STOP_REPLAY_RETENTION_MS = 2 * WINDOWS_CONTROL_STOP_MAX_CLOCK_SKEW_MS;
const WINDOWS_CONTROL_STOP_MAX_REPLAY_NONCES = 4_096;
const replayExpirations = new WeakMap();

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const NONCE = /^[a-f0-9]{64}$/u;
const PROOF = /^[A-Za-z0-9_-]{43}$/u;
const EXPECTED_KEYS = Object.freeze([
  "schemaVersion",
  "action",
  "requestId",
  "supervisorInstanceId",
  "ownerPid",
  "supervisorPid",
  "issuedAt",
  "nonce",
  "proof",
]);

function stopError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactKeys(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === EXPECTED_KEYS.length
    && EXPECTED_KEYS.every((key) => Object.hasOwn(value, key));
}

function sameStopRequest(left, right) {
  return Boolean(left && right)
    && Object.keys(left).length === EXPECTED_KEYS.length
    && Object.keys(right).length === EXPECTED_KEYS.length
    && EXPECTED_KEYS.every((key) => Object.hasOwn(left, key)
      && Object.hasOwn(right, key)
      && left[key] === right[key]);
}

export function classifyWindowsControlStopAttempt({
  request,
  acceptedRequest = null,
  state = "idle",
  stopPromiseActive = false,
  stopping = false,
  stopReason = null,
  acceptedRequestId = null,
  busy = false,
} = {}) {
  const exact = sameStopRequest(request, acceptedRequest);
  if (exact) {
    if (state === "running" && stopPromiseActive && stopping && stopReason === "WINDOWS_UI") {
      return Object.freeze({
        exact: true,
        kind: "retry-running",
        statusCode: 202,
        accepted: true,
        alreadyStopping: true,
        error: null,
      });
    }
    return Object.freeze({
      exact: true,
      kind: "reject",
      statusCode: 409,
      accepted: false,
      alreadyStopping: false,
      error: state === "failed"
        ? "WINDOWS_CONTROL_STOP_FAILED"
        : "WINDOWS_CONTROL_STOP_NOT_RUNNING",
    });
  }
  if (acceptedRequestId) {
    return Object.freeze({
      exact: false,
      kind: "reject",
      statusCode: 409,
      accepted: false,
      alreadyStopping: false,
      error: state === "failed"
        ? "WINDOWS_CONTROL_STOP_FAILED"
        : "WINDOWS_CONTROL_STOP_ALREADY_ACCEPTED",
    });
  }
  if (stopping || stopPromiseActive || stopReason) {
    return Object.freeze({
      exact: false,
      kind: "reject",
      statusCode: 409,
      accepted: false,
      alreadyStopping: false,
      error: "WINDOWS_CONTROL_STOP_CONFLICTING_SHUTDOWN",
    });
  }
  if (busy) {
    return Object.freeze({
      exact: false,
      kind: "reject",
      statusCode: 423,
      accepted: false,
      alreadyStopping: false,
      error: "WINDOWS_CONTROL_STOP_BUSY",
    });
  }
  return Object.freeze({
    exact: false,
    kind: "accept",
    statusCode: 202,
    accepted: true,
    alreadyStopping: false,
    error: null,
  });
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validInstanceId(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function replayExpirationMap(usedNonces) {
  let expirations = replayExpirations.get(usedNonces);
  if (!expirations) {
    expirations = new Map();
    replayExpirations.set(usedNonces, expirations);
  }
  return expirations;
}

function reserveReplayNonce(usedNonces, nonce, now) {
  if (!usedNonces) return;

  // Preserve compatibility with the original small has/add interface. The
  // supervisor passes a native Set, for which this module can additionally
  // provide bounded and time-pruned storage without changing its public API.
  if (!(usedNonces instanceof Set)) {
    if (usedNonces.has(nonce)) throw stopError("WINDOWS_CONTROL_STOP_REPLAY");
    usedNonces.add(nonce);
    return;
  }

  const expirations = replayExpirationMap(usedNonces);
  for (const [rememberedNonce, expiresAt] of expirations) {
    // Keep the Set and its private expiry index as one logical data
    // structure. If a caller removed an entry from the Set, its expiry must
    // not continue consuming capacity; expired entries disappear from both.
    if (!usedNonces.has(rememberedNonce)) {
      expirations.delete(rememberedNonce);
      continue;
    }
    if (expiresAt > now) continue;
    expirations.delete(rememberedNonce);
    usedNonces.delete(rememberedNonce);
  }
  if (usedNonces.has(nonce)) {
    // Native Sets supplied by older callers may already contain a nonce
    // without an expiry entry. Record a bounded expiry before rejecting so a
    // mixed-version caller cannot leave the two bookkeeping views divergent.
    if (!expirations.has(nonce)) {
      if (expirations.size >= WINDOWS_CONTROL_STOP_MAX_REPLAY_NONCES) {
        throw stopError("WINDOWS_CONTROL_STOP_REPLAY_CACHE_FULL");
      }
      expirations.set(nonce, now + WINDOWS_CONTROL_STOP_REPLAY_RETENTION_MS);
    }
    throw stopError("WINDOWS_CONTROL_STOP_REPLAY");
  }
  if (usedNonces.size >= WINDOWS_CONTROL_STOP_MAX_REPLAY_NONCES
    || expirations.size >= WINDOWS_CONTROL_STOP_MAX_REPLAY_NONCES) {
    throw stopError("WINDOWS_CONTROL_STOP_REPLAY_CACHE_FULL");
  }
  usedNonces.add(nonce);
  expirations.set(nonce, now + WINDOWS_CONTROL_STOP_REPLAY_RETENTION_MS);
}

export function windowsControlStopMessage(value) {
  return [
    WINDOWS_CONTROL_STOP_SCHEMA,
    WINDOWS_CONTROL_STOP_ACTION,
    String(value.requestId),
    String(value.supervisorInstanceId),
    String(value.ownerPid),
    String(value.supervisorPid),
    String(value.issuedAt),
    String(value.nonce),
  ].join("\n");
}

export function signWindowsControlStopRequest(value, token) {
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw stopError("WINDOWS_CONTROL_STOP_TOKEN_INVALID");
  }
  return createHmac("sha256", token)
    .update(windowsControlStopMessage(value), "utf8")
    .digest("base64url");
}

export function verifyWindowsControlStopRequest(value, {
  token,
  supervisorInstanceId,
  ownerPid,
  supervisorPid,
  now = Date.now(),
  usedNonces = null,
} = {}) {
  if (!exactKeys(value)
    || value.schemaVersion !== WINDOWS_CONTROL_STOP_SCHEMA
    || value.action !== WINDOWS_CONTROL_STOP_ACTION
    || typeof value.requestId !== "string"
    || !REQUEST_ID.test(value.requestId)
    || !validInstanceId(value.supervisorInstanceId)
    || value.supervisorInstanceId !== supervisorInstanceId
    || !validPid(value.ownerPid)
    || value.ownerPid !== ownerPid
    || !validPid(value.supervisorPid)
    || value.supervisorPid !== supervisorPid
    || !Number.isFinite(now)
    || typeof value.issuedAt !== "string"
    || !Number.isFinite(Date.parse(value.issuedAt))
    || new Date(Date.parse(value.issuedAt)).toISOString() !== value.issuedAt
    || Math.abs(now - Date.parse(value.issuedAt)) > WINDOWS_CONTROL_STOP_MAX_CLOCK_SKEW_MS
    || typeof value.nonce !== "string"
    || !NONCE.test(value.nonce)
    || typeof value.proof !== "string"
    || !PROOF.test(value.proof)
    || typeof token !== "string"
    || !TOKEN.test(token)) {
    throw stopError("WINDOWS_CONTROL_STOP_AUTH_INVALID");
  }
  // Compare the canonical wire strings rather than their decoded bytes. A
  // base64url decoder accepts multiple final characters for the same SHA-256
  // bytes; accepting those aliases would make an otherwise valid proof
  // textually malleable.
  const expected = Buffer.from(signWindowsControlStopRequest(value, token), "ascii");
  const actual = Buffer.from(value.proof, "ascii");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw stopError("WINDOWS_CONTROL_STOP_AUTH_INVALID");
  }
  reserveReplayNonce(usedNonces, value.nonce, now);
  return Object.freeze({
    requestId: value.requestId,
    supervisorInstanceId: value.supervisorInstanceId,
    ownerPid: value.ownerPid,
    supervisorPid: value.supervisorPid,
    issuedAt: value.issuedAt,
    nonce: value.nonce,
  });
}
