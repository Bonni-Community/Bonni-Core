import { getServerPrismaClient } from "../../../database/database.js";
import { env } from "../../../config/env.js";
import { createPresenceService } from "./service.js";
export const presenceService = createPresenceService(getServerPrismaClient("core"), env.MASTER_KEY);
