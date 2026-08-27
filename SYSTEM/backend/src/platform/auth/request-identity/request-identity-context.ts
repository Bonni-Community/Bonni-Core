import { AsyncLocalStorage } from "node:async_hooks";

export type RequestIdentityAccountType = "MEMBER" | "ADMIN" | "TERMINAL";

export type RequestIdentity = Readonly<{
  accountId: string;
  loginName: string;
  type: RequestIdentityAccountType;
  roles: readonly string[];
  permissions: readonly string[];
  allowedApps: readonly string[];
  personId: string | null;
  memberId: string | null;
  credentialRevision: number;
}>;

export type RequestSessionAssurance = Readonly<{
  sessionId: string;
  accountId: string;
  credentialRevision: number;
  mfaVerifiedAt: string | null;
  mfaProviderId: string | null;
  mfaMethod: string | null;
}>;

type RequestIdentityContext = Readonly<{
  identity: RequestIdentity | null;
  sessionAssurance: RequestSessionAssurance | null;
}>;

const requestIdentityStorage = new AsyncLocalStorage<RequestIdentityContext>();

function frozenStrings(values: readonly string[]) {
  return Object.freeze([...values]);
}

function freezeIdentity(identity: RequestIdentity): RequestIdentity {
  return Object.freeze({
    accountId: identity.accountId,
    loginName: identity.loginName,
    type: identity.type,
    roles: frozenStrings(identity.roles),
    permissions: frozenStrings(identity.permissions),
    allowedApps: frozenStrings(identity.allowedApps),
    personId: identity.personId,
    memberId: identity.memberId,
    credentialRevision: identity.credentialRevision,
  });
}

function freezeSessionAssurance(
  assurance: RequestSessionAssurance,
): RequestSessionAssurance {
  return Object.freeze({
    sessionId: assurance.sessionId,
    accountId: assurance.accountId,
    credentialRevision: assurance.credentialRevision,
    mfaVerifiedAt: assurance.mfaVerifiedAt,
    mfaProviderId: assurance.mfaProviderId,
    mfaMethod: assurance.mfaMethod,
  });
}

/**
 * Internal Core boundary used by authentication middleware. Runtime modules
 * only receive the read-only capability created in module-request-identity-runtime.
 */
export function runWithVerifiedRequestIdentity<T>(
  identity: RequestIdentity | null,
  callback: () => T,
  sessionAssurance: RequestSessionAssurance | null = null,
): T {
  const context = Object.freeze({
    identity: identity ? freezeIdentity(identity) : null,
    sessionAssurance: sessionAssurance
      ? freezeSessionAssurance(sessionAssurance)
      : null,
  });
  return requestIdentityStorage.run(context, callback);
}

export function getVerifiedRequestIdentity(): RequestIdentity | null {
  return requestIdentityStorage.getStore()?.identity ?? null;
}

export function getVerifiedRequestSessionAssurance(): RequestSessionAssurance | null {
  return requestIdentityStorage.getStore()?.sessionAssurance ?? null;
}
