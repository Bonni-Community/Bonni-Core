import jwt, { type JwtPayload } from "jsonwebtoken";

export function verifyBoundedJwt(token: string, secret: string): JwtPayload {
  if (typeof token !== "string" || token.length > 8192) throw new Error("INVALID_TOKEN_SIZE");
  const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("INVALID_TOKEN_PAYLOAD");
  return payload;
}

export function tokenIdentityText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 320 && !/[\x00-\x1f\x7f]/.test(value);
}

export function assertExpiringJwt(payload: JwtPayload): void {
  if (!Number.isSafeInteger(payload.exp) || Number(payload.exp) <= 0
    || payload.iat !== undefined && (!Number.isSafeInteger(payload.iat) || payload.iat < 0 || Number(payload.exp) <= payload.iat)) {
    throw new Error("INVALID_TOKEN_EXPIRATION");
  }
}
