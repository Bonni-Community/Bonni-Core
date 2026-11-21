import { createHash, randomBytes } from "node:crypto";
import { getVerifiedRequestIdentity, getVerifiedRequestSessionAssurance } from "../request-identity/request-identity-context.js";
import { createModuleTwoFactorRuntime } from "../../../core/modules/security/two-factor/module-runtime.js";
export const MEMBER_DEVICES_CONTRACT_VERSION = "bonni.member-devices/v1";
export const MEMBER_DEVICE_COOKIE = "bonni_browser_device";
const PREFIX = "auth-browser-device:";
const SESSION_PREFIX = "browser-device:";
const ACTION_PREFIX = "auth-browser-device-action:";
const DEVICE_ID = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMINS = new Set(["admin", "system.admin", "access:control-center:control-center:administrator"]);
const settingKey = (accountId, deviceId) => `${PREFIX}${accountId}:${deviceId}`;
function fail(code, message, statusCode = 400) { throw Object.assign(new Error(message), { code, statusCode }); }
const iso = (value) => value ? new Date(value).toISOString() : null;
function deviceName(userAgent) {
    const os = /iPad/i.test(userAgent) ? "iPad" : /iPhone/i.test(userAgent) ? "iPhone" : /Android/i.test(userAgent) ? "Android" : /Windows/i.test(userAgent) ? "Windows" : /Macintosh/i.test(userAgent) ? "Mac" : /Linux/i.test(userAgent) ? "Linux" : "Browser";
    const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
    return `${os} · ${browser}`;
}
/** A random, account-bound browser credential; no hardware fingerprint. */
export function prepareBrowserDevice(req) {
    const cookie = String(req.headers?.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(MEMBER_DEVICE_COOKIE + "="))?.slice(MEMBER_DEVICE_COOKIE.length + 1);
    const existing = typeof cookie === "string" && /^[A-Za-z0-9_-]{43}$/.test(cookie);
    const secret = existing ? cookie : randomBytes(32).toString("base64url");
    return { id: createHash("sha256").update(secret).digest("hex"), secret, isNew: !existing, name: deviceName(String(req.headers?.["user-agent"] || "")) };
}
/** Called inside the same Core transaction that creates the login session. */
export async function registerBrowserLogin(tx, accountId, device) {
    const key = settingKey(accountId, device.id);
    const row = await tx.systemSetting.findUnique({ where: { key } });
    if (row?.value?.blockedAt)
        fail("ACCOUNT_DEVICE_BLOCKED", "Dieser Browserzugang ist für dieses Konto gesperrt.", 423);
    const now = new Date().toISOString();
    const value = { ...row?.value, accountId, deviceId: device.id, name: device.name, firstSeenAt: row?.value?.firstSeenAt || now, lastLoginAt: now, blockedAt: null };
    if (row) {
        // Claim the device row before inserting a session. A concurrent block must
        // either see this session or make this login fail; it cannot be bypassed.
        const changed = await tx.systemSetting.updateMany({ where: { key, value: { equals: row.value } }, data: { value } });
        if (changed.count !== 1)
            fail("ACCOUNT_DEVICE_CHANGED", "Der Gerätestatus wurde gleichzeitig geändert. Bitte erneut anmelden.", 409);
    }
    else
        await tx.systemSetting.create({ data: { key, value } });
    return SESSION_PREFIX + device.id;
}
export function rememberBrowserDevice(req, device) {
    if (!device.isNew)
        return;
    // Both supported Core login aliases must retain the same browser identity.
    // Keep the credential off app API paths and unavailable to JavaScript.
    for (const path of ["/api/auth", "/api/identity/auth"])
        req.res?.cookie(MEMBER_DEVICE_COOKIE, device.secret, { httpOnly: true, sameSite: "strict", secure: Boolean(req.secure), path, maxAge: 365 * 24 * 60 * 60 * 1000 });
}
export async function assertMemberDeviceAdministrator(status) {
    const actor = getVerifiedRequestIdentity();
    if (!actor)
        fail("ACCOUNT_DEVICE_AUTH_REQUIRED", "Bitte erneut anmelden.", 401);
    const roles = actor.roles.map(value => String(value).toLowerCase());
    if (!roles.some(value => ADMINS.has(value)) && !actor.permissions.includes("system.admin"))
        fail("ACCOUNT_DEVICE_ADMIN_REQUIRED", "Geräte werden durch einen Bonni-Core-Administrator verwaltet.", 403);
    const proof = getVerifiedRequestSessionAssurance();
    if (!proof || proof.accountId !== actor.accountId || proof.credentialRevision !== actor.credentialRevision || !proof.mfaVerifiedAt)
        fail("ACCOUNT_DEVICE_MFA_REQUIRED", "Bitte mit bestätigtem zweiten Faktor anmelden.", 403);
    const mfa = await status();
    if (!mfa?.sessionSatisfied)
        fail("ACCOUNT_DEVICE_MFA_REQUIRED", "Bitte mit bestätigtem zweiten Faktor anmelden.", 403);
    return actor;
}
export function createMemberDevicesRuntime({ prisma, moduleKey, resolveAccounts, authorize }) {
    const permission = authorize || (() => assertMemberDeviceAdministrator(() => createModuleTwoFactorRuntime(moduleKey).status()));
    async function owners(memberId) {
        if (typeof memberId !== "string" || !memberId.trim() || memberId.length > 160)
            fail("ACCOUNT_DEVICE_MEMBER_INVALID", "Ungültiges Mitglied.");
        const accounts = await resolveAccounts(memberId);
        if (!accounts.length)
            fail("ACCOUNT_DEVICE_MEMBER_NOT_FOUND", "Für dieses Mitglied gibt es keinen zugeordneten persönlichen Zugang.", 404);
        return accounts;
    }
    async function list(memberId) {
        await permission();
        const accounts = await owners(memberId), ids = accounts.map(account => account.accountId);
        const [records, sessions] = await Promise.all([
            prisma.systemSetting.findMany({ where: { OR: ids.map(accountId => ({ key: { startsWith: `${PREFIX}${accountId}:` } })) }, orderBy: { updatedAt: "desc" } }),
            prisma.session.findMany({ where: { accountId: { in: ids }, endedAt: null }, orderBy: { startedAt: "desc" } }),
        ]);
        const ownSession = getVerifiedRequestSessionAssurance()?.sessionId;
        const devices = [];
        const known = new Set();
        for (const record of records) {
            const value = record.value;
            if (!value || !ids.includes(value.accountId) || !DEVICE_ID.test(value.deviceId || "") || record.key !== settingKey(value.accountId, value.deviceId))
                continue;
            const matching = sessions.filter((session) => session.accountId === value.accountId && session.terminalId === SESSION_PREFIX + value.deviceId);
            known.add(`${value.accountId}:${value.deviceId}`);
            devices.push({ id: value.deviceId, accountId: value.accountId, accountLabel: accounts.find(account => account.accountId === value.accountId)?.loginName || "", name: String(value.name || "Browser").slice(0, 100), kind: "BROWSER", status: value.blockedAt ? "BLOCKED" : matching.length ? "SIGNED_IN" : "SIGNED_OUT", firstSeenAt: value.firstSeenAt, lastLoginAt: value.lastLoginAt, sessionCount: matching.length, isCurrent: matching.some((session) => session.id === ownSession) });
        }
        for (const session of sessions) {
            const deviceId = String(session.terminalId || "").startsWith(SESSION_PREFIX) ? session.terminalId.slice(SESSION_PREFIX.length) : null;
            if (deviceId && known.has(`${session.accountId}:${deviceId}`))
                continue;
            devices.push({ id: "session:" + session.id, accountId: session.accountId, accountLabel: accounts.find(account => account.accountId === session.accountId)?.loginName || "", name: deviceName(String(session.userAgent || "")), kind: "LEGACY_SESSION", status: "SIGNED_IN", firstSeenAt: iso(session.startedAt), lastLoginAt: iso(session.startedAt), sessionCount: 1, isCurrent: session.id === ownSession });
        }
        return { contractVersion: MEMBER_DEVICES_CONTRACT_VERSION, memberId, devices };
    }
    async function change(memberId, deviceId, input) {
        const actor = await permission();
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["accountId", "action", "operationId"].includes(key)) || !["SIGN_OUT", "BLOCK", "UNBLOCK"].includes(input.action) || !OPERATION_ID.test(input.operationId || ""))
            fail("ACCOUNT_DEVICE_ACTION_INVALID", "Ungültiger Geräteauftrag.");
        const accounts = await owners(memberId), ids = accounts.map(account => account.accountId);
        if (!ids.includes(input.accountId))
            fail("ACCOUNT_DEVICE_NOT_FOUND", "Das Gerät gehört nicht zu diesem Mitglied.", 404);
        const legacy = /^session:[A-Za-z0-9][A-Za-z0-9_-]{7,179}$/.test(deviceId);
        if (!DEVICE_ID.test(deviceId) && !legacy)
            fail("ACCOUNT_DEVICE_ID_INVALID", "Ungültiges Gerät.");
        if (legacy && input.action !== "SIGN_OUT")
            fail("ACCOUNT_DEVICE_IDENTITY_UNAVAILABLE", "Diese ältere Sitzung kann abgemeldet werden. Eine Gerätesperre ist nach der nächsten Anmeldung zuordenbar.", 422);
        const signature = { moduleKey, actorAccountId: actor.accountId, memberId, accountId: input.accountId, deviceId, action: input.action };
        const key = ACTION_PREFIX + input.operationId;
        return prisma.$transaction(async (tx) => {
            const owner = await tx.account.findFirst({ where: { id: input.accountId, person: { member: { id: memberId } } }, select: { id: true } });
            if (!owner)
                fail("ACCOUNT_DEVICE_NOT_FOUND", "Der Zugang gehört nicht mehr zu diesem Mitglied.", 404);
            const previous = await tx.systemSetting.findUnique({ where: { key } });
            if (previous) {
                if (JSON.stringify(previous.value.signature) !== JSON.stringify(signature))
                    fail("ACCOUNT_DEVICE_OPERATION_CONFLICT", "Die Vorgangsnummer gehört zu einer anderen Geräteaktion.", 409);
                return previous.value.result;
            }
            const now = new Date();
            let ended = 0;
            if (legacy) {
                const session = await tx.session.findFirst({ where: { id: deviceId.slice(8), accountId: input.accountId } });
                if (!session)
                    fail("ACCOUNT_DEVICE_NOT_FOUND", "Das Gerät gehört nicht zu diesem Mitglied.", 404);
                ended = (await tx.session.updateMany({ where: { id: session.id, accountId: session.accountId, endedAt: null }, data: { endedAt: now } })).count;
            }
            else {
                const record = await tx.systemSetting.findUnique({ where: { key: settingKey(input.accountId, deviceId) } });
                if (!record)
                    fail("ACCOUNT_DEVICE_NOT_FOUND", "Das Gerät gehört nicht zu diesem Mitglied.", 404);
                const value = record.value;
                if (!ids.includes(value.accountId) || value.deviceId !== deviceId)
                    fail("ACCOUNT_DEVICE_NOT_FOUND", "Das Gerät gehört nicht zu diesem Mitglied.", 404);
                const next = { ...value, blockedAt: input.action === "BLOCK" ? value.blockedAt || now.toISOString() : input.action === "UNBLOCK" ? null : value.blockedAt, lastActionAt: now.toISOString(), lastAction: input.action, lastActorAccountId: actor.accountId };
                const claimed = await tx.systemSetting.updateMany({ where: { key: record.key, value: { equals: value } }, data: { value: next } });
                if (claimed.count !== 1)
                    fail("ACCOUNT_DEVICE_CHANGED", "Der Gerätestatus wurde gleichzeitig geändert. Bitte die Anzeige neu laden.", 409);
                if (input.action !== "UNBLOCK")
                    ended = (await tx.session.updateMany({ where: { accountId: value.accountId, terminalId: SESSION_PREFIX + deviceId, endedAt: null }, data: { endedAt: now } })).count;
            }
            const result = { operationId: input.operationId, memberId, deviceId, action: input.action, applied: true, endedSessions: ended };
            // Also serves as an immutable, actor-bound security action receipt.
            await tx.systemSetting.create({ data: { key, value: { signature, result, occurredAt: now.toISOString() } } });
            return result;
        }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 30000 });
    }
    return Object.freeze({ contractVersion: MEMBER_DEVICES_CONTRACT_VERSION, list, change });
}
