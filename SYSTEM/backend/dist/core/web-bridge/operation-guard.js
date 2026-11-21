import { bridgeError } from "./protocol.js";
const active = new Set();
export function isWebBridgeBusy(provider) { return active.has(provider); }
export async function withWebBridgeOperation(provider, operation) {
    if (active.has(provider))
        throw bridgeError("WEB_BRIDGE_BUSY", 409);
    // Reserve synchronously, before any database or network await.
    active.add(provider);
    try {
        return await operation();
    }
    finally {
        active.delete(provider);
    }
}
