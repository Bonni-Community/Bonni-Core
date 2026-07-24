import jwt, { type SignOptions } from "jsonwebtoken";

const FALLBACK_SECRET = "dev-secret-change-me";

export type CoreTokenPayload = {
  accountId: string;
  loginName: string;
  source?: string;
};

export class CoreTokenService {
  issueToken(payload: CoreTokenPayload) {
    const secret = process.env.JWT_SECRET || FALLBACK_SECRET;

    return jwt.sign(payload, secret, {
      expiresIn: (process.env.JWT_EXPIRES_IN || "8h") as SignOptions["expiresIn"],
    });
  }

  verifyToken(token: string): CoreTokenPayload {
    const secret = process.env.JWT_SECRET || FALLBACK_SECRET;
    return jwt.verify(token, secret) as CoreTokenPayload;
  }
}

export const coreTokenService = new CoreTokenService();
