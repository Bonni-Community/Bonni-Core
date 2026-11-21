import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveBonniProjectRoot } from "../project-root.js";
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
export function resolveCentralLicenseRoot(projectSystemRoot = resolveBonniProjectRoot(), explicitLicenseRoot) {
    const configured = String(explicitLicenseRoot || process.env.BONNI_LICENSE_ROOT || "").trim();
    const configuredModuleRoot = String(process.env.BONNI_MODULE_LICENSE_ROOT || "").trim();
    if (configuredModuleRoot) {
        const moduleRoot = path.resolve(configuredModuleRoot);
        if (path.basename(moduleRoot) !== "modules")
            throw new Error("LICENSE_MODULE_ROOT_INVALID");
        const derivedCentralRoot = path.dirname(moduleRoot);
        if (configured && path.resolve(configured) !== derivedCentralRoot) {
            throw new Error("LICENSE_STORAGE_ROOT_MISMATCH");
        }
        if (!configured)
            return derivedCentralRoot;
    }
    return configured
        ? path.resolve(configured)
        : path.join(path.resolve(projectSystemRoot), "licenses");
}
async function assertAbsolutePathWithoutSymlinks(absolute, allowMissingTail = true) {
    const resolved = path.resolve(absolute);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    let missing = false;
    for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (missing)
            continue;
        const state = await fs.lstat(current).catch((error) => {
            if (error.code === "ENOENT")
                return null;
            throw error;
        });
        if (!state) {
            if (!allowMissingTail)
                throw new Error("LICENSE_PATH_MISSING");
            missing = true;
            continue;
        }
        if (state.isSymbolicLink())
            throw new Error("LICENSE_CLEANUP_PARENT_SYMLINK_DENIED");
    }
}
async function atomicJson(file, value) {
    await assertAbsolutePathWithoutSymlinks(path.dirname(file));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await assertAbsolutePathWithoutSymlinks(path.dirname(file), false);
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644, flag: "wx" });
        await fs.rename(temporary, file);
    }
    catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function scanFamily(root, family) {
    const result = [];
    const familyRoot = path.join(root, family);
    const familyState = await fs.lstat(familyRoot).catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    if (!familyState)
        return result;
    if (!familyState.isDirectory() || familyState.isSymbolicLink()) {
        throw new Error("LICENSE_FAMILY_ROOT_INVALID");
    }
    const familyEntries = await fs.readdir(familyRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT")
            return [];
        throw error;
    });
    for (const keyEntry of familyEntries) {
        if (!keyEntry.isDirectory() || keyEntry.isSymbolicLink() || !SAFE_KEY.test(keyEntry.name)) {
            throw new Error("LICENSE_KEY_DIRECTORY_INVALID");
        }
        for (const versionEntry of await fs.readdir(path.join(root, family, keyEntry.name), { withFileTypes: true })) {
            if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink() || !SAFE_VERSION.test(versionEntry.name)) {
                throw new Error("LICENSE_VERSION_DIRECTORY_INVALID");
            }
            const relative = `${family}/${keyEntry.name}/${versionEntry.name}/RECEIPT.json`;
            const receiptFile = path.join(root, ...relative.split("/"));
            const receiptState = await fs.lstat(receiptFile);
            if (!receiptState.isFile() || receiptState.isSymbolicLink())
                throw new Error("LICENSE_RECEIPT_INVALID");
            const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
            if (!/^[a-f0-9]{64}$/u.test(String(receipt.treeSha256 || "")))
                throw new Error("LICENSE_RECEIPT_INVALID");
            if (family === "platform") {
                if (receipt.product !== keyEntry.name || receipt.version !== versionEntry.name) {
                    throw new Error("LICENSE_RECEIPT_IDENTITY_MISMATCH");
                }
            }
            else if (receipt.moduleKey !== keyEntry.name || receipt.moduleVersion !== versionEntry.name) {
                throw new Error("LICENSE_RECEIPT_IDENTITY_MISMATCH");
            }
            result.push({
                type: family === "platform" ? "platform" : "module",
                key: keyEntry.name,
                version: versionEntry.name,
                receipt: relative,
                treeSha256: receipt.treeSha256,
            });
        }
    }
    return result;
}
async function rebuildAtRoot(root) {
    await assertAbsolutePathWithoutSymlinks(root);
    await fs.mkdir(root, { recursive: true });
    await assertAbsolutePathWithoutSymlinks(root, false);
    const entries = [
        ...await scanFamily(root, "platform"),
        ...await scanFamily(root, "modules"),
    ].sort((left, right) => `${left.type}:${left.key}:${left.version}`.localeCompare(`${right.type}:${right.key}:${right.version}`, "en"));
    const catalog = { schemaVersion: "bonni.license-catalog/v1", generatedAt: new Date().toISOString(), entries };
    await atomicJson(path.join(root, "catalog.json"), catalog);
    return catalog;
}
export async function rebuildCentralLicenseCatalog(projectSystemRoot = resolveBonniProjectRoot(), explicitLicenseRoot) {
    return rebuildAtRoot(resolveCentralLicenseRoot(projectSystemRoot, explicitLicenseRoot));
}
async function readCleanupAudit(file) {
    const state = await fs.lstat(file).catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    if (!state)
        return [];
    if (!state.isFile() || state.isSymbolicLink())
        throw new Error("LICENSE_CLEANUP_HISTORY_INVALID");
    const source = await fs.readFile(file, "utf8");
    const audit = JSON.parse(source);
    if (!Array.isArray(audit))
        throw new Error("LICENSE_CLEANUP_HISTORY_INVALID");
    return audit;
}
function cleanupOperationId(version, reason) {
    return crypto.createHash("sha256").update(`platform\0bonni-core\0${version}\0${reason}`).digest("hex");
}
export async function removeCoreLicenseVersion(version, reason, projectSystemRoot = resolveBonniProjectRoot(), explicitLicenseRoot) {
    if (!SAFE_VERSION.test(version))
        throw new Error("LICENSE_VERSION_INVALID");
    const root = resolveCentralLicenseRoot(projectSystemRoot, explicitLicenseRoot);
    await assertAbsolutePathWithoutSymlinks(root);
    await fs.mkdir(root, { recursive: true });
    await assertAbsolutePathWithoutSymlinks(root, false);
    const target = path.join(root, "platform", "bonni-core", version);
    const expectedParent = path.join(root, "platform", "bonni-core");
    if (path.dirname(target) !== expectedParent)
        throw new Error("LICENSE_CLEANUP_PATH_INVALID");
    await assertAbsolutePathWithoutSymlinks(expectedParent);
    const auditFile = path.join(root, "cleanup-history.json");
    const audit = await readCleanupAudit(auditFile);
    const operationId = cleanupOperationId(version, reason);
    const intentFile = path.join(root, ".cleanup-intents", `${operationId}.json`);
    await assertAbsolutePathWithoutSymlinks(path.dirname(intentFile));
    const intentState = await fs.lstat(intentFile).catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    if (intentState && (!intentState.isFile() || intentState.isSymbolicLink())) {
        throw new Error("LICENSE_CLEANUP_INTENT_INVALID");
    }
    const pendingIntent = intentState
        ? JSON.parse(await fs.readFile(intentFile, "utf8"))
        : null;
    const targetState = await fs.lstat(target).catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    const alreadyAudited = audit.some((item) => item.operationId === operationId);
    if (!targetState && !pendingIntent && alreadyAudited) {
        await rebuildAtRoot(root);
        return { removed: false, version };
    }
    if (targetState && (!targetState.isDirectory() || targetState.isSymbolicLink())) {
        throw new Error("LICENSE_CLEANUP_TARGET_UNSAFE");
    }
    let receipt = null;
    if (targetState) {
        try {
            receipt = JSON.parse(await fs.readFile(path.join(target, "RECEIPT.json"), "utf8"));
        }
        catch (error) {
            throw new Error("LICENSE_CLEANUP_RECEIPT_INVALID", { cause: error });
        }
        if (receipt?.product !== "bonni-core"
            || receipt.version !== version
            || !/^[a-f0-9]{64}$/u.test(String(receipt.treeSha256 || "")))
            throw new Error("LICENSE_CLEANUP_RECEIPT_INVALID");
    }
    const entry = pendingIntent || {
        schemaVersion: "bonni.license-cleanup/v1",
        operationId,
        type: "platform",
        key: "bonni-core",
        version,
        treeSha256: typeof receipt?.treeSha256 === "string" ? receipt.treeSha256 : null,
        reason,
        deletedAt: new Date().toISOString(),
    };
    if (entry.operationId !== operationId
        || entry.version !== version
        || entry.reason !== reason
        || entry.key !== "bonni-core")
        throw new Error("LICENSE_CLEANUP_INTENT_INVALID");
    if (!pendingIntent)
        await atomicJson(intentFile, entry);
    if (targetState)
        await fs.rm(target, { recursive: true, force: true });
    if (!alreadyAudited) {
        audit.push(entry);
        await atomicJson(auditFile, audit);
    }
    await rebuildAtRoot(root);
    await fs.rm(intentFile, { force: true });
    return { removed: Boolean(targetState), version };
}
