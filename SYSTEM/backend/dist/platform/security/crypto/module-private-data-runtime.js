import { createHmac } from "node:crypto";
import { requireRuntimeSecret } from "./runtime-secret.js";
import { decryptAes256GcmToUtf8, encryptAes256Gcm } from "./symmetric.js";
export const MODULE_PRIVATE_DATA_CONTRACT_VERSION = "bonni.private-data/v1";
const PREFIX = "mpd1";
function normalize(value, code, max = 180) {
    const result = String(value ?? "").trim().toLowerCase();
    if (!result || result.length > max)
        throw Object.assign(new Error(code), { statusCode: 500 });
    return result;
}
function rootKey() {
    const secret = requireRuntimeSecret({
        names: ["MODULE_PRIVATE_DATA_SECRET"],
        errorCode: "MODULE_PRIVATE_DATA_SECRET_NOT_CONFIGURED",
        minLength: 43,
    });
    return createHmac("sha256", secret)
        .update("bonni-core:module-private-data:v1")
        .digest();
}
export function createModulePrivateDataRuntime(moduleKeyValue) {
    const moduleKey = normalize(moduleKeyValue, "PRIVATE_DATA_MODULE_KEY_INVALID");
    const key = () => createHmac("sha256", rootKey()).update(`module:${moduleKey}`).digest();
    const aad = (subjectIdValue, fieldValue) => {
        const subjectId = normalize(subjectIdValue, "PRIVATE_DATA_SUBJECT_REQUIRED");
        const field = normalize(fieldValue, "PRIVATE_DATA_FIELD_REQUIRED", 100);
        return `bonni.private-data/v1|module:${moduleKey}|subject:${subjectId}|field:${field}`;
    };
    return Object.freeze({
        contractVersion: MODULE_PRIVATE_DATA_CONTRACT_VERSION,
        encrypt(subjectId, field, value) {
            if (value === null || value === undefined || value === "")
                return null;
            return `${PREFIX}.${encryptAes256Gcm(String(value), key(), aad(subjectId, field))}`;
        },
        decrypt(subjectId, field, value) {
            if (value === null || value === undefined || value === "")
                return null;
            if (!String(value).startsWith(`${PREFIX}.`)) {
                throw Object.assign(new Error("PRIVATE_DATA_CIPHERTEXT_INVALID"), { statusCode: 500 });
            }
            return decryptAes256GcmToUtf8(String(value).slice(PREFIX.length + 1), key(), aad(subjectId, field));
        },
    });
}
