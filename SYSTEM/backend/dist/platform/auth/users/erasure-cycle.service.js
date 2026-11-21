import { createRetentionBridge, listRetentionRecords, expireRetentionPayloads } from "./erasure-retention-vault.js";
import { erasureStatusMailbox } from "./erasure-status-mailbox.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { getDataDomainConnectionString } from "../../../core/database/data-domain-routing.js";
import { dataDomainForModule } from "../../../core/database/data-domains.js";
import { getDatabaseRoutingStatus, getDatabaseTargetConnectionString } from "../../../core/database/database-routing.js";
import { getJsonEmergencyStatus } from "../../../core/database/json-emergency-store.js";
import { moduleServicesRegistry } from "../../../core/module-services/module-services-runtime.js";
import { createSystemBackup, validateSystemBackup, rotateErasureBackups, listSystemBackups } from "../../../system/routes/control-api/backup/backup.service.js";
import { resolvePersistentStorageRoot } from "../../../../scripts/storage/persistent-storage-root.mjs";
import { ERASURE_TYPE, ERASURE_MODULE, erasureError } from "./erasure-workflow.js";
import { createErasureCycle } from "./erasure-cycle.js";
import { defaultErasureCycleSettings, validateErasureCycleSettings, berlinThreeOnDay } from "./erasure-cycle-settings.js";
import { erasureExclusive } from "./erasure-write-barrier.js";
import { deactivateErasureSubject, inspectCoreErasure, freezeCoreErasure, eraseCoreSubject, verifyCoreErasure } from "./erasure-core-participant.js";
const settingsKey = "erasure:cycle-settings:v1";
const core = () => getServerPrismaClient("core"), privacy = () => getServerPrismaClient("privacy");
const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const category = { requestType: ERASURE_TYPE, subjectType: "BONNI_USER" };
let timer, working = false;
const ledgerPath = () => path.join(resolvePersistentStorageRoot(), "system", "erasure-ledger.json");
export async function readErasureCycleSettings() {
    const row = await privacy().privacySetting.findUnique({ where: { key: settingsKey } });
    return row ? validateErasureCycleSettings(row.value) : defaultErasureCycleSettings();
}
export async function writeErasureCycleSettings(value) {
    const settings = validateErasureCycleSettings(value);
    await privacy().privacySetting.upsert({ where: { key: settingsKey }, create: { key: settingsKey, value: settings }, update: { value: settings } });
    return settings;
}
async function installedParticipants() {
    const rows = await core().installedModule.findMany({ select: { key: true, status: true, installedAt: true, enabledAt: true, uninstalledAt: true, deletedAt: true } });
    return rows.filter(r => r.status !== "DISCOVERED" || r.installedAt || r.enabledAt || r.uninstalledAt || r.deletedAt).map(r => r.key).sort();
}
async function backupDomains() {
    const domains = new Set(["core", "people", "organization", "privacy"]);
    for (const key of await installedParticipants())
        domains.add(dataDomainForModule(key));
    return [...domains].map(domain => ({ domain, url: getDataDomainConnectionString(domain, "normal", getDatabaseTargetConnectionString("normal")) }));
}
async function approvalVerified(row) {
    const request = await privacy().privacyRequest.findFirst({ where: { ...category, id: row.id, status: "IN_REVIEW" } });
    const info = request?.resultJson;
    if (!request || !info || info.approvedByAccountId !== row.approvedBy || !info.devicesClearedAt ||
        !info.approvalBinding?.startsWith("erasure-v1:approve:" + row.id + ":") ||
        info.approvedByAccountId === row.subject.accountIds[0])
        return fail("ERASURE_APPROVAL_UNVERIFIED");
    // Once Core identity deletion committed, the target's proof cascades away.
    // The independent reviewer's approval proof remains the authority on retry.
    if (!await core().securityTwoFactorChallenge.findFirst({ where: { id: info.approvalProofId, accountId: row.approvedBy,
            status: "CONSUMED", verifiedAt: { not: null }, consumedAt: { not: null }, moduleKey: ERASURE_MODULE,
            purpose: "DSGVO_SUBJECT_DATA_DELETE", subjectId: info.approvalBinding }, select: { id: true } }))
        return fail("ERASURE_APPROVAL_UNVERIFIED");
}
async function save(row) {
    const previous = await privacy().privacyRequest.findFirst({ where: { ...category, id: row.id, status: "IN_REVIEW" } });
    if (!previous)
        return fail("ERASURE_REQUEST_CHANGED");
    const info = previous.resultJson;
    if (row.state === "COMPLETED") {
        // A minimal tombstone prevents delayed imports from recreating a removed
        // identity. It contains opaque IDs only; no names, contacts or credentials.
        const references = [...new Set([...row.references, ...row.subject.accountIds, ...row.subject.personIds, ...row.subject.memberIds])];
        const tombstone = { schema: "bonni.erasure-tombstone/v1", requestId: row.id, references, completedAt: row.completedAt };
        await appendDeletionLedger(tombstone);
        await privacy().$transaction(async (tx) => {
            await tx.privacySetting.upsert({ where: { key: "erasure:tombstone:" + row.id }, create: { key: "erasure:tombstone:" + row.id, value: tombstone }, update: { value: tombstone } });
            await tx.privacyRequest.update({ where: { id: row.id }, data: { status: "COMPLETED", completedAt: new Date(row.completedAt),
                    accountId: null, subjectId: null, requestedByAccountId: null, message: null, errorMessage: null,
                    resultJson: { scope: "BONNI_USER_AND_ALL_APPS", cycle: { state: "COMPLETED", completedAt: row.completedAt,
                            participants: row.participants, backupId: row.backupId } } } });
        }, { isolationLevel: "Serializable" });
        const retainedCount = (await listRetentionRecords(row.id)).filter(record => record.action === "retain" && !record.expiredAt).length;
        await erasureStatusMailbox().publish(row.id, "COMPLETED", null, retainedCount).catch(() => undefined);
        return;
    }
    await privacy().privacyRequest.update({ where: { id: row.id }, data: { resultJson: { ...info, cycle: row } } });
    const settings = await readErasureCycleSettings();
    await erasureStatusMailbox().publish(row.id, row.state, settings.enabled ? settings.nextRunAt : null).catch(() => undefined);
}
async function appendDeletionLedger(tombstone) {
    const file = ledgerPath();
    let ledger = { schema: "bonni.erasure-ledger/v1", entries: [] };
    try {
        ledger = JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    if (ledger.schema !== "bonni.erasure-ledger/v1" || !Array.isArray(ledger.entries))
        return fail("ERASURE_LEDGER_INVALID");
    ledger.entries = [...ledger.entries.filter((e) => e.requestId !== tombstone.requestId), tombstone];
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = file + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(ledger), { mode: 0o600 });
    await fs.rename(temp, file);
}
export async function erasureRetentionContext(row, module) {
    const request = await privacy().privacyRequest.findUnique({ where: { id: row.id } });
    const policy = request?.resultJson?.retentionPolicy;
    if (policy && !await core().securityTwoFactorChallenge.findFirst({ where: { id: policy.proofId, accountId: policy.approvedBy,
            status: "CONSUMED", verifiedAt: { not: null }, consumedAt: { not: null }, moduleKey: ERASURE_MODULE,
            purpose: "DSGVO_SUBJECT_DATA_DELETE", subjectId: policy.binding }, select: { id: true } }))
        return fail("ERASURE_RETENTION_APPROVAL_UNVERIFIED");
    return { policy, bridge: createRetentionBridge(row.id, module, policy) };
}
async function participantCall(key, operation, row) {
    const { bridge } = await erasureRetentionContext(row, key);
    return moduleServicesRegistry.cycleAccountErasure(key, operation, { ...row.subject, recordReferences: row.references, devicesCleared: true }, row.approvedBy, bridge);
}
export async function loadErasureCaseForReview(requestId) {
    const request = await privacy().privacyRequest.findFirst({ where: { ...category, id: requestId } });
    if (!request || !["OPEN", "IN_REVIEW"].includes(request.status) || !request.accountId || !request.subjectId)
        return fail("ERASURE_NOT_PENDING");
    const info = request.resultJson;
    const member = await core().memberProfile.findUnique({ where: { personId: request.subjectId }, select: { id: true } });
    const row = info?.cycle || { id: request.id, subject: { requestId, accountIds: [request.accountId], personIds: [request.subjectId], memberIds: member ? [member.id] : [] },
        approvedBy: info?.approvedByAccountId || "core-precheck", approvedAt: info?.approvedAt || request.createdAt.toISOString(), state: "APPROVED_PENDING_CHECKS", participants: [], frozen: [], erased: [], references: [], blockers: [] };
    return { request, row, info };
}
export async function reviewErasureCase(requestId) {
    const { request, row } = await loadErasureCaseForReview(requestId);
    const reports = [];
    for (const module of ["core", ...await installedParticipants()]) {
        try {
            const { bridge } = await erasureRetentionContext(row, module);
            const report = module === "core" ? await inspectCoreErasure(row, bridge) : await participantCall(module, "inspect", row);
            reports.push({ module, status: report.status, reasons: report.reasons, details: report.details || [], canDeactivate: report.canDeactivate === true });
        }
        catch (e) {
            reports.push({ module, status: "unverified", reasons: [e?.code?.startsWith("ERASURE_") ? e.code : "DATA_UNAVAILABLE"], details: [], canDeactivate: false });
        }
    }
    if (request.status === "IN_REVIEW") {
        row.blockers = reports.flatMap(report => report.reasons.map((reason) => `${report.module}:${reason}`));
        row.state = row.blockers.length ? "BLOCKED" : "WAITING_CYCLE";
        await save(row);
    }
    return { reports };
}
const cycle = createErasureCycle({
    exclusive: erasureExclusive,
    async load() {
        const rows = await privacy().privacyRequest.findMany({ where: { ...category, status: "IN_REVIEW" }, orderBy: { createdAt: "asc" } });
        return rows.flatMap(r => r.resultJson?.cycle ? [r.resultJson.cycle] : []);
    },
    save, verifyApproval: approvalVerified,
    async participants() {
        const status = getDatabaseRoutingStatus();
        if (status.mode !== "normal" || status.configured.redundant || status.jsonEmergency.enabled || status.degraded || status.maintenance)
            return fail("ERASURE_REPLICA_REVIEW_REQUIRED");
        if ((await getJsonEmergencyStatus()).pendingCount)
            return fail("ERASURE_PENDING_QUEUE");
        return ["core", ...await installedParticipants()];
    },
    deactivate: deactivateErasureSubject,
    freeze: (key, row) => key === "core" ? freezeCoreErasure(row) : participantCall(key, "freeze", row),
    inspect: async (key, row) => { const { bridge } = await erasureRetentionContext(row, key); return key === "core" ? inspectCoreErasure(row, bridge) : participantCall(key, "inspect", row); },
    erase: async (key, row) => { const { bridge, policy } = await erasureRetentionContext(row, key); return key === "core" ? eraseCoreSubject(row, bridge, policy) : participantCall(key, "erase", row); },
    verify: async (key, row) => { const { bridge } = await erasureRetentionContext(row, key); return key === "core" ? verifyCoreErasure(row, bridge) : participantCall(key, "verify", row); },
    async backup(reason) {
        const result = await createSystemBackup({ reason, domainDatabases: await backupDomains() });
        if (!result.ok || !result.backup?.id)
            return fail("ERASURE_BACKUP_FAILED");
        return { id: result.backup.id };
    },
    async validateBackup(id) {
        const result = await validateSystemBackup(id);
        const domains = (await backupDomains()).map(d => d.domain);
        return result.ok && domains.every(domain => result.backup?.domainDatabases?.some(d => d.domain === domain)) &&
            result.backup?.components.every(c => c.status === "completed") === true;
    }, now: () => new Date(),
});
export async function prepareApprovedErasure(requestId) {
    return erasureExclusive(async () => {
        const request = await privacy().privacyRequest.findFirst({ where: { ...category, id: requestId, status: "IN_REVIEW" } });
        if (!request?.accountId || !request.subjectId)
            return fail("ERASURE_IDENTITY_UNVERIFIED");
        const info = request.resultJson;
        const member = await core().memberProfile.findUnique({ where: { personId: request.subjectId }, select: { id: true } });
        const row = info.cycle || { id: request.id, subject: { requestId: request.id, accountIds: [request.accountId],
                personIds: [request.subjectId], memberIds: member ? [member.id] : [] }, approvedBy: info.approvedByAccountId,
            approvedAt: info.approvedAt, state: "APPROVED_PENDING_CHECKS", participants: [], frozen: [], erased: [], references: [], blockers: [] };
        await save(row); // The fence is visible before any module write resumes.
        await deactivateErasureSubject(row);
        row.state = "DEACTIVATED";
        await save(row);
        try {
            await cycle.prepare(row);
        }
        catch (error) {
            row.state = "BLOCKED";
            row.blockers = [error?.code?.startsWith("ERASURE_") ? error.code : "ERASURE_PREPARATION_FAILED"];
            await save(row);
        }
        return row;
    });
}
export async function precheckErasureDeactivation(accountId, requestId) {
    const a = await core().account.findUnique({ where: { id: accountId }, select: { personId: true, person: { select: { member: { select: { id: true } } } } } });
    if (!a?.personId)
        return fail("ERASURE_IDENTITY_UNVERIFIED");
    const subject = { requestId, accountIds: [accountId], personIds: [a.personId], memberIds: a.person?.member ? [a.person.member.id] : [] };
    const fake = { id: requestId, subject };
    if (!(await inspectCoreErasure(fake)).canDeactivate)
        return fail("ERASURE_FINANCIAL_NOT_CLEAR");
    for (const module of await installedParticipants()) {
        await moduleServicesRegistry.cycleAccountErasure(module, "retentionPreview", { ...subject, devicesCleared: true, prepareRetentionIndex: true }, "core-precheck", createRetentionBridge(requestId, module));
        const report = await moduleServicesRegistry.cycleAccountErasure(module, "inspect", { ...subject, devicesCleared: true }, "core-precheck", createRetentionBridge(requestId, module));
        if (report?.canDeactivate !== true)
            return fail("ERASURE_FINANCIAL_NOT_CLEAR");
    }
}
export async function erasureCycleOverview() {
    const settings = await readErasureCycleSettings();
    const rows = await privacy().privacyRequest.findMany({ where: { ...category, status: { in: ["OPEN", "IN_REVIEW", "COMPLETED"] } }, orderBy: { updatedAt: "desc" }, take: 200 });
    const ids = rows.flatMap(row => row.accountId ? [row.accountId] : []);
    const accounts = await core().account.findMany({ where: { id: { in: ids } }, select: { id: true, loginName: true, person: { select: { displayName: true } } } });
    const byId = new Map(accounts.map(account => [account.id, account]));
    return { settings, cases: rows.map(r => {
            const info = r.resultJson, c = info?.cycle;
            return { id: r.id, accountId: r.accountId,
                label: r.accountId ? byId.get(r.accountId)?.person?.displayName || byId.get(r.accountId)?.loginName || "Benutzerzuordnung prüfen" : "Gelöschtes Mitglied",
                requestedAt: r.createdAt.toISOString(), approvedAt: info?.approvedAt || null, approvedBy: info?.approvedByAccountId || null,
                state: r.status === "OPEN" ? "REQUESTED" : c?.state || "APPROVED_PENDING_CHECKS", nextRunAt: r.status === "COMPLETED" || !settings.enabled ? null : settings.nextRunAt,
                completedAt: c?.completedAt || null, blockers: c?.blockers || [], backupId: c?.backupId || null };
        }) };
}
export function runImmediateErasure(requestId, actor) {
    return erasureExclusive(async () => {
        const request = await privacy().privacyRequest.findFirst({ where: { ...category, id: requestId } });
        if (request?.status === "COMPLETED")
            return { requestId, state: "COMPLETED", alreadyCompleted: true };
        if (request?.status !== "IN_REVIEW" || !request.accountId || !request.subjectId) {
            return erasureError("ERASURE_NOT_APPROVED", "Für diese Antrags-ID muss ein freigegebener Löschantrag vorliegen.");
        }
        if (actor.id === request.accountId || (actor.personId && actor.personId === request.subjectId)) {
            return erasureError("ERASURE_SELF_APPROVAL_FORBIDDEN", "Eine andere berechtigte Person muss die sofortige Löschung auslösen.", 403);
        }
        const info = request.resultJson;
        if (!info?.cycle) {
            return erasureError("ERASURE_PREPARATION_REQUIRED", "Der Core bereitet den freigegebenen Antrag noch für den Löschzyklus vor.");
        }
        let followUpBackupPending = false;
        try {
            const result = await cycle.run(requestId);
            followUpBackupPending = result.completed > 0 && !("postBackupId" in result && result.postBackupId);
        }
        catch (error) {
            const current = await privacy().privacyRequest.findUnique({ where: { id: requestId }, select: { status: true } });
            if (current?.status !== "COMPLETED")
                throw error;
            followUpBackupPending = true;
        }
        const current = await privacy().privacyRequest.findUnique({ where: { id: requestId }, select: { status: true, resultJson: true } });
        const saved = current?.resultJson?.cycle;
        if (current?.status === "COMPLETED") {
            return { requestId, state: "COMPLETED", backupId: saved?.backupId, followUpBackupPending };
        }
        return { requestId, state: saved?.state || "BLOCKED", blockers: saved?.blockers || ["ERASURE_EXECUTION_UNCONFIRMED"] };
    });
}
export async function runScheduledErasureCycle() {
    if (working)
        return;
    working = true;
    try {
        const pending = await privacy().privacyRequest.findMany({ where: { ...category, status: { in: ["OPEN", "IN_REVIEW"] } },
            select: { id: true, accountId: true, status: true, resultJson: true } });
        for (const request of pending) {
            const details = request.resultJson;
            if (request.status === "IN_REVIEW" && details?.devicesClearedAt && !details.cycle)
                await prepareApprovedErasure(request.id);
            if (request.accountId) {
                const { notifyErasureMember } = await import("./erasure-notifications.js");
                await notifyErasureMember(request.accountId, request.id, request.status === "IN_REVIEW").catch(() => undefined);
            }
        }
        const completed = await privacy().privacyRequest.findMany({ where: { ...category, status: "COMPLETED" }, select: { id: true }, take: 5000 });
        for (const row of completed)
            await erasureStatusMailbox().publish(row.id, "COMPLETED", null, (await listRetentionRecords(row.id)).filter(record => record.action === "retain" && !record.expiredAt).length).catch(() => undefined);
        await expireRetentionPayloads();
        await erasureStatusMailbox().expire();
        let settings = await readErasureCycleSettings();
        // Materialize the first due date once; never recalculate it on every poll.
        if (!await privacy().privacySetting.findUnique({ where: { key: settingsKey } }))
            await writeErasureCycleSettings(settings);
        if (!settings.enabled || Date.parse(settings.nextRunAt) > Date.now())
            return;
        // A due-time claim and the erasure pass use the same cross-process lock.
        await erasureExclusive(async () => {
            settings = await readErasureCycleSettings();
            if (!settings.enabled || Date.parse(settings.nextRunAt) > Date.now())
                return;
            await writeErasureCycleSettings({ ...settings, nextRunAt: berlinThreeOnDay(new Date(), settings.intervalDays) });
            const result = await cycle.run();
            const postBackupId = result.postBackupId || (await listSystemBackups()).find(b => b.status === "completed" && b.reason.startsWith("after-erasure:"))?.id;
            if (postBackupId)
                await rotateErasureBackups({ retentionDays: settings.backupRetentionDays,
                    verifiedPostBackupId: postBackupId,
                    protectedIds: (await cycleCases()).flatMap(c => c.backupId ? [c.backupId] : []) });
        });
    }
    finally {
        working = false;
    }
}
async function cycleCases() {
    const rows = await privacy().privacyRequest.findMany({ where: { ...category, status: "IN_REVIEW" }, select: { resultJson: true } });
    return rows.flatMap(r => r.resultJson?.cycle ? [r.resultJson.cycle] : []);
}
export function startErasureCycleWorker() {
    if (timer)
        return;
    const tick = () => void runScheduledErasureCycle().catch(error => console.warn("[privacy.erasure] Löschzyklus angehalten", { code: error?.code || "ERASURE_CYCLE_FAILED" }));
    timer = setInterval(tick, 60_000);
    timer.unref();
    tick();
}
