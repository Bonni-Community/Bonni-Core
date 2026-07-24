import { createHash } from "node:crypto";
import { prisma } from "../../../core/core.js";

function hashPayload(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function buildRange(from?: string, to?: string) {
  if (!from && !to) {
    return undefined;
  }

  return {
    ...(from ? { gte: new Date(from) } : {}),
    ...(to ? { lte: new Date(to) } : {})
  };
}

export async function listLogs(query: {
  module?: string;
  level?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
}) {
  return prisma.systemLog.findMany({
    where: {
      ...(query.module ? { module: query.module } : {}),
      ...(query.level ? { level: query.level as never } : {}),
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

export async function getTimeline(entityType: string, entityId: string) {
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

export async function exportAudit(data: {
  entityType?: string;
  entityId?: string;
  module?: string;
  format: "JSON" | "CSV";
}) {
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

export async function createSnapshot(data: {
  module: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  metadataJson?: unknown;
}) {
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
      beforeJson: data.beforeJson as object | undefined,
      afterJson: data.afterJson as object | undefined,
      metadataJson: data.metadataJson as object | undefined,
      hash,
      previousHash: previous?.hash
    }
  });
}

export async function getRecovery(entityType: string, entityId: string) {
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
