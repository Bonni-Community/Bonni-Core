import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function sha256Buffer(value) {
    return createHash("sha256").update(value).digest();
}
export function deriveSha256Key(value) {
    return sha256Buffer(value);
}
export function sha256Json(value) {
    return sha256(JSON.stringify(stableJson(value)));
}
export function hmacDigest(value, secret, algorithm = "sha256") {
    return createHmac(algorithm, secret).update(value).digest();
}
export function hmacHex(value, secret, algorithm = "sha256") {
    return hmacDigest(value, secret, algorithm).toString("hex");
}
export function hmacSha256(value, secret) {
    return hmacHex(value, secret, "sha256");
}
export function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}
function stableJson(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => stableJson(entry));
    }
    if (value && typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((accumulator, key) => {
            accumulator[key] = stableJson(value[key]);
            return accumulator;
        }, {});
    }
    return value;
}
