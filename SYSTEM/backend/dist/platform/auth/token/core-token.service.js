import jwt from "jsonwebtoken";
import { requireRuntimeSecret } from "../../security/crypto/runtime-secret.js";
import { assertExpiringJwt, tokenIdentityText, verifyBoundedJwt } from "./jwt-policy.js";
export class CoreTokenService {
    issueToken(payload) {
        const secret = getJwtSecret();
        return jwt.sign(payload, secret, {
            algorithm: "HS256",
            expiresIn: (process.env.JWT_EXPIRES_IN || "8h"),
        });
    }
    verifyToken(token) {
        const secret = getJwtSecret();
        const payload = verifyBoundedJwt(token, secret);
        if (!tokenIdentityText(payload.accountId)
            || !tokenIdentityText(payload.loginName)
            || typeof payload.sessionId !== "string"
            || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,179}$/u.test(payload.sessionId)
            || !Number.isInteger(payload.credentialRevision)
            || !Number.isSafeInteger(payload.credentialRevision)
            || Number(payload.credentialRevision) < 0)
            throw new Error("INVALID_TOKEN_SESSION_OR_CREDENTIAL_REVISION");
        assertExpiringJwt(payload);
        return payload;
    }
}
function getJwtSecret() {
    return requireRuntimeSecret({
        names: ["JWT_SECRET"],
        errorCode: "JWT_SECRET_MISSING_OR_WEAK",
    });
}
export const coreTokenService = new CoreTokenService();
