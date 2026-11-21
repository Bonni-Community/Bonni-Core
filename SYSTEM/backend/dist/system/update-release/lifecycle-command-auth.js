import crypto from "node:crypto";
export const DEPLOYMENT_LIFECYCLE_AUTH_DOMAIN = "BONNI_CORE_DEPLOYMENT_LIFECYCLE_V1";
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new Error("LIFECYCLE_CANONICAL_JSON_REQUIRES_SAFE_INTEGER");
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
    throw new Error(`UNSUPPORTED_LIFECYCLE_CANONICAL_JSON_TYPE:${typeof value}`);
}
export function canonicalLifecycleCommand(command) {
    return Buffer.from(`${DEPLOYMENT_LIFECYCLE_AUTH_DOMAIN}\n${canonicalJson(command)}\n`, "utf8");
}
export function signLifecycleCommand(command, secret) {
    if (!Buffer.isBuffer(secret) || secret.length < 32)
        throw new Error("UPDATE_REQUEST_SECRET_TOO_SHORT");
    const value = crypto.createHmac("sha256", secret)
        .update(canonicalLifecycleCommand(command))
        .digest("hex");
    return { ...command, auth: { algorithm: "HMAC-SHA256", value } };
}
