import jwt, { type SignOptions } from "jsonwebtoken";
import { requireRuntimeSecret } from "../../security/crypto/runtime-secret.js";

export type CoreTokenPayload = {
  accountId: string;
  loginName: string;
  source?: string;
};

export class CoreTokenService {
  issueToken(payload: CoreTokenPayload) {
    const secret = getJwtSecret();

    return jwt.sign(payload, secret, {
      expiresIn: (process.env.JWT_EXPIRES_IN || "8h") as SignOptions["expiresIn"],
    });
  }

  verifyToken(token: string): CoreTokenPayload {
    const secret = getJwtSecret();
    return jwt.verify(token, secret) as CoreTokenPayload;
  }
}

function getJwtSecret() {
  return requireRuntimeSecret({
    names: ["JWT_SECRET"],
    errorCode: "JWT_SECRET_MISSING_OR_WEAK",
  });
}

export const coreTokenService = new CoreTokenService();
