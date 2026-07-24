import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { getRunSystemSystemRoot } from "../../../../system/boot/run-system/index.js";
import { logger } from "../../../../core/logger/logger.js";

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
let managedProcess: ManagedProcess | null = null;
let scheduledAutoStart: NodeJS.Timeout | null = null;
let autoStartScheduledFor: string | null = null;

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

async function readPidFromFile() {
  try {
    const pid = Number((await fs.readFile(pidFilePath(), "utf8")).trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writePid(pid: number) {
  await ensureEmergencyDirectory();
  await fs.writeFile(pidFilePath(), String(pid), "utf8");
}

async function removePid() {
  await fs.rm(pidFilePath(), { force: true }).catch(() => undefined);
}

async function appendLog(line: string) {
  await ensureEmergencyDirectory();
  await fs.appendFile(logFilePath(), line, "utf8").catch(() => undefined);
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

export async function getEmergencyHealth(config?: EmergencyControlConfig) {
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

  return {
    origin,
    reachable,
    readyForTraffic,
    ready,
    notlauf,
  };
}

export async function getEmergencyControlStatus() {
  const config = await readEmergencyControlConfig();
  const pidFromFile = await readPidFromFile();
  const managedPid = managedProcess?.child?.pid || null;
  const pid = managedPid || pidFromFile;
  const processAlive = isProcessAlive(pid);
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
      logFile: logFilePath(),
    },
    health,
    schedule: {
      scheduled: Boolean(scheduledAutoStart),
      scheduledFor: autoStartScheduledFor,
    },
  };
}

async function waitForEmergencyHealthy(config: EmergencyControlConfig, timeoutMs = START_WAIT_MS) {
  const start = Date.now();
  let lastHealth = await getEmergencyHealth(config);

  while (Date.now() - start < timeoutMs) {
    if (lastHealth.reachable) {
      return lastHealth;
    }
    await delay(750);
    lastHealth = await getEmergencyHealth(config);
  }

  return lastHealth;
}

export async function startEmergencyBackend(reason = "manual") {
  const config = await readEmergencyControlConfig();

  if (!config.enabled) {
    return {
      ...(await getEmergencyControlStatus()),
      started: false,
      reason: "EMERGENCY_DISABLED",
    };
  }

  const existingHealth = await getEmergencyHealth(config);
  if (existingHealth.reachable) {
    return {
      ...(await getEmergencyControlStatus()),
      started: false,
      reason: "ALREADY_REACHABLE",
    };
  }

  const pidFromFile = await readPidFromFile();
  if (isProcessAlive(pidFromFile)) {
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

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    detached: false,
    windowsHide: false,
  });

  managedProcess = {
    child,
    startedAt: new Date().toISOString(),
  };

  child.stdout.on("data", (chunk) => void appendLog(String(chunk)));
  child.stderr.on("data", (chunk) => void appendLog(String(chunk)));
  child.once("exit", (code, signal) => {
    void appendLog(`\n[emergency-control] Prozess beendet: code=${code} signal=${signal}\n`);
    if (managedProcess?.child?.pid === child.pid) {
      managedProcess = null;
    }
    void removePid();
  });

  if (child.pid) {
    await writePid(child.pid);
  }

  logger.info("Emergency-Backend gestartet", {
    module: "emergency-control",
    reason,
    pid: child.pid,
    port: config.port,
  });

  const health = await waitForEmergencyHealthy(config);
  return {
    ...(await getEmergencyControlStatus()),
    started: true,
    reason,
    healthAfterStart: health,
  };
}

async function killPid(pid: number) {
  if (isWindows()) {
    await new Promise<void>((resolve) => {
      const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("exit", () => resolve());
      taskkill.once("error", () => resolve());
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(1_500);
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

export async function stopEmergencyBackend(reason = "manual") {
  clearEmergencyAutoStartSchedule();
  const pid = managedProcess?.child?.pid || (await readPidFromFile());

  if (!pid || !isProcessAlive(pid)) {
    managedProcess = null;
    await removePid();
    return {
      ...(await getEmergencyControlStatus()),
      stopped: false,
      reason: "NOT_RUNNING",
    };
  }

  await killPid(pid);
  managedProcess = null;
  await removePid();

  logger.info("Emergency-Backend beendet", {
    module: "emergency-control",
    reason,
    pid,
  });

  return {
    ...(await getEmergencyControlStatus()),
    stopped: true,
    reason,
  };
}

export async function restartEmergencyBackend(reason = "manual") {
  await stopEmergencyBackend(`restart:${reason}`);
  return startEmergencyBackend(`restart:${reason}`);
}

export function clearEmergencyAutoStartSchedule() {
  if (scheduledAutoStart) {
    clearTimeout(scheduledAutoStart);
  }
  scheduledAutoStart = null;
  autoStartScheduledFor = null;
}

export async function scheduleEmergencyAutoStart(reason = "active-started") {
  const config = await readEmergencyControlConfig();

  clearEmergencyAutoStartSchedule();

  if (!config.enabled || !config.autoStart) {
    return {
      scheduled: false,
      reason: !config.enabled ? "EMERGENCY_DISABLED" : "AUTOSTART_DISABLED",
      config,
    };
  }

  const health = await getEmergencyHealth(config);
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
