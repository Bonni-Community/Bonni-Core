import { Router } from "express";
import { authRouter } from "./routes/auth.routes.js";
import { accountRouter } from "./routes/account.routes.js";

export const identityRouter = Router();

identityRouter.use("/auth", authRouter);
identityRouter.use("/", accountRouter);
