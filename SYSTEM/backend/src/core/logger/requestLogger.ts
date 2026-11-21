import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";
import { safeLogPath, safeRequestId } from "./http-log-context.js";
import { validDiagnosticId } from "./diagnostic-journal.js";
import { withDiagnosticRequest } from "./diagnostic-context.js";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = safeRequestId();
  const startedAt = Date.now();
  const legacyApp = /^\/api\/apps\/(stueberlapp|kontorapp|hocketapp|messenger|messengerapp|bonnimessenger|meetapp)(?:[/?]|$)/.exec(req.originalUrl)?.[1];
  const context = {
    requestId, method: req.method,
    moduleId: legacyApp ? `app.${legacyApp}` : undefined,
    operationId: validDiagnosticId(req.header("x-bonni-operation-id")) ? req.header("x-bonni-operation-id") : undefined,
    get path() { return safeLogPath(req.route?.path); },
  };

  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    const backgroundPoll = /^\/api\/system(?:\/system)?\/(?:diagnostics\/(?:live|logins)|monitoring\/resources)\/?(?:\?|$)/iu.test(req.originalUrl);
    if (req.method === "GET" && res.statusCode === 200 && backgroundPoll) return;

    logger.info("HTTP request", {
      module: "http",
      moduleId: context.moduleId,
      requestId,
      method: req.method,
      path: safeLogPath(req.route?.path),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  withDiagnosticRequest(context, next);
}
