import { randomUUID } from "node:crypto";
export function safeRequestId(_value) {
    // This ID belongs to one diagnostic request, never to an account or client.
    return randomUUID();
}
export function safeLogPath(value) {
    if (typeof value !== "string")
        return "[Route ausgelassen]";
    // Only pass a router's declared pattern, never req.originalUrl or parameters.
    const result = privateValue({ route: value });
    return result.route || "[Route ausgelassen]";
}
import { privateValue } from "../../../scripts/runtime/log-privacy.mjs";
export function safeLogHeader(value) {
    return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) : null;
}
