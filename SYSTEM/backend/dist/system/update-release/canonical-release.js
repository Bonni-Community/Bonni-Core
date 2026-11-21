import { parseReleaseManifest, parseReleaseManifestPayload, } from "./release-manifest.schema.js";
export const RELEASE_SIGNATURE_DOMAIN = "BONNI_CORE_RELEASE_MANIFEST_V2";
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new Error("CANONICAL_JSON_REQUIRES_SAFE_INTEGER");
        return String(value);
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
    }
    throw new Error(`UNSUPPORTED_CANONICAL_JSON_TYPE:${typeof value}`);
}
export function unsignedReleasePayload(manifest) {
    const { signature: _signature, ...payload } = parseReleaseManifest(manifest);
    return parseReleaseManifestPayload(payload);
}
export function canonicalizeReleasePayload(value) {
    return canonicalJson(unsignedReleasePayload(parseReleaseManifest(value)));
}
export function releaseSignatureBytes(value) {
    const parsed = parseReleaseManifest(value);
    const payload = unsignedReleasePayload(parsed);
    return Buffer.from(`${RELEASE_SIGNATURE_DOMAIN}\n${canonicalJson(payload)}\n`, "utf8");
}
