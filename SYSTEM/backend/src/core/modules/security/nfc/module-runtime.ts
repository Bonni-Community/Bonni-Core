import {
  getVerifiedRequestIdentity,
} from "../../../../platform/auth/request-identity/request-identity-context.js";
import { nfcService } from "./index.js";
import {
  NFC_ASSURANCE,
  NFC_SECURITY_LEVEL,
  type NfcActor,
  NfcError,
} from "./service.js";

export const MODULE_NFC_CONTRACT_VERSION = "bonni.nfc/v1" as const;

export const NFC_SECURITY_POLICY = Object.freeze({
  level: NFC_SECURITY_LEVEL,
  assurance: NFC_ASSURANCE,
  cloneResistant: false,
  replacesPassword: false,
  replacesTwoFactor: false,
  requiresAuthenticatedOperator: true,
});

type NfcCoreService = {
  identify: (
    code: string,
    actor: NfcActor,
    moduleKey: string,
    accessProfiles: readonly string[],
  ) => Promise<unknown>;
};

function normalizeModuleKey(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/u.test(normalized)) {
    throw Object.assign(new Error("NFC_MODULE_KEY_INVALID"), { code: "NFC_MODULE_KEY_INVALID", statusCode: 500 });
  }
  return normalized;
}

function normalizeAccessProfiles(value: unknown) {
  if (value === undefined || value === null) return Object.freeze([] as string[]);
  if (!Array.isArray(value) || value.length > 50) {
    throw Object.assign(new Error("NFC_ACCESS_PROFILES_INVALID"), { code: "NFC_ACCESS_PROFILES_INVALID", statusCode: 500 });
  }

  const profiles: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const raw = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).key
        : null;
    const profile = String(raw ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,79}$/u.test(profile) || seen.has(profile)) {
      throw Object.assign(new Error("NFC_ACCESS_PROFILES_INVALID"), { code: "NFC_ACCESS_PROFILES_INVALID", statusCode: 500 });
    }
    seen.add(profile);
    profiles.push(profile);
  }
  return Object.freeze(profiles);
}

function currentIdentity() {
  const identity = getVerifiedRequestIdentity();
  if (!identity) throw new NfcError("NFC_REQUEST_IDENTITY_REQUIRED", 401);
  return identity;
}

/**
 * Module-bound Core port. It exposes only the security result; registration,
 * raw codes, hashes and account data remain inside Bonni Core.
 */
export function createModuleNfcRuntime(
  moduleKeyValue: string,
  accessProfilesValue: unknown = [],
  serviceValue: NfcCoreService = nfcService,
) {
  const moduleKey = normalizeModuleKey(moduleKeyValue);
  const accessProfiles = normalizeAccessProfiles(accessProfilesValue);

  return Object.freeze({
    contractVersion: MODULE_NFC_CONTRACT_VERSION,
    policy: NFC_SECURITY_POLICY,
    async identify(code: string) {
      const identity = currentIdentity();
      return serviceValue.identify(code, identity, moduleKey, accessProfiles);
    },
  });
}
