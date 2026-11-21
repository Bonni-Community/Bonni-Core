import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { getRunSystemSystemRoot } from "../../../../system/boot/run-system/index.js";
import { logger } from "../../../../core/logger/logger.js";
import { privateText } from "../../../../../scripts/runtime/log-privacy.mjs";
import { cleanPrivateLogFile } from "../../../../../scripts/runtime/log-privacy-files.mjs";
import { createPrivateErrorStream } from "../../../../../scripts/runtime/log-private-stream.mjs";

type EmergencyControlConfig = {
  enabled: boolean;
  autoStart: boolean;
  autoStartDelayMs: number;
  port: number;
  bind: string;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
};

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams;
  startedAt: string;
  ownerToken: string;
  stopRequested: boolean;
  processGroup: boolean;
};

type EmergencyPidReceipt = {
  schemaVersion: "bonni.emergency-process/v1" | "legacy-pid/v0";
  pid: number;
  ownerToken: string | null;
  startedAt: string | null;
  processGroup: boolean;
};

const DEFAULT_CONFIG: EmergencyControlConfig = {
  enabled: false,
  autoStart: true,
  autoStartDelayMs: 120_000,
  port: 4001,
  bind: "127.0.0.1",
  lastChangedAt: null,
  lastChangedBy: null,
};

const HEALTH_TIMEOUT_MS = 1_500;
const START_WAIT_MS = 12_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const PROCESS_STOP_POLL_INTERVAL_MS = 100;
const TASKKILL_TIMEOUT_MS = 10_000;
let managedProcess: ManagedProcess | null = null;
let scheduledAutoStart: NodeJS.Timeout | null = null;
let autoStartScheduledFor: string | null = null;
let lifecycleTail: Promise<void> = Promise.resolve();
let lifecycleGeneration = 0;
let localShutdownHold = false;

function withEmergencyLifecycleLock<T>(operation: () => Promise<T>) {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.then(() => undefined, () => undefined);
  return result;
}

function isLocalSupervisorStopReason(reason: string) {
  return reason === "local-source-update"
    || reason === "local-source-supervisor-disconnected";
}

function controlFilePath() {
  return path.join(getRunSystemSystemRoot(), "emergency-control.json");
}

function pidFilePath() {
  return path.join(getRunSystemSystemRoot(), "emergency", "emergency.pid");
}

function logFilePath() {
  return path.join(getRunSystemSystemRoot(), "emergency", "emergency.log");
}

async function ensureEmergencyDirectory() {
  await fs.mkdir(path.dirname(pidFilePath()), { recursive: true });
}

function clampDelay(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONFIG.autoStartDelayMs;
  return Math.max(0, Math.min(Math.round(number), 24 * 60 * 60 * 1000));
}

function normalizeConfig(raw: Partial<EmergencyControlConfig> | null | undefined): EmergencyControlConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw || {}),
    enabled: Boolean(raw?.enabled ?? DEFAULT_CONFIG.enabled),
    autoStart: Boolean(raw?.autoStart ?? DEFAULT_CONFIG.autoStart),
    autoStartDelayMs: clampDelay(raw?.autoStartDelayMs ?? DEFAULT_CONFIG.autoStartDelayMs),
    port: Number.isFinite(Number(raw?.port)) ? Number(raw?.port) : DEFAULT_CONFIG.port,
    bind: String(raw?.bind || DEFAULT_CONFIG.bind),
    lastChangedAt: raw?.lastChangedAt || null,
    lastChangedBy: raw?.lastChangedBy || null,
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Emergency control config konnte nicht gelesen werden", {
        module: "emergency-control",
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readEmergencyControlConfig(): Promise<EmergencyControlConfig> {
  return normalizeConfig(await readJson<Partial<EmergencyControlConfig>>(controlFilePath()));
}

