import { getServerPrismaClient } from "../../../database/database.js";
import { env } from "../../../config/env.js";
import { createNfcService } from "./service.js";
// Domain-separated HMAC with the existing installation key; no new secret file.
export const nfcService = createNfcService(getServerPrismaClient("core"), env.MASTER_KEY);
export { createModuleNfcRuntime, MODULE_NFC_CONTRACT_VERSION, NFC_SECURITY_POLICY, } from "./module-runtime.js";
