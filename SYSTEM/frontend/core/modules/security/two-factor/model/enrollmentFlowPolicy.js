const RETAIN_SETUP_ERROR_CODES = new Set([
  "TWO_FACTOR_PAYLOAD_INVALID",
  "TWO_FACTOR_INVALID_CODE",
  "TWO_FACTOR_TEMPORARILY_LOCKED",
]);

export function isCompleteTotpCode(value) {
  return typeof value === "string" && /^\d{6}(?:\d{2})?$/.test(value);
}

export function retainTotpSetupAfterError(error) {
  return RETAIN_SETUP_ERROR_CODES.has(error?.code);
}
