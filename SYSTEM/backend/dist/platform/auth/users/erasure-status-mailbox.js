import { createHash, randomBytes } from "node:crypto";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { sealRetention, openRetention } from "./erasure-retention-vault.js";
const slot = (id) => "erasure:status-secret:v1:" + id;
const entry = (hash) => "erasure:status:v1:" + hash;
const aad = (id) => "bonni.erasure-status/v1:" + id;
const hash = (token) => createHash("sha256").update(token).digest("hex");
export const erasureStateLabels = {
    REQUESTED: "Dein Löschantrag wurde angenommen. Die Freigabe durch die Verwaltung steht noch aus.",
    APPROVED_PENDING_CHECKS: "Dein Antrag wurde freigegeben. Dein Zugang wird deaktiviert.",
    DEACTIVATED: "Dein Zugang ist deaktiviert. Die Löschung wird vorbereitet.",
    WAITING_CYCLE: "Dein Zugang ist deaktiviert. Die Löschung ist für den nächsten Löschzyklus vorgesehen.",
    BLOCKED: "Deine Löschung verzögert sich. Die Verwaltung muss noch Daten oder offene Vorgänge klären.",
    ERASING: "Deine Löschung wird durchgeführt und geprüft.",
    COMPLETED: "Dein Benutzerkonto und die dafür freigegebenen persönlichen Daten wurden gelöscht. Begründet aufbewahrte Nachweise bleiben bis zum festgelegten Enddatum geschützt gespeichert.",
};
export function createErasureStatusMailbox(database) {
    return {
        async link(requestId) {
            const previous = await database.privacySetting.findUnique({ where: { key: slot(requestId) } });
            if (previous)
                return "/#erasure-status=" + openRetention(previous.value, aad(requestId)).token;
            const token = randomBytes(32).toString("base64url");
            // A unique request slot arbitrates concurrent reads; transactions roll back
            // the losing token mapping, so only the returned link can open this case.
            return database.$transaction(async (tx) => {
                const saved = await tx.privacySetting.upsert({ where: { key: slot(requestId) },
                    create: { key: slot(requestId), value: sealRetention({ token }, aad(requestId)) }, update: {} });
                const actual = openRetention(saved.value, aad(requestId)).token;
                await tx.privacySetting.upsert({ where: { key: entry(hash(actual)) },
                    create: { key: entry(hash(actual)), value: { schema: "bonni.erasure-status/v1", requestId, state: "REQUESTED", events: [] } }, update: {} });
                return "/#erasure-status=" + actual;
            }, { isolationLevel: "Serializable" });
        },
        async publish(requestId, state, nextRunAt, retainedCount) {
            if (!Object.hasOwn(erasureStateLabels, state))
                return;
            const secret = await database.privacySetting.findUnique({ where: { key: slot(requestId) } });
            // Completion may be retried after deleting the encrypted link copy.
            const row = secret ? await database.privacySetting.findUnique({ where: { key: entry(hash(openRetention(secret.value, aad(requestId)).token)) } })
                : await database.privacySetting.findFirst({ where: { key: { startsWith: "erasure:status:v1:" }, value: { path: ["requestId"], equals: requestId } } });
            if (!row)
                return;
            const old = row.value, now = new Date().toISOString();
            const changed = old.state !== state || old.nextRunAt !== nextRunAt || !old.events?.length;
            const event = { state, at: now, message: erasureStateLabels[state], nextRunAt };
            const events = changed ? [...(old.events || []), event].slice(-24) : old.events;
            await database.privacySetting.update({ where: { key: row.key }, data: { value: { ...old, state, nextRunAt, events,
                        ...(retainedCount !== undefined ? { retainedCount } : {}),
                        ...(state === "COMPLETED" ? { completedAt: old.completedAt || now, expiresAt: old.expiresAt || new Date(Date.now() + 90 * 86400000).toISOString() } : {}) } } });
            if (state === "COMPLETED")
                await database.privacySetting.deleteMany({ where: { key: slot(requestId) } });
        },
        async read(token) {
            if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
                return null;
            const row = await database.privacySetting.findUnique({ where: { key: entry(hash(token)) } });
            const v = row?.value;
            if (!v || (v.expiresAt && Date.parse(v.expiresAt) <= Date.now()))
                return null;
            // Explicit projection: no identities, blockers, snapshots, balance or token.
            return { state: v.state, nextRunAt: v.nextRunAt || null, events: v.events || [],
                completedAt: v.completedAt || null, expiresAt: v.expiresAt || null, retainedCount: v.retainedCount || 0 };
        },
        async expire() {
            const rows = await database.privacySetting.findMany({ where: { key: { startsWith: "erasure:status:v1:" } } });
            for (const row of rows)
                if (row.value?.expiresAt && Date.parse(row.value.expiresAt) <= Date.now())
                    await database.privacySetting.deleteMany({ where: { key: row.key } });
        },
    };
}
export const erasureStatusMailbox = () => createErasureStatusMailbox(getServerPrismaClient("privacy"));
