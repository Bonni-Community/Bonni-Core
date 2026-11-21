import { createRandomCode, createBase64UrlToken, decryptAes256GcmToUtf8, deriveSha256Key, encryptAes256Gcm, hmacDigest, hmacSha256, requireRuntimeSecret, safeEqual, secureRandomBytes, } from "../../../../platform/security/crypto/index.js";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_SECRET_AAD = "security:two-factor:totp-secret:v1";
// Six digits are the interoperable default used by the otpauth URI format.
// Eight digits remain available through TWO_FACTOR_TOTP_DIGITS for existing installations.
const DEFAULT_TOTP_DIGITS = 6;
const DEFAULT_TOTP_PERIOD_SECONDS = 30;
const DEFAULT_TOTP_WINDOW = 1;
function numberFromEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function getTotpDigits() {
    const digits = numberFromEnv("TWO_FACTOR_TOTP_DIGITS", DEFAULT_TOTP_DIGITS);
    return digits === 6 || digits === 8 ? digits : DEFAULT_TOTP_DIGITS;
}
export function getTotpPeriodSeconds() {
    return numberFromEnv("TWO_FACTOR_TOTP_PERIOD_SECONDS", DEFAULT_TOTP_PERIOD_SECONDS);
}
export function getTotpWindow() {
    return Math.min(numberFromEnv("TWO_FACTOR_TOTP_WINDOW", DEFAULT_TOTP_WINDOW), 1);
}
function getEncryptionKey() {
    const secret = requireRuntimeSecret({
        names: ["TWO_FACTOR_ENCRYPTION_KEY", "JWT_SECRET"],
        errorCode: "TWO_FACTOR_ENCRYPTION_KEY_MISSING_OR_WEAK",
    });
    return deriveSha256Key(secret);
}
export function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = "";
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}
export function base32Decode(input) {
    const normalized = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of normalized) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) {
            throw Object.assign(new Error("TWO_FACTOR_INVALID_SECRET"), { statusCode: 400 });
        }
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}
export function generateTotpSecret() {
    return base32Encode(secureRandomBytes(20));
}
export function encryptSecret(secret) {
    return encryptAes256Gcm(secret, getEncryptionKey(), TOTP_SECRET_AAD);
}
export function decryptSecret(value) {
    try {
        return decryptAes256GcmToUtf8(value, getEncryptionKey(), TOTP_SECRET_AAD);
    }
    catch (error) {
        if (error instanceof Error && error.message === "ENCRYPTED_VALUE_CORRUPT") {
            throw Object.assign(new Error("TWO_FACTOR_SECRET_CORRUPT"), { statusCode: 500 });
        }
        throw error;
    }
}
export function fingerprintSecret(secret) {
    return hmacSha256(`totp:${secret}`, getEncryptionKey());
}
function hotp(secret, counter, digits = getTotpDigits()) {
    const secretBytes = base32Decode(secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter >>> 0, 4);
    const hmac = hmacDigest(counterBuffer, secretBytes, "sha1");
    const offset = hmac[hmac.length - 1] & 0xf;
    const binary = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    const otp = binary % 10 ** digits;
    return otp.toString().padStart(digits, "0");
}
export function verifyTotpCode(secret, code, now = new Date(), window = getTotpWindow()) {
    return matchTotpCounter(secret, code, now, window) !== null;
}
export function matchTotpCounter(secret, code, now = new Date(), window = getTotpWindow()) {
    if (typeof code !== "string")
        return null;
    const cleanCode = code;
    const digits = getTotpDigits();
    if (!new RegExp(`^\\d{${digits}}$`).test(cleanCode)) {
        return null;
    }
    const counter = Math.floor(now.getTime() / 1000 / getTotpPeriodSeconds());
    for (let offset = -window; offset <= window; offset += 1) {
        if (safeEqual(hotp(secret, counter + offset, digits), cleanCode)) {
            return counter + offset;
        }
    }
    return null;
}
export function buildTotpOtpauthUri(input) {
    const issuer = input.issuer.trim() || "Bonni Core";
    const label = input.label.trim() || "Account";
    const digits = getTotpDigits();
    const period = getTotpPeriodSeconds();
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${encodeURIComponent(input.secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${digits}&period=${period}`;
}
export async function buildTotpQrCodeDataUrl(otpauthUri) {
    const QRCode = await import("qrcode");
    return QRCode.toDataURL(otpauthUri, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 256,
        type: "image/png",
    });
}
export function recoveryCodeHash(accountId, code) {
    return hmacSha256(`recovery:${accountId}:${normalizeRecoveryCode(code)}`, getEncryptionKey());
}
export function normalizeRecoveryCode(code) {
    if (typeof code !== "string" || !/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u.test(code)) {
        throw Object.assign(new Error("TWO_FACTOR_RECOVERY_CODE_FORMAT_INVALID"), { statusCode: 400 });
    }
    return code;
}
export function generateRecoveryCode() {
    const raw = createRandomCode(16);
    return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}
export function generateEnrollmentPassword() {
    // 20 cryptographically random bytes = exactly 160 bits of entropy.
    return createBase64UrlToken(20);
}
export function enrollmentPasswordHash(accountId, password) {
    return hmacSha256(`enrollment:${accountId}:${password}`, getEncryptionKey());
}
export function verifyEnrollmentPasswordHash(accountId, password, expectedHash) {
    return safeEqual(enrollmentPasswordHash(accountId, password), expectedHash);
}
