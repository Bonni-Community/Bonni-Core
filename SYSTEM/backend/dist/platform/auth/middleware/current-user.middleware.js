import { createHash, timingSafeEqual } from "node:crypto";
import { coreTokenService } from "../token/core-token.service.js";
import { getServerPrismaClient } from "../../../core/database/database.js";
import { listModuleManifests } from "../../module-manager/manifests/index.js";
import { scopeTerminalAccount } from "../terminal-accounts/terminal-account-access.js";
import { isDatabaseAuthorizationFailure, isDatabaseConnectionFailure, } from "../../../core/database/database-routing.js";
import { runWithVerifiedRequestIdentity, } from "../request-identity/request-identity-context.js";
function unique(values) {
    return [...new Set(values.filter(Boolean))];
}
function appKeyFromAccessRole(roleKey) {
    const parts = String(roleKey || "").trim().toLowerCase().split(":");
    if (parts.length !== 4 || parts[0] !== "access" || parts[1] !== "app" || !parts[2] || !parts[3]) {
        return null;
    }
    const storedKey = parts[2];
    if (!/^app-[a-z0-9-]+$/.test(storedKey) || !/^[a-z0-9-]+$/.test(parts[3]))
        return null;
    return storedKey.startsWith("app-")
        ? `app.${storedKey.slice(4)}`
        : `app.${storedKey.replace(/-/g, "")}`;
}
function hashToken(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
}
function tokenMatchesSession(token, storedHash) {
    if (!storedHash || !/^[a-f0-9]{64}$/u.test(storedHash))
        return false;
    const actual = Buffer.from(hashToken(token), "hex");
    const expected = Buffer.from(storedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function sessionAssurance(account, session) {
    const verifiedAt = session.mfaVerifiedAt instanceof Date
        && Number.isFinite(session.mfaVerifiedAt.getTime())
        && String(session.mfaProviderId || "").trim()
        ? session.mfaVerifiedAt.toISOString()
        : null;
    return {
        sessionId: session.id,
        accountId: account.id,
        credentialRevision: session.credentialRevision,
        mfaVerifiedAt: verifiedAt,
        mfaProviderId: verifiedAt ? String(session.mfaProviderId).trim().toLowerCase() : null,
        mfaMethod: verifiedAt ? String(session.mfaMethod || "").trim().toUpperCase() || null : null,
    };
}
function requestIdentity(account) {
    const roles = unique(account.roles.map((entry) => entry.role.key));
    const permissions = unique(account.roles.flatMap((entry) => (entry.role.permissions.map((rolePermission) => rolePermission.permission.key))));
    const allowedApps = unique(roles.map(appKeyFromAccessRole).filter((value) => Boolean(value)));
    return {
        accountId: account.id,
        loginName: account.loginName,
        type: account.type,
        roles,
        permissions,
        allowedApps,
        personId: account.personId || null,
        memberId: account.person?.member?.id || null,
        credentialRevision: account.credentialRevision,
    };
}
export function createCurrentUserMiddleware(dependencies) {
    return async function resolveCurrentUser(req, res, next) {
        const header = req.headers?.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        let identity = null;
        let assurance = null;
        let tokenSource = "LOCAL";
        delete req.user;
        delete req.bonniSessionId;
        req.bonniIdentityVerified = false;
        if (token) {
            let payload;
            try {
                payload = dependencies.verifyToken(token);
            }
            catch (error) {
                // Nur ein tatsächlich ungültiger Token wird wie eine anonyme Anfrage
                // behandelt. Ein Datenbankfehler nach erfolgreicher Tokenprüfung darf
                // die Sitzung nicht als vermeintlich ungültig löschen.
                dependencies.warn("Current user could not be resolved", error);
                return runWithVerifiedRequestIdentity(null, next);
            }
            tokenSource = payload.source || "LOCAL";
            try {
                const [account, session] = await Promise.all([
                    dependencies.findAccount(payload.accountId),
                    dependencies.findSession(payload.sessionId, payload.accountId),
                ]);
                if (account && account.type === "SERVICE") {
                    identity = null;
                }
                else if (account?.isActive
                    && !account.passwordRecoveryLockedAt
                    && account.credentialRevision === payload.credentialRevision
                    && session
                    && session.id === payload.sessionId
                    && session.accountId === account.id
                    && session.credentialRevision === account.credentialRevision
                    && !session.endedAt
                    && tokenMatchesSession(token, session.tokenHash)) {
                    const scopedAccount = account.type === "TERMINAL"
                        ? scopeTerminalAccount(account, await (dependencies.listManifests || listModuleManifests)())
                        : account;
                    if (account.type !== "TERMINAL" || scopedAccount.roles.length) {
                        identity = requestIdentity(scopedAccount);
                        assurance = sessionAssurance(scopedAccount, session);
                    }
                }
            }
            catch (error) {
                dependencies.warn("Current user database lookup failed", error);
                if (isDatabaseAuthorizationFailure(error)) {
                    return res.status(500).json({
                        code: "DATABASE_SCHEMA_PERMISSION_DENIED",
                        message: "Die Datenbank ist erreichbar, aber dem Backend fehlen Rechte auf das Core-Schema.",
                    });
                }
                return res.status(isDatabaseConnectionFailure(error) ? 503 : 500).json({
                    code: "AUTH_SERVICE_UNAVAILABLE",
                    message: "Die Anmeldung wurde erkannt, konnte aber momentan nicht gegen die Datenbank geprüft werden.",
                });
            }
        }
        if (identity) {
            req.user = {
                ...identity,
                id: identity.accountId,
                source: tokenSource,
                status: "ACTIVE",
            };
            req.bonniSessionId = assurance?.sessionId;
            req.bonniIdentityVerified = true;
        }
        return runWithVerifiedRequestIdentity(identity, next, assurance);
    };
}
export const currentUserMiddleware = createCurrentUserMiddleware({
    verifyToken: (token) => coreTokenService.verifyToken(token),
    findAccount: (accountId) => getServerPrismaClient("core").account.findUnique({
        where: { id: accountId },
        select: {
            id: true,
            loginName: true,
            type: true,
            isActive: true,
            credentialRevision: true,
            passwordRecoveryLockedAt: true,
            personId: true,
            person: {
                select: {
                    member: {
                        select: { id: true },
                    },
                },
            },
            roles: {
                select: {
                    role: {
                        select: {
                            key: true,
                            permissions: {
                                select: {
                                    permission: {
                                        select: { key: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }),
    findSession: (sessionId, accountId) => getServerPrismaClient("core").session.findFirst({
        where: {
            id: sessionId,
            accountId,
        },
        select: {
            id: true,
            accountId: true,
            tokenHash: true,
            credentialRevision: true,
            mfaVerifiedAt: true,
            mfaProviderId: true,
            mfaMethod: true,
            endedAt: true,
        },
    }),
    warn: (message, error) => console.warn(message, error),
});
