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
