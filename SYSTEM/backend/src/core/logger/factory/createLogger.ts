import { childLogger } from "../logger.js";

export function createLogger(moduleName: string) {
  const logger = childLogger(moduleName);

  return {
    info(message: string, meta: Record<string, unknown> = {}) {
      logger.info(message, meta);
    },

    warn(message: string, meta: Record<string, unknown> = {}) {
      logger.warn(message, meta);
    },

    error(message: string, meta: Record<string, unknown> = {}) {
      logger.error(message, meta);
    },

    debug(message: string, meta: Record<string, unknown> = {}) {
      logger.debug(message, meta);
    }
  };
}
