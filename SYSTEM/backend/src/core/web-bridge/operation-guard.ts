import { bridgeError, type WebProvider } from "./protocol.js";

const active = new Set<WebProvider>();
export function isWebBridgeBusy(provider: WebProvider) { return active.has(provider); }

export async function withWebBridgeOperation<T>(provider: WebProvider, operation: () => Promise<T>): Promise<T> {
  if (active.has(provider)) throw bridgeError("WEB_BRIDGE_BUSY", 409);
  // Reserve synchronously, before any database or network await.
  active.add(provider);
  try { return await operation(); }
  finally { active.delete(provider); }
}
