import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveBonniProjectRoot } from "../project-root.js";
import { rebuildCentralLicenseCatalog, resolveCentralLicenseRoot, } from "./central-license-catalog.service.js";
const SAFE_KEY = /^(?:app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/u;
const SAFE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function canonicalTreeHash(files) {
    return sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""));
}
function safeRelativePath(value, label) {
    if (!value || value.includes("\\") || path.isAbsolute(value))
        throw new Error(`MODULE_LEGAL_PATH_INVALID:${label}`);
    const normalized = path.posix.normalize(value);
    if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")
        || normalized.split("/").some((part) => !part || part === "." || part === ".."))
        throw new Error(`MODULE_LEGAL_PATH_INVALID:${label}`);
    return normalized;
}
async function assertPathWithoutSymlinks(root, relative) {
    let current = root;
    for (const part of relative.split("/")) {
        current = path.join(current, part);
        const state = await fs.lstat(current).catch(() => null);
        if (!state)
            throw new Error(`MODULE_LEGAL_SOURCE_MISSING:${relative}`);
        if (state.isSymbolicLink())
            throw new Error(`MODULE_LEGAL_SYMLINK_DENIED:${relative}`);
    }
}
async function assertAbsolutePathWithoutSymlinks(absolute) {
    const resolved = path.resolve(absolute);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const part of parts) {
        current = path.join(current, part);
        const state = await fs.lstat(current).catch(() => null);
        if (!state)
            break;
        if (state.isSymbolicLink())
            throw new Error(`MODULE_LEGAL_SYMLINK_DENIED:${current}`);
    }
}
async function collectTree(packageRoot, sourceRelative, destinationRelative, files, totals) {
    const safeSource = safeRelativePath(sourceRelative, sourceRelative);
    const safeDestination = safeRelativePath(destinationRelative, destinationRelative);
    await assertPathWithoutSymlinks(packageRoot, safeSource);
    const source = path.join(packageRoot, ...safeSource.split("/"));
    const state = await fs.lstat(source);
    if (state.isFile()) {
        if (state.size > MAX_FILE_BYTES)
            throw new Error(`MODULE_LEGAL_FILE_TOO_LARGE:${safeSource}`);
        totals.bytes += state.size;
        if (totals.bytes > MAX_TOTAL_BYTES)
            throw new Error("MODULE_LEGAL_PAYLOAD_TOO_LARGE");
        const content = await fs.readFile(source);
        files.push({ source, path: safeDestination, bytes: content.byteLength, sha256: sha256(content) });
        if (files.length > MAX_FILES)
            throw new Error("MODULE_LEGAL_FILE_COUNT_EXCEEDED");
        return;
    }
    if (!state.isDirectory())
        throw new Error(`MODULE_LEGAL_SOURCE_TYPE_INVALID:${safeSource}`);
    const entries = await fs.readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
        if (entry.isSymbolicLink())
            throw new Error(`MODULE_LEGAL_SYMLINK_DENIED:${safeSource}/${entry.name}`);
        await collectTree(packageRoot, `${safeSource}/${entry.name}`, `${safeDestination}/${entry.name}`, files, totals);
    }
}
function legalDeclaration(manifest) {
    const legal = manifest.legal;
    if (!legal)
        return null;
    if (legal.schemaVersion !== "bonni.module-legal/v1")
        throw new Error("MODULE_LEGAL_SCHEMA_INVALID");
    return legal;
}
async function isSourcePackage(packageRoot) {
    const [backendSource, frontendSource] = await Promise.all([
        fs.lstat(path.join(packageRoot, "backend", "src")).catch(() => null),
        fs.lstat(path.join(packageRoot, "frontend", "src")).catch(() => null),
    ]);
    return Boolean(backendSource?.isDirectory() || frontendSource?.isDirectory());
}
async function collectDeclaredSourceFiles(packageRoot, declaration) {
    const sourceFiles = [];
    const totals = { bytes: 0 };
    await collectTree(packageRoot, declaration.notices, "THIRD_PARTY_NOTICES.md", sourceFiles, totals);
    for (const payloadRoot of declaration.payloadRoots) {
        const safeRoot = safeRelativePath(payloadRoot, payloadRoot);
        await collectTree(packageRoot, safeRoot, safeRoot, sourceFiles, totals);
    }
    sourceFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
    if (new Set(sourceFiles.map((file) => file.path)).size !== sourceFiles.length) {
        throw new Error("MODULE_LEGAL_DESTINATION_COLLISION");
    }
    return sourceFiles;
}
async function readReceipt(targetRoot) {
    try {
        return JSON.parse(await fs.readFile(path.join(targetRoot, "RECEIPT.json"), "utf8"));
    }
    catch {
        throw new Error("MODULE_LEGAL_RECEIPT_JSON_INVALID");
    }
}
function exactObjectFields(value, fields) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}
function validateReceipt(value, identity) {
    if (!exactObjectFields(value, [
        "schemaVersion",
        "moduleKey",
        "moduleVersion",
        "sourceManifest",
        "files",
        "treeSha256",
    ]))
        throw new Error("MODULE_LEGAL_RECEIPT_SHAPE_INVALID");
    const receipt = value;
    if (receipt.schemaVersion !== "bonni.module-legal-receipt/v1") {
        throw new Error("MODULE_LEGAL_RECEIPT_SCHEMA_INVALID");
    }
    if (!SAFE_KEY.test(receipt.moduleKey) || !SAFE_VERSION.test(receipt.moduleVersion)) {
        throw new Error("MODULE_LEGAL_RECEIPT_IDENTITY_INVALID");
    }
    if (receipt.moduleKey !== identity.moduleKey || receipt.moduleVersion !== identity.moduleVersion) {
        throw new Error("MODULE_LEGAL_RECEIPT_IDENTITY_MISMATCH");
    }
    if (typeof receipt.sourceManifest !== "string")
        throw new Error("MODULE_LEGAL_RECEIPT_SOURCE_INVALID");
    if (receipt.sourceManifest)
        safeRelativePath(receipt.sourceManifest, "receipt.sourceManifest");
    if (identity.sourceManifest !== undefined && receipt.sourceManifest !== identity.sourceManifest) {
        throw new Error("MODULE_LEGAL_RECEIPT_SOURCE_MISMATCH");
    }
    if (!/^[a-f0-9]{64}$/u.test(receipt.treeSha256))
        throw new Error("MODULE_LEGAL_RECEIPT_TREE_HASH_INVALID");
    if (identity.treeSha256 !== undefined && receipt.treeSha256 !== identity.treeSha256) {
        throw new Error("MODULE_LEGAL_RECEIPT_TREE_HASH_MISMATCH");
    }
    if (!Array.isArray(receipt.files) || receipt.files.length < 1 || receipt.files.length > MAX_FILES) {
        throw new Error("MODULE_LEGAL_RECEIPT_FILE_COUNT_INVALID");
    }
    if (identity.fileCount !== undefined && receipt.files.length !== identity.fileCount) {
        throw new Error("MODULE_LEGAL_RECEIPT_FILE_COUNT_MISMATCH");
    }
    const seen = new Set();
    let totalBytes = 0;
    let previous = "";
    for (const entry of receipt.files) {
        if (!exactObjectFields(entry, ["path", "bytes", "sha256"])) {
            throw new Error("MODULE_LEGAL_RECEIPT_ENTRY_SHAPE_INVALID");
        }
        const filePath = safeRelativePath(entry.path, "receipt.files.path");
        if (filePath === "RECEIPT.json")
            throw new Error("MODULE_LEGAL_RECEIPT_ENTRY_PATH_INVALID");
        if (seen.has(filePath))
            throw new Error("MODULE_LEGAL_RECEIPT_ENTRY_DUPLICATE");
        if (previous && previous.localeCompare(filePath, "en") >= 0) {
            throw new Error("MODULE_LEGAL_RECEIPT_ENTRY_ORDER_INVALID");
        }
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) {
            throw new Error("MODULE_LEGAL_RECEIPT_ENTRY_BYTES_INVALID");
        }
        if (!/^[a-f0-9]{64}$/u.test(entry.sha256))
            throw new Error("MODULE_LEGAL_RECEIPT_ENTRY_HASH_INVALID");
        seen.add(filePath);
        previous = filePath;
        totalBytes += entry.bytes;
        if (totalBytes > MAX_TOTAL_BYTES)
            throw new Error("MODULE_LEGAL_RECEIPT_TOTAL_BYTES_INVALID");
    }
    if (canonicalTreeHash(receipt.files) !== receipt.treeSha256) {
        throw new Error("MODULE_LEGAL_RECEIPT_TREE_HASH_MISMATCH");
    }
    return receipt;
}
export async function verifyStoredModuleLegalPayload(targetRoot, expected) {
    await assertAbsolutePathWithoutSymlinks(targetRoot);
    const targetState = await fs.lstat(targetRoot);
    if (!targetState.isDirectory() || targetState.isSymbolicLink())
        throw new Error("MODULE_LEGAL_TARGET_INVALID");
    const receiptState = await fs.lstat(path.join(targetRoot, "RECEIPT.json"));
    if (!receiptState.isFile() || receiptState.isSymbolicLink())
        throw new Error("MODULE_LEGAL_RECEIPT_INVALID");
    const identity = expected
        ? {
            moduleKey: expected.moduleKey,
            moduleVersion: expected.moduleVersion,
            sourceManifest: expected.sourceManifest,
            treeSha256: expected.treeSha256,
            fileCount: expected.files.length,
        }
        : {
            moduleKey: path.basename(path.dirname(targetRoot)),
            moduleVersion: path.basename(targetRoot),
        };
    const receipt = validateReceipt(await readReceipt(targetRoot), identity);
    const actual = [];
    let totalBytes = 0;
    async function walk(relative) {
        const directory = relative ? path.join(targetRoot, ...relative.split("/")) : targetRoot;
        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
        for (const entry of entries) {
            const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
            if (childRelative === "RECEIPT.json")
                continue;
            if (entry.isSymbolicLink())
                throw new Error(`MODULE_LEGAL_SYMLINK_DENIED:${childRelative}`);
            if (entry.isDirectory())
                await walk(childRelative);
            else if (entry.isFile()) {
                const content = await fs.readFile(path.join(targetRoot, ...childRelative.split("/")));
                if (content.byteLength > MAX_FILE_BYTES)
                    throw new Error(`MODULE_LEGAL_FILE_TOO_LARGE:${childRelative}`);
                totalBytes += content.byteLength;
                if (totalBytes > MAX_TOTAL_BYTES)
                    throw new Error("MODULE_LEGAL_PAYLOAD_TOO_LARGE");
                actual.push({ path: childRelative, bytes: content.byteLength, sha256: sha256(content) });
                if (actual.length > MAX_FILES)
                    throw new Error("MODULE_LEGAL_FILE_COUNT_EXCEEDED");
            }
            else
                throw new Error(`MODULE_LEGAL_TARGET_TYPE_INVALID:${childRelative}`);
        }
    }
    await walk("");
    const expectedReceipt = expected || receipt;
    if (JSON.stringify(actual) !== JSON.stringify(expectedReceipt.files))
        throw new Error("MODULE_LEGAL_EXACT_TREE_MISMATCH");
    if (canonicalTreeHash(actual) !== expectedReceipt.treeSha256)
        throw new Error("MODULE_LEGAL_TREE_HASH_MISMATCH");
    if (JSON.stringify(receipt) !== JSON.stringify(expectedReceipt))
        throw new Error("MODULE_LEGAL_RECEIPT_MISMATCH");
    return receipt;
}
async function cleanImportedRuntimePayload(packageRoot, declaration) {
    if (await isSourcePackage(packageRoot))
        return false;
    const paths = [declaration.notices, ...declaration.payloadRoots];
    const quarantineRoot = path.join(packageRoot, `.legal-imported-${process.pid}-${randomUUID()}`);
    const moved = [];
    try {
        await fs.mkdir(quarantineRoot, { recursive: false, mode: 0o700 });
        for (const relative of paths) {
            const source = path.join(packageRoot, ...safeRelativePath(relative, relative).split("/"));
            if (!(await fs.lstat(source).catch(() => null)))
                continue;
            const destination = path.join(quarantineRoot, ...relative.split("/"));
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.rename(source, destination);
            moved.push({ from: source, to: destination });
        }
        await fs.rm(quarantineRoot, { recursive: true, force: true });
        return moved.length > 0;
    }
    catch (error) {
        for (const entry of moved.reverse()) {
            await fs.mkdir(path.dirname(entry.from), { recursive: true });
            await fs.rename(entry.to, entry.from).catch(() => undefined);
        }
        await fs.rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
export async function installModuleLegalPayload(manifest, options = {}) {
    const declaration = legalDeclaration(manifest);
    if (!declaration)
        return null;
    if (!SAFE_KEY.test(manifest.key) || !SAFE_VERSION.test(manifest.version))
        throw new Error("MODULE_LEGAL_IDENTITY_INVALID");
    const projectRoot = path.resolve(options.projectRoot || resolveBonniProjectRoot());
    await assertAbsolutePathWithoutSymlinks(projectRoot);
    const packageRoot = path.resolve(projectRoot, manifest.sourcePath || "");
    if (packageRoot === projectRoot || !packageRoot.startsWith(`${projectRoot}${path.sep}`))
        throw new Error("MODULE_LEGAL_PACKAGE_ROOT_INVALID");
    await assertPathWithoutSymlinks(projectRoot, safeRelativePath(manifest.sourcePath || "", "manifest.sourcePath"));
    const centralRoot = resolveCentralLicenseRoot(projectRoot);
    const configuredModuleRoot = String(options.storageRoot || process.env.BONNI_MODULE_LICENSE_ROOT || "").trim();
    const storageRoot = path.resolve(configuredModuleRoot || path.join(centralRoot, "modules"));
    if (path.basename(storageRoot) !== "modules")
        throw new Error("MODULE_LEGAL_STORAGE_ROOT_INVALID");
    const storageCentralRoot = path.dirname(storageRoot);
    if ((process.env.BONNI_LICENSE_ROOT || process.env.BONNI_MODULE_LICENSE_ROOT || !configuredModuleRoot)
        && storageCentralRoot !== centralRoot)
        throw new Error("MODULE_LEGAL_STORAGE_ROOT_MISMATCH");
    await assertAbsolutePathWithoutSymlinks(storageRoot);
    const targetRoot = path.join(storageRoot, manifest.key, manifest.version);
    if (!targetRoot.startsWith(`${storageRoot}${path.sep}`))
        throw new Error("MODULE_LEGAL_TARGET_ESCAPE");
    const existing = await fs.lstat(targetRoot).catch(() => null);
    if (existing) {
        const receiptValue = await readReceipt(targetRoot);
        const stored = validateReceipt(receiptValue, {
            moduleKey: manifest.key,
            moduleVersion: manifest.version,
            sourceManifest: manifest.manifestPath || "",
        });
        if (stored.treeSha256 !== declaration.treeSha256 || stored.files.length !== declaration.fileCount) {
            throw new Error(`MODULE_LEGAL_MANIFEST_BINDING_MISMATCH:${stored.files.length}:${stored.treeSha256}:${declaration.fileCount}:${declaration.treeSha256}`);
        }
        await verifyStoredModuleLegalPayload(targetRoot, stored);
        if (await isSourcePackage(packageRoot)) {
            let sourceFiles;
            try {
                sourceFiles = await collectDeclaredSourceFiles(packageRoot, declaration);
            }
            catch (error) {
                throw new Error(`MODULE_LEGAL_SOURCE_DRIFT:${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            const sourceReceiptFiles = sourceFiles.map(({ path: filePath, bytes, sha256: digest }) => ({
                path: filePath,
                bytes,
                sha256: digest,
            }));
            if (JSON.stringify(sourceReceiptFiles) !== JSON.stringify(stored.files)
                || canonicalTreeHash(sourceReceiptFiles) !== declaration.treeSha256)
                throw new Error("MODULE_LEGAL_SOURCE_DRIFT");
        }
        const cleanedSource = await cleanImportedRuntimePayload(packageRoot, declaration);
        await rebuildCentralLicenseCatalog(projectRoot, storageCentralRoot);
        return { created: false, cleanedSource, targetRoot, receipt: stored };
    }
    const sourceFiles = await collectDeclaredSourceFiles(packageRoot, declaration);
    const receipt = {
        schemaVersion: "bonni.module-legal-receipt/v1",
        moduleKey: manifest.key,
        moduleVersion: manifest.version,
        sourceManifest: manifest.manifestPath || "",
        files: sourceFiles.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes, sha256: digest })),
        treeSha256: "",
    };
    receipt.treeSha256 = canonicalTreeHash(receipt.files);
    if (receipt.treeSha256 !== declaration.treeSha256 || receipt.files.length !== declaration.fileCount) {
        throw new Error(`MODULE_LEGAL_MANIFEST_BINDING_MISMATCH:${receipt.files.length}:${receipt.treeSha256}:${declaration.fileCount}:${declaration.treeSha256}`);
    }
    const parent = path.dirname(targetRoot);
    await fs.mkdir(parent, { recursive: true });
    await assertAbsolutePathWithoutSymlinks(parent);
    const temporary = path.join(parent, `.${manifest.version}.tmp-${process.pid}-${randomUUID()}`);
    try {
        await fs.mkdir(temporary, { recursive: false, mode: 0o755 });
        for (const file of sourceFiles) {
            const destination = path.join(temporary, ...file.path.split("/"));
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(file.source, destination);
            await fs.chmod(destination, 0o444).catch(() => undefined);
        }
        await fs.writeFile(path.join(temporary, "RECEIPT.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444, flag: "wx" });
        await verifyStoredModuleLegalPayload(temporary, receipt);
        await fs.rename(temporary, targetRoot);
    }
    catch (error) {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        if (await fs.lstat(targetRoot).catch(() => null)) {
            const stored = await verifyStoredModuleLegalPayload(targetRoot, receipt);
            if (stored.treeSha256 !== declaration.treeSha256 || stored.files.length !== declaration.fileCount) {
                throw new Error("MODULE_LEGAL_MANIFEST_BINDING_MISMATCH");
            }
            const cleanedSource = await cleanImportedRuntimePayload(packageRoot, declaration);
            await rebuildCentralLicenseCatalog(projectRoot, storageCentralRoot);
            return { created: false, cleanedSource, targetRoot, receipt: stored };
        }
        throw error;
    }
    const cleanedSource = await cleanImportedRuntimePayload(packageRoot, declaration);
    await rebuildCentralLicenseCatalog(projectRoot, storageCentralRoot);
    return { created: true, cleanedSource, targetRoot, receipt };
}
