import { prisma } from "../../../../core/core.js";

export async function listNotifications(accountId?: string) {
  return prisma.notification.findMany({
    where: {
      archivedAt: null,
      ...(accountId
        ? {
            OR: [
              { accountId },
              { accountId: null }
            ]
          }
        : {})
    },
    orderBy: {
      createdAt: "desc"
    }
  });
}

export async function createNotification(data: {
  type: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
  message: string;
  targetRole?: string;
  accountId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  metadataJson?: unknown;
}) {
  const notification = await prisma.notification.create({
    data: {
      type: data.type,
      severity: data.severity,
      message: data.message,
      targetRole: data.targetRole,
      accountId: data.accountId,
      relatedEntityType: data.relatedEntityType,
      relatedEntityId: data.relatedEntityId,
      metadataJson: data.metadataJson as object | undefined
    }
  });

  await prisma.notificationLog.create({
    data: {
      notificationId: notification.id,
      channel: "IN_APP",
      target: data.accountId ?? data.targetRole ?? "GLOBAL",
      status: "CREATED"
    }
  }).catch(() => undefined);

  return notification;
}

export async function markNotificationRead(id: string) {
  return prisma.notification.update({
    where: { id },
    data: {
      readAt: new Date()
    }
  });
}

export async function archiveNotification(id: string) {
  return prisma.notification.update({
    where: { id },
    data: {
      archivedAt: new Date()
    }
  });
}
