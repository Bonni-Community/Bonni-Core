import {
  hashExactLocalPassword,
  verifyExactLocalPassword,
} from "../../../core/modules/identity/local-password-policy.js";

export async function hashPassword(password: string) {
  return hashExactLocalPassword(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return verifyExactLocalPassword(password, passwordHash);
}
