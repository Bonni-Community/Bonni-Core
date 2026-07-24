import bcrypt from "bcryptjs";

export async function hashPasswordRuntime(password: string, rounds = 12) {
  return bcrypt.hash(password, rounds);
}

export async function verifyPasswordRuntime(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}
