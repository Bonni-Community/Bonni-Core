async function prismaClient() {
    const { prisma } = await import("../../../core/database/prisma.js");
    return prisma;
}
function enumToPublic(value) {
    return String(value || "").toLowerCase();
}
function statusFlags(status) {
    return {
        installed: ["installed", "enabled", "disabled", "update_available", "update_failed", "error"].includes(status),
        enabled: status === "enabled",
    };
}
function normalizeKind(value) {
    const normalized = String(value || "app").toLowerCase().replaceAll("_", "-");
    if (["add-on", "addon"].includes(normalized))
        return "addon";
    if (["plug-in", "plugin"].includes(normalized))
        return "plugin";
    if (normalized === "bridge")
        return "bridge";
    return "app";
}
function normalize(row) {
    const status = enumToPublic(row.status);
    const kind = normalizeKind(row.manifestJson?.kind || row.kind);
    const flags = statusFlags(status);
    return {
        id: row.id,
        key: row.key,
        kind,
        name: row.name,
        label: row.name,
        version: row.version,
        status,
        installed: flags.installed,
        enabled: flags.enabled,
        sourcePath: row.sourcePath,
        installPath: row.installPath,
        backendEntry: row.backendEntry,
        frontendEntry: row.frontendEntry,
        prismaSourcePath: row.prismaSourcePath,
        assembledPrismaPath: row.assembledPrismaPath,
        manifest: row.manifestJson,
        manifestJson: row.manifestJson,
        lastError: row.lastError,
        installedAt: row.installedAt,
        enabledAt: row.enabledAt,
        disabledAt: row.disabledAt,
        uninstalledAt: row.uninstalledAt,
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
function toPrismaKind(kind) {
    const normalized = String(kind || "app").toLowerCase();
    if (normalized === "add-on" || normalized === "addon")
        return "ADD_ON";
    if (["plug-in", "plugin", "bridge"].includes(normalized))
        return "PLUG_IN";
    return "APP";
}
function toPrismaStatus(status) {
    return status.toUpperCase();
}
function toPrismaEvent(type) {
    return type.toUpperCase();
}
export async function listInstalledModulesStrict() {
    const prisma = await prismaClient();
    const rows = await prisma.installedModule.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] });
    return rows.map(normalize);
}
export async function listInstalledModules() {
    try {
        return await listInstalledModulesStrict();
    }
    catch {
        // Read-only Control-Center views may remain available in a degraded
        // state. Runtime startup deliberately uses the strict variant below so a
        // registry/database problem cannot masquerade as an uninstalled module.
        return [];
    }
}
export async function findInstalledModule(key) {
    try {
        const prisma = await prismaClient();
        const row = await prisma.installedModule.findUnique({ where: { key } });
        return row ? normalize(row) : null;
    }
    catch {
        return null;
    }
}
export async function recordModuleEvent(key, type, data = {}) {
    const prisma = await prismaClient();
    const module = await prisma.installedModule.findUnique({ where: { key } });
    if (!module)
        return null;
    return prisma.moduleInstallEvent.create({
        data: {
            moduleId: module.id,
            type: toPrismaEvent(type),
            fromVersion: data.fromVersion,
            toVersion: data.toVersion,
            message: data.message,
            errorMessage: data.errorMessage,
            metadataJson: data.metadataJson,
        },
    });
}
export async function updateInstalledModuleStatus(key, status) {
    const prisma = await prismaClient();
    const now = new Date();
    const data = { status: toPrismaStatus(status) };
    if (status === "enabled")
        data.enabledAt = now;
    if (status === "disabled")
        data.disabledAt = now;
    if (status === "uninstalled")
        data.uninstalledAt = now;
    if (status === "deleted")
        data.deletedAt = now;
    const row = await prisma.installedModule.update({ where: { key }, data });
    await recordModuleEvent(key, status === "enabled" ? "enabled" : status === "disabled" ? "disabled" : status === "uninstalled" ? "uninstalled" : status === "deleted" ? "deleted" : "updated");
    return normalize(row);
}
export async function upsertInstalledModuleFromManifest(manifest, sourcePath) {
    const prisma = await prismaClient();
    const key = String(manifest.key || manifest.id || "").trim();
    if (!key)
        throw new Error("MODULE_MANIFEST_KEY_REQUIRED");
    const kind = toPrismaKind(manifest.kind || manifest.type || "app");
    const name = String(manifest.name || manifest.label || key);
    const version = String(manifest.version || "0.0.0");
    const backendEntry = manifest.backend?.entry || null;
    const frontendEntry = manifest.frontend?.runtimeEntry || manifest.frontend?.entry || null;
    const prismaSourcePath = manifest.prisma?.source || null;
    const assembledPrismaPath = manifest.prisma?.assembled || null;
    const existing = await prisma.installedModule.findUnique({ where: { key } });
    // sourcePath stammt aus dem aktuell gefundenen Manifest und muss nach einer
    // Paketverschiebung einen möglicherweise veralteten installPath ersetzen.
    const installPath = sourcePath || existing?.sourcePath || existing?.installPath || null;
    const row = await prisma.installedModule.upsert({
        where: { key },
        create: {
            key,
            kind,
            name,
            version,
            status: "INSTALLED",
            sourcePath,
            installPath,
            backendEntry,
            frontendEntry,
            prismaSourcePath,
            assembledPrismaPath,
            manifestJson: manifest,
            installedAt: new Date(),
        },
        update: {
            kind,
            name,
            version,
            sourcePath,
            installPath,
            backendEntry,
            frontendEntry,
            prismaSourcePath,
            assembledPrismaPath,
            manifestJson: manifest,
            status: existing?.status === "ENABLED" ? "ENABLED" : "INSTALLED",
        },
    });
    await recordModuleEvent(key, existing ? "updated" : "installed", {
        fromVersion: existing?.version,
        toVersion: version,
        message: existing ? "Module package updated from manifest." : "Module package installed from manifest.",
    });
    return normalize(row);
}
export async function syncInstalledModuleFromManifest(manifest, sourcePath) {
    const prisma = await prismaClient();
    const key = String(manifest.key || manifest.id || "").trim();
    if (!key)
        throw new Error("MODULE_MANIFEST_KEY_REQUIRED");
    const existing = await prisma.installedModule.findUnique({ where: { key } });
    if (!existing)
        return null;
    const installPath = sourcePath || existing.sourcePath || existing.installPath || null;
    const row = await prisma.installedModule.update({
        where: { key },
        data: {
            kind: toPrismaKind(manifest.kind || manifest.type || "app"),
            name: String(manifest.name || manifest.label || key),
            version: String(manifest.version || "0.0.0"),
            sourcePath: sourcePath || existing.sourcePath,
            installPath,
            backendEntry: manifest.backend?.entry || null,
            frontendEntry: manifest.frontend?.runtimeEntry || manifest.frontend?.entry || null,
            prismaSourcePath: manifest.prisma?.source || null,
            assembledPrismaPath: manifest.prisma?.assembled || null,
            manifestJson: manifest,
        },
    });
    return normalize(row);
}
