import type { NextFunction, Request, Response } from "express";

import { getSystemRuntimeConfig } from "../runtime.config.js";

const ALLOWED_PROBE_PATHS = [
  "/api/health",
  "/api/runtime",
];

function isProbePath(pathname: string) {
  return ALLOWED_PROBE_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * A Candidate is a health probe, not a second production writer. While the
 * runner has not promoted it, only read-only health/runtime endpoints exist.
 * Its database and storage are separate at the Compose boundary as a second
 * line of defence.
 */
export function updateProbeGuard(req: Request, res: Response, next: NextFunction) {
  const runtime = getSystemRuntimeConfig();
  if (!runtime.updateProbeMode) {
    next();
    return;
  }

  res.setHeader("X-Bonni-Update-Probe", "active");
  res.setHeader("Cache-Control", "no-store");
  const pathname = req.originalUrl.split("?", 1)[0] || req.path;
  const safeMethod = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";

  if (safeMethod && isProbePath(pathname)) {
    next();
    return;
  }

  res.status(503).json({
    ok: false,
    error: "UPDATE_PROBE_MODE",
    message: "Candidate-System ist ausschließlich für Update-Prüfungen freigegeben.",
    runtime: {
      slotName: runtime.slotName,
      slotRole: runtime.slotRole,
      version: runtime.version,
    },
  });
}
