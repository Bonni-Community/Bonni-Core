import { createHash } from "node:crypto";

import bcrypt from "bcryptjs";

export const LOCAL_PASSWORD_MAX_LENGTH = 512;
export const LOCAL_PASSWORD_HASH_VERSION = "bonni-pw-v1";

const PREHASH_DOMAIN = Buffer.from("bonni-local-password:v1\0", "utf8");
const VERSION_PREFIX = `${LOCAL_PASSWORD_HASH_VERSION}$`;

export type LocalPasswordValidation =
  | { ok: true; password: string; utf8Bytes: number; characters: number }
  | { ok: false; code: "LOCAL_PASSWORD_INVALID_TYPE" | "LOCAL_PASSWORD_EMPTY" | "LOCAL_PASSWORD_TOO_LONG" | "LOCAL_PASSWORD_CONTROL_CHARACTER" | "LOCAL_PASSWORD_INVALID_UNICODE" };

/**
 * Passwords are deliberately not trimmed, normalized or coerced. A password
 * is the exact UTF-8 byte sequence entered by the account owner.
 */
export function validateExactLocalPassword(value: unknown): LocalPasswordValidation {
  if (typeof value !== "string") return { ok: false, code: "LOCAL_PASSWORD_INVALID_TYPE" };
  if (value.length === 0) return { ok: false, code: "LOCAL_PASSWORD_EMPTY" };
  if (/[\r\n\0]/u.test(value)) return { ok: false, code: "LOCAL_PASSWORD_CONTROL_CHARACTER" };

  const characters = [...value].length;
  if (characters > LOCAL_PASSWORD_MAX_LENGTH) return { ok: false, code: "LOCAL_PASSWORD_TOO_LONG" };

  const bytes = Buffer.from(value, "utf8");
  // Node replaces lone UTF-16 surrogates while encoding. Rejecting those
  // prevents two distinct JavaScript strings from becoming the same password.
  if (bytes.toString("utf8") !== value) return { ok: false, code: "LOCAL_PASSWORD_INVALID_UNICODE" };

  return { ok: true, password: value, utf8Bytes: bytes.length, characters };
}

export function assertExactLocalPassword(value: unknown) {
  const result = validateExactLocalPassword(value);
  if (!result.ok) {
    throw Object.assign(new Error(result.code), { code: result.code, statusCode: 400 });
  }
  return result.password;
}

function prehash(password: string) {
  // SHA-384 base64url is exactly 64 ASCII bytes. Therefore bcrypt receives the
  // complete domain-separated digest and never truncates it at its 72-byte limit.
  return createHash("sha384")
    .update(PREHASH_DOMAIN)
    .update(Buffer.from(password, "utf8"))
    .digest("base64url");
}

export async function hashExactLocalPassword(value: unknown, rounds = 12) {
  const password = assertExactLocalPassword(value);
  const digest = prehash(password);
  if (Buffer.byteLength(digest, "ascii") !== 64) throw new Error("LOCAL_PASSWORD_PREHASH_LENGTH_INVALID");
  return `${VERSION_PREFIX}${await bcrypt.hash(digest, rounds)}`;
}

export async function verifyExactLocalPassword(value: unknown, storedHash: unknown) {
  const validation = validateExactLocalPassword(value);
  if (!validation.ok || typeof storedHash !== "string" || !storedHash) return false;

  if (storedHash.startsWith(VERSION_PREFIX)) {
    const bcryptHash = storedHash.slice(VERSION_PREFIX.length);
    if (!/^\$2[aby]\$/u.test(bcryptHash)) return false;
    return bcrypt.compare(prehash(validation.password), bcryptHash);
  }

  // Legacy bcrypt hashes cannot distinguish suffixes beyond 72 UTF-8 bytes.
  // Continue to support safely representable legacy passwords only.
  if (!/^\$2[aby]\$/u.test(storedHash) || validation.utf8Bytes > 72) return false;
  return bcrypt.compare(validation.password, storedHash);
}

export function isVersionedLocalPasswordHash(value: unknown) {
  return typeof value === "string" && value.startsWith(VERSION_PREFIX);
}
