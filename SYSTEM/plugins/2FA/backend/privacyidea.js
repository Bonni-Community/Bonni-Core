const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CHALLENGE_EXPIRES_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 8;

export const PRIVACYIDEA_DEFAULT_CONFIGURATION = Object.freeze({
  enabled: false,
  baseUrl: "",
  realm: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  challengeExpiresSeconds: DEFAULT_CHALLENGE_EXPIRES_SECONDS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  credentialOrder: "TOKEN_PASSWORD",
  passwordSource: "BONNI_PASSWORD",
});

function pluginError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), min), max) : fallback;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function normalizePrivacyIdeaBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw pluginError("PRIVACYIDEA_BASE_URL_INVALID");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw pluginError("PRIVACYIDEA_BASE_URL_INVALID");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw pluginError("PRIVACYIDEA_HTTPS_REQUIRED");
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizePrivacyIdeaConfiguration(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const realm = String(input.realm || "").trim();
  if (realm.length > 255) throw pluginError("PRIVACYIDEA_REALM_INVALID");
  const credentialOrder = input.credentialOrder === "PASSWORD_TOKEN"
    ? "PASSWORD_TOKEN"
    : "TOKEN_PASSWORD";
  const passwordSource = input.passwordSource === "SEPARATE_PASSWORD"
    ? "SEPARATE_PASSWORD"
    : "BONNI_PASSWORD";
  const result = {
    enabled: input.enabled === true,
    baseUrl: normalizePrivacyIdeaBaseUrl(input.baseUrl),
    realm,
    timeoutMs: numberInRange(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 30_000),
    challengeExpiresSeconds: numberInRange(
      input.challengeExpiresSeconds,
      DEFAULT_CHALLENGE_EXPIRES_SECONDS,
      30,
      600,
    ),
    maxAttempts: numberInRange(input.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 20),
    credentialOrder,
    passwordSource,
  };
  if (result.enabled && !result.baseUrl) throw pluginError("PRIVACYIDEA_BASE_URL_REQUIRED");
  return Object.freeze(result);
}

export function composePrivacyIdeaPass(configuration, proof = {}) {
  const config = normalizePrivacyIdeaConfiguration(configuration);
  const token = String(proof.token || proof.code || "").trim();
  const password = String(proof.password || "");
  if (!token || !password || token.length > 128 || password.length > 256 || /[\r\n]/.test(token + password)) {
    return "";
  }
  return config.credentialOrder === "PASSWORD_TOKEN"
    ? `${password}${token}`
    : `${token}${password}`;
}

export function privacyIdeaProofFields(configuration) {
  const config = normalizePrivacyIdeaConfiguration(configuration);
  return [
    {
      name: "token",
      label: "Token",
      type: "password",
      autocomplete: "one-time-code",
      help: "Aktueller Einmalcode des zugeordneten Tokens.",
    },
    {
      name: "password",
      label: config.passwordSource === "SEPARATE_PASSWORD"
        ? "Separates privacyIDEA-Passwort"
        : "Bonni-Passwort",
      type: "password",
      autocomplete: config.passwordSource === "SEPARATE_PASSWORD" ? "off" : "current-password",
      help: config.passwordSource === "SEPARATE_PASSWORD"
        ? "Dieses Passwort wird nur für die laufende Prüfung verwendet und nicht in Bonni gespeichert."
        : "Das Passwort muss zur Prüfung erneut eingegeben werden und wird nicht gespeichert.",
    },
  ];
}

export async function verifyPrivacyIdea(configuration, input, fetchImpl = fetch) {
  const config = normalizePrivacyIdeaConfiguration(configuration);
  if (!config.enabled || !config.baseUrl) throw pluginError("PRIVACYIDEA_NOT_CONFIGURED", 409);
  const user = String(input?.loginName || "").trim();
  const pass = composePrivacyIdeaPass(config, input?.proof);
  if (!user || !pass) return { ok: false };

  const body = new URLSearchParams({ user, pass });
  if (config.realm) body.set("realm", config.realm);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/validate/check`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw pluginError("PRIVACYIDEA_UNAVAILABLE", 503);
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object" || typeof payload.result !== "object") {
      throw pluginError("PRIVACYIDEA_RESPONSE_INVALID", 502);
    }
    return { ok: payload.result.status === true && payload.result.value === true };
  } catch (error) {
    if (error?.name === "AbortError") throw pluginError("PRIVACYIDEA_TIMEOUT", 503);
    if (error?.code) throw error;
    throw pluginError("PRIVACYIDEA_UNAVAILABLE", 503);
  } finally {
    clearTimeout(timeout);
  }
}
