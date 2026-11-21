import crypto from "node:crypto";
export const UPDATE_REQUEST_AUTH_DOMAIN = "BONNI_CORE_UPDATE_REQUEST_V1";
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new Error("REQUEST_CANONICAL_JSON_REQUIRES_SAFE_INTEGER");
        return String(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(",")}}`;
    }
    throw new Error(`UNSUPPORTED_REQUEST_CANONICAL_JSON_TYPE:${typeof value}`);
}
export function canonicalUpdateRunnerRequest(request) {
    const { auth: _auth, ...unsigned } = request;
    return Buffer.from(`${UPDATE_REQUEST_AUTH_DOMAIN}\n${canonicalJson(unsigned)}\n`, "utf8");
}
export function signUpdateRunnerRequest(request, secret) {
    if (!Buffer.isBuffer(secret) || secret.length < 32)
        throw new Error("UPDATE_REQUEST_SECRET_TOO_SHORT");
    const { auth: _auth, ...unsigned } = request;
    const value = crypto.createHmac("sha256", secret)
        .update(canonicalUpdateRunnerRequest(unsigned))
        .digest("hex");
    return {
        ...unsigned,
        auth: { algorithm: "HMAC-SHA256", value },
    };
}
