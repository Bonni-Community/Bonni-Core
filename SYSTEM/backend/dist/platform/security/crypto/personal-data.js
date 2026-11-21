import { derivePersonalDataEncryptionKey, normalizeIdentityCryptoContext, } from "./derived-keys.js";
import { decryptAes256GcmToUtf8, encryptAes256Gcm } from "./symmetric.js";
/**
 * Version 3 derives two independent purpose keys from one server master key.
 * This file uses only the personal-data-encryption purpose key and binds it to:
 *
 *   Server-Master-Key + accountId + memberId
 *
 * The DSGVO audit module uses the same identity context, but a different purpose
 * key. Do not add personId, fieldName, admin account IDs or system account IDs
 * to this key context without introducing another cipher prefix/version.
 */
const PERSONAL_DATA_CIPHER_PREFIX = "pd3";
const LEGACY_PERSONAL_DATA_CIPHER_PREFIXES = ["pd1", "pd2"];
export function derivePersonalDataIdentityKey(context) {
    return derivePersonalDataEncryptionKey(context);
}
/**
 * Backwards-compatible export name for callers that already used the first helper.
 */
export const derivePersonalDataFieldKey = derivePersonalDataIdentityKey;
export function createPersonalDataAad(context) {
    return normalizeIdentityCryptoContext(context);
}
/**
 * Backwards-compatible export name for existing callers.
 */
export const createPersonalDataFieldAad = createPersonalDataAad;
export function encryptPersonalDataField(value, context) {
    if (value === null || value === undefined) {
        return null;
    }
    const plaintext = value instanceof Date ? value.toISOString() : String(value);
    const key = derivePersonalDataIdentityKey(context);
    const aad = createPersonalDataAad(context);
    return `${PERSONAL_DATA_CIPHER_PREFIX}.${encryptAes256Gcm(plaintext, key, aad)}`;
}
export function decryptPersonalDataField(value, context) {
    if (value === null || value === undefined) {
        return null;
    }
    if (!isEncryptedPersonalDataField(value)) {
        return value;
    }
    for (const legacyPrefix of LEGACY_PERSONAL_DATA_CIPHER_PREFIXES) {
        if (value.startsWith(`${legacyPrefix}.`)) {
            throw new Error("PERSONAL_DATA_LEGACY_CIPHER_CONTEXT_REQUIRES_MIGRATION");
        }
    }
    const encryptedValue = value.slice(`${PERSONAL_DATA_CIPHER_PREFIX}.`.length);
    const key = derivePersonalDataIdentityKey(context);
    const aad = createPersonalDataAad(context);
    return decryptAes256GcmToUtf8(encryptedValue, key, aad);
}
export function isEncryptedPersonalDataField(value) {
    return (typeof value === "string" &&
        (value.startsWith(`${PERSONAL_DATA_CIPHER_PREFIX}.`) ||
            LEGACY_PERSONAL_DATA_CIPHER_PREFIXES.some((prefix) => value.startsWith(`${prefix}.`))));
}
