import type { Request, Response, NextFunction } from "express";
import { logError } from "../../logger/errorLogger.js";
import { safeLogPath } from "../../logger/http-log-context.js";

type HttpError = Error & {
  statusCode?: number;
  status?: number;
  code?: string;
  details?: unknown;
};

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  // Body-parser error messages include excerpts of the submitted JSON. Never
  // reflect password/proof material in responses or diagnostics.
  const parserMessages: Record<string, string> = {
    "entity.parse.failed": "Ungültige JSON-Anfrage.",
    "entity.too.large": "Die Anfrage ist zu groß.",
    "encoding.unsupported": "Dieses Anfrageformat wird nicht unterstützt.",
  };
  const parserType = (error as { type?: string })?.type;
  const parserMessage = parserType ? parserMessages[parserType] : undefined;
  const err = error as HttpError;
  const appSchemaIncomplete = /^\/api\/apps\/[a-z][a-z0-9-]*(?:\/|\?|$)/.test(req.originalUrl)
    && ["P2021", "P2022"].includes(String(err?.code || ""));

  logError(parserMessage ? new Error(parserMessage) : error, {
    module: "middleware",
    method: req.method,
    path: safeLogPath(req.route?.path),
    code: typeof err?.code === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(err.code) ? err.code : undefined,
  });

  const candidateStatus =
    appSchemaIncomplete ? 503 : typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
      ? err.status
      : 500;
  const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500;
  if (res.headersSent) { _next(error); return; }
  res.setHeader("Cache-Control", "no-store");

  res.status(statusCode).json({
    error:
      appSchemaIncomplete ? "APP_DATABASE_SCHEMA_INCOMPLETE" : statusCode >= 500
        ? "INTERNAL_SERVER_ERROR"
        : parserMessage ? "REQUEST_BODY_INVALID" : err?.code || err?.message || "REQUEST_ERROR",
    message:
      appSchemaIncomplete
        ? "Die App-Datenbank enthält noch nicht alle benötigten Tabellen oder Spalten. Bitte den aktuellen Server-Protokollauszug prüfen (APP_DATABASE_SCHEMA_INCOMPLETE)."
        : statusCode >= 500
        ? "Unexpected server error"
        : parserMessage || err?.message || "Request failed",
    details: statusCode >= 500 || parserMessage ? undefined : err?.details,
  });
}
