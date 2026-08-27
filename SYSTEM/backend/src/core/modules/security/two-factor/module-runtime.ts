import {
  getVerifiedRequestIdentity,
  getVerifiedRequestSessionAssurance,
} from "../../../../platform/auth/request-identity/request-identity-context.js";
import {
  consumeVerifiedChallenge,
  createChallenge,
  getStatus,
  verifyChallenge,
} from "./service.js";

export const MODULE_TWO_FACTOR_CONTRACT_VERSION = "bonni.two-factor/v1" as const;
const PRIVATE_PURPOSE = "MODULE_PRIVATE_DATA_ACCESS" as const;

function normalizeModuleKey(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/u.test(normalized)) {
    throw Object.assign(new Error("TWO_FACTOR_MODULE_KEY_INVALID"), { code: "TWO_FACTOR_MODULE_KEY_INVALID", statusCode: 500 });
  }
  return normalized;
}

function identity() {
  const current = getVerifiedRequestIdentity();
  if (!current) {
    throw Object.assign(new Error("TWO_FACTOR_REQUEST_IDENTITY_REQUIRED"), { code: "TWO_FACTOR_REQUEST_IDENTITY_REQUIRED", statusCode: 401 });
  }
  return current;
}

function accessScope(value: unknown) {
  const normalized = String(value || "PRIVATE_DATA").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9._:-]{2,119}$/u.test(normalized)) {
    throw Object.assign(new Error("TWO_FACTOR_ACCESS_SCOPE_INVALID"), { code: "TWO_FACTOR_ACCESS_SCOPE_INVALID", statusCode: 400 });
  }
  return normalized;
}

/** Module-bound Core port. No app receives a TOTP secret or provider registry. */
export function createModuleTwoFactorRuntime(moduleKeyValue: string) {
  const boundModuleKey = normalizeModuleKey(moduleKeyValue);
  return Object.freeze({
    contractVersion: MODULE_TWO_FACTOR_CONTRACT_VERSION,
    async status() {
      const current = identity();
      const [status, assurance] = await Promise.all([
        getStatus(current.accountId),
        Promise.resolve(getVerifiedRequestSessionAssurance()),
      ]);
      const providerId = String(status.provider?.id || "").trim().toLowerCase();
      const sessionSatisfied = Boolean(
        status.enabled === true
        && status.available === true
        && status.provider?.configured === true
        && status.provider?.available !== false
        && assurance?.accountId === current.accountId
        && assurance.credentialRevision === current.credentialRevision
        && assurance.mfaVerifiedAt
        && assurance.mfaProviderId === providerId
      );
      return Object.freeze({ ...status, sessionSatisfied });
    },
    async createPrivateDataChallenge(input: {
      accessScope?: string;
      subjectId?: string | null;
      memberId?: string | null;
      context?: Record<string, unknown>;
    } = {}) {
      const current = identity();
      return createChallenge(current.accountId, {
        purpose: PRIVATE_PURPOSE,
        moduleKey: boundModuleKey,
        accessScope: accessScope(input.accessScope),
        subjectId: input.subjectId || input.memberId || null,
      });
    },
    async verifyPrivateDataChallenge(
      challengeId: string,
      proof: { code?: string; recoveryCode?: string; token?: string; password?: string },
    ) {
      return verifyChallenge(identity().accountId, challengeId, proof);
    },
    async consumePrivateDataChallenge(
      challengeId: string,
      options: number | { accessScope?: string; subjectId?: string | null; maxAgeMinutes?: number } = {},
    ) {
      const normalized = typeof options === "number" ? { maxAgeMinutes: options } : options;
      return consumeVerifiedChallenge({
        accountId: identity().accountId,
        challengeId,
        purpose: PRIVATE_PURPOSE,
        moduleKey: boundModuleKey,
        accessScope: accessScope(normalized.accessScope),
        subjectId: normalized.subjectId ?? null,
        maxAgeMinutes: normalized.maxAgeMinutes,
      });
    },
  });
}
