import type { NextFunction, Request, Response } from "express";

export function emergencyReadOnlyMethodGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void;
