import { hashExactLocalPassword, verifyExactLocalPassword, } from "../../../core/modules/identity/local-password-policy.js";
export async function hashPassword(password) {
    return hashExactLocalPassword(password, 12);
}
export async function verifyPassword(password, passwordHash) {
    return verifyExactLocalPassword(password, passwordHash);
}
