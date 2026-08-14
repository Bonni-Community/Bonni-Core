export const BOOTSTRAP_ADMIN_LOGIN_NAME = "admin";

const FORBIDDEN_LOGIN_NAMES = new Set([
  "root",
]);

export function normalizeSystemLoginName(value) {
  return String(value || "").trim().toLowerCase();
}

export function isBootstrapAdminLoginName(value) {
  return normalizeSystemLoginName(value) === BOOTSTRAP_ADMIN_LOGIN_NAME;
}

export function isForbiddenLoginName(value) {
  return FORBIDDEN_LOGIN_NAMES.has(normalizeSystemLoginName(value));
}