export async function updateEmergencyControlConfig(
  patch: Partial<EmergencyControlConfig>,
  actor: string | null = null,
) {
  const current = await readEmergencyControlConfig();
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<EmergencyControlConfig>;
  const next = normalizeConfig({
    ...current,
    ...definedPatch,
    lastChangedAt: new Date().toISOString(),
    lastChangedBy: actor,
  });

  await writeJson(controlFilePath(), next);

  if (!next.enabled || !next.autoStart) {
    clearEmergencyAutoStartSchedule();
  } else {
    scheduleEmergencyAutoStart("settings-updated").catch((error) => {
      logger.warn("Emergency-Autostart konnte nicht geplant werden", {
        module: "emergency-control",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return getEmergencyControlStatus();
}

function isWindows() {
  return process.platform === "win32";
}

function emergencyCommand() {
  const entryPoint = String(process.argv[1] || "").replace(/\\/g, "/");
  const script = entryPoint.includes("/dist/") ? "redundant:start" : "redundant:dev";

  return isWindows()
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script}`] }
    : { command: "npm", args: ["run", script] };
}

function emergencyProcessError(code: string, detail = "") {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.name = "EmergencyProcessError";
  return error;
}

async function readPidReceipt(): Promise<EmergencyPidReceipt | null> {
  try {
    const raw = (await fs.readFile(pidFilePath(), "utf8")).trim();
    if (/^[1-9][0-9]*$/u.test(raw)) {
      const pid = Number(raw);
      if (Number.isSafeInteger(pid)) {
        return {
          schemaVersion: "legacy-pid/v0",
          pid,
          ownerToken: null,
          startedAt: null,
          processGroup: false,
        };
      }
    }

    const parsed = JSON.parse(raw) as Partial<EmergencyPidReceipt> | null;
    const startedAt = typeof parsed?.startedAt === "string" ? parsed.startedAt : "";
    if (
      parsed?.schemaVersion !== "bonni.emergency-process/v1"
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.ownerToken !== "string"
      || parsed.ownerToken.length < 16
      || parsed.ownerToken.length > 128
      || !Number.isFinite(Date.parse(startedAt))
    ) throw emergencyProcessError("EMERGENCY_PID_RECEIPT_INVALID");
    return {
      schemaVersion: parsed.schemaVersion,
      pid: Number(parsed.pid),
      ownerToken: parsed.ownerToken,
      startedAt,
      processGroup: parsed.processGroup === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw emergencyProcessError("EMERGENCY_PID_RECEIPT_INVALID");
    }
    throw error;
  }
}

async function readPidFromFile() {
  return (await readPidReceipt())?.pid || null;
}

export function isEmergencyProcessAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writePid(receipt: EmergencyPidReceipt) {
  await ensureEmergencyDirectory();
  await fs.writeFile(pidFilePath(), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(pidFilePath(), 0o600);
}

function samePidReceipt(left: EmergencyPidReceipt, right: EmergencyPidReceipt) {
  return left.pid === right.pid
    && left.ownerToken === right.ownerToken
    && left.schemaVersion === right.schemaVersion
    && left.processGroup === right.processGroup;
}

async function removePid(expected?: EmergencyPidReceipt | null) {
  const current = await readPidReceipt();
  if (!current) return false;
  if (expected && !samePidReceipt(current, expected)) {
    throw emergencyProcessError("EMERGENCY_PID_RECEIPT_CHANGED", `${expected.pid}:${current.pid}`);
  }
  await fs.rm(pidFilePath());
  return true;
}

let emergencyLogQueue: Promise<unknown> = Promise.resolve();
function appendLog(line: string) {
  const safe = privateText(line);
  emergencyLogQueue = emergencyLogQueue.catch(() => undefined).then(async () => {
    await ensureEmergencyDirectory();
    cleanPrivateLogFile(logFilePath());
    const handle = await fs.open(logFilePath(), "a", 0o600);
    try {
      const state = await handle.stat();
      if (!state.isFile() || state.nlink !== 1) throw new Error("CORE_LOG_FILE_UNSAFE");
      if (state.size > 8 * 1024 * 1024) await handle.truncate(0);
      await handle.writeFile(safe, "utf8");
    } finally { await handle.close(); }
  }).catch(() => { logger.warn("CORE_LOG_WRITE_FAILED", { module: "server" }); });
  return emergencyLogQueue;
}

async function fetchJson(url: string, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function getEmergencyHealth(
  config?: EmergencyControlConfig,
  expectedPid?: number | null,
  expectedStartedAt?: string | null,
) {
  const resolvedConfig = config ?? (await readEmergencyControlConfig());
  const origin = `http://${resolvedConfig.bind === "0.0.0.0" ? "127.0.0.1" : resolvedConfig.bind}:${resolvedConfig.port}`;
  const [ready, notlauf] = await Promise.all([
    fetchJson(`${origin}/api/health/ready`),
    fetchJson(`${origin}/api/runtime/notlauf`),
  ]);

  // Auch eine HTTP-Fehlerantwort (zum Beispiel 503 während des Notlaufs)
  // beweist, dass der redundante Server erreichbar ist. Ob er bereits für
  // Anfragen bereit ist, wird davon getrennt ausgewiesen.
  const reachable = ready.status > 0 || notlauf.status > 0;
  const readyForTraffic = ready.ok || notlauf.ok;
  const runtime = objectValue(objectValue(ready.body)?.runtime);
  const runtimePid = Number(runtime?.pid);
  const slotRole = typeof runtime?.slotRole === "string" ? runtime.slotRole : null;
  const emergencyRole = slotRole === "emergency" || slotRole === "redundant";
  const runtimeStartedAt = typeof runtime?.startedAt === "string" ? runtime.startedAt : null;
  const expectedStartedAtMs = expectedStartedAt ? Date.parse(expectedStartedAt) : Number.NaN;
  const runtimeStartedAtMs = runtimeStartedAt ? Date.parse(runtimeStartedAt) : Number.NaN;
  // In legacy npm launches the receipt can refer to the taskkill tree root
  // while /ready reports its Node descendant. A narrow launch-time window
  // binds both without exposing the random owner token through HTTP.
  const matchesExpectedLaunch = Number.isFinite(expectedStartedAtMs)
    && Number.isFinite(runtimeStartedAtMs)
    && runtimeStartedAtMs >= expectedStartedAtMs - 1_000
    && runtimeStartedAtMs <= expectedStartedAtMs + 60_000;
  const matchesExpectedPid = expectedPid
    ? emergencyRole && runtimePid === expectedPid
    : null;

  return {
    origin,
    reachable,
    readyForTraffic,
    ready,
    notlauf,
    identity: {
      pid: Number.isSafeInteger(runtimePid) && runtimePid > 0 ? runtimePid : null,
      slotRole,
      startedAt: runtimeStartedAt,
      emergencyRole,
      matchesExpectedPid,
      matchesExpectedLaunch: expectedStartedAt ? matchesExpectedLaunch : null,
      matchesExpectedProcess: expectedPid
        ? emergencyRole && (matchesExpectedPid === true || matchesExpectedLaunch)
        : null,
    },
  };
}

export async function getEmergencyControlStatus() {
  const config = await readEmergencyControlConfig();
  const pidReceipt = await readPidReceipt();
  const pidFromFile = pidReceipt?.pid || null;
  const managedPid = managedProcess?.child?.pid || null;
  const pid = managedPid || pidFromFile;
  const processAlive = isEmergencyProcessAlive(pid);
  const health = await getEmergencyHealth(config);

  return {
    ok: true,
    mode: "manual-controlled",
    config,
    process: {
      managed: Boolean(managedProcess),
      pid,
      alive: processAlive,
      startedAt: managedProcess?.startedAt || null,
      pidFile: pidFilePath(),
      pidReceipt: pidReceipt?.schemaVersion || null,
      logFile: logFilePath(),
    },
    health,
    schedule: {
      scheduled: Boolean(scheduledAutoStart),
      scheduledFor: autoStartScheduledFor,
    },
  };
}

async function waitForEmergencyHealthy(
  config: EmergencyControlConfig,
  timeoutMs = START_WAIT_MS,
  cancelled: () => boolean = () => false,
) {
  const start = Date.now();
  let lastHealth = await getEmergencyHealth(config);

  while (Date.now() - start < timeoutMs) {
    if (lastHealth.reachable || cancelled()) {
      return lastHealth;
    }
    await delay(750);
    lastHealth = await getEmergencyHealth(config);
  }

  return lastHealth;
}

function cancelledStartResult(reason: string, spawned = false) {
  return {
    ok: false,
    started: false,
    spawned,
    reason: "EMERGENCY_START_CANCELLED",
    requestedReason: reason,
  };
}

async function startEmergencyBackendLocked(
  reason: string,
  startGeneration: number,
) {
  const cancelled = () => localShutdownHold || lifecycleGeneration !== startGeneration;
  if (cancelled()) return cancelledStartResult(reason);
  const config = await readEmergencyControlConfig();
  if (cancelled()) return cancelledStartResult(reason);

  if (!config.enabled) {
    return {
      ...(await getEmergencyControlStatus()),
      started: false,
      reason: "EMERGENCY_DISABLED",
    };
  }

  const existingHealth = await getEmergencyHealth(config);
  if (cancelled()) return cancelledStartResult(reason);
  if (existingHealth.reachable) {
    return {
      ...(await getEmergencyControlStatus()),
      started: false,
      reason: "ALREADY_REACHABLE",
    };
  }

  const pidFromFile = await readPidFromFile();
  if (cancelled()) return cancelledStartResult(reason);
  if (isEmergencyProcessAlive(pidFromFile)) {
    return {
      ...(await getEmergencyControlStatus()),
      started: false,
      reason: "PROCESS_ALREADY_RUNNING",
    };
  }

  await ensureEmergencyDirectory();
  const { command, args } = emergencyCommand();
  const env = {
    ...process.env,
    PORT: String(config.port),
    LOCAL_AUTH_PORT: String(config.port),
    SYSTEM_SLOT_NAME: "backend-emergency",
    SYSTEM_SLOT_ROLE: "emergency",
    SYSTEM_RUNTIME_SOURCE: "json",
    LOCAL_AUTH_BIND: config.bind,
  };

  if (cancelled()) return cancelledStartResult(reason);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    // A dedicated POSIX process group lets shutdown signal the npm/tsx tree,
    // not only its wrapper PID. Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
    windowsHide: false,
  });

  if (!child.pid) throw emergencyProcessError("EMERGENCY_PROCESS_PID_MISSING");
  const startedAt = new Date().toISOString();
  const ownerToken = randomUUID();
  const pidReceipt: EmergencyPidReceipt = {
    schemaVersion: "bonni.emergency-process/v1",
    pid: child.pid,
    ownerToken,
    startedAt,
    processGroup: process.platform !== "win32",
  };
  managedProcess = {
    child,
    startedAt,
    ownerToken,
    stopRequested: false,
    processGroup: process.platform !== "win32",
  };
  const pidReceiptWritten = writePid(pidReceipt);

  const diagnostic = createPrivateErrorStream((line) => { void appendLog(line); });
  const diagnosticOut = diagnostic.channel(), diagnosticError = diagnostic.channel();
  child.stdout.on("data", (chunk) => diagnosticOut.write(chunk));
  child.stderr.on("data", (chunk) => diagnosticError.write(chunk));
  child.once("close", () => { diagnosticOut.end(); diagnosticError.end(); });
  child.once("exit", (code, signal) => {
    diagnosticOut.write(JSON.stringify({ ok: code === 0, phase: code ? "failed" : "stopped", exitCode: code }) + "\n");
    const currentManagedProcess = managedProcess;
    if (
      currentManagedProcess
      && currentManagedProcess.child.pid === child.pid
      && currentManagedProcess.ownerToken === ownerToken
      && !currentManagedProcess.stopRequested
    ) {
      // Der Wrapper kann enden, während ein Nachfahre weiter Port/DB hält.
      // Deshalb bleiben Verwaltungszustand und PID-Beleg bis zu einem
      // verifizierten stopEmergencyBackend-Lauf als Diagnosebeleg erhalten.
      void pidReceiptWritten.catch((error) => {
        logger.warn("Emergency-PID-Beleg konnte nicht gesichert werden", {
          module: "emergency-control",
          pid: child.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  await pidReceiptWritten;
  if (cancelled()) return cancelledStartResult(reason, true);

  logger.info("Emergency-Backend gestartet", {
    module: "emergency-control",
    reason,
    pid: child.pid,
    port: config.port,
  });

  const health = await waitForEmergencyHealthy(config, START_WAIT_MS, cancelled);
  if (cancelled()) return cancelledStartResult(reason, true);
  return {
    ...(await getEmergencyControlStatus()),
    started: true,
    reason,
    healthAfterStart: health,
  };
}

export function startEmergencyBackend(reason = "manual") {
  const startGeneration = lifecycleGeneration;
  return withEmergencyLifecycleLock(
    () => startEmergencyBackendLocked(reason, startGeneration),
  );
}

interface TaskkillProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type EmergencyKillDependencies = {
  platform?: NodeJS.Platform;
  processGroup?: boolean;
  processAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => unknown;
  spawnTaskkill?: (pid: number) => TaskkillProcess;
  wait?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  taskkillTimeoutMs?: number;
};

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  {
    processAlive,
    wait,
    now,
    pollIntervalMs,
  }: Required<Pick<EmergencyKillDependencies, "processAlive" | "wait" | "now" | "pollIntervalMs">>,
) {
  const startedAt = now();
  while (processAlive(pid)) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) return false;
    await wait(Math.max(1, Math.min(pollIntervalMs, timeoutMs - elapsed)));
  }
  return true;
}

async function runTaskkill(
  pid: number,
  spawnTaskkill: (pid: number) => TaskkillProcess,
  timeoutMs: number,
) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let child: TaskkillProcess | null = null;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child?.off("error", onError);
      child?.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(emergencyProcessError(
      "EMERGENCY_TASKKILL_SPAWN_FAILED",
      error.message,
    ));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && signal === null) {
        finish();
        return;
      }
      finish(emergencyProcessError(
        "EMERGENCY_TASKKILL_FAILED",
        signal ? `signal-${signal}` : `exit-${code ?? "unknown"}`,
      ));
    };
    const startTimeout = () => setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Der Taskkill-Hilfsprozess ist nur best-effort abbrechbar. Der
        // eigentliche Emergency-PID-Beleg bleibt wegen des Fehlers erhalten.
      }
      finish(emergencyProcessError("EMERGENCY_TASKKILL_TIMEOUT", String(pid)));
    }, timeoutMs);

    try {
      child = spawnTaskkill(pid);
      child.once("error", onError);
      child.once("exit", onExit);
      timer = startTimeout();
    } catch (error) {
      finish(emergencyProcessError(
        "EMERGENCY_TASKKILL_SPAWN_FAILED",
        error instanceof Error ? error.message : String(error),
      ));
    }
  });
}

