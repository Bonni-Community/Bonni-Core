import type { Request, Response, NextFunction } from "express";
import { logError } from "../../logger/errorLogger.js";

type HttpError = Error & {
  statusCode?: number;
  status?: number;
  code?: string;
  details?: unknown;
};

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  logError(error, {
    module: "middleware",
    method: req.method,
    path: req.originalUrl,
    terminalId: req.header("x-terminal-id") ?? null,
    localNodeId: req.header("x-local-node-id") ?? null
  });

  const err = error as HttpError;
  const statusCode =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
      ? err.status
      : 500;

  res.status(statusCode).json({
    error:
      statusCode >= 500
        ? "INTERNAL_SERVER_ERROR"
        : err?.code || err?.message || "REQUEST_ERROR",
    message:
      statusCode >= 500
        ? "Unexpected server error"
        : err?.message || "Request failed",
    details: statusCode >= 500 ? undefined : err?.details,
  });
}
