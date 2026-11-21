const DEFAULT_MIN_LENGTH = 32;
const INSECURE_SECRET_PATTERNS = [
    /change[-_ ]?me/iu,
    /development/iu,
    /dev[-_ ]?secret/iu,
    /example/iu,
    /placeholder/iu,
    /replace[-_ ]?me/iu,
    /your[-_ ]?(?:jwt[-_ ]?)?secret/iu,
];
/**
 * Reads a runtime secret without ever falling back to a value embedded in the
 * application bundle. If the first configured variable is invalid, fail
 * closed instead of silently using a lower-priority variable.
 */
export function requireRuntimeSecret(options) {
    const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
    const configuredName = options.names.find((name) => process.env[name] !== undefined);
    const secret = configuredName ? process.env[configuredName] ?? "" : "";
    const normalized = secret.trim();
    const isRepeatedCharacter = normalized.length > 0 && /^([\s\S])\1+$/u.test(normalized);
    const isInsecure = normalized.length < minLength ||
        isRepeatedCharacter ||
        INSECURE_SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
    if (!configuredName || isInsecure) {
        throw Object.assign(new Error(options.errorCode), {
            statusCode: 500,
            code: options.errorCode,
            details: {
                expectedEnvironment: options.names.join(" or "),
                minimumLength: minLength,
            },
        });
    }
    return secret;
}
