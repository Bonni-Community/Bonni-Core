import { childLogger } from "../logger.js";
export function createLogger(moduleName) {
    const logger = childLogger(moduleName);
    return {
        info(message, meta = {}) {
            logger.info(message, meta);
        },
        warn(message, meta = {}) {
            logger.warn(message, meta);
        },
        error(message, meta = {}) {
            logger.error(message, meta);
        },
        critical(message, meta = {}) {
            logger.log("critical", message, { ...meta, severity: "critical" });
        },
        debug(message, meta = {}) {
            logger.debug(message, meta);
        }
    };
}
