import type { Request, Response } from "express";

import {
  bootWithoutKeyDecisionSchema,
  developerBootModeSchema,
  initializeMasterKeyStorageSchema,
  loadMasterKeyFromFileSchema,
} from "./master-key.schemas.js";
import {
  decideBootWithoutKey,
  getMasterKeyControlStatus,
  initializeMasterKeyStorage,
  listMasterKeyStorageLocations,
  loadMasterKey,
  setDeveloperBootMode,
} from "./master-key.service.js";

export function getMasterKeyStatusController(_req: Request, res: Response) {
  res.json(getMasterKeyControlStatus());
}

export function listMasterKeyStorageLocationsController(_req: Request, res: Response) {
  res.json(listMasterKeyStorageLocations());
}

export function bootWithoutKeyDecisionController(req: Request, res: Response) {
  const input = bootWithoutKeyDecisionSchema.parse(req.body);
  res.json(decideBootWithoutKey(input));
}

export function loadMasterKeyController(req: Request, res: Response) {
  const input = loadMasterKeyFromFileSchema.parse(req.body);
  res.json(loadMasterKey(input));
}

export function initializeMasterKeyStorageController(req: Request, res: Response) {
  const input = initializeMasterKeyStorageSchema.parse(req.body);
  res.json(initializeMasterKeyStorage(input));
}

export function setDeveloperBootModeController(req: Request, res: Response) {
  const input = developerBootModeSchema.parse(req.body);
  res.json(setDeveloperBootMode(input));
}
