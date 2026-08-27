import { verifyExactLocalPassword } from "../../../core/modules/identity/local-password-policy.js";

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return verifyExactLocalPassword(password, passwordHash);
}
