import fs from "node:fs";
import { Writable } from "node:stream";
import { format as utilFormat } from "node:util";
import winston from "winston";

import { env } from "../config/env.js";
import {
  coreLogRotationDue,
  ensureCoreLogDirectory,
  resolveCoreLogPaths,
  rotateCoreLogFiles,
  type CoreLogPaths,
} from "./coreLogStorage.js";

const CORE_LEVELS = {
  critical: 0,
  error: 1,
  warn: 2,
  info: 3,
  http: 4,
  verbose: 5,
  debug: 6,
  silly: 7,
} as const;

const CORE_LINE = Symbol("bonni-core-line");
const CORE_ERROR_BLOCK = Symbol("bonni-core-error-block");
const previousLines: string[] = [];
const coreLogPaths: CoreLogPaths = resolveCoreLogPaths();

ensureCoreLogDirectory(coreLogPaths);
// A new Core process owns a new diagnostic session. Any previous current
// files are retained as .1/.2 so a crashed process remains diagnosable.
rotateCoreLogFiles(coreLogPaths, { force: true });

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function redact(value: unknown, key = ""): unknown {
  if (/password|secret|token|authorization|cookie|master.?key|private.?key|api.?key|credential/i.test(key)) {
    return "[redacted]";
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      redact(entry, entryKey),
    ]));
  }
  return value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return "[unserializable]";
  }
}

function compactText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/gu, "\\n")
    .trim();
}

function errorCodeAndDetail(info: any): { code: string; detail: string } {
  const message = compactText(info.message);
  const explicitCode = compactText(info.errorCode || info.code || "");
  const match = /^([A-Z][A-Z0-9_.-]{2,})(?::\s*(.*))?$/u.exec(message);
  const code = (explicitCode || match?.[1] || "CORE_ERROR").toUpperCase();
  const detail = compactText(
    match?.[2]
      || info.detail
      || info.reason
      || (explicitCode && message !== explicitCode ? message : ""),
  );
  return { code, detail };
}

function isErrorLevel(info: any): boolean {
  const level = String(info.level).toLowerCase() as keyof typeof CORE_LEVELS;
  return Object.hasOwn(CORE_LEVELS, level) && CORE_LEVELS[level] <= CORE_LEVELS.error;
}

function isCriticalLevel(info: any): boolean {
  return String(info.level).toLowerCase() === "critical"
    || String(info.severity || info.errorSeverity || "").toLowerCase() === "critical"
    || info.critical === true;
}

function renderLogLine(info: any): string {
  const timestamp = compactText(info.timestamp || new Date().toISOString());
  const level = isCriticalLevel(info) ? "CRITICAL" : String(info.level).toUpperCase();
  const moduleName = info.module ? `[${compactText(info.module)}]` : "";
  const requestId = info.requestId ? `[${compactText(info.requestId)}]` : "";
  const message = compactText(info.message);

  const meta: Record<string, unknown> = { ...info };
  delete meta.level;
  delete meta.message;
  delete meta.timestamp;

  const metaText = Object.keys(meta).length > 0 ? ` ${safeJson(meta)}` : "";

  return `${timestamp} ${level} ${moduleName}${requestId} ${message}${metaText}`
    .replace(/  +/gu, " ")
    .trim();
}

function renderErrorBlock(info: any, context: string[]): string {
  const { code, detail } = errorCodeAndDetail(info);
  const marker = isCriticalLevel(info) ? "[CRITICAL ERROR]" : "[ERROR]";
  const errorLines = [`${marker} ${code}`, ...(detail ? [detail] : [])];

  return [
    `= ${compactText(info.timestamp || new Date().toISOString())}`,
    "——————————————-",
    ...context,
    "",
    ...errorLines,
    "——————————————-",
  ].join("\n");
}

