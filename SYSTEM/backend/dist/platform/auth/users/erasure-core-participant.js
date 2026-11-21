import { supportedCoreRetention, inspectCoreRetention, archiveCoreRetention } from "./erasure-core-retention.js";
import { retentionVerificationRecords } from "./erasure-retention-vault.js";
import { cleanupRetentionAttachments, verifyRetentionAttachments } from "./erasure-retention-files.js";
import { getServerPrismaClient } from "../../../core/database/prisma.js";
import { Prisma } from "@prisma/client";
import { coreErasureDomains } from "./erasure-core-catalog.js";
import { isBootstrapAdminLoginName } from "../system-account-policy.js";
const core = () => getServerPrismaClient("core");
const people = () => getServerPrismaClient("people");
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const handled = new Set(["Account", "Person", "MemberProfile", "MemberAccount", "MemberPresenceLog", "AccountRole", "AccountMemberCapability",
    "Session", "RefreshToken", "ExternalIdentity", "SecurityTwoFactorEnrollment", "SecurityTwoFactorCredential", "SecurityTwoFactorRecoveryCode",
    "SecurityTwoFactorChallenge", "SecurityTwoFactorLockout", "SecurityAccountRecoveryRequest", "SecurityNfcTag", "SecurityMemberPresence",
    "AccountPersonLinkRequest", "ArchiveFolder", "ArchiveFolderGrant", "PeopleProfile", "PeopleAddress", "PeopleBankAccount", "PeopleFamilyRelation",
    "PeopleHealthRecord", "PeopleEmergencyContact", "ConsentRecord", "ProtectedDataAccessGrant", "ProtectedDataAccessLog",
    "SystemLog", "RequestLog", "SecurityLog", "TokenProblemLog", "SecurityTwoFactorAuditLog", "ModuleNetworkObservation", "SystemEmergencyAccessEvent",
    "TerminalSession", "TerminalOperatorConfirmation", "NotificationRecipientState", "Notification"]);
