import { logger } from "./logger.js";

export function logError(error: unknown, context: Record<string, unknown> = {}) {
  if (error instanceof Error) {
    logger.error(error.message, {
      ...context,
      errorName: error.name,
      stack: error.stack
    });
    return;
  }

  logger.error("Unknown error", {
    ...context,
    error
  });
}

export function logCriticalError(error: unknown, context: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  logger.log("critical", message, {
    ...context,
    severity: "critical",
    errorName: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  });
}
