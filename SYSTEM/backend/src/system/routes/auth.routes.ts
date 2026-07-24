import { Router } from "express";
import { authRoutes } from "../../platform/auth/routes/index.js";

const router = Router();

router.use("/auth", authRoutes);

export default router;
