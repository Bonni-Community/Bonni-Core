import jwt from "jsonwebtoken";
import { authConfig } from "../../../core/config/auth.config.js";
import { assertExpiringJwt, tokenIdentityText, verifyBoundedJwt } from "./jwt-policy.js";

export type AccessTokenPayload = {
  accountId: string;
  loginName: string;
  type?: string;
  credentialRevision: number;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, authConfig.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "15m"
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = verifyBoundedJwt(token, authConfig.jwtSecret);

  if (!decoded || typeof decoded !== "object") {
    throw new Error("INVALID_TOKEN_PAYLOAD");
  }

  const payload = decoded as Partial<AccessTokenPayload>;

  if (!tokenIdentityText(payload.accountId) || !tokenIdentityText(payload.loginName) || !Number.isInteger(payload.credentialRevision) || !Number.isSafeInteger(payload.credentialRevision) || Number(payload.credentialRevision) < 0) {
    throw new Error("INVALID_TOKEN_PAYLOAD");
  }
  assertExpiringJwt(decoded);

  return {
    accountId: payload.accountId,
    loginName: payload.loginName,
    type: payload.type,
    credentialRevision: Number(payload.credentialRevision),
  };
}
