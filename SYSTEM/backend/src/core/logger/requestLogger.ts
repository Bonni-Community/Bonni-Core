import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";
import { safeLogHeader, safeLogPath, safeRequestId } from "./http-log-context.js";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = safeRequestId(req.header("x-request-id"));
  const startedAt = Date.now();

  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    logger.info("HTTP request", {
      module: "http",
      requestId,
      method: req.method,
      path: safeLogPath(req.originalUrl),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ipAddress: req.ip,
      userAgent: safeLogHeader(req.header("user-agent")),
      terminalId: safeLogHeader(req.header("x-terminal-id")),
      localNodeId: safeLogHeader(req.header("x-local-node-id"))
    });
  });

  next();
}
