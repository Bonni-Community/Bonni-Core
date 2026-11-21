import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../database/prisma.js";
import { logger } from "../logger/logger.js";
import { requireRuntimeSecret } from "../../platform/security/crypto/runtime-secret.js";
import { decryptAes256GcmToUtf8, encryptAes256Gcm } from "../../platform/security/crypto/symmetric.js";
import { getSystemRuntimeConfig } from "../../system/runtime/runtime.config.js";
import { isWebBridgeBusy, withWebBridgeOperation } from "./operation-guard.js";
import { bridgeError, bridgeRequest, cancelWebBridgeRequests, resumeWebBridgeRequests, normalizeBaseUrl, publicContentSchema, receiveOrderBatch, secretSchema, sha256, siteIdSchema, WEB_BRIDGE_PROTOCOL, } from "./protocol.js";
const ROOT = "integration.webBridge.";
const emptyConfig = { enabled: false, baseUrl: "", siteId: "", secretCipher: "", webEnabled: false,
    shopEnabled: false, autoSync: false, pollSeconds: 60, version: 0 };
const updateSchema = z.object({
    enabled: z.boolean(), baseUrl: z.string().max(500), siteId: siteIdSchema.or(z.literal("")),
    webEnabled: z.boolean(), shopEnabled: z.boolean(), autoSync: z.boolean(),
    pollSeconds: z.number().int().min(30).max(3600), secret: secretSchema.optional(),
}).strict();
const configKey = (provider) => `${ROOT}${provider}.config`;
const publicationKey = (provider) => `${ROOT}${provider}.publication`;
function scope(provider, config) { return sha256(`${provider}\n${config.baseUrl}\n${config.siteId}`); }
function inboxPrefix(provider, config) { return `${ROOT}inbox.${scope(provider, config)}.`; }
function encryptionKey() {
    return createHmac("sha256", requireRuntimeSecret({ names: ["MODULE_PRIVATE_DATA_SECRET"],
        errorCode: "WEB_BRIDGE_STORAGE_SECRET_REQUIRED", minLength: 43 })).update("bonni-core:web-bridge:v1").digest();
}
function encrypt(value, context) { return encryptAes256Gcm(JSON.stringify(value), encryptionKey(), context); }
function decrypt(value, context) { return JSON.parse(decryptAes256GcmToUtf8(value, encryptionKey(), context)); }
async function read(key) { return (await prisma.systemSetting.findUnique({ where: { key } }))?.value ?? null; }
async function write(key, value) {
    return prisma.systemSetting.upsert({ where: { key }, create: { key, value: value },
        update: { value: value } });
}
async function configFor(provider) { return { ...emptyConfig, ...await read(configKey(provider)) }; }
function publicConfig(provider, config) {
    const { secretCipher, ...settings } = config;
    return { ...settings, provider, secretConfigured: Boolean(secretCipher) };
}
function connection(provider, config) {
    if (!config.baseUrl || !config.siteId || !config.secretCipher)
        throw bridgeError("WEB_BRIDGE_CONFIGURATION_INCOMPLETE");
    return { provider, baseUrl: config.baseUrl, siteId: config.siteId, secret: decrypt(config.secretCipher, configKey(provider)) };
}
function assertActive() {
    const runtime = getSystemRuntimeConfig();
    if (runtime.slotRole !== "active" || runtime.updateProbeMode)
        throw bridgeError("WEB_BRIDGE_ACTIVE_CORE_REQUIRED", 409);
}
export async function getWebBridgeStatus(provider) {
    const config = await configFor(provider);
    const prefix = inboxPrefix(provider, config);
    const [status, publication, inboxCount, waitingForReceipt] = await Promise.all([
        read(`${ROOT}${provider}.status`), read(publicationKey(provider)),
        prisma.systemSetting.count({ where: { key: { startsWith: prefix } } }),
        prisma.systemSetting.count({ where: { key: { startsWith: prefix }, value: { path: ["acknowledged"], equals: false } } }),
    ]);
    return { settings: publicConfig(provider, config), status, inboxCount, waitingForReceipt,
        publication: publication ? { ...publication, scopeMatches: publication.scope === scope(provider, config) } : null,
        syncing: isWebBridgeBusy(provider) };
}
export async function updateWebBridgeConfig(provider, raw, accountId) {
    return withWebBridgeOperation(provider, async () => {
        const input = updateSchema.parse(raw);
        const previous = await configFor(provider);
        const baseUrl = input.baseUrl ? normalizeBaseUrl(input.baseUrl) : "";
        const identityChanged = previous.siteId !== input.siteId || previous.baseUrl !== baseUrl;
        const secretCipher = input.secret ? encrypt(input.secret, configKey(provider))
            : identityChanged ? "" : previous.secretCipher;
        if (input.enabled && (!baseUrl || !input.siteId || !secretCipher))
            throw bridgeError("WEB_BRIDGE_CONFIGURATION_INCOMPLETE");
        const { secret, ...fields } = input;
        const config = { ...fields, baseUrl, secretCipher, version: previous.version + 1 };
        // Credential edits use the same admin-elevation contract as other Core integrations.
        await prisma.$transaction([
            prisma.systemSetting.upsert({ where: { key: configKey(provider) }, create: { key: configKey(provider), value: config }, update: { value: config } }),
            prisma.auditLog.create({ data: { category: "SECURITY", event: "WEB_BRIDGE_CONFIGURATION_CHANGED", result: "SUCCESS", accountId,
                    targetType: "WebBridge", targetId: provider, severity: "WARN",
                    metadataJson: { enabled: config.enabled, siteId: config.siteId, secretRotated: Boolean(secret), version: config.version } } }),
        ]);
        await write(`${ROOT}${provider}.status`, { state: config.enabled ? "ready" : "disabled", failures: 0, nextAttemptAt: null });
        return getWebBridgeStatus(provider);
    });
}
async function checkRemote(remote) {
    const health = await bridgeRequest(remote, "health", {});
    if (health.protocol !== WEB_BRIDGE_PROTOCOL || health.provider !== remote.provider || health.siteId !== remote.siteId) {
        throw bridgeError("WEB_BRIDGE_REMOTE_IDENTITY_MISMATCH", 502);
    }
    return { ok: true, health };
}
export async function testWebBridge(provider) {
    assertActive();
    return withWebBridgeOperation(provider, async () => checkRemote(connection(provider, await configFor(provider))));
}
export async function stageWebPublication(provider, raw) {
    return withWebBridgeOperation(provider, async () => {
        const config = await configFor(provider);
        const publication = { revision: randomUUID(), data: publicContentSchema.parse(raw), scope: scope(provider, config),
            pending: true, savedAt: new Date().toISOString() };
        await write(publicationKey(provider), publication);
        return publication;
    });
}
async function persistEvent(provider, config, event) {
    const key = `${inboxPrefix(provider, config)}${sha256(event.id)}`;
    const hash = sha256(JSON.stringify(event));
    const existing = await read(key);
    if (existing) {
        if (existing.hash !== hash)
            throw bridgeError("WEB_BRIDGE_EVENT_ID_CONFLICT", 502);
        return false;
    }
    const value = { eventId: event.id, hash, payloadCipher: encrypt(event, key), receivedAt: new Date().toISOString(), acknowledged: false };
    try {
        await prisma.systemSetting.create({ data: { key, value } });
    }
    catch (error) {
        // A parallel active process must never overwrite the first receipt.
        if (error.code !== "P2002")
            throw error;
        if ((await read(key))?.hash !== hash)
            throw bridgeError("WEB_BRIDGE_EVENT_ID_CONFLICT", 502);
        return false;
    }
    return true;
}
export async function listWebBridgeInbox(provider) {
    const config = await configFor(provider);
    const rows = await prisma.systemSetting.findMany({ where: { key: { startsWith: inboxPrefix(provider, config) } },
        orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map((row) => {
        const value = row.value;
        return { receivedAt: value.receivedAt, acknowledged: value.acknowledged, event: decrypt(value.payloadCipher, row.key) };
    });
}
export async function syncWebBridge(provider) {
    const startedAt = Date.now();
    assertActive();
    return withWebBridgeOperation(provider, async () => {
        let config = emptyConfig;
        try {
            config = await configFor(provider);
            if (!config.enabled)
                throw bridgeError("WEB_BRIDGE_DISABLED", 409);
            const remote = connection(provider, config);
            await checkRemote(remote);
            let published = false;
            const publication = await read(publicationKey(provider));
            if (config.webEnabled && publication?.pending && publication.scope === scope(provider, config)) {
                const result = await bridgeRequest(remote, "publication", { revision: publication.revision, data: publication.data });
                if (result.revision !== publication.revision)
                    throw bridgeError("WEB_BRIDGE_PUBLICATION_RECEIPT_INVALID", 502);
                await write(publicationKey(provider), { ...publication, pending: false, publishedAt: new Date().toISOString() });
                published = true;
            }
            let batch = { imported: 0, duplicates: 0, rejected: 0, delivered: [] };
            let hasMore = false;
            if (config.shopEnabled) {
                const response = await bridgeRequest(remote, "events", { limit: 25 });
                if (!Array.isArray(response.events) || response.events.length > 25 || typeof response.hasMore !== "boolean") {
                    throw bridgeError("WEB_BRIDGE_EVENT_BATCH_INVALID", 502);
                }
                hasMore = response.hasMore;
                batch = await receiveOrderBatch({ events: response.events,
                    persist: (event) => persistEvent(provider, config, event),
                    acknowledge: async (ids) => {
                        const ack = await bridgeRequest(remote, "ack", { ids });
                        if (!Array.isArray(ack.acknowledged))
                            throw bridgeError("WEB_BRIDGE_ACK_INVALID", 502);
                        return ack.acknowledged;
                    },
                });
                for (const id of batch.delivered) {
                    const key = `${inboxPrefix(provider, config)}${sha256(id)}`;
                    const receipt = await read(key);
                    if (receipt)
                        await write(key, { ...receipt, acknowledged: true });
                }
                // A lost local receipt flag after a confirmed remote ACK is reconciled
                // here too, even when Drupal/TYPO3 no longer returns that event.
                const pending = await prisma.systemSetting.findMany({ where: { key: { startsWith: inboxPrefix(provider, config) },
                        value: { path: ["acknowledged"], equals: false } }, take: 25 });
                if (pending.length) {
                    const ids = pending.map((row) => row.value.eventId);
                    const ack = await bridgeRequest(remote, "ack", { ids });
                    if (!Array.isArray(ack.acknowledged) || ids.some((id) => !ack.acknowledged.includes(id))) {
                        throw bridgeError("WEB_BRIDGE_ACK_MISMATCH", 502);
                    }
                    for (const row of pending)
                        await write(row.key, { ...row.value, acknowledged: true });
                }
            }
            const result = { state: batch.rejected ? "attention" : "connected", failures: 0, nextAttemptAt: null,
                lastSuccessAt: new Date().toISOString(), published, imported: batch.imported, duplicates: batch.duplicates,
                rejected: batch.rejected, hasMore, durationMs: Date.now() - startedAt };
            await write(`${ROOT}${provider}.status`, result);
            if (published || batch.imported || batch.rejected)
                logger.info("Web-Kopplung synchronisiert", {
                    module: "web-bridge", provider, imported: batch.imported, rejected: batch.rejected, published, durationMs: result.durationMs,
                });
            return result;
        }
        catch (error) {
            const previous = await read(`${ROOT}${provider}.status`);
            const failures = Math.min(20, (Number(previous?.failures) || 0) + 1);
            await write(`${ROOT}${provider}.status`, { ...previous, state: "waiting", failures,
                error: error.code || "WEB_BRIDGE_SYNC_FAILED",
                nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, config.pollSeconds * 1000 * 2 ** Math.min(failures - 1, 7))).toISOString() });
            logger.warn("Web-Kopplung wartet auf Wiederholung", { module: "web-bridge", provider, failures,
                code: error.code || "WEB_BRIDGE_SYNC_FAILED", durationMs: Date.now() - startedAt });
            throw error;
        }
    });
}
let workerTimer;
let workerRunning;
let workerStopped = true;
export function startWebBridgeWorker() {
    if (workerTimer || workerRunning)
        return;
    resumeWebBridgeRequests();
    workerStopped = false;
    const tick = async () => {
        try {
            if (process.env.NODE_ENV !== "production")
                return;
            assertActive();
            for (const provider of ["drupal", "typo3"]) {
                if (workerStopped)
                    break;
                try {
                    const config = await configFor(provider);
                    if (!config.enabled || !config.autoSync || isWebBridgeBusy(provider))
                        continue;
                    const status = await read(`${ROOT}${provider}.status`);
                    const nextAt = status?.nextAttemptAt ? Date.parse(status.nextAttemptAt)
                        : status?.lastSuccessAt ? Date.parse(status.lastSuccessAt) + config.pollSeconds * 1000 : 0;
                    if (Date.now() >= nextAt)
                        await syncWebBridge(provider);
                }
                catch { /* Durable status and backoff keep network outages out of startup. */ }
            }
        }
        catch { /* Candidate/emergency instances do not contact the public CMS. */ }
    };
    const run = () => {
        workerTimer = undefined;
        workerRunning = tick().finally(() => {
            workerRunning = undefined;
            if (!workerStopped) {
                workerTimer = setTimeout(run, 15_000);
                workerTimer.unref();
            }
        });
    };
    workerTimer = setTimeout(run, 5_000);
    workerTimer.unref();
}
export async function stopWebBridgeWorker() {
    workerStopped = true;
    cancelWebBridgeRequests();
    clearTimeout(workerTimer);
    workerTimer = undefined;
    await workerRunning;
}
