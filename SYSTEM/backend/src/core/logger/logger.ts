import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import { env } from "../config/env.js";

const logDir = env.BONNI_LOG_ROOT
  ? path.resolve(env.BONNI_LOG_ROOT)
  : path.join(process.cwd(), "archives", "logs");

fs.mkdirSync(logDir, { recursive: true });

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

const consoleFormat = winston.format.printf((info) => {
  const timestamp = info.timestamp;
  const level = String(info.level).toUpperCase();
  const moduleName = info.module ? `[${info.module}]` : "";
  const requestId = info.requestId ? `[${info.requestId}]` : "";
  const message = info.message;

  const meta: Record<string, unknown> = { ...info };
  delete meta.level;
  delete meta.message;
  delete meta.timestamp;

  const metaText = Object.keys(meta).length > 0 ? ` ${safeJson(meta)}` : "";

  return `${timestamp} ${level} ${moduleName}${requestId} ${message}${metaText}`;
});

const fileJsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  defaultMeta: {
    service: "backend"
  },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        consoleFormat
      )
    }),
    new winston.transports.File({
      filename: path.join(logDir, "backend.log"),
      format: fileJsonFormat
    }),
    new winston.transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
      format: fileJsonFormat
    })
  ]
});

export function childLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}

export { requestLogger } from "./requestLogger.js";
export { logError } from "./errorLogger.js";
export { createLogger } from "./factory/createLogger.js";
export { LOG_LABELS } from "./core/loggerLabels.js";
export { clientLogRouter } from "./clientLog.routes.js";
