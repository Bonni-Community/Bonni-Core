import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertLocalHostBackendRuntimeLease } from "./runtime-mode-exclusion.mjs";

const PUBLIC_HOST = "127.0.0.1";
const PUBLIC_PORT = 4000;
const ACTIVE_HOST = "127.0.0.1";
const ACTIVE_PORT = 4100;
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}:${PUBLIC_PORT}`;
const PROOF_PATH = "/__bonni/local-start-proof";
const PROOF_SCHEMA = "bonni.local-start-proof/v1";
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_PROOF_BYTES = 16 * 1024;
const MAX_HEALTH_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const EXIT_NOT_READY = 1;
const EXIT_BACKEND_ENDED = 2;
const EXIT_START_CANCELLED = 3;
const EXIT_UNTRUSTED_SERVICE = 20;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const NONCE = /^[a-f0-9]{64}$/u;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "..", "..");
const productRoot = path.resolve(backendRoot, "..", "..");
const hostReceiptPath = path.join(
  productRoot,
  "SYSTEM",
  ".bonni-source-update",
  "control-center",
  "host-backend-runtime.json",
);

function exactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function proofMessage({
  nonce,
  ownerPid,
  childPid,
  backendPid,
  backendStartedAt,
  supervisorInstanceId,
  publicPort,
  generation,
  targetSlotId,
  targetHost,
  targetPort,
  targetReceiptSha256,
}) {
  return [
    PROOF_SCHEMA,
    nonce,
    String(ownerPid),
    String(childPid),
    String(backendPid),
    String(backendStartedAt),
    String(supervisorInstanceId),
    String(publicPort),
    String(generation),
    String(targetSlotId),
    String(targetHost),
    String(targetPort),
    String(targetReceiptSha256),
  ].join("\n");
}

async function readHostReceiptCandidate() {
  const handle = await fs.open(hostReceiptPath, "r").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const [opened, linked] = await Promise.all([handle.stat(), fs.lstat(hostReceiptPath)]);
    if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_RECEIPT_BYTES
      || linked.isSymbolicLink() || !linked.isFile()
      || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw new Error("BONNI_LOCAL_START_RECEIPT_UNSAFE");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!validPid(value?.pid) || typeof value?.token !== "string" || !TOKEN.test(value.token)) {
      throw new Error("BONNI_LOCAL_START_RECEIPT_INVALID");
    }
    return { ownerPid: value.pid, token: value.token };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readVerifiedHostReceipt() {
  const candidate = await readHostReceiptCandidate();
  if (!candidate) return null;
  return assertLocalHostBackendRuntimeLease({
    productRoot,
    ownerPid: candidate.ownerPid,
    token: candidate.token,
  });
}

function portIsOpen(timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: PUBLIC_HOST, port: PUBLIC_PORT });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function boundedBody(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null
    && (!/^(?:0|[1-9][0-9]{0,9})$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("BONNI_LOCAL_START_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumBytes) throw new Error("BONNI_LOCAL_START_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function localFetch(pathname, { timeoutMs = 2_500, maximumBytes = MAX_PROOF_BYTES } = {}) {
  const url = `${PUBLIC_ORIGIN}${pathname}`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json, text/html;q=0.8" },
    });
  } catch (cause) {
    const error = new Error("BONNI_LOCAL_START_ENDPOINT_UNREACHABLE", { cause });
    error.transient = true;
    throw error;
  }
  if (response.url !== url || (response.status >= 300 && response.status < 400)) {
    throw new Error("BONNI_LOCAL_START_REDIRECT_FORBIDDEN");
  }
  return { response, body: await boundedBody(response, maximumBytes) };
}

function parseJsonBody(body, code) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(code);
  }
}

async function verifyProof(receipt) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const { response, body } = await localFetch(`${PROOF_PATH}?nonce=${nonce}`);
  if (response.status === 502 || response.status === 503) return false;
  if (response.status !== 200
    || !String(response.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    throw new Error("BONNI_LOCAL_START_PROOF_HTTP_INVALID");
  }
  const value = parseJsonBody(body, "BONNI_LOCAL_START_PROOF_JSON_INVALID");
  const keys = [
    "schemaVersion", "service", "nonce", "ownerPid", "childPid", "backendPid",
    "backendStartedAt", "supervisorInstanceId", "publicPort", "generation",
    "targetSlotId", "targetHost", "targetPort", "targetReceiptSha256", "proof",
  ];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== PROOF_SCHEMA
    || value.service !== "bonni-local-run-controller"
    || value.nonce !== nonce || !NONCE.test(value.nonce)
    || value.ownerPid !== receipt.pid
    || value.childPid !== receipt.childPid || !validPid(value.childPid)
    || !validPid(value.backendPid)
    || typeof value.backendStartedAt !== "string"
    || !Number.isFinite(Date.parse(value.backendStartedAt))
    || typeof value.supervisorInstanceId !== "string"
    || value.supervisorInstanceId.length < 1 || value.supervisorInstanceId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.supervisorInstanceId)
    || value.publicPort !== PUBLIC_PORT
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.targetSlotId !== "string" || value.targetSlotId.length < 1
    || value.targetSlotId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.targetSlotId)
    || value.targetHost !== ACTIVE_HOST
    || value.targetPort !== ACTIVE_PORT
    || !(value.targetReceiptSha256 === null
      || (typeof value.targetReceiptSha256 === "string"
        && /^[a-f0-9]{64}$/u.test(value.targetReceiptSha256)))
    || typeof value.proof !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.proof)) {
    throw new Error("BONNI_LOCAL_START_PROOF_SHAPE_INVALID");
  }
  const expected = crypto.createHmac("sha256", receipt.token)
    .update(proofMessage(value))
    .digest();
  const actual = Buffer.from(value.proof, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("BONNI_LOCAL_START_PROOF_MISMATCH");
  }
  return value;
}

async function verifyHealthAndPage(proof) {
  const healthResult = await localFetch("/api/health/ready", { maximumBytes: MAX_HEALTH_BYTES });
  if (healthResult.response.status === 502 || healthResult.response.status === 503) return false;
  const healthType = String(healthResult.response.headers.get("content-type") || "").toLowerCase();
  if (healthResult.response.status !== 200 || !healthType.startsWith("application/json")) {
    throw new Error("BONNI_LOCAL_START_HEALTH_HTTP_INVALID");
  }
  const health = parseJsonBody(healthResult.body, "BONNI_LOCAL_START_HEALTH_JSON_INVALID");
  if (health?.ok !== true || !["ready", "degraded"].includes(health?.state)
    || health?.runtime?.slotRole !== "active" || health?.runtime?.updateProbeMode !== false
    || health?.runtime?.pid !== proof.backendPid
    || typeof health?.runtime?.startedAt !== "string"
    || !Number.isFinite(Date.parse(health.runtime.startedAt))
    || Math.abs(Date.parse(health.runtime.startedAt) - Date.parse(proof.backendStartedAt)) > 60_000) {
    throw new Error("BONNI_LOCAL_START_HEALTH_SHAPE_INVALID");
  }

  const pageResult = await localFetch("/", { maximumBytes: MAX_PAGE_BYTES });
  if (pageResult.response.status === 502 || pageResult.response.status === 503) return false;
  const pageType = String(pageResult.response.headers.get("content-type") || "").toLowerCase();
  if (pageResult.response.status !== 200 || !/^text\/html(?:\s*;|$)/u.test(pageType)) {
    throw new Error("BONNI_LOCAL_START_PAGE_HTTP_INVALID");
  }
  const prefix = pageResult.body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (!prefix.startsWith("<!doctype html") && !prefix.startsWith("<html")) {
    throw new Error("BONNI_LOCAL_START_PAGE_SHAPE_INVALID");
  }
  return health;
}

function sameProofRuntime(left, right) {
  return [
    "ownerPid", "childPid", "backendPid", "backendStartedAt", "supervisorInstanceId",
    "publicPort", "generation", "targetSlotId", "targetHost", "targetPort",
    "targetReceiptSha256",
  ].every((field) => left?.[field] === right?.[field]);
}

function sameHostReceipt(left, right) {
  return ["schemaVersion", "pid", "childPid", "token", "entry", "startedAt"]
    .every((field) => left?.[field] === right?.[field]);
}

function stableDiagnosticCode(error, fallback = "BONNI_LOCAL_START_NOT_READY") {
  const candidate = String(error?.code || error?.message || "").trim();
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(candidate) ? candidate : fallback;
}

function emitDiagnostic(phase, state, code) {
  const acceptedPhases = new Set(["receipt", "proof", "health", "page", "binding", "ready"]);
  const acceptedStates = new Set(["waiting", "failed", "ready"]);
  const safePhase = acceptedPhases.has(phase) ? phase : "binding";
  const safeState = acceptedStates.has(state) ? state : "failed";
  const safeCode = /^[A-Z][A-Z0-9_]{2,127}$/u.test(String(code || ""))
    ? String(code)
    : "BONNI_LOCAL_START_DIAGNOSTIC_INVALID";
  console.info(`[DIAGNOSE] phase=${safePhase}; state=${safeState}; code=${safeCode}`);
}

async function runReadinessPhase(phase, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && !error.readinessPhase) {
      error.readinessPhase = phase;
    }
    throw error;
  }
}

async function checkReadiness({ report = null } = {}) {
  const note = typeof report === "function" ? report : () => {};
  let receipt;
  try {
    receipt = await readVerifiedHostReceipt();
  } catch (error) {
    const open = await portIsOpen();
    note("receipt", "failed", stableDiagnosticCode(error, "BONNI_LOCAL_START_RECEIPT_INVALID"));
    return open ? EXIT_UNTRUSTED_SERVICE : EXIT_NOT_READY;
  }
  if (!receipt || receipt.childPid === null) {
    const open = await portIsOpen();
    note(
      "receipt",
      open ? "failed" : "waiting",
      open ? "BONNI_LOCAL_START_UNBOUND_SERVICE" : "BONNI_LOCAL_START_RECEIPT_NOT_READY",
    );
    return open ? EXIT_UNTRUSTED_SERVICE : EXIT_NOT_READY;
  }
  note("receipt", "ready", "BONNI_LOCAL_START_RECEIPT_VALID");

  try {
    const firstProof = await runReadinessPhase("proof", () => verifyProof(receipt));
    if (!firstProof) {
      note("proof", "waiting", "BONNI_LOCAL_START_PROOF_NOT_READY");
      return EXIT_NOT_READY;
    }
    note("proof", "ready", "BONNI_LOCAL_START_PROOF_VALID");

    const healthAndPage = await runReadinessPhase("health", () => verifyHealthAndPage(firstProof));
    if (!healthAndPage) {
      note("health", "waiting", "BONNI_LOCAL_START_HEALTH_NOT_READY");
      return EXIT_NOT_READY;
    }
    note("health", "ready", "BONNI_LOCAL_START_HEALTH_VALID");
    note("page", "ready", "BONNI_LOCAL_START_PAGE_VALID");

    const secondProof = await runReadinessPhase("binding", () => verifyProof(receipt));
    if (!secondProof || !sameProofRuntime(firstProof, secondProof)) {
      note("binding", "failed", "BONNI_LOCAL_START_PROOF_BINDING_CHANGED");
      return EXIT_NOT_READY;
    }
    const recheckedReceipt = await runReadinessPhase("binding", () => readVerifiedHostReceipt());
    if (!recheckedReceipt || !sameHostReceipt(receipt, recheckedReceipt)) {
      note("binding", "failed", "BONNI_LOCAL_START_RECEIPT_BINDING_CHANGED");
      return EXIT_NOT_READY;
    }
    note("binding", "ready", "BONNI_LOCAL_START_BINDING_VALID");
    note("ready", "ready", "BONNI_LOCAL_START_READY");
    return 0;
  } catch (error) {
    const code = stableDiagnosticCode(error);
    const reportedPhase = code.includes("_PAGE_")
      ? "page"
      : code.includes("_HEALTH_")
        ? "health"
        : error?.readinessPhase;
    const phase = ["receipt", "proof", "health", "page", "binding", "ready"]
      .includes(reportedPhase)
      ? reportedPhase
      : "binding";
    const open = await portIsOpen();
    note(phase, error?.transient ? "waiting" : "failed", code);
    if (error?.transient) return EXIT_NOT_READY;
    return open ? EXIT_UNTRUSTED_SERVICE : EXIT_NOT_READY;
  }
}

function parseArguments(argv) {
  const options = {
    mode: "check",
    waitSeconds: 0,
    resultFile: null,
    cancelFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.mode = "check";
    else if (argument === "--port-open") options.mode = "port";
    else if (argument === "--diagnose") options.mode = "diagnose";
    else if (argument === "--wait-seconds") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 600) {
        throw new Error("BONNI_LOCAL_START_WAIT_INVALID");
      }
      options.mode = "wait";
      options.waitSeconds = value;
    } else if (argument === "--result-file") {
      const value = argv[++index];
      if (!value || value.includes("\0") || !path.isAbsolute(value)) {
        throw new Error("BONNI_LOCAL_START_RESULT_FILE_INVALID");
      }
      options.resultFile = path.resolve(value);
    } else if (argument === "--cancel-file") {
      const value = argv[++index];
      if (!value || value.includes("\0") || !path.isAbsolute(value)) {
        throw new Error("BONNI_LOCAL_START_CANCEL_FILE_INVALID");
      }
      const resolved = path.resolve(value);
      const cancelRoot = path.join(productRoot, "RUN_SYSTEM", "windows-start");
      const relative = path.relative(cancelRoot, resolved);
      if (!relative
        || path.isAbsolute(relative)
        || relative.startsWith(`..${path.sep}`)
        || relative === ".."
        || !/^start-cancel-[a-f0-9]{32}\.cancel$/u.test(path.basename(resolved))) {
        throw new Error("BONNI_LOCAL_START_CANCEL_FILE_INVALID");
      }
      options.cancelFile = resolved;
    } else throw new Error("BONNI_LOCAL_START_ARGUMENT_INVALID");
  }
  return options;
}

async function cancellationRequested(file) {
  if (!file) return false;
  const state = await fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isFile() || state.isSymbolicLink() || state.size <= 0 || state.size > 256) {
    throw new Error("BONNI_LOCAL_START_CANCEL_FILE_UNSAFE");
  }
  return true;
}

async function resultFileExists(file) {
  if (!file) return false;
  const state = await fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return Boolean(state?.isFile() && !state.isSymbolicLink());
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "port") return await portIsOpen() ? 0 : EXIT_NOT_READY;
  if (options.mode === "check") return checkReadiness();
  if (options.mode === "diagnose") return checkReadiness({ report: emitDiagnostic });
  const deadline = Date.now() + options.waitSeconds * 1_000;
  while (Date.now() < deadline) {
    if (await cancellationRequested(options.cancelFile)) return EXIT_START_CANCELLED;
    if (await resultFileExists(options.resultFile)) return EXIT_BACKEND_ENDED;
    const result = await checkReadiness();
    if (result === 0 || result === EXIT_UNTRUSTED_SERVICE) return result;
    if (await cancellationRequested(options.cancelFile)) return EXIT_START_CANCELLED;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return EXIT_NOT_READY;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = EXIT_UNTRUSTED_SERVICE; },
  );
}

export {
  checkReadiness,
  proofMessage,
};
