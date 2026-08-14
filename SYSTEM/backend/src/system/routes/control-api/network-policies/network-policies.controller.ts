import type { NextFunction, Request, Response } from "express";

import { getPrismaClient } from "../../../../core/database/database.js";
import {
  listModuleNetworkObservations,
  listModuleNetworkPolicies,
  updateModuleNetworkPolicy,
} from "../../../../core/network-policy/index.js";

function accountId(req: Request) {
  return String((req as Request & { auth?: { accountId?: unknown } }).auth?.accountId || "").trim();
}

export async function listNetworkPoliciesController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const prisma = getPrismaClient();
    const [policies, observations] = await Promise.all([
      listModuleNetworkPolicies(prisma),
      listModuleNetworkObservations(prisma, { limit: 100 }),
    ]);
    res.json({ ok: true, policies, observations });
  } catch (error) {
    next(error);
  }
}

export async function updateNetworkPolicyController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const actorId = accountId(req);
    if (!actorId) return res.status(401).json({ error: "UNAUTHORIZED" });
    const policy = await updateModuleNetworkPolicy(
      getPrismaClient(),
      req.params.moduleKey,
      req.body && typeof req.body === "object" ? req.body : {},
      actorId,
    );
    return res.json({ ok: true, policy });
  } catch (error) {
    return next(error);
  }
}

export async function listNetworkObservationsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const observations = await listModuleNetworkObservations(getPrismaClient(), {
      moduleKey: req.query.moduleKey,
      decision: req.query.decision,
      limit: req.query.limit,
    });
    res.json({ ok: true, observations });
  } catch (error) {
    next(error);
  }
}
