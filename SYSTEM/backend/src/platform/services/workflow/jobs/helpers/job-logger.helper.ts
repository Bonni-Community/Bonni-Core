import { logger } from "../../../../../core/logger/logger.js";

export function jobInfo(jobName: string, message: string, meta?: Record<string, unknown>) {
  logger.info(`[job:${jobName}] ${message}`, meta || {});
}

export function jobWarn(jobName: string, message: string, meta?: Record<string, unknown>) {
  logger.warn(`[job:${jobName}] ${message}`, meta || {});
}
