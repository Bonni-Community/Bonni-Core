import { logger } from "./logger.js";
import { serializeDiagnosticError } from "./diagnostic-serialization.js";

export function logError(error: unknown, context: Record<string, unknown> = {}) {
  const detail = serializeDiagnosticError(error);
  logger.error(detail.message, { ...context, code: context.code || detail.code, errorName: detail.name, stack: detail.stack, error: detail });
}

export function logCriticalError(error: unknown, context: Record<string, unknown> = {}) {
  const detail = serializeDiagnosticError(error);
  logger.log("critical", detail.message, {
    ...context,
    severity: "critical",
    code: context.code || detail.code, errorName: detail.name, stack: detail.stack, error: detail,
  });
}