const coreRecordFormat = winston.format((info: any) => {
  const line = renderLogLine(info);
  // Winston may clone `info` once per transport. Keep these derived values
  // enumerable so the text and Error transports receive the same rendered
  // line/block instead of an empty newline.
  Object.defineProperty(info, CORE_LINE, { value: line, enumerable: true, configurable: true });
  if (isErrorLevel(info)) {
    Object.defineProperty(info, CORE_ERROR_BLOCK, {
      value: renderErrorBlock(info, previousLines.slice(-5)),
      enumerable: true,
      configurable: true,
    });
  }
  previousLines.push(line);
  if (previousLines.length > 5) previousLines.shift();
  return info;
})();

function assertSafeLogFile(file: string) {
  let state: fs.Stats;
  try {
    state = fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error("CORE_LOG_FILE_UNSAFE");
  }
}

function appendStream(file: string): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        ensureCoreLogDirectory(coreLogPaths);
        assertSafeLogFile(file);
        const value = String(chunk);
        fs.appendFileSync(file, value.endsWith("\n") ? value : `${value}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

const levelName = String(env.LOG_LEVEL || "info").toLowerCase();
const selectedLevel = Object.hasOwn(CORE_LEVELS, levelName) ? levelName : "info";

export const logger = winston.createLogger({
  levels: CORE_LEVELS,
  level: selectedLevel,
  defaultMeta: {
    service: "backend",
  },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    coreRecordFormat,
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.printf((info: any) => String(info[CORE_LINE] || "")),
    }),
    new winston.transports.Stream({
      stream: appendStream(coreLogPaths.logFile),
      format: winston.format.printf((info: any) => String(info[CORE_LINE] || "")),
    }),
    new winston.transports.Stream({
      level: "error",
      stream: appendStream(coreLogPaths.errorFile),
      format: winston.format.printf((info: any) => String(info[CORE_ERROR_BLOCK] || "")),
    }),
  ],
});

let closed = false;
const rotationTimer = setInterval(() => {
  if (closed || !coreLogRotationDue(coreLogPaths)) return;
  try {
    rotateCoreLogFiles(coreLogPaths);
    previousLines.length = 0;
  } catch (error) {
    originalConsole.error("[bonni-core] Log-Rotation fehlgeschlagen", error);
  }
}, 60_000);
rotationTimer.unref?.();

function installConsoleBridge() {
  const methods: Array<[keyof typeof originalConsole, "info" | "warn" | "error" | "debug"]> = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
  ];
  let forwarding = false;

  for (const [method, level] of methods) {
    (console as any)[method] = (...args: unknown[]) => {
      originalConsole[method](...args);
      if (forwarding || closed) return;
      forwarding = true;
      try {
        logger.log(level, utilFormat(...args), { module: "console", source: "console" });
      } finally {
        forwarding = false;
      }
    };
  }
}

installConsoleBridge();

export function getCoreLogPaths(): CoreLogPaths {
  return { ...coreLogPaths };
}

export function closeCoreLogging({ rotate = true } = {}) {
  if (closed) return;
  closed = true;
  clearInterval(rotationTimer);
  logger.close();
  if (rotate) rotateCoreLogFiles(coreLogPaths, { force: true });
}

process.once("exit", () => {
  if (closed) return;
  closed = true;
  clearInterval(rotationTimer);
  try {
    rotateCoreLogFiles(coreLogPaths, { force: true });
  } catch (error) {
    originalConsole.error("[bonni-core] Log-Dateien konnten beim Prozessende nicht rotiert werden", error);
  }
});

export function childLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}

export { requestLogger } from "./requestLogger.js";
export { logError, logCriticalError } from "./errorLogger.js";
export { createLogger } from "./factory/createLogger.js";
export { LOG_LABELS } from "./core/loggerLabels.js";
export { clientLogRouter } from "./clientLog.routes.js";
export {
  CORE_ERROR_FILE_NAME,
  CORE_LOG_FILE_NAME,
  CORE_LOG_RETENTION_COUNT,
  CORE_LOG_ROTATION_INTERVAL_MS,
  parseCoreErrorBlocks,
  readCoreLogFile,
  readCoreLogSnapshot,
  resolveCoreLogPaths,
} from "./coreLogStorage.js";
