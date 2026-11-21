import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const MATRIX_MANAGER_PROTOCOL = "bonni.matrix-manager/v1";
export const actions = ["status", "start", "stop", "restart", "configuration", "configure", "check-update", "update"] as const;
export type MatrixAction = typeof actions[number];
export const grantsSchema = z.object({ status: z.boolean(), lifecycle: z.boolean(), configure: z.boolean(), update: z.boolean() }).strict();
export const settingsSchema = z.object({ controllerUrl: z.string().max(500), installationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/),
  grants: grantsSchema, version: z.number().int().min(0), secret: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).optional() }).strict();
export const commandSchema = z.object({ action: z.enum(actions), payload: z.record(z.string(), z.unknown()).optional() }).strict();
export function managerError(code: string, statusCode = 400) { return Object.assign(new Error(`MATRIX_MANAGER_${code}`), { statusCode }); }
export function requiredGrant(action: MatrixAction) {
  return action === "status" || action === "configuration" ? "status" : ["start", "stop", "restart"].includes(action)
    ? "lifecycle" : action === "configure" ? "configure" : "update";
}
export function normalizeControllerUrl(value: string) {
  if (!value) return "";
  let url: URL;
  try { url = new URL(value); } catch { throw managerError("URL_INVALID"); }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
    || !["http:", "https:"].includes(url.protocol)) throw managerError("URL_INVALID");
  const approved = (process.env.MATRIX_MANAGER_ALLOWED_ORIGINS || "http://127.0.0.1:18090,http://localhost:18090,http://bonni-matrix-manager:18090")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!approved.includes(url.origin)) throw managerError("ORIGIN_NOT_APPROVED", 403);
  return url.origin;
}
export function requestSignature(secret: string, body: string) {
  return createHmac("sha256", secret).update(`request\n${MATRIX_MANAGER_PROTOCOL}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
}
export function responseSignature(secret: string, requestId: string, status: number, body: string) {
  return createHmac("sha256", secret).update(`response\n${requestId}\n${status}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
}
export async function managerRequest(connection: { controllerUrl: string; installationId: string; secret: string },
  action: MatrixAction, payload: Record<string, unknown> = {}, fetcher: typeof fetch = fetch) {
  const origin = normalizeControllerUrl(connection.controllerUrl);
  const requestId = randomUUID();
  const body = JSON.stringify({ protocol: MATRIX_MANAGER_PROTOCOL, installationId: connection.installationId,
    action, payload, requestId, timestamp: Date.now(), nonce: randomBytes(24).toString("base64url") });
  if (Buffer.byteLength(body) > 32_768) throw managerError("REQUEST_TOO_LARGE");
  let response: Response;
  try {
    response = await fetcher(`${origin}/v1/command`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "X-Bonni-Signature": requestSignature(connection.secret, body) }, body });
  } catch { throw managerError("UNREACHABLE", 502); }
  if (response.status >= 300 && response.status < 400) throw managerError("REDIRECT_REJECTED", 502);
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 262_144) { await reader.cancel(); throw managerError("RESPONSE_TOO_LARGE", 502); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString("utf8");
  const signature = response.headers.get("X-Bonni-Signature") || "";
  const expected = responseSignature(connection.secret, requestId, response.status, raw);
  if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    throw managerError("RESPONSE_SIGNATURE_INVALID", 502);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw managerError("RESPONSE_INVALID", 502); }
  if (data.protocol !== MATRIX_MANAGER_PROTOCOL || data.installationId !== connection.installationId || data.requestId !== requestId) {
    throw managerError("REMOTE_IDENTITY_MISMATCH", 502);
  }
  if (!response.ok) throw managerError(/^[A-Z_]{2,80}$/.test(data.error) ? data.error : "REMOTE_OPERATION_FAILED", response.status);
  return data.result;
}
