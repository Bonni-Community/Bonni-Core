import { Router } from "express";
import { requireAuth, requirePermission, prisma } from "../../../../core/core.js";

export const identityRouter = Router();

identityRouter.get("/accounts", requireAuth, requirePermission("SYSTEM_ADMIN"), async (_req, res) => {
  const accounts = await prisma.account.findMany({
    select: {
      id: true,
      loginName: true,
      email: true,
      type: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" }
  });

  res.json(accounts);
});

identityRouter.get("/roles", requireAuth, async (_req, res) => {
  const roles = await prisma.role.findMany({
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    },
    orderBy: { key: "asc" }
  });

  res.json(roles);
});

identityRouter.get("/permissions", requireAuth, async (_req, res) => {
  const permissions = await prisma.permission.findMany({
    orderBy: { key: "asc" }
  });

  res.json(permissions);
});
