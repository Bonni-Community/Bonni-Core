export const JITSI_SECRET_MIN_LENGTH = 32;
export const JITSI_SECRET_MAX_LENGTH = 512;
/**
 * Jitsi JWT secrets are exact UTF-8 values. They are never trimmed,
 * normalized or coerced. Empty input is accepted only for the explicit
 * clear-secret update; omitting the property keeps the current secret.
 */
export function validateExactJitsiSecret(value, { allowEmpty = false } = {}) {
    if (typeof value !== "string")
        return { ok: false, code: "JITSI_SECRET_INVALID_TYPE" };
    if (value.length === 0) {
        return allowEmpty
            ? { ok: true, secret: value, characters: 0, utf8Bytes: 0 }
            : { ok: false, code: "JITSI_SECRET_EMPTY" };
    }
    if (/[\r\n\0]/u.test(value))
        return { ok: false, code: "JITSI_SECRET_CONTROL_CHARACTER" };
    const characters = [...value].length;
    if (characters < JITSI_SECRET_MIN_LENGTH)
        return { ok: false, code: "JITSI_SECRET_TOO_SHORT" };
    if (characters > JITSI_SECRET_MAX_LENGTH)
        return { ok: false, code: "JITSI_SECRET_TOO_LONG" };
    const bytes = Buffer.from(value, "utf8");
    if (bytes.toString("utf8") !== value)
        return { ok: false, code: "JITSI_SECRET_INVALID_UNICODE" };
    return { ok: true, secret: value, characters, utf8Bytes: bytes.length };
}
export function assertExactJitsiSecret(value, options = {}) {
    const validation = validateExactJitsiSecret(value, options);
    if (!validation.ok) {
        throw Object.assign(new Error(validation.code), { code: validation.code, statusCode: 400 });
    }
    return validation.secret;
}
