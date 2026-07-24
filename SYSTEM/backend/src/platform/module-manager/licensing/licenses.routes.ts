import { Router } from "express";
import {
  activateSystemLicense,
  getLicenseStatus,
  getSystemLicensesOverview,
  validateSystemLicense,
} from "./license.service.js";

export const systemLicensesRouter = Router();

systemLicensesRouter.get("/", async (_req, res, next) => {
  try { res.json(await getSystemLicensesOverview()); } catch (error) { next(error); }
});

systemLicensesRouter.get("/status", async (_req, res, next) => {
  try { res.json(await getLicenseStatus()); } catch (error) { next(error); }
});

systemLicensesRouter.post("/activate", async (req, res, next) => {
  try { res.json(await activateSystemLicense(req.body?.licenseKey)); } catch (error) { next(error); }
});

systemLicensesRouter.post("/validate", async (req, res, next) => {
  try { res.json(await validateSystemLicense(req.body?.licenseKey)); } catch (error) { next(error); }
});