const privacyModels = new Set(["PrivacySetting", "PrivacyRequest", "ConsentRecord", "DataRetentionRule", "ProtectedDataAccessGrant", "ProtectedDataAccessLog"]);
export async function attributableCoreRows(row) {
    const ids = [...row.subject.accountIds, ...row.subject.personIds, ...row.subject.memberIds];
    const reports = [];
    for (const model of Prisma.dmmf.datamodel.models) {
        if (!Object.hasOwn(coreErasureDomains, model.name))
            continue;
        const fields = model.fields.filter(f => f.kind === "scalar" && f.type === "String" && !f.isList && (f.name === "id" || /Id$/.test(f.name) || ["createdBy", "changedBy", "markedBy", "target"].includes(f.name))).map(f => f.name);
        if (!fields.length)
            continue;
        const domain = coreErasureDomains[model.name];
        const delegate = model.name[0].toLowerCase() + model.name.slice(1);
        const where = { OR: fields.map(field => ({ [field]: { in: ids } })), ...(model.name === "PrivacyRequest" ? { id: { not: row.id } } : {}) };
        const rows = await getServerPrismaClient(domain)[delegate].findMany({ where, take: 1001 });
        if (rows.length > 1000)
            return fail("ERASURE_SCOPE_TOO_LARGE");
        if (rows.length)
            reports.push({ name: model.name, delegate, domain, fields, rows });
    }
    return reports;
}
export async function deactivateErasureSubject(row) {
    await core().$transaction(async (tx) => {
        const a = await tx.account.findUnique({ where: { id: row.subject.accountIds[0] }, include: { person: { include: { accounts: { select: { id: true } }, member: true } }, roles: { include: { role: true } } } });
        if (!a) {
            if ((row.frozen.includes("core") && row.backupId) || row.erased.includes("core"))
                return;
            return fail("ERASURE_IDENTITY_CHANGED");
        }
        if (isBootstrapAdminLoginName(a.loginName) || !["MEMBER", "ADMIN"].includes(a.type) || !a.personId ||
            a.personId !== row.subject.personIds[0] || a.person?.accounts.length !== 1 ||
            (a.person?.member?.id || null) !== (row.subject.memberIds[0] || null))
            return fail("ERASURE_IDENTITY_CHANGED");
        if (a.roles.some(r => r.role.key === "admin") && await tx.account.count({ where: { id: { not: a.id }, isActive: true,
                roles: { some: { role: { key: "admin" } } } } }) === 0)
            return fail("ERASURE_LAST_ADMIN_PROTECTED");
        if (a.isActive)
            await tx.account.update({ where: { id: a.id }, data: { isActive: false, credentialRevision: { increment: 1 } } });
        await tx.session.updateMany({ where: { accountId: a.id, endedAt: null }, data: { endedAt: new Date() } });
        await tx.refreshToken.updateMany({ where: { accountId: a.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }, { isolationLevel: "Serializable" });
}
export async function inspectCoreErasure(row, bridge) {
    const db = core(), s = row.subject, a = { in: s.accountIds }, p = { in: s.personIds }, m = { in: s.memberIds };
    const reasons = new Set();
    const accounts = await db.memberAccount.findMany({ where: { memberId: m }, select: { balanceCached: true } });
    if (accounts.some(v => !v.balanceCached.isZero()))
        reasons.add("BALANCE");
    const retentionChecks = [
        db.archiveFolderGrant.count({ where: { grantedByAccountId: a, granteePersonId: { notIn: s.personIds } } }),
        db.archiveFolder.count({ where: { ownerPersonId: { notIn: s.personIds }, parent: { ownerPersonId: p } } }),
        getServerPrismaClient("privacy").protectedDataAccessGrant.count({ where: { grantedByAccountId: a, accountId: { notIn: s.accountIds } } }),
    ];
    if ((await Promise.all(retentionChecks)).some(count => count > 0))
        reasons.add("RETENTION");
    const attributed = await attributableCoreRows(row);
    if (attributed.some(r => !handled.has(r.name) && !supportedCoreRetention.has(r.name)))
        reasons.add("RETENTION");
    const retention = await inspectCoreRetention(row, attributed, bridge);
    if (retention.unsupported.length)
        reasons.add("SHARED_SUBJECT");
    for (const candidate of retention.candidates) {
        const original = attributed.find(entry => entry.name === candidate.model)?.rows.find(record => record.id === candidate.locator.id);
        if (!original || await bridge?.assess(candidate, original) !== "approved")
            reasons.add(candidate.changed ? "RETENTION_CHANGED" : "RETENTION");
    }
    // An administrator may have created another person's security/archive
    // record. Do not erase that other person's record as a side effect.
    for (const entry of attributed)
        for (const record of entry.rows) {
            if (["SecurityTwoFactorEnrollment", "SecurityAccountRecoveryRequest"].includes(entry.name) && record.accountId && !s.accountIds.includes(record.accountId))
                reasons.add("RETENTION");
            if (entry.name === "PeopleFamilyRelation" && !s.personIds.includes(record.personId))
                reasons.add("SHARED_SUBJECT");
            if (entry.name === "ArchiveFolder" && !s.personIds.includes(record.ownerPersonId))
                reasons.add("RETENTION");
            if (["SecurityMemberPresence", "SecurityNfcTag"].includes(entry.name) && !s.memberIds.includes(record.memberId))
                reasons.add("RETENTION");
        }
    for (const accountId of s.accountIds) {
        if (await getServerPrismaClient("privacy").privacyRequest.findFirst({ where: { requestType: "SYSTEM_WIDE_USER_ERASURE_V1", status: "IN_REVIEW",
                id: { not: row.id }, OR: [{ resultJson: { path: ["approvedByAccountId"], equals: accountId } }, { resultJson: { path: ["retentionPolicy", "approvedBy"], equals: accountId } }] }, select: { id: true } }))
            reasons.add("RETENTION");
    }
    return { status: reasons.size ? "blocked" : "clear", reasons: [...reasons], canDeactivate: !reasons.has("BALANCE"), details: [...retention.unsupported, ...attributed.filter(r => !handled.has(r.name) && !supportedCoreRetention.has(r.name)).map(r => ({ module: "core", model: r.name, count: r.rows.length, reason: "UNSUPPORTED_DATA" }))] };
}
export async function freezeCoreErasure(row) {
    const refs = await core().memberAccount.findMany({ where: { memberId: { in: row.subject.memberIds } }, select: { id: true } });
    const owned = await attributableCoreRows(row);
    return { requestId: row.id, frozen: true, references: [...new Set([...refs.map(r => r.id), ...owned.flatMap(r => r.rows.map(value => value.id).filter(Boolean))])] };
}
export async function eraseCoreSubject(row, bridge, policy) {
    if ((await inspectCoreErasure(row, bridge)).status !== "clear")
        return fail("ERASURE_FINAL_CHECK_BLOCKED");
    const s = row.subject;
    const records = await attributableCoreRows(row);
    if (records.some(entry => supportedCoreRetention.has(entry.name))) {
        if (!bridge)
            return fail("ERASURE_RETENTION_APPROVAL_REQUIRED");
        await archiveCoreRetention(row, records, bridge, policy);
    }
    await cleanupRetentionAttachments(row.id);
    // Protected personal data has its own database. Removing it is idempotent;
    // the shared identity remains disabled if a later database is unavailable.
    await people().$transaction(async (tx) => {
        const where = { personId: { in: s.personIds } };
        await tx.peopleFamilyRelation.deleteMany({ where: { OR: [where, { relatedPersonId: { in: s.personIds } }] } });
        for (const model of ["peopleHealthRecord", "peopleEmergencyContact", "peopleAddress", "peopleBankAccount", "peopleProfile"])
            await tx[model].deleteMany({ where });
    }, { isolationLevel: "Serializable" });
    await getServerPrismaClient("privacy").$transaction(async (tx) => {
        for (const model of ["consentRecord", "protectedDataAccessGrant", "protectedDataAccessLog"])
            await tx[model].deleteMany({ where: { OR: [{ accountId: { in: s.accountIds } }, { subjectId: { in: [...s.personIds, ...s.memberIds] } }] } });
    }, { isolationLevel: "Serializable" });
    await core().$transaction(async (tx) => {
        const a = { in: s.accountIds }, p = { in: s.personIds }, m = { in: s.memberIds };
        const existing = await tx.account.findUnique({ where: { id: s.accountIds[0] } });
        if (existing?.isActive)
            return fail("ERASURE_SUBJECT_NOT_FROZEN");
        await tx.archiveFolderGrant.deleteMany({ where: { OR: [{ granteePersonId: p }, { grantedByAccountId: a }] } });
        const folders = await tx.archiveFolder.findMany({ where: { ownerPersonId: p }, select: { id: true, parentId: true } });
        let pending = [...folders];
        while (pending.length) {
            const leaves = pending.filter(f => !pending.some(other => other.parentId === f.id));
            if (!leaves.length)
                return fail("ERASURE_ARCHIVE_TREE_INVALID");
            await tx.archiveFolder.deleteMany({ where: { id: { in: leaves.map(f => f.id) } } });
            pending = pending.filter(f => !leaves.some(leaf => leaf.id === f.id));
        }
        await tx.memberPresenceLog.deleteMany({ where: { memberId: m } });
        await tx.terminalSession.deleteMany({ where: { OR: [{ accountId: a }, { personId: p }] } });
        for (const model of ["systemLog", "requestLog", "securityLog", "tokenProblemLog", "securityTwoFactorAuditLog", "moduleNetworkObservation",
            "systemEmergencyAccessEvent", "terminalOperatorConfirmation", "notificationRecipientState", "notification"])
            await tx[model].deleteMany({ where: { accountId: a } });
        await tx.memberAccount.deleteMany({ where: { memberId: m, balanceCached: 0 } });
        await tx.accountRole.deleteMany({ where: { accountId: a } });
        await tx.accountMemberCapability.deleteMany({ where: { accountId: a } });
        await tx.session.deleteMany({ where: { accountId: a } });
        await tx.refreshToken.deleteMany({ where: { accountId: a } });
        await tx.externalIdentity.deleteMany({ where: { accountId: a } });
        await tx.account.deleteMany({ where: { id: a, isActive: false } });
        await tx.person.deleteMany({ where: { id: p } });
    }, { isolationLevel: "Serializable", timeout: 30_000 });
    return verifyCoreErasure(row, bridge);
}
export async function verifyCoreErasure(row, bridge) {
    const s = row.subject;
    if (await core().account.count({ where: { id: { in: s.accountIds } } }) ||
        await core().person.count({ where: { id: { in: s.personIds } } }) ||
        await core().memberProfile.count({ where: { id: { in: s.memberIds } } }))
        return fail("ERASURE_VERIFICATION_FAILED");
    for (const model of ["peopleHealthRecord", "peopleEmergencyContact", "peopleFamilyRelation", "peopleAddress", "peopleBankAccount", "peopleProfile"])
        if (await people()[model].count({ where: { personId: { in: s.personIds } } }))
            return fail("ERASURE_VERIFICATION_FAILED");
    if ((await attributableCoreRows(row)).length)
        return fail("ERASURE_VERIFICATION_FAILED");
    await cleanupRetentionAttachments(row.id);
    if (!await verifyRetentionAttachments(row.id))
        return fail("ERASURE_DOCUMENT_CLEANUP_PENDING");
    for (const record of await retentionVerificationRecords(row.id, "core")) {
        const domain = coreErasureDomains[record.model], delegate = record.model[0].toLowerCase() + record.model.slice(1);
        const current = await getServerPrismaClient(domain)[delegate].findUnique({ where: record.locator });
        if (!bridge || !await bridge.verify(record, current))
            return fail("ERASURE_RETENTION_VERIFICATION_FAILED");
    }
    return { requestId: row.id, erased: true };
}
