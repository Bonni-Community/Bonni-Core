import { Router, type NextFunction, type Request, type Response } from "express";

import { getSystemRuntimeConfig } from "./runtime.config.js";
import { getRuntimeLiveStatus, getRuntimeReadyStatus } from "./runtime.status.js";

export const runtimeControlRouter = Router();

type JsonRecord = Record<string, unknown>;

function expectedRuntimeControlToken() {
  return (
    process.env.RUNTIME_CONTROL_TOKEN?.trim() ||
    process.env.FEATURE_MODULE_INSTALLER_TOKEN?.trim() ||
    ""
  );
}

function receivedRuntimeControlToken(req: Request) {
  return (
    req.header("x-runtime-control-token")?.trim() ||
    req.header("x-installer-token")?.trim() ||
    ""
  );
}

function requireRuntimeControlToken(req: Request, res: Response, next: NextFunction) {
  const expected = expectedRuntimeControlToken();

  if (!expected) {
    res.status(503).json({
      error: "RUNTIME_CONTROL_TOKEN_NOT_CONFIGURED",
      message: "Runtime-Control ist nicht aktiviert. Setze RUNTIME_CONTROL_TOKEN oder FEATURE_MODULE_INSTALLER_TOKEN.",
    });
    return;
  }

  if (receivedRuntimeControlToken(req) !== expected) {
    res.status(401).json({ error: "RUNTIME_CONTROL_UNAUTHORIZED" });
    return;
  }

  next();
}

function bodyRecord(req: Request): JsonRecord {
  return typeof req.body === "object" && req.body !== null ? req.body as JsonRecord : {};
}

function restartDelayMs() {
  const raw = Number(process.env.RUNTIME_CONTROL_RESTART_DELAY_MS ?? 750);
  return Number.isFinite(raw) && raw >= 0 ? raw : 750;
}

function scheduleSelfRestart(reason: string, requestedBy: JsonRecord) {
  const delayMs = restartDelayMs();

  setTimeout(() => {
    console.warn("[runtime-control] Restart requested", {
      reason,
      requestedBy,
      runtime: getSystemRuntimeConfig(),
    });
    process.kill(process.pid, "SIGTERM");
  }, delayMs).unref();

  return { scheduled: true, delayMs };
}

runtimeControlRouter.use(requireRuntimeControlToken);

runtimeControlRouter.get("/status", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      live: getRuntimeLiveStatus(),
      ready: await getRuntimeReadyStatus(),
    });
  } catch (error) {
    next(error);
  }
});

runtimeControlRouter.post("/restart", (req, res) => {
  const body = bodyRecord(req);
  const runtime = getSystemRuntimeConfig();
  const expectedSlotRole = typeof body.expectedSlotRole === "string" ? body.expectedSlotRole : null;

  if (expectedSlotRole && runtime.slotRole !== expectedSlotRole) {
    res.status(409).json({
      error: "RUNTIME_CONTROL_SLOT_ROLE_MISMATCH",
      expectedSlotRole,
      actualSlotRole: runtime.slotRole,
      runtime,
    });
    return;
  }

  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : "runtime-control-restart";

  const restart = scheduleSelfRestart(reason, {
    installId: typeof body.installId === "string" ? body.installId : null,
    manifestId: typeof body.manifestId === "string" ? body.manifestId : null,
    action: typeof body.action === "string" ? body.action : null,
  });

  res.json({
    ok: true,
    restart,
    runtime,
    reason,
  });
});

export default runtimeControlRouter;
