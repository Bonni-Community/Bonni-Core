import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
export const WEB_BRIDGE_PROTOCOL = "bonni.web-bridge/v1";
export const providers = ["drupal", "typo3"];
export const MAX_RESPONSE_BYTES = 1_048_576;
export const siteIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/);
export const secretSchema = z.string().regex(/^[a-f0-9]{64}$/, "64 zufällige Hex-Zeichen erforderlich");
const decimal = z.string().regex(/^\d{1,16}(?:\.\d{1,6})?$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const short = z.string().max(200);
export const orderEventSchema = z.object({
    id,
    type: z.enum(["order.placed", "order.updated", "order.cancelled"]),
    occurredAt: z.iso.datetime(),
    order: z.object({
        id,
        number: short,
        status: z.string().min(1).max(80),
        currency: z.string().regex(/^[A-Z]{3}$/),
        total: decimal,
        paidTotal: decimal,
        email: z.string().max(254).optional(),
        items: z.array(z.object({
            id,
            sku: z.string().max(160),
            title: short,
            quantity: decimal,
            unitPrice: decimal,
        }).strict()).max(200),
    }).strict(),
}).strict();
// This is an explicit public projection. Never serialize a member or an app
// entity directly into this contract. Monetary values stay decimal strings.
export const publicContentSchema = z.object({
    title: z.string().max(160),
    text: z.string().max(10_000),
    events: z.array(z.object({
        id, title: short, startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime().optional(), description: z.string().max(5_000),
    }).strict()).max(100),
    products: z.array(z.object({
        id, sku: z.string().min(1).max(160), title: short,
        description: z.string().max(5_000), currency: z.string().regex(/^[A-Z]{3}$/),
        price: decimal, available: z.boolean(),
    }).strict()).max(200),
}).strict();
export function bridgeError(code, statusCode = 400) {
    return Object.assign(new Error(code), { code, statusCode });
}
export function normalizeBaseUrl(value) {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw bridgeError("WEB_BRIDGE_URL_INVALID");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw bridgeError("WEB_BRIDGE_HTTPS_REQUIRED");
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
        throw bridgeError("WEB_BRIDGE_PUBLIC_HOST_REQUIRED");
    }
    if (url.pathname.includes("%") || /\/\//.test(url.pathname))
        throw bridgeError("WEB_BRIDGE_PATH_INVALID");
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
export const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
export function requestSignature(secret, siteId, method, path, timestamp, nonce, body) {
    return createHmac("sha256", secret).update([
        WEB_BRIDGE_PROTOCOL, siteId, method, path, timestamp, nonce, sha256(body),
    ].join("\n")).digest("hex");
}
export function responseSignature(secret, siteId, status, path, timestamp, nonce, body) {
    return createHmac("sha256", secret).update([
        `${WEB_BRIDGE_PROTOCOL}:response`, siteId, String(status), path, timestamp, nonce, sha256(body),
    ].join("\n")).digest("hex");
}
export function signaturesEqual(expected, supplied) {
    return /^[a-f0-9]{64}$/.test(supplied)
        && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}
const pendingRequests = new Set();
let transportStopping = false;
export function resumeWebBridgeRequests() { transportStopping = false; }
export function cancelWebBridgeRequests() {
    transportStopping = true;
    for (const controller of pendingRequests)
        controller.abort(bridgeError("WEB_BRIDGE_STOPPING", 503));
}
export async function bridgeRequest(connection, operation, data, fetcher = fetch) {
    if (transportStopping)
        throw bridgeError("WEB_BRIDGE_STOPPING", 503);
    const url = new URL(`${normalizeBaseUrl(connection.baseUrl)}/bonni/bridge/v1/${operation}`);
    const path = url.pathname;
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
        throw bridgeError("WEB_BRIDGE_REQUEST_TOO_LARGE");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const abort = new AbortController();
    pendingRequests.add(abort);
    const timer = setTimeout(() => abort.abort(bridgeError("WEB_BRIDGE_REQUEST_TIMEOUT", 504)), 10_000);
    try {
        const response = await fetcher(url, {
            method: "POST", redirect: "manual", signal: abort.signal,
            headers: {
                "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-store",
                "X-Bonni-Site": connection.siteId, "X-Bonni-Timestamp": timestamp, "X-Bonni-Nonce": nonce,
                "X-Bonni-Signature": requestSignature(connection.secret, connection.siteId, "POST", path, timestamp, nonce, body),
            }, body,
        });
        if (response.status >= 300 && response.status < 400)
            throw bridgeError("WEB_BRIDGE_REDIRECT_REJECTED", 502);
        if (!/application\/json/i.test(response.headers.get("content-type") || "")) {
            throw bridgeError("WEB_BRIDGE_JSON_REQUIRED", 502);
        }
        if (!response.body)
            throw bridgeError("WEB_BRIDGE_EMPTY_RESPONSE", 502);
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                bytes += value.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) {
                    await reader.cancel();
                    throw bridgeError("WEB_BRIDGE_RESPONSE_TOO_LARGE", 502);
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const expected = responseSignature(connection.secret, connection.siteId, response.status, path, timestamp, nonce, raw);
        if (!signaturesEqual(expected, response.headers.get("x-bonni-signature") || "")) {
            throw bridgeError("WEB_BRIDGE_RESPONSE_SIGNATURE_INVALID", 502);
        }
        if (!response.ok)
            throw bridgeError(`WEB_BRIDGE_REMOTE_HTTP_${response.status}`, 502);
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw bridgeError("WEB_BRIDGE_RESPONSE_INVALID", 502);
        return parsed;
    }
    catch (error) {
        if (abort.signal.aborted)
            throw abort.signal.reason;
        abort.abort();
        if (error && typeof error === "object" && "code" in error)
            throw error;
        throw bridgeError("WEB_BRIDGE_CONNECTION_FAILED", 502);
    }
    finally {
        clearTimeout(timer);
        pendingRequests.delete(abort);
    }
}
// The remote delivery receipt is sent only after a durable local write.
// Processing by a business app or Kontor is a separate, later operation.
export async function receiveOrderBatch(input) {
    const delivered = [];
    let imported = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const raw of input.events) {
        const parsed = orderEventSchema.safeParse(raw);
        if (!parsed.success) {
            rejected++;
            continue;
        }
        const created = await input.persist(parsed.data);
        if (created)
            imported++;
        else
            duplicates++;
        if (!delivered.includes(parsed.data.id))
            delivered.push(parsed.data.id);
    }
    if (delivered.length) {
        const confirmed = await input.acknowledge(delivered);
        if (confirmed.length !== delivered.length || new Set(confirmed).size !== delivered.length
            || confirmed.some((id) => !delivered.includes(id))) {
            throw bridgeError("WEB_BRIDGE_ACK_MISMATCH", 502);
        }
    }
    return { imported, duplicates, rejected, delivered };
}
