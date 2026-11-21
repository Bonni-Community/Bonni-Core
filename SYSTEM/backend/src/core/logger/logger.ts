import { recordLoggerDiagnostic } from "./diagnostic-journal.js";
import fs from "node:fs";
import winston from "winston";
import { randomUUID } from "node:crypto";
import { getDiagnosticRequest, getDiagnosticRuntime } from "./diagnostic-context.js";
import { sanitizeDiagnosticText } from "./diagnostic-serialization.js";
import { privateValue, privateMessage, privateCode } from "../../../scripts/runtime/log-privacy.mjs";
import { createErrorWindow } from "./error-window.js";

import { env } from "../config/env.js";
import {
  coreLogRotationDue,
  ensureCoreLogDirectory,
  resolveCoreLogPaths,
  rotateCoreLogFiles,
  cleanCoreLogFiles,
  pruneCoreLogFiles,
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
cleanCoreLogFiles(coreLogPaths);
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(privateValue(value));
  } catch {
    return "[unserializable]";
  }
}

function compactText(value: unknown): string {
  return sanitizeDiagnosticText(value)
    .replace(/[\r\n]+/gu, "\\n")
    .trim();
}

function logTimestamp(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : new Date().toISOString();
}

function errorCodeAndDetail(info: any): { code: string; detail: string } {
  const message = privateMessage(info.message);
  const explicitCode = info.errorCode || info.code ? privateCode(info.errorCode || info.code) : "";
  const match = /^([A-Z][A-Z0-9_.-]{2,})(?::\s*(.*))?$/u.exec(message);
  const code = (explicitCode || match?.[1] || "CORE_ERROR").toUpperCase();
  const detail = compactText(
    match?.[2] || (message !== code ? message : ""),
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
  const timestamp = logTimestamp(info.timestamp);
  const level = isCriticalLevel(info) ? "CRITICAL" : String(info.level).toUpperCase();
  const safe = privateValue({ module: info.module, requestId: info.requestId });
  const moduleName = safe.module ? `[${safe.module}]` : "";
  const requestId = safe.requestId ? `[${safe.requestId}]` : "";
  const message = privateMessage(info.message);

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
  const errorLines = [`${marker} ${code}`, `[DIAGNOSE-ID] ${info.errorId}`, ...(detail ? [detail] : []), renderLogLine(info)];

  return [
    `= ${logTimestamp(info.timestamp)}`,
    "——————————————-",
    ...context,
    "",
    ...errorLines,
    "——————————————-",
  ].join("\n");
}

const coreRecordFormat = winston.format((info: any) => {
  const request = getDiagnosticRequest();
  if (request) {
    info.requestId = request.requestId;
    info.method ??= request.method;
    info.path ??= request.path;
    info.moduleId ??= request.moduleId;
  }
  if (isErrorLevel(info)) {
    info.errorId = randomUUID();
    info.runtime = getDiagnosticRuntime();
  }
  try { recordLoggerDiagnostic(info); } catch { /* Diagnostic journal failure must not abort work. */ }
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
  try { errorWindow.record(line, isErrorLevel(info) ? { id: info.errorId, block: String(info[CORE_ERROR_BLOCK]) } : undefined); }
  catch { originalConsole.error("CORE_LOG_WRITE_FAILED"); }
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

const levelName = String(env.LOG_LEVEL || "info").toLowerCase();
const selectedLevel = Object.hasOwn(CORE_LEVELS, levelName) ? levelName : "info";
const appendPrivate = (file: string, text: string) => {
  ensureCoreLogDirectory(coreLogPaths); assertSafeLogFile(file);
  try { if (fs.statSync(file).size > 8 * 1024 * 1024) rotateCoreLogFiles(coreLogPaths, { force: true }); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const state = fs.fstatSync(fd);
    if (!state.isFile() || state.nlink !== 1) throw new Error("CORE_LOG_FILE_UNSAFE");
    fs.writeFileSync(fd, text, "utf8");
  } finally { fs.closeSync(fd); }
};
const errorWindow = createErrorWindow(text => appendPrivate(coreLogPaths.logFile, text), text => appendPrivate(coreLogPaths.errorFile, text));

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
      format: winston.format.combine(
        winston.format((info: any) => info.source === "console" ? false : info)(),
        winston.format.printf((info: any) => String(info[CORE_LINE] || "")),
      ),
    }),
  ],
});

let closed = false;
const rotationTimer = setInterval(() => {
  if (closed) return;
  try {
    pruneCoreLogFiles(coreLogPaths);
    if (!coreLogRotationDue(coreLogPaths)) return;
    rotateCoreLogFiles(coreLogPaths);
    previousLines.length = 0;
    errorWindow.reset();
  } catch (error) {
    originalConsole.error("CORE_LOG_WRITE_FAILED");
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
      let safeArgs: unknown[];
      try { safeArgs = args.map(value => privateValue(value)); }
      catch { safeArgs = ["CORE_LOG_PRIVACY_FAILED"]; }
      originalConsole[method](...safeArgs);
      if (forwarding || closed) return;
      forwarding = true;
      try {
        const errors = args.filter(value => value instanceof Error).map(value => privateValue(value));
        const message = typeof safeArgs[0] === "string" ? privateMessage(safeArgs[0]) : "CORE_ERROR";
        let firstRecord: any = safeArgs[0];
        if (typeof firstRecord === "string" && firstRecord.startsWith("{")) {
          try { firstRecord = JSON.parse(firstRecord); } catch { firstRecord = null; }
        }
        const code = errors[0]?.code || (firstRecord && typeof firstRecord === "object" ? firstRecord.code : undefined);
        const selectedLevel = level === "error" && typeof args[0] === "string" && /^\(node:\d+\) (?:[A-Za-z]+Warning|Warning):/.test(args[0]) ? "warn" : level;
        logger.log(selectedLevel, message, { module: "console", source: "console", code, consoleArguments: message === safeArgs[0] ? safeArgs.slice(1) : safeArgs, ...(errors.length ? { errors } : {}) });
      } catch {
        originalConsole.error("CORE_LOG_PRIVACY_FAILED");
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
    originalConsole.error("CORE_LOG_WRITE_FAILED");
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
