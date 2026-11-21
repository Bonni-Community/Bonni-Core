import { parseAccessToken } from "../services/auth.service.js";
import { getServerPrismaClient } from "../../../../core/database/database.js";
import { permissionsService } from "../../../permissions/permissions.service.js";
import { assertPersonalDataLoginAllowed, getPersonalDataMasterKeyStatus } from "../../crypto/index.js";
import { isDatabaseAuthorizationFailure, } from "../../../../core/database/database-routing.js";
import { getVerifiedRequestIdentity, getVerifiedRequestSessionAssurance, } from "../../../auth/request-identity/request-identity-context.js";
const prisma = getServerPrismaClient("core");
export async function requireAuth(req, res, next) {
    const authHeader = req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    const token = authHeader.slice("Bearer ".length);
    let payload;
    try {
        payload = parseAccessToken(token);
    }
    catch (error) {
        console.warn("Access token rejected", error);
        return res.status(401).json({ error: "INVALID_TOKEN" });
    }
    const verifiedIdentity = getVerifiedRequestIdentity();
    const verifiedSession = getVerifiedRequestSessionAssurance();
    if (!verifiedIdentity
        || !verifiedSession
        || verifiedIdentity.accountId !== payload.accountId
        || verifiedSession.accountId !== payload.accountId
        || verifiedSession.credentialRevision !== payload.credentialRevision) {
        return res.status(401).json({ error: "INVALID_OR_ENDED_SESSION" });
    }
    try {
        const account = await prisma.account.findUnique({
            where: { id: payload.accountId },
            select: {
                id: true,
                loginName: true,
                email: true,
                type: true,
                isActive: true,
                credentialRevision: true,
                passwordRecoveryLockedAt: true,
                roles: {
                    include: {
                        role: true,
                    },
                },
                person: {
                    include: {
                        member: true,
                    },
                },
            },
        });
        if (!account?.isActive
            || account.passwordRecoveryLockedAt
            || account.credentialRevision !== payload.credentialRevision) {
            return res.status(401).json({ error: "ACCOUNT_DISABLED" });
        }
        if (account.type === "SERVICE") {
            return res.status(403).json({ error: "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN" });
        }
        const roles = account.roles.map((entry) => entry.role.key);
        try {
            assertPersonalDataLoginAllowed({
                accountId: account.id,
                loginName: account.loginName,
                memberId: account.person?.member?.id,
                roles,
            });
        }
        catch (error) {
            return res.status(Number(error?.statusCode || error?.status || 423)).json({
                error: error?.code || error?.message || "PERSONAL_DATA_MASTER_KEY_LOCKED",
                message: error?.code === "PERSONAL_DATA_MEMBER_LOGIN_LOCKED"
                    ? "Member-Login ist ohne geladenen Master-Key gesperrt."
                    : "Personendaten sind noch verschlüsselt. Admins können sich weiter anmelden; Member-Logins bleiben gesperrt.",
                personalDataMasterKey: getPersonalDataMasterKeyStatus(),
            });
        }
        const resolvedPermissions = await permissionsService.resolveForIdentity({
            accountId: account.id,
            loginName: account.loginName,
            type: account.type,
            roles,
        });
        const user = {
            id: account.id,
            accountId: account.id,
            loginName: account.loginName,
            email: account.email,
            type: account.type,
            roles: resolvedPermissions.roles,
            permissions: resolvedPermissions.permissions,
            memberCapabilities: resolvedPermissions.memberCapabilities,
            allowedWorkspaces: resolvedPermissions.allowedWorkspaces,
            defaultWorkspace: resolvedPermissions.defaultWorkspace,
        };
        const auth = {
            ...payload,
            roles: resolvedPermissions.roles,
            permissions: resolvedPermissions.permissions,
            memberCapabilities: resolvedPermissions.memberCapabilities,
        };
        req.auth = auth;
        req.user = user;
        req.account = user;
        next();
    }
    catch (error) {
        // Never authenticate an interactive account from a cached revision. The
        // database is authoritative for password/2FA rotation and revocation.
        console.error("Authentication service unavailable", error);
        if (isDatabaseAuthorizationFailure(error)) {
            return res.status(500).json({
                error: "DATABASE_SCHEMA_PERMISSION_DENIED",
                code: "DATABASE_SCHEMA_PERMISSION_DENIED",
                message: "Die Datenbank ist erreichbar, aber dem Backend fehlen Rechte auf das zugewiesene Schema. Bitte das Backend-Setup erneut ausführen und anschließend neu starten.",
            });
        }
        return res.status(503).json({
            error: "AUTH_SERVICE_UNAVAILABLE",
            code: "AUTH_SERVICE_UNAVAILABLE",
            message: "Die Anmeldung kann momentan nicht geprüft werden, weil die Datenbank nicht erreichbar ist.",
        });
    }
}
