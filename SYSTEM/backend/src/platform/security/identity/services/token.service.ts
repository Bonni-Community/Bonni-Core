import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "node:crypto";
import { env } from "../../../../core/config/env.js";
import { assertExpiringJwt, tokenIdentityText, verifyBoundedJwt } from "../../../auth/token/jwt-policy.js";

export type AccessTokenPayload = {
  accountId: string;
  loginName: string;
  type: string;
  credentialRevision: number;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "15m"
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = verifyBoundedJwt(token, env.JWT_SECRET);
  if (
    !tokenIdentityText(payload.accountId)
    || !tokenIdentityText(payload.loginName)
    || !Number.isInteger(payload.credentialRevision)
    || !Number.isSafeInteger(payload.credentialRevision)
    || payload.credentialRevision < 0
  ) throw new Error("INVALID_ACCESS_TOKEN_CREDENTIAL_REVISION");
  assertExpiringJwt(payload);
  return payload as AccessTokenPayload;
}

export function createRefreshToken(): string {
  return randomBytes(48).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
