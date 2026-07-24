import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = req.header("x-request-id") ?? randomUUID();
  const startedAt = Date.now();

  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    logger.info("HTTP request", {
      module: "http",
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ipAddress: req.ip,
      userAgent: req.header("user-agent"),
      terminalId: req.header("x-terminal-id") ?? null,
      localNodeId: req.header("x-local-node-id") ?? null
    });
  });

  next();
}
