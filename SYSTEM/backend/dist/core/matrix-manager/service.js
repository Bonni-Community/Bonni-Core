import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { requireRuntimeSecret } from "../../platform/security/crypto/runtime-secret.js";
import { encryptAes256Gcm, decryptAes256GcmToUtf8 } from "../../platform/security/crypto/symmetric.js";
import { getSystemRuntimeConfig } from "../../system/runtime/runtime.config.js";
import { commandSchema, managerError, managerRequest, normalizeControllerUrl, requiredGrant, settingsSchema } from "./protocol.js";
const KEY = "integration.matrixManager.v1";
const AAD = "bonni-core:matrix-manager:v1";
const empty = { controllerUrl: "", installationId: "bonni-matrix", secretCipher: "", version: 0,
    grants: { status: false, lifecycle: false, configure: false, update: false } };
let operation = null;
function activeCore() {
    const runtime = getSystemRuntimeConfig();
    if (runtime.slotRole !== "active" || runtime.updateProbeMode)
        throw managerError("ACTIVE_CORE_REQUIRED", 409);
}
function encryptionKey() {
    return createHmac("sha256", requireRuntimeSecret({ names: ["MODULE_PRIVATE_DATA_SECRET"],
        minLength: 43, errorCode: "MATRIX_MANAGER_STORAGE_SECRET_REQUIRED" })).update(AAD).digest();
}
async function config() { return { ...empty, ...(await prisma.systemSetting.findUnique({ where: { key: KEY } }))?.value }; }
function publicConfig(value) { const { secretCipher, ...settings } = value; return { ...settings, secretConfigured: Boolean(secretCipher) }; }
async function remote(value, action, payload = {}) {
    if (!value.grants.status || !value.grants[requiredGrant(action)])
        throw managerError("GRANT_REQUIRED", 403);
    if (!value.controllerUrl || !value.secretCipher)
        throw managerError("NOT_CONFIGURED", 409);
    return managerRequest({ controllerUrl: value.controllerUrl, installationId: value.installationId,
        secret: decryptAes256GcmToUtf8(value.secretCipher, encryptionKey(), AAD) }, action, payload);
}
export async function getMatrixManagerSettings() { return { settings: publicConfig(await config()), busy: Boolean(operation) }; }
export async function getMatrixManagerStatus() {
    const value = await config();
    if (!value.grants.status)
        return { settings: publicConfig(value), status: null };
    return { settings: publicConfig(value), status: await remote(value, "status") };
}
export async function updateMatrixManagerSettings(raw, accountId) {
    activeCore();
    const input = settingsSchema.parse(raw), controllerUrl = normalizeControllerUrl(input.controllerUrl);
    if (operation)
        throw managerError("BUSY", 409);
    const result = prisma.$transaction(async (tx) => {
        const before = { ...empty, ...(await tx.systemSetting.findUnique({ where: { key: KEY } }))?.value };
        if (input.version !== before.version)
            throw managerError("CONFIGURATION_CHANGED", 409);
        const changed = controllerUrl !== before.controllerUrl || input.installationId !== before.installationId;
        const secretCipher = input.secret ? encryptAes256Gcm(input.secret, encryptionKey(), AAD) : changed ? "" : before.secretCipher;
        if (input.grants.status && (!controllerUrl || !secretCipher))
            throw managerError("NOT_CONFIGURED", 409);
        if (!input.grants.status && (input.grants.lifecycle || input.grants.configure || input.grants.update))
            throw managerError("STATUS_GRANT_REQUIRED");
        const next = { controllerUrl, installationId: input.installationId, grants: input.grants, secretCipher,
            version: before.version + 1, updatedAt: new Date().toISOString() };
        await tx.systemSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
        await tx.auditLog.create({ data: { category: "SECURITY", event: "MATRIX_MANAGER_GRANTS_CHANGED", result: "SUCCESS", accountId,
                targetType: "MatrixServer", targetId: next.installationId, severity: "WARN",
                metadataJson: { controllerOrigin: controllerUrl, grants: input.grants, secretRotated: Boolean(input.secret), version: next.version } } });
        return { settings: publicConfig(next) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    operation = result;
    try {
        return await result;
    }
    finally {
        operation = null;
    }
}
export async function runMatrixManagerCommand(raw, accountId) {
    activeCore();
    const { action, payload = {} } = commandSchema.parse(raw);
    if (operation)
        throw managerError("BUSY", 409);
    const work = (async () => {
        const current = await config();
        if (!current.grants.status || !current.grants[requiredGrant(action)])
            throw managerError("GRANT_REQUIRED", 403);
        if (!["status", "configuration"].includes(action))
            await prisma.auditLog.create({ data: {
                    category: "SECURITY", event: "MATRIX_SERVER_OPERATION_AUTHORIZED", result: "SUCCESS", accountId,
                    targetType: "MatrixServer", targetId: current.installationId, severity: "WARN",
                    metadataJson: { action, configurationVersion: current.version },
                } });
        const result = await remote(current, action, payload);
        return { result };
    })();
    operation = work;
    try {
        return await work;
    }
    finally {
        operation = null;
    }
}
