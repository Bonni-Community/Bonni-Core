import { AsyncLocalStorage } from "node:async_hooks";
const requestIdentityStorage = new AsyncLocalStorage();
function frozenStrings(values) {
    return Object.freeze([...values]);
}
function freezeIdentity(identity) {
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
function freezeSessionAssurance(assurance) {
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
export function runWithVerifiedRequestIdentity(identity, callback, sessionAssurance = null) {
    const context = Object.freeze({
        identity: identity ? freezeIdentity(identity) : null,
        sessionAssurance: sessionAssurance
            ? freezeSessionAssurance(sessionAssurance)
            : null,
    });
    return requestIdentityStorage.run(context, callback);
}
export function getVerifiedRequestIdentity() {
    return requestIdentityStorage.getStore()?.identity ?? null;
}
export function getVerifiedRequestSessionAssurance() {
    return requestIdentityStorage.getStore()?.sessionAssurance ?? null;
}
