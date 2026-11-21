import { createHmac, randomBytes } from "node:crypto";
import { NfcError, canIdentifyNfc, createNfcRateLimiter } from "../nfc/service.js";
const activeMembers = {
    status: { not: "FORMER_MEMBER" }, membershipStatus: { not: "RESIGNED" },
    OR: [
        { person: { accounts: { none: {} } } },
        { person: { accounts: { some: { type: { in: ["MEMBER", "ADMIN"] }, isSandbox: false } } } },
    ],
};
const bridgePublic = { id: true, label: true, scope: true, createdAt: true, expiresAt: true, revokedAt: true };
const timeoutKey = "presence.timeoutMinutes";
const validTimeout = (value) => Number.isInteger(value) && Number(value) >= 5 && Number(value) <= 1440;
export function presenceDto(memberId, state, at = new Date(), timeoutMinutes = 60) {
    const lastSeenAt = state?.lastSeenAt || null;
    const expiresAt = lastSeenAt ? new Date(lastSeenAt.getTime() + timeoutMinutes * 60_000) : null;
    const status = state?.status === "IN" ? (expiresAt && expiresAt > at ? "IN" : "EXPIRED") : state?.status === "OUT" ? "OUT" : "UNKNOWN";
    return { memberId, status, present: status === "UNKNOWN" ? null : status === "IN",
        changedAt: state?.changedAt.toISOString() || null, version: state?.version || 0,
        lastSeenAt: lastSeenAt?.toISOString() || null,
        secondsSinceLastSeen: lastSeenAt ? Math.max(0, Math.floor((at.getTime() - lastSeenAt.getTime()) / 1000)) : null,
        presentUntil: state?.status === "IN" ? expiresAt?.toISOString() || null : null,
    };
}
export function createPresenceService(db, key, now = () => new Date()) {
    const limit = createNfcRateLimiter();
    const hash = (token) => createHmac("sha256", key).update(`bonni:presence-bridge:v1:${token}`).digest("hex");
    const audit = (tx, event, accountId, targetId) => tx.auditLog.create({ data: {
            category: "SECURITY", event, result: "SUCCESS", accountId, targetType: "Presence", targetId,
        } });
    async function timeout(tx) {
        const setting = await tx.systemSetting.findUnique({ where: { key: timeoutKey } });
        return validTimeout(setting?.value) ? setting.value : 60;
    }
    async function summary(tx, at, timeoutMinutes) {
        const total = await tx.memberProfile.count({ where: activeMembers });
        const since = new Date(at.getTime() - timeoutMinutes * 60_000);
        const presentCount = await tx.securityMemberPresence.count({ where: { member: activeMembers, status: "IN", lastSeenAt: { gt: since } } });
        const inCount = await tx.securityMemberPresence.count({ where: { member: activeMembers, status: "IN" } });
        const absentCount = await tx.securityMemberPresence.count({ where: { member: activeMembers, status: "OUT" } });
        return { memberCount: total, presentCount, absentCount, expiredCount: inCount - presentCount, unknownCount: total - inCount - absentCount };
    }
    return Object.freeze({
        overview() {
            return db.$transaction(async (tx) => {
                const at = now();
                const timeoutMinutes = await timeout(tx);
                const counts = await summary(tx, at, timeoutMinutes);
                const members = await tx.memberProfile.findMany({ where: activeMembers, orderBy: { id: "asc" }, take: 5000, select: {
                        id: true, currentPresence: true, person: { select: { displayName: true } },
                    } });
                return { asOf: at.toISOString(), timeoutMinutes, ...counts, truncated: counts.memberCount > members.length,
                    members: members.map(member => ({ ...presenceDto(member.id, member.currentPresence, at, timeoutMinutes), displayName: member.person.displayName })),
                };
            }, { isolationLevel: "RepeatableRead" });
        },
        setTimeoutMinutes(minutes, actorId) {
            if (!validTimeout(minutes))
                throw new NfcError("PRESENCE_TIMEOUT_INVALID");
            return db.$transaction(async (tx) => {
                await tx.systemSetting.upsert({ where: { key: timeoutKey }, create: { key: timeoutKey, value: minutes }, update: { value: minutes } });
                await audit(tx, "PRESENCE_TIMEOUT_CHANGED", actorId, timeoutKey);
                return { timeoutMinutes: minutes };
            });
        },
        async mark(memberId, status, actorId, expectedVersion) {
            if (!["IN", "OUT", "UNKNOWN"].includes(status))
                throw new NfcError("PRESENCE_STATUS_INVALID");
            try {
                return await db.$transaction(async (tx) => {
                    const member = await tx.memberProfile.findFirst({ where: { id: memberId, ...activeMembers }, select: { id: true } });
                    if (!member)
                        throw new NfcError("PRESENCE_MEMBER_UNAVAILABLE", 404);
                    const before = await tx.securityMemberPresence.findUnique({ where: { memberId } });
                    const at = now();
                    const timeoutMinutes = await timeout(tx);
                    if (before?.status === status && status !== "IN")
                        return presenceDto(memberId, before, at, timeoutMinutes);
                    if (expectedVersion !== undefined && (before?.version || 0) !== expectedVersion)
                        throw new NfcError("PRESENCE_CONFLICT", 409);
                    const after = await tx.securityMemberPresence.upsert({ where: { memberId },
                        create: { memberId, status, changedBy: actorId, changedAt: at, lastSeenAt: status === "IN" ? at : null },
                        update: { status, changedBy: actorId, changedAt: at, ...(status === "IN" ? { lastSeenAt: at } : {}), version: { increment: 1 } },
                    });
                    if (before?.status !== status)
                        await tx.memberPresenceLog.create({ data: { memberId, status, source: "core.presence", createdAt: after.changedAt } });
                    await audit(tx, `PRESENCE_${status}`, actorId, memberId);
                    return presenceDto(memberId, after, at, timeoutMinutes);
                }, { isolationLevel: "Serializable" });
            }
            catch (error) {
                if (error?.code === "P2034")
                    throw new NfcError("PRESENCE_CONFLICT", 409);
                throw error;
            }
        },
        async recordBookingSeen(input, actor, moduleKey) {
            if (!actor)
                throw new NfcError("PRESENCE_UNAUTHENTICATED", 401);
            if (moduleKey !== "app.stueberlapp" || (actor.memberId !== input?.memberId && !canIdentifyNfc(actor, moduleKey)))
                throw new NfcError("PRESENCE_FORBIDDEN", 403);
            const at = now();
            const seen = new Date(input?.observedAt);
            if (!input?.memberId || typeof input.bookingId !== "string" || !input.bookingId.length || input.bookingId.length > 160 || !Number.isFinite(seen.getTime()) || seen.getTime() > at.getTime() + 30_000)
                throw new NfcError("PRESENCE_OBSERVATION_INVALID");
            if (seen > at)
                seen.setTime(at.getTime());
            const id = createHmac("sha256", key).update(`bonni:presence-observation:v1:${moduleKey}:${input.bookingId}`).digest("hex");
            return db.$transaction(async (tx) => {
                const member = await tx.memberProfile.findFirst({ where: { id: input.memberId, ...activeMembers }, select: { id: true } });
                if (!member)
                    throw new NfcError("PRESENCE_MEMBER_UNAVAILABLE", 404);
                const before = await tx.securityMemberPresence.findUnique({ where: { memberId: input.memberId } });
                const timeoutMinutes = await timeout(tx);
                if (await tx.securityPresenceObservation.findUnique({ where: { id } }))
                    return { ...presenceDto(input.memberId, before, at, timeoutMinutes), duplicate: true };
                await tx.securityPresenceObservation.create({ data: { id, observedAt: seen } });
                // Delayed/offline events cannot undo a newer explicit departure or observation.
                if (before && (before.changedAt >= seen || (before.lastSeenAt && before.lastSeenAt >= seen)))
                    return { ...presenceDto(input.memberId, before, at, timeoutMinutes), ignoredOlderObservation: true };
                const after = await tx.securityMemberPresence.upsert({ where: { memberId: input.memberId },
                    create: { memberId: input.memberId, status: "IN", changedBy: actor.accountId, changedAt: seen, lastSeenAt: seen },
                    update: { status: "IN", changedBy: actor.accountId, changedAt: seen, lastSeenAt: seen, version: { increment: 1 } },
                });
                if (before?.status !== "IN")
                    await tx.memberPresenceLog.create({ data: { memberId: input.memberId, status: "IN", source: "app.stueberlapp.booking", createdAt: seen } });
                await audit(tx, "PRESENCE_BOOKING_SEEN", actor.accountId, input.memberId);
                return presenceDto(input.memberId, after, at, timeoutMinutes);
            }, { isolationLevel: "Serializable" });
        },
        listBridges() { return db.$transaction(tx => tx.securityPresenceBridge.findMany({ select: bridgePublic, orderBy: { createdAt: "desc" } })); },
        async createBridge(label, scope, actorId) {
            if (!label.trim() || label.length > 80 || !["COUNT", "MEMBERS"].includes(scope))
                throw new NfcError("PRESENCE_BRIDGE_INVALID");
            const token = `bonni-presence-${randomBytes(32).toString("base64url")}`;
            return db.$transaction(async (tx) => {
                if (await tx.securityPresenceBridge.count({ where: { revokedAt: null, expiresAt: { gt: now() } } }) >= 20)
                    throw new NfcError("PRESENCE_BRIDGE_LIMIT", 409);
                const bridge = await tx.securityPresenceBridge.create({ data: {
                        label: label.trim(), scope, tokenHash: hash(token), createdBy: actorId,
                        expiresAt: new Date(now().getTime() + 90 * 86_400_000),
                    }, select: bridgePublic });
                await audit(tx, "PRESENCE_BRIDGE_CREATED", actorId, bridge.id);
                return { ...bridge, token }; // One-time response only, never persisted raw.
            }, { isolationLevel: "Serializable" });
        },
        revokeBridge(id, actorId) {
            return db.$transaction(async (tx) => {
                const changed = await tx.securityPresenceBridge.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now() } });
                if (changed.count)
                    await audit(tx, "PRESENCE_BRIDGE_REVOKED", actorId, id);
                return { ok: true };
            });
        },
        readBridge(authorization, memberId, ip) {
            limit(`bridge:${ip}`, 120);
            if (typeof authorization !== "string" || !/^Bearer bonni-presence-[A-Za-z0-9_-]{43}$/.test(authorization))
                throw new NfcError("PRESENCE_BRIDGE_UNAUTHORIZED", 401);
            const tokenHash = hash(authorization.slice(7));
            return db.$transaction(async (tx) => {
                const bridge = await tx.securityPresenceBridge.findUnique({ where: { tokenHash } });
                if (!bridge || bridge.revokedAt || bridge.expiresAt <= now())
                    throw new NfcError("PRESENCE_BRIDGE_UNAUTHORIZED", 401);
                if (memberId && bridge.scope !== "MEMBERS")
                    throw new NfcError("PRESENCE_BRIDGE_SCOPE_DENIED", 403);
                const at = now();
                const asOf = at.toISOString();
                const timeoutMinutes = await timeout(tx);
                if (!memberId)
                    return { asOf, timeoutMinutes, ...await summary(tx, at, timeoutMinutes) };
                const member = await tx.memberProfile.findFirst({ where: { id: memberId, ...activeMembers }, select: { id: true, currentPresence: true } });
                if (!member)
                    throw new NfcError("PRESENCE_MEMBER_UNAVAILABLE", 404);
                return { asOf, timeoutMinutes, ...presenceDto(member.id, member.currentPresence, at, timeoutMinutes) };
            }, { isolationLevel: "RepeatableRead" });
        },
    });
}
