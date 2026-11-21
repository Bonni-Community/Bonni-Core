import { prisma } from "../../../../core/database/database.js";
import { getVerifiedRequestIdentity, } from "../../../auth/request-identity/request-identity-context.js";
function requestError(code, statusCode) {
    return Object.assign(new Error(code), { code, statusCode });
}
function notificationIdentity() {
    const identity = getVerifiedRequestIdentity();
    if (!identity?.accountId)
        throw requestError("UNAUTHORIZED", 401);
    return identity;
}
function audience(identity) {
    return {
        AND: [
            { OR: [{ accountId: identity.accountId }, { accountId: null }] },
            { OR: [{ targetRole: null }, { targetRole: { in: [...identity.roles] } }] },
        ],
    };
}
export async function listNotifications(requestedAccountId) {
    const identity = notificationIdentity();
    // An explicit selector is compatible only with the caller's own identity.
    // Administrators cannot select another person's inbox through a query.
    if (requestedAccountId !== undefined && requestedAccountId !== identity.accountId) {
        throw requestError("NOTIFICATION_ACCOUNT_FORBIDDEN", 403);
    }
    const notifications = await prisma.notification.findMany({
        where: {
            ...audience(identity),
            archivedAt: null,
            recipientStates: {
                none: { accountId: identity.accountId, archivedAt: { not: null } },
            },
        },
        include: {
            recipientStates: {
                where: { accountId: identity.accountId },
                select: { readAt: true, archivedAt: true },
            },
        },
        orderBy: { createdAt: "desc" },
    });
    return notifications.map(({ recipientStates, ...notification }) => ({
        ...notification,
        readAt: recipientStates[0]?.readAt ?? notification.readAt,
        archivedAt: recipientStates[0]?.archivedAt ?? notification.archivedAt,
    }));
}
export async function createNotification(data) {
    const identity = notificationIdentity();
    if (!identity.permissions.includes("SYSTEM_ADMIN")) {
        throw requestError("NOTIFICATION_CREATE_FORBIDDEN", 403);
    }
    const notification = await prisma.notification.create({
        data: {
            type: data.type,
            severity: data.severity,
            message: data.message,
            targetRole: data.targetRole,
            accountId: data.accountId,
            relatedEntityType: data.relatedEntityType,
            relatedEntityId: data.relatedEntityId,
            metadataJson: data.metadataJson,
        },
    });
    await prisma.notificationLog.create({
        data: {
            notificationId: notification.id,
            channel: "IN_APP",
            target: data.accountId ?? data.targetRole ?? "GLOBAL",
            status: "CREATED",
        },
    }).catch(() => undefined);
    return notification;
}
async function acknowledgeNotification(id, field) {
    const identity = notificationIdentity();
    return prisma.$transaction(async (transaction) => {
        const notification = await transaction.notification.findFirst({
            where: { id, ...audience(identity) },
        });
        // An unknown ID and an inaccessible message have the same response.
        if (!notification)
            throw requestError("NOTIFICATION_NOT_FOUND", 404);
        const changed = { [field]: new Date() };
        const state = await transaction.notificationRecipientState.upsert({
            where: { notificationId_accountId: { notificationId: id, accountId: identity.accountId } },
            create: { notificationId: id, accountId: identity.accountId, ...changed },
            update: changed,
        });
        return {
            ...notification,
            readAt: state.readAt ?? notification.readAt,
            archivedAt: state.archivedAt ?? notification.archivedAt,
        };
    });
}
export function markNotificationRead(id) {
    return acknowledgeNotification(id, "readAt");
}
export function archiveNotification(id) {
    return acknowledgeNotification(id, "archivedAt");
}
