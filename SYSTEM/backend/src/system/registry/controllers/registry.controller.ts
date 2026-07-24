import type { Request, Response } from "express";

import {
  getSystemRegistry,
  runSystemRegistrySyncTool,
  syncSystemRegistry,
} from "./registry.service.js";

export async function getRegistryController(_req: Request, res: Response) {
  res.json(await getSystemRegistry());
}

export async function syncRegistryController(_req: Request, res: Response) {
  res.json(await syncSystemRegistry());
}

export async function runRegistrySyncToolController(_req: Request, res: Response) {
  res.json(await runSystemRegistrySyncTool());
}
