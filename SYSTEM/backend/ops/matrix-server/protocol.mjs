import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export const PROTOCOL = "bonni.matrix-manager/v1";
export const ACTIONS = ["status", "start", "stop", "restart", "configuration", "configure", "check-update", "update"];
export function fail(code, statusCode = 400) { return Object.assign(new Error(code), { statusCode }); }
export function signature(secret, body) {
  return createHmac("sha256", secret).update(`request\n${PROTOCOL}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
}
export function responseSignature(secret, requestId, status, body) {
  return createHmac("sha256", secret).update(`response\n${requestId}\n${status}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
}
export function verifyCommand(raw, signed, secret, installationId, nonces, now = Date.now()) {
  if (Buffer.byteLength(raw) > 32_768 || !/^[a-f0-9]{64}$/.test(signed || "")) throw fail("AUTH_INVALID", 401);
  if (!timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(secret, raw), "hex"))) throw fail("AUTH_INVALID", 401);
  let value;
  try { value = JSON.parse(raw); } catch { throw fail("INPUT_INVALID"); }
  if (value.protocol !== PROTOCOL || value.installationId !== installationId) throw fail("IDENTITY_MISMATCH", 403);
  if (!/^[0-9a-f-]{36}$/.test(value.requestId || "") || !/^[A-Za-z0-9_-]{32}$/.test(value.nonce || "")
    || !Number.isSafeInteger(value.timestamp) || Math.abs(now - value.timestamp) > 60_000) throw fail("REQUEST_EXPIRED", 401);
  for (const [nonce, time] of nonces) if (now - time > 120_000) nonces.delete(nonce);
  if (nonces.has(value.nonce)) throw fail("REPLAY_REJECTED", 409);
  if (nonces.size >= 10_000) throw fail("REQUEST_LIMIT", 429);
  nonces.set(value.nonce, now);
  if (!ACTIONS.includes(value.action) || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw fail("INPUT_INVALID");
  return value;
}
export function serverName(value) {
  if (typeof value !== "string" || value.length > 255 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/.test(value)
    || value.split(":")[0].split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))
    || /^[0-9.]+$/.test(value.split(":")[0]) || (value.includes(":") && Number(value.split(":")[1]) > 65535)) throw fail("SERVER_NAME_INVALID");
  return value;
}
export function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail("PUBLIC_URL_INVALID"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw fail("PUBLIC_URL_INVALID");
  return url.origin;
}
export function version(value) {
  if (typeof value !== "string" || !/^1\.[0-9]{1,4}\.[0-9]{1,4}$/.test(value)) throw fail("VERSION_INVALID");
  return value;
}
export function newer(candidate, current) {
  const a = version(candidate).split(".").map(Number), b = version(current).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function configuration(input, ownServer) {
  if (!input || Object.keys(input).some((key) => !["serverName", "publicBaseUrl", "allowedServers", "maxUploadMiB", "revision"].includes(key))) throw fail("CONFIGURATION_INVALID");
  if (input.serverName !== ownServer) throw fail("SERVER_NAME_IMMUTABLE");
  if (!Array.isArray(input.allowedServers) || input.allowedServers.length > 32 || !Number.isSafeInteger(input.maxUploadMiB)
    || input.maxUploadMiB < 1 || input.maxUploadMiB > 100 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw fail("CONFIGURATION_INVALID");
  return { serverName: ownServer, publicBaseUrl: publicUrl(input.publicBaseUrl),
    allowedServers: [...new Set(input.allowedServers.map(serverName))].filter((name) => name !== ownServer),
    maxUploadMiB: input.maxUploadMiB, revision: input.revision };
}
