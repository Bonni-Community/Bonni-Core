import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../../platform/auth/session/authContext.js";

export function requirePermission(permission: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: "AUTH_REQUIRED" });
    }

    if (!req.auth.permissions.includes(permission)) {
      return res.status(403).json({
        error: "PERMISSION_DENIED",
        permission
      });
    }

    next();
  };
}
