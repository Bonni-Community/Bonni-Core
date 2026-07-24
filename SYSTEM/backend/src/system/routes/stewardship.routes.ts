import { Router } from "express";

/**
 * Stewardship add-on route placeholder.
 * Bonni Core Base does not hard-import the stewardship add-on.
 */
const stewardshipRoutes = Router();

stewardshipRoutes.get("/status", (_req, res) => {
  res.json({ ok: false, installed: false, reason: "STEWARDSHIP_ADDON_NOT_INSTALLED" });
});

export default stewardshipRoutes;
