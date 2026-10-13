import { apiRequest } from "./apiClient.js";
export { createJitsiAdminChallenge as createWebBridgeAdminChallenge,
  verifyJitsiAdminChallenge as verifyWebBridgeAdminChallenge } from "./jitsiSettingsApi.js";

const MESSAGES = {
  WEB_BRIDGE_CONFIGURATION_INCOMPLETE: "Bitte Website-Adresse, Site-ID und Verbindungsschlüssel speichern.",
  WEB_BRIDGE_HTTPS_REQUIRED: "Die Website-Adresse muss mit https:// beginnen.",
  WEB_BRIDGE_URL_INVALID: "Die Website-Adresse ist ungültig.",
  WEB_BRIDGE_INPUT_INVALID: "Bitte Eingaben prüfen. Der Verbindungsschlüssel besteht aus 64 Hex-Zeichen.",
  WEB_BRIDGE_STORAGE_SECRET_REQUIRED: "Der sichere Schlüsselspeicher im Core ist noch nicht eingerichtet.",
  WEB_BRIDGE_CONNECTION_FAILED: "Die Website ist derzeit nicht erreichbar. Die Bestellungen bleiben gespeichert.",
  WEB_BRIDGE_REQUEST_TIMEOUT: "Die Website antwortet zu langsam. Bitte später erneut synchronisieren.",
  WEB_BRIDGE_STOPPING: "Bonni Core wird beendet. Die Übertragung kann nach dem Neustart wiederholt werden.",
  WEB_BRIDGE_RESPONSE_SIGNATURE_INVALID: "Die Antwort konnte nicht geprüft werden. Bitte Schlüssel, Site-ID und CMS-Erweiterung prüfen.",
  WEB_BRIDGE_REMOTE_IDENTITY_MISMATCH: "Die Website meldet eine andere Site-ID oder ein anderes CMS.",
  WEB_BRIDGE_REDIRECT_REJECTED: "Die Adresse leitet weiter. Bitte die endgültige HTTPS-Adresse speichern.",
  WEB_BRIDGE_JSON_REQUIRED: "Die CMS-Erweiterung antwortet nicht. Bitte Installation und Website-Adresse prüfen.",
  WEB_BRIDGE_BUSY: "Eine Prüfung, Änderung oder Übertragung läuft bereits. Bitte kurz warten.",
  WEB_BRIDGE_DISABLED: "Bitte die Kopplung zuerst aktivieren und speichern.",
  WEB_BRIDGE_ACTIVE_CORE_REQUIRED: "Diese Übertragung ist nur im aktiven Core verfügbar.",
  WEB_BRIDGE_EVENT_ID_CONFLICT: "Eine Bestell-ID enthält abweichende Daten. Bitte den Shopadapter prüfen.",
};
async function request(token, provider, suffix = "", method = "GET", body) {
  try {
    return await apiRequest(`/api/system/integrations/web/${provider}${suffix}`, {
      token, method, ...(body === undefined ? {} : { body }), allowFailover: false,
      cache: "no-store", sensitive: true, headers: { Accept: "application/json", "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  } catch (error) {
    const message = error?.message || "";
    const code = Object.keys(MESSAGES).find((code) => message.includes(code));
    if (code) throw new Error(MESSAGES[code]);
    if (message.includes("WEB_BRIDGE_REMOTE_HTTP_")) throw new Error("Die CMS-Erweiterung hat den Auftrag abgelehnt. Bitte ihre Einstellungen prüfen.");
    throw error;
  }
}
export const getWebBridgeSettings = (token, provider) => request(token, provider);
export const getWebBridgeInbox = (token, provider) => request(token, provider, "/inbox");
export const testWebBridgeSettings = (token, provider) => request(token, provider, "/test", "POST", {});
export const saveWebBridgeSettings = (token, provider, payload) => request(token, provider, "", "PUT", payload);
export const syncWebBridge = (token, provider) => request(token, provider, "/sync", "POST", {});
export const publishWebBridge = (token, provider, payload) => request(token, provider, "/publication", "PUT", payload);
