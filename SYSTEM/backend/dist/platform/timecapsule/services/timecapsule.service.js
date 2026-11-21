import { createHash } from "node:crypto";
import { prisma } from "../../../core/core.js";
function hashPayload(value) {
    return createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex");
}
function buildRange(from, to) {
    if (!from && !to) {
        return undefined;
    }
    return {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {})
    };
}
export async function listLogs(query) {
    return prisma.systemLog.findMany({
        where: {
            ...(query.module ? { module: query.module } : {}),
            ...(query.level ? { level: query.level } : {}),
            ...(query.entityType ? { entityType: query.entityType } : {}),
            ...(query.entityId ? { entityId: query.entityId } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: buildRange(query.from, query.to)
                }
                : {})
        },
        orderBy: {
            createdAt: "desc"
        }
    });
}
export async function getTimeline(entityType, entityId) {
    const [logs, events] = await Promise.all([
        prisma.systemLog.findMany({
            where: {
                entityType,
                entityId
            },
            orderBy: {
                createdAt: "asc"
            }
        }),
        prisma.timeCapsuleEvent.findMany({
            where: {
                entityType,
                entityId
            },
            orderBy: {
                createdAt: "asc"
            }
        })
    ]);
    return {
        entityType,
        entityId,
        logs,
        events
    };
}
export async function exportAudit(data) {
    const logs = await prisma.systemLog.findMany({
        where: {
            ...(data.entityType ? { entityType: data.entityType } : {}),
            ...(data.entityId ? { entityId: data.entityId } : {}),
            ...(data.module ? { module: data.module } : {})
        },
        orderBy: {
            createdAt: "asc"
        }
    });
    const events = await prisma.timeCapsuleEvent.findMany({
        where: {
            ...(data.entityType ? { entityType: data.entityType } : {}),
            ...(data.entityId ? { entityId: data.entityId } : {}),
            ...(data.module ? { module: data.module } : {})
        },
        orderBy: {
            createdAt: "asc"
        }
    });
    return {
        exportedAt: new Date(),
        format: data.format,
        logs,
        events
    };
}
export async function listTimeCapsuleEvents() {
    return prisma.timeCapsuleEvent.findMany({
        orderBy: {
            createdAt: "desc"
        }
    });
}
export async function createSnapshot(data) {
    const previous = await prisma.timeCapsuleEvent.findFirst({
        where: {
            entityType: data.entityType,
            entityId: data.entityId
        },
        orderBy: {
            createdAt: "desc"
        }
    });
    const payload = {
        module: data.module,
        entityType: data.entityType,
        entityId: data.entityId,
        action: data.action,
        beforeJson: data.beforeJson,
        afterJson: data.afterJson,
        metadataJson: data.metadataJson,
        previousHash: previous?.hash ?? null,
        createdAt: new Date().toISOString()
    };
    const hash = hashPayload(payload);
    return prisma.timeCapsuleEvent.create({
        data: {
            module: data.module,
            entityType: data.entityType,
            entityId: data.entityId,
            action: data.action,
            beforeJson: data.beforeJson,
            afterJson: data.afterJson,
            metadataJson: data.metadataJson,
            hash,
            previousHash: previous?.hash
        }
    });
}
export async function getRecovery(entityType, entityId) {
    const snapshots = await prisma.timeCapsuleEvent.findMany({
        where: {
            entityType,
            entityId
        },
        orderBy: {
            createdAt: "asc"
        }
    });
    const latest = snapshots[snapshots.length - 1];
    return {
        entityType,
        entityId,
        snapshots,
        latestState: latest?.afterJson ?? null
    };
}
