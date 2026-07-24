import type { NextFunction, Request, Response } from "express";

import {
  endSystemNotlauf,
  getSystemDatabaseRouting,
  getSystemDatabaseTargets,
  getSystemNotlaufStatus,
  getSystemSystemSettings,
  pingSystemDatabase,
  replaySystemJsonEmergency,
  startSystemNotlauf,
  syncSystemNotlaufFiles,
  updateSystemDatabaseRouting,
  updateSystemDatabaseTarget,
  updateSystemSystemSettings,
} from "./system-config.service.js";
import { runDatabaseFullSync } from "./database-full-sync.service.js";

export async function getSystemConfigController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getSystemSystemSettings());
  } catch (error) {
    next(error);
  }
}

export async function updateSystemConfigController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await updateSystemSystemSettings(req.body));
  } catch (error) {
    next(error);
  }
}

export async function pingSystemDatabaseController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await pingSystemDatabase(req.body));
  } catch (error) {
    next(error);
  }
}

export async function getSystemDatabaseTargetsController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getSystemDatabaseTargets());
  } catch (error) {
    next(error);
  }
}

export async function updateSystemDatabaseTargetController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await updateSystemDatabaseTarget(req.body));
  } catch (error) {
    next(error);
  }
}

export async function getSystemDatabaseRoutingController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getSystemDatabaseRouting());
  } catch (error) {
    next(error);
  }
}

export async function updateSystemDatabaseRoutingController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await updateSystemDatabaseRouting(req.body));
  } catch (error) {
    next(error);
  }
}

export async function runSystemDatabaseFullSyncController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await runDatabaseFullSync(req.body));
  } catch (error) {
    const code = String((error as { code?: unknown; message?: unknown } | null)?.code
      || (error as { message?: unknown } | null)?.message
      || "");
    if ([
      "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED",
      "DATABASE_FULL_SYNC_TIMEOUT",
      "DATABASE_FULL_SYNC_TOOL_FAILED",
    ].includes(code)) {
      const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode || 500);
      res.status(statusCode).json({
        ok: false,
        code,
        message: code === "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED"
          ? "PostgreSQL-Werkzeuge pg_dump und pg_restore sind nicht installiert."
          : code === "DATABASE_FULL_SYNC_TIMEOUT"
            ? "Der Datenbank-Vollabgleich hat das Zeitlimit überschritten."
            : "Der Datenbank-Vollabgleich ist fehlgeschlagen.",
      });
      return;
    }
    next(error);
  }
}

export async function replaySystemJsonEmergencyController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await replaySystemJsonEmergency(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getNotlaufStatusController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getSystemNotlaufStatus());
  } catch (error) {
    next(error);
  }
}

export async function startNotlaufController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await startSystemNotlauf());
  } catch (error) {
    next(error);
  }
}

export async function syncNotlaufFilesController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await syncSystemNotlaufFiles());
  } catch (error) {
    next(error);
  }
}

export async function endNotlaufController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await endSystemNotlauf(req.body));
  } catch (error) {
    next(error);
  }
}
