import { hmacDigest, hmacHex } from "./hash.js";
import { getPersonalDataMasterKey, isPersonalDataMasterKeyLoaded } from "./master-key.js";
const DERIVATION_CONTEXT_VERSION = "bonni-core:identity-bound-crypto:v1";
export function hasCompleteIdentityCryptoContext(context) {
    return Boolean(normalizeContextValue(context?.accountId) && normalizeContextValue(context?.memberId));
}
export function normalizeIdentityCryptoContext(context) {
    const accountId = normalizeContextValue(context.accountId);
    const memberId = normalizeContextValue(context.memberId);
    if (!accountId) {
        throw new Error("IDENTITY_CRYPTO_ACCOUNT_ID_REQUIRED");
    }
    if (!memberId) {
        throw new Error("IDENTITY_CRYPTO_MEMBER_ID_REQUIRED");
    }
    return [
        DERIVATION_CONTEXT_VERSION,
        "scope:account-member",
        `account:${accountId}`,
        `member:${memberId}`,
    ].join("|");
}
/**
 * Creates one purpose-specific root key from the server master key.
 *
 * This is the cryptographic version of "two keys from one entered server key".
 * We never reverse strings or concatenate raw secrets. The purpose label separates
 * the roots so the encryption key and DSGVO audit key cannot be substituted for
 * each other.
 */
export function derivePurposeRootKey(purpose) {
    const masterKey = getPersonalDataMasterKey({ required: true });
    return hmacDigest(`${DERIVATION_CONTEXT_VERSION}|root-purpose:${purpose}`, masterKey, "sha256");
}
/**
 * Creates a long 256-bit key bound to both accountId and memberId.
 */
export function deriveIdentityBoundKey(purpose, context) {
    const rootKey = derivePurposeRootKey(purpose);
    return hmacDigest(normalizeIdentityCryptoContext(context), rootKey, "sha256");
}
export function derivePersonalDataEncryptionKey(context) {
    return deriveIdentityBoundKey("personal-data-encryption", context);
}
export function deriveDsgvoAuditIdentityHashKey(context) {
    return deriveIdentityBoundKey("dsgvo-audit-hash", context);
}
/**
 * System-level audit entries do not always belong to one subject account/member.
 * They still use a separate master-key-derived key, but without identity binding.
 */
export function deriveDsgvoAuditChainKey() {
    return derivePurposeRootKey("dsgvo-audit-chain");
}
export function createIdentityCryptoContextFingerprint(context) {
    const rootKey = derivePurposeRootKey("dsgvo-audit-hash");
    return hmacHex(normalizeIdentityCryptoContext(context), rootKey, "sha256").slice(0, 24);
}
export function getIdentityBoundCryptoStatus(context) {
    return {
        masterKeyLoaded: isPersonalDataMasterKeyLoaded(),
        identityContextComplete: hasCompleteIdentityCryptoContext(context),
    };
}
function normalizeContextValue(value) {
    return value?.trim() ?? "";
}
