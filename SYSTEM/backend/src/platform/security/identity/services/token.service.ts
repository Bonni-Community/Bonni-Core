import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "node:crypto";
import { env } from "../../../../core/config/env.js";

export type AccessTokenPayload = {
  accountId: string;
  loginName: string;
  type: string;
  credentialRevision: number;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: "15m"
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (
    !payload.accountId
    || !payload.loginName
    || !Number.isInteger(payload.credentialRevision)
    || payload.credentialRevision < 0
  ) throw new Error("INVALID_ACCESS_TOKEN_CREDENTIAL_REVISION");
  return payload;
}

export function createRefreshToken(): string {
  return randomBytes(48).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
