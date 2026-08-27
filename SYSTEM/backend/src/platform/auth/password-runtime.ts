import {
  hashExactLocalPassword,
  verifyExactLocalPassword,
} from "../../core/modules/identity/local-password-policy.js";

export async function hashPasswordRuntime(password: string, rounds = 12) {
  return hashExactLocalPassword(password, rounds);
}

export async function verifyPasswordRuntime(password: string, passwordHash: string) {
  return verifyExactLocalPassword(password, passwordHash);
}
