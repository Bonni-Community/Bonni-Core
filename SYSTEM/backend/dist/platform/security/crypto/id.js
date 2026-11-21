import { randomUUID } from "node:crypto";
import { createHexToken } from "./random.js";
const DEFAULT_ID_BYTES = 16;
const ID_PREFIX_PATTERN = /^[a-z][a-z0-9_]{1,15}$/;
export const ACCOUNT_ID_PREFIX = "acc";
export const MEMBER_ID_PREFIX = "mem";
export function createUuid() {
    return randomUUID();
}
export function createHexId(bytes = DEFAULT_ID_BYTES) {
    return createHexToken(bytes);
}
export function createPrefixedId(prefix, bytes = DEFAULT_ID_BYTES) {
    const normalizedPrefix = normalizeIdPrefix(prefix);
    return `${normalizedPrefix}_${createHexId(bytes)}`;
}
export function createAccountId() {
    return createPrefixedId(ACCOUNT_ID_PREFIX, 18);
}
export function createMemberId() {
    return createPrefixedId(MEMBER_ID_PREFIX, 18);
}
export function isAccountId(value) {
    return typeof value === "string" && value.startsWith(`${ACCOUNT_ID_PREFIX}_`);
}
export function isMemberId(value) {
    return typeof value === "string" && value.startsWith(`${MEMBER_ID_PREFIX}_`);
}
function normalizeIdPrefix(prefix) {
    const normalizedPrefix = prefix.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!ID_PREFIX_PATTERN.test(normalizedPrefix)) {
        throw new Error("ID prefix must start with a letter and contain only lowercase letters, digits or underscores.");
    }
    return normalizedPrefix;
}
