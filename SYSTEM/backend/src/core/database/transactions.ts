import type { PrismaClient } from "@prisma/client";

import { getPrismaClient } from "./prisma.js";

export const dbTransaction = ((...args: Parameters<PrismaClient["$transaction"]>) => {
  return (getPrismaClient().$transaction as (...transactionArgs: Parameters<PrismaClient["$transaction"]>) => ReturnType<PrismaClient["$transaction"]>)(...args);
}) as PrismaClient["$transaction"];
