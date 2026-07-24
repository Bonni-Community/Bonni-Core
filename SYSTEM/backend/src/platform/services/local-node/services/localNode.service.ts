import { prisma } from "../../../../core/core.js";

type LocalNodeStatus =
  | "ONLINE"
  | "DEGRADED"
  | "EMERGENCY_LOCAL"
  | "SYNCING"
  | "READ_ONLY"
  | "ERROR";

export async function listLocalNodes() {
  return prisma.localNode.findMany({
    include: {
      terminals: true
    },
    orderBy: {
      name: "asc"
    }
  });
}

export async function getLocalNode(id: string) {
  return prisma.localNode.findUnique({
    where: { id },
    include: {
      terminals: true,
      offlineQueue: {
        orderBy: { createdAt: "desc" },
        take: 50
      }
    }
  });
}

export async function createLocalNode(data: {
  key: string;
  name: string;
  location?: string;
}) {
  return prisma.localNode.create({
    data: {
      key: data.key,
      name: data.name,
      location: data.location
    }
  });
}

export async function updateLocalNode(id: string, data: {
  name?: string;
  location?: string;
  warningMessage?: string | null;
}) {
  return prisma.localNode.update({
    where: { id },
    data
  });
}

export async function heartbeat(id: string, data: {
  hasInternet: boolean;
  canReachMainDb: boolean;
  status?: LocalNodeStatus;
  warningMessage?: string;
}) {
  const calculatedStatus: LocalNodeStatus =
    data.status ??
    (data.canReachMainDb
      ? "ONLINE"
      : data.hasInternet
        ? "DEGRADED"
        : "EMERGENCY_LOCAL");

  return prisma.localNode.update({
    where: { id },
    data: {
      hasInternet: data.hasInternet,
      canReachMainDb: data.canReachMainDb,
      status: calculatedStatus,
      warningMessage: data.warningMessage,
      emergencySince:
        calculatedStatus === "EMERGENCY_LOCAL"
          ? new Date()
          : null,
      lastSeenAt: new Date()
    }
  });
}

export async function getStatus(id: string) {
  const node = await prisma.localNode.findUnique({
    where: { id },
    include: {
      terminals: true
    }
  });

  if (!node) {
    throw Object.assign(new Error("LOCAL_NODE_NOT_FOUND"), { statusCode: 404 });
  }

  const pendingCount = await prisma.offlineQueue.count({
    where: {
      localNodeId: id,
      status: "PENDING"
    }
  });

  const conflictCount = await prisma.offlineQueue.count({
    where: {
      localNodeId: id,
      status: "CONFLICT"
    }
  });

  return {
    id: node.id,
    key: node.key,
    name: node.name,
    status: node.status,
    hasInternet: node.hasInternet,
    canReachMainDb: node.canReachMainDb,
    emergencySince: node.emergencySince,
    warningMessage: node.warningMessage,
    lastSeenAt: node.lastSeenAt,
    terminals: node.terminals.length,
    pendingQueueItems: pendingCount,
    conflictQueueItems: conflictCount
  };
}

export async function setEmergencyMode(id: string, enabled: boolean, reason?: string) {
  const status = enabled ? "EMERGENCY_LOCAL" : "ONLINE";

  const node = await prisma.localNode.update({
    where: { id },
    data: {
      status,
      emergencySince: enabled ? new Date() : null,
      warningMessage: enabled
        ? reason ?? "Notlauf aktiv"
        : null
    }
  });

  await prisma.systemLog.create({
    data: {
      level: enabled ? "WARN" : "INFO",
      module: "local-node",
      message: enabled
        ? "LocalNode entered emergency mode"
        : "LocalNode left emergency mode",
      localNodeId: id,
      metadataJson: {
        reason
      }
    }
  }).catch(() => undefined);

  await prisma.timeCapsuleEvent.create({
    data: {
      eventType: enabled ? "LOCAL_NODE_EMERGENCY_ENABLED" : "LOCAL_NODE_EMERGENCY_DISABLED",
      module: "local-node",
      entityType: "LocalNode",
      entityId: id,
      action: enabled ? "ENABLE_EMERGENCY_MODE" : "DISABLE_EMERGENCY_MODE",
      afterJson: node,
      metadataJson: { reason },
      hash: `${id}:${status}:${Date.now()}`
    }
  }).catch(() => undefined);

  return node;
}

export async function listOfflineQueue(localNodeId: string, status?: string) {
  return prisma.offlineQueue.findMany({
    where: {
      localNodeId,
      ...(status ? { status: status as never } : {})
    },
    orderBy: {
      localSequence: "asc"
    }
  });
}

export async function addOfflineQueueItem(localNodeId: string, data: {
  terminalId?: string;
  localSequence: number;
  operationType: string;
  entityType?: string;
  entityId?: string;
  payloadJson: unknown;
  payloadHash: string;
  createdAtLocal: string;
}) {
  return prisma.offlineQueue.create({
    data: {
      localNodeId,
      terminalId: data.terminalId,
      localSequence: data.localSequence,
      operationType: data.operationType,
      entityType: data.entityType,
      entityId: data.entityId,
      payloadJson: data.payloadJson as object,
      payloadHash: data.payloadHash,
      createdAtLocal: new Date(data.createdAtLocal)
    }
  });
}

export async function markQueueItem(id: string, status: "PENDING" | "SYNCED" | "FAILED" | "CONFLICT", errorMessage?: string) {
  return prisma.offlineQueue.update({
    where: { id },
    data: {
      status,
      errorMessage,
      syncedAt: status === "SYNCED" ? new Date() : undefined
    }
  });
}

export async function syncLocalNode(localNodeId: string) {
  const pendingItems = await prisma.offlineQueue.findMany({
    where: {
      localNodeId,
      status: "PENDING"
    },
    orderBy: {
      localSequence: "asc"
    }
  });

  await prisma.syncLog.create({
    data: {
      localNodeId,
      direction: "LOCAL_TO_MAIN",
      status: "STARTED",
      itemCount: pendingItems.length,
      startedAt: new Date()
    }
  }).catch(() => undefined);

  // Stub: Hier kommt später die echte Replay-Logik rein.
  // Aktuell markieren wir nichts automatisch als SYNCED,
  // damit keine lokalen Aktionen versehentlich als verarbeitet gelten.

  return {
    ok: true,
    localNodeId,
    pendingItems: pendingItems.length,
    message: "Sync stub executed. Replay logic not implemented yet."
  };
}
