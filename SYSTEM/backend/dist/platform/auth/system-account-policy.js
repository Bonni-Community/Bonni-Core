export const BOOTSTRAP_ADMIN_LOGIN_NAME = "admin";
const FORBIDDEN_INTERACTIVE_LOGIN_NAMES = new Set([
    "root",
]);
export function normalizeSystemLoginName(value) {
    return String(value || "").trim().toLowerCase();
}
export function isBootstrapAdminLoginName(value) {
    return normalizeSystemLoginName(value) === BOOTSTRAP_ADMIN_LOGIN_NAME;
}
export function isForbiddenInteractiveLoginName(value) {
    return FORBIDDEN_INTERACTIVE_LOGIN_NAMES.has(normalizeSystemLoginName(value));
}
