import { hashExactLocalPassword, verifyExactLocalPassword, } from "../../core/modules/identity/local-password-policy.js";
export async function hashPasswordRuntime(password, rounds = 12) {
    return hashExactLocalPassword(password, rounds);
}
export async function verifyPasswordRuntime(password, passwordHash) {
    return verifyExactLocalPassword(password, passwordHash);
}
