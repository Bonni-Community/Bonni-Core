import type { Request, Response } from "express";

import {
  checkForLocalSourceUpdate,
  checkForCoreUpdate,
  finalizeDeploymentLifecycle,
  getCoreUpdateCenterStatus,
  rollbackDeploymentLifecycle,
  startLocalSourceUpdateInstallation,
  startCoreUpdateInstallation,
  startCoreUpdatePreparation,
  updateCoreUpdateSettings,
} from "./update-center.service.js";

function assertLifecycleSameOrigin(req: Request) {
  const fetchSite = req.header("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return;
  if (fetchSite) {
    throw Object.assign(new Error("DEPLOYMENT_FINALIZE_CROSS_ORIGIN_FORBIDDEN"), {
      code: "DEPLOYMENT_FINALIZE_CROSS_ORIGIN_FORBIDDEN",
      statusCode: 403,
    });
  }
  const source = req.header("origin") || req.header("referer");
  if (!source) return;
  let parsed: URL;
  try { parsed = new URL(source); } catch { parsed = new URL("https://invalid.invalid"); }
  if (parsed.origin !== `${req.protocol}://${req.get("host")}`) {
    throw Object.assign(new Error("DEPLOYMENT_FINALIZE_CROSS_ORIGIN_FORBIDDEN"), {
      code: "DEPLOYMENT_FINALIZE_CROSS_ORIGIN_FORBIDDEN",
      statusCode: 403,
    });
  }
}

export async function finalizeDeploymentLifecycleController(req: Request, res: Response) {
  assertLifecycleSameOrigin(req);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((key) => !["holdId", "generation"].includes(key));
  const holdId = typeof body.holdId === "string" ? body.holdId.trim() : "";
  const generation = body.generation;
  if (unknown.length
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(holdId)
    || !Number.isSafeInteger(generation) || generation <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_DEPLOYMENT_FINALIZE_REQUEST" });
    return;
  }
  const result = await finalizeDeploymentLifecycle({ holdId, generation });
  res.status(result.ok ? result.accepted ? 202 : 200 : 409).json(result);
}

export async function rollbackDeploymentLifecycleController(req: Request, res: Response) {
  assertLifecycleSameOrigin(req);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((key) => !["holdId", "generation"].includes(key));
  const holdId = typeof body.holdId === "string" ? body.holdId.trim() : "";
  const generation = body.generation;
  if (unknown.length
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(holdId)
    || !Number.isSafeInteger(generation) || generation <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_DEPLOYMENT_ROLLBACK_REQUEST" });
    return;
  }
  const result = await rollbackDeploymentLifecycle({ holdId, generation });
  res.status(result.ok ? ("accepted" in result && result.accepted ? 202 : 200) : 409).json(result);
}

export async function getCoreUpdateCenterStatusController(_req: Request, res: Response) {
  res.json(await getCoreUpdateCenterStatus());
}

export async function checkForCoreUpdateController(_req: Request, res: Response) {
  res.json(await checkForCoreUpdate());
}

export async function checkForLocalSourceUpdateController(_req: Request, res: Response) {
  res.json(await checkForLocalSourceUpdate());
}

export async function startLocalSourceUpdateInstallationController(req: Request, res: Response) {
  const updateId = typeof req.body?.updateId === "string" ? req.body.updateId.trim() : undefined;
  const manifestSha256 = typeof req.body?.manifestSha256 === "string" ? req.body.manifestSha256.trim() : undefined;
  const result = await startLocalSourceUpdateInstallation({ updateId, manifestSha256 });
  res.status(result.ok ? 202 : 409).json(result);
}

export async function startCoreUpdatePreparationController(_req: Request, res: Response) {
  const result = await startCoreUpdatePreparation();
  res.status(result.ok ? 202 : 409).json(result);
}

export async function startCoreUpdateInstallationController(req: Request, res: Response) {
  const targetVersion = typeof req.body?.targetVersion === "string" ? req.body.targetVersion.trim() : undefined;
  const result = await startCoreUpdateInstallation(targetVersion || undefined);
  res.status(result.ok ? 202 : 409).json(result);
}

export async function updateCoreUpdateSettingsController(req: Request, res: Response) {
  try { res.json(await updateCoreUpdateSettings(req.body || {})); }
  catch (error) {
    if ((error as {statusCode?:number}).statusCode !== 400) throw error;
    res.status(400).json({ok:false,error:error instanceof Error ? error.message : "Ungültige Update-Einstellungen."});
  }
}
