export const BOOTSTRAP_ADMIN_LOGIN_NAME = "admin" as const;

const FORBIDDEN_INTERACTIVE_LOGIN_NAMES = new Set([
  "root",
]);

export function normalizeSystemLoginName(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function isBootstrapAdminLoginName(value: unknown) {
  return normalizeSystemLoginName(value) === BOOTSTRAP_ADMIN_LOGIN_NAME;
}

export function isForbiddenInteractiveLoginName(value: unknown) {
  return FORBIDDEN_INTERACTIVE_LOGIN_NAMES.has(normalizeSystemLoginName(value));
}