export async function killPid(pid: number, dependencies: EmergencyKillDependencies = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw emergencyProcessError("EMERGENCY_PROCESS_PID_INVALID", String(pid));
  }
  const platform = dependencies.platform || process.platform;
  const processGroup = platform !== "win32" && dependencies.processGroup === true;
  const processAlive = dependencies.processAlive || isEmergencyProcessAlive;
  const sendSignal = dependencies.sendSignal || ((targetPid, signal) => process.kill(targetPid, signal));
  const spawnTaskkill = dependencies.spawnTaskkill || ((targetPid) => spawn(
    "taskkill",
    ["/PID", String(targetPid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  ) as TaskkillProcess);
  const wait = dependencies.wait || ((milliseconds) => delay(milliseconds));
  const now = dependencies.now || (() => Date.now());
  const stopTimeoutMs = Math.max(1, dependencies.stopTimeoutMs ?? PROCESS_STOP_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, dependencies.pollIntervalMs ?? PROCESS_STOP_POLL_INTERVAL_MS);

  const signalPid = processGroup ? -pid : pid;
  if (!processAlive(signalPid)) return { pid, stopped: true, alreadyStopped: true };

  if (platform === "win32") {
    await runTaskkill(pid, spawnTaskkill, Math.max(
      1,
      dependencies.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS,
    ));
    const stopped = await waitForPidExit(pid, stopTimeoutMs, {
      processAlive,
      wait,
      now,
      pollIntervalMs,
    });
    if (!stopped) {
      throw emergencyProcessError("EMERGENCY_PROCESS_STILL_RUNNING", String(pid));
    }
    return { pid, stopped: true, alreadyStopped: false };
  }

  try {
    sendSignal(signalPid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" || processAlive(signalPid)) {
      throw emergencyProcessError(
        "EMERGENCY_SIGTERM_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const gracefulTimeoutMs = Math.min(1_500, stopTimeoutMs);
  if (await waitForPidExit(signalPid, gracefulTimeoutMs, {
    processAlive,
    wait,
    now,
    pollIntervalMs,
  })) return { pid, stopped: true, alreadyStopped: false };

  try {
    sendSignal(signalPid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" || processAlive(signalPid)) {
      throw emergencyProcessError(
        "EMERGENCY_SIGKILL_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const stopped = await waitForPidExit(signalPid, Math.max(1, stopTimeoutMs - gracefulTimeoutMs), {
    processAlive,
    wait,
    now,
    pollIntervalMs,
  });
  if (!stopped) throw emergencyProcessError("EMERGENCY_PROCESS_STILL_RUNNING", String(pid));
  return { pid, stopped: true, alreadyStopped: false };
}

export type StopEmergencyDependencies = {
  processAlive?: (pid: number) => boolean;
  terminatePid?: (pid: number) => Promise<unknown>;
  getHealth?: typeof getEmergencyHealth;
  getStatus?: typeof getEmergencyControlStatus;
};

async function stopEmergencyBackendLocked(
  reason = "manual",
  dependencies: StopEmergencyDependencies = {},
) {
  clearEmergencyAutoStartSchedule();
  const processAlive = dependencies.processAlive || isEmergencyProcessAlive;
  const getHealth = dependencies.getHealth || getEmergencyHealth;
  const getStatus = dependencies.getStatus || getEmergencyControlStatus;
  const managed = managedProcess;
  const receipt = await readPidReceipt();
  const processGroup = process.platform !== "win32"
    && Boolean(managed?.processGroup || receipt?.processGroup);
  const terminatePid = dependencies.terminatePid || ((pid) => killPid(pid, {
    processGroup,
  }));
  const managedPid = managed?.child?.pid || null;
  if (
    managedPid
    && receipt
    && (
      receipt.pid !== managedPid
      || (receipt.ownerToken && receipt.ownerToken !== managed?.ownerToken)
    )
  ) {
    throw emergencyProcessError(
      "EMERGENCY_PID_RECEIPT_MISMATCH",
      `${managedPid}:${receipt.pid}`,
    );
  }
  const pid = managedPid || receipt?.pid || null;
  const livenessPid = pid ? (processGroup ? -pid : pid) : null;
  const processTreeAlive = livenessPid ? processAlive(livenessPid) : false;

  if (!pid || !processTreeAlive) {
    const config = await readEmergencyControlConfig();
    const health = await getHealth(config, pid, receipt?.startedAt);
    if (health.reachable) {
      throw emergencyProcessError(
        "EMERGENCY_BACKEND_REACHABLE_WITHOUT_LIVE_OWNER_PID",
        `${pid || "missing"}:${health.identity?.slotRole || "unknown"}`,
      );
    }
    const finalStatus = await getStatus();
    if (finalStatus.health?.reachable !== false) {
      throw emergencyProcessError(
        "EMERGENCY_BACKEND_REAPPEARED_DURING_STOP",
        String(pid || "missing"),
      );
    }
    if (
      managedProcess?.child?.pid === managedPid
      && managedProcess?.ownerToken === managed?.ownerToken
    ) managedProcess = null;
    if (receipt) await removePid(receipt);
    return {
      ...finalStatus,
      stopped: false,
      reason: "NOT_RUNNING",
    };
  }

  if (!managed) {
    const config = await readEmergencyControlConfig();
    const health = await getHealth(config, pid, receipt?.startedAt);
    if (health.identity?.matchesExpectedProcess !== true) {
      throw emergencyProcessError(
        "EMERGENCY_PROCESS_OWNERSHIP_UNVERIFIED",
        `${pid}:${health.identity?.slotRole || "unknown"}`,
      );
    }
  }

  if (
    managedProcess?.child?.pid === managedPid
    && managedProcess?.ownerToken === managed?.ownerToken
  ) managedProcess.stopRequested = true;
  await terminatePid(pid);
  if (processAlive(processGroup ? -pid : pid)) {
    throw emergencyProcessError("EMERGENCY_PROCESS_STILL_RUNNING", String(pid));
  }
  const healthAfterStop = await getHealth(
    await readEmergencyControlConfig(),
    pid,
    receipt?.startedAt,
  );
  if (healthAfterStop.reachable) {
    throw emergencyProcessError(
      "EMERGENCY_BACKEND_STILL_REACHABLE_AFTER_STOP",
      `${pid}:${healthAfterStop.identity?.slotRole || "unknown"}`,
    );
  }
  const finalStatus = await getStatus();
  if (finalStatus.health?.reachable !== false) {
    throw emergencyProcessError(
      "EMERGENCY_BACKEND_REAPPEARED_DURING_STOP",
      String(pid),
    );
  }
  if (
    managedProcess?.child?.pid === managedPid
    && managedProcess?.ownerToken === managed?.ownerToken
  ) managedProcess = null;
  if (receipt) await removePid(receipt);

  logger.info("Emergency-Backend beendet", {
    module: "emergency-control",
    reason,
    pid,
  });

  return {
    ...finalStatus,
    stopped: true,
    reason,
  };
}

export function stopEmergencyBackend(
  reason = "manual",
  dependencies: StopEmergencyDependencies = {},
) {
  // The generation changes synchronously, before a running start reaches its
  // next await boundary. Local supervisor shutdown also permanently holds new
  // starts in this Core process until it exits.
  lifecycleGeneration += 1;
  if (isLocalSupervisorStopReason(reason)) localShutdownHold = true;
  clearEmergencyAutoStartSchedule();
  return withEmergencyLifecycleLock(
    () => stopEmergencyBackendLocked(reason, dependencies),
  );
}

export function restartEmergencyBackend(reason = "manual") {
  const restartGeneration = ++lifecycleGeneration;
  clearEmergencyAutoStartSchedule();
  return withEmergencyLifecycleLock(async () => {
    await stopEmergencyBackendLocked(`restart:${reason}`);
    return startEmergencyBackendLocked(`restart:${reason}`, restartGeneration);
  });
}

export function clearEmergencyAutoStartSchedule() {
  if (scheduledAutoStart) {
    clearTimeout(scheduledAutoStart);
  }
  scheduledAutoStart = null;
  autoStartScheduledFor = null;
}

async function scheduleEmergencyAutoStartLocked(
  reason: string,
  scheduleGeneration: number,
) {
  const cancelled = () => localShutdownHold || lifecycleGeneration !== scheduleGeneration;
  if (cancelled()) {
    return { scheduled: false, reason: "LIFECYCLE_STOP_PENDING" };
  }
  const config = await readEmergencyControlConfig();
  if (cancelled()) {
    return { scheduled: false, reason: "LIFECYCLE_STOP_PENDING", config };
  }

  clearEmergencyAutoStartSchedule();

  if (!config.enabled || !config.autoStart) {
    return {
      scheduled: false,
      reason: !config.enabled ? "EMERGENCY_DISABLED" : "AUTOSTART_DISABLED",
      config,
    };
  }

  const health = await getEmergencyHealth(config);
  if (cancelled()) {
    return { scheduled: false, reason: "LIFECYCLE_STOP_PENDING", config, health };
  }
  if (health.reachable) {
    return {
      scheduled: false,
      reason: "ALREADY_REACHABLE",
      config,
      health,
    };
  }

  const startsAt = new Date(Date.now() + config.autoStartDelayMs);
  autoStartScheduledFor = startsAt.toISOString();
  scheduledAutoStart = setTimeout(() => {
    scheduledAutoStart = null;
    autoStartScheduledFor = null;
    if (cancelled()) return;
    void startEmergencyBackend(`auto:${reason}`).catch((error) => {
      logger.error("Emergency-Autostart fehlgeschlagen", {
        module: "emergency-control",
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.autoStartDelayMs);

  return {
    scheduled: true,
    reason,
    startsAt: autoStartScheduledFor,
    config,
  };
}

export function scheduleEmergencyAutoStart(reason = "active-started") {
  const scheduleGeneration = lifecycleGeneration;
  return withEmergencyLifecycleLock(
    () => scheduleEmergencyAutoStartLocked(reason, scheduleGeneration),
  );
}
