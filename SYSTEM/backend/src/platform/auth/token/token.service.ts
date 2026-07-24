import jwt from "jsonwebtoken";
import { authConfig } from "../../../core/config/auth.config.js";

export type AccessTokenPayload = {
  accountId: string;
  loginName: string;
  type?: string;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, authConfig.jwtSecret, {
    expiresIn: "15m"
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, authConfig.jwtSecret);

  if (!decoded || typeof decoded !== "object") {
    throw new Error("INVALID_TOKEN_PAYLOAD");
  }

  const payload = decoded as Partial<AccessTokenPayload>;

  if (!payload.accountId || !payload.loginName) {
    throw new Error("INVALID_TOKEN_PAYLOAD");
  }

  return {
    accountId: payload.accountId,
    loginName: payload.loginName,
    type: payload.type
  };
}
