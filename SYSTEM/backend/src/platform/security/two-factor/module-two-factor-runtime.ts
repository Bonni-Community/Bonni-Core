import { getVerifiedRequestIdentity } from "../../auth/request-identity/request-identity-context.js";
import {
  consumeVerifiedChallenge,
  createChallenge,
  getStatus,
  verifyChallenge,
} from "./services/two-factor.service.js";

export const MODULE_TWO_FACTOR_CONTRACT_VERSION = "bonni.two-factor/v1" as const;
const PRIVATE_PURPOSE = "MODULE_PRIVATE_DATA_ACCESS" as const;

function moduleKey(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(normalized)) {
    throw Object.assign(new Error("TWO_FACTOR_MODULE_KEY_INVALID"), { statusCode: 500 });
  }
  return normalized;
}

function identity() {
  const current = getVerifiedRequestIdentity();
  if (!current) {
    throw Object.assign(new Error("TWO_FACTOR_REQUEST_IDENTITY_REQUIRED"), { statusCode: 401 });
  }
  return current;
}

/** Module-bound 2FA proof. A proof created by one module cannot authorize another module. */
export function createModuleTwoFactorRuntime(moduleKeyValue: string) {
  const boundModuleKey = moduleKey(moduleKeyValue);
  return Object.freeze({
    contractVersion: MODULE_TWO_FACTOR_CONTRACT_VERSION,
    async status() {
      return getStatus(identity().accountId);
    },
    async createPrivateDataChallenge(metadata: Record<string, unknown> = {}) {
      const current = identity();
      return createChallenge(current.accountId, {
        purpose: PRIVATE_PURPOSE,
        metadataJson: { moduleKey: boundModuleKey, ...metadata },
      });
    },
    async verifyPrivateDataChallenge(
      challengeId: string,
      proof: { code?: string; recoveryCode?: string; token?: string; password?: string },
    ) {
      return verifyChallenge(identity().accountId, challengeId, proof);
    },
    async consumePrivateDataChallenge(challengeId: string, maxAgeMinutes = 10) {
      return consumeVerifiedChallenge({
        accountId: identity().accountId,
        challengeId,
        purpose: PRIVATE_PURPOSE,
        maxAgeMinutes,
        metadata: { moduleKey: boundModuleKey },
      });
    },
  });
}
