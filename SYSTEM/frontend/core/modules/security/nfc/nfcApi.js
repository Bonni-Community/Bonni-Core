import { apiRequest } from "../../../../system/api/apiClient.js";

const options = { allowFailover: false, sensitive: true, cache: "no-store" };
const path = memberId => `/api/system/user/members/${encodeURIComponent(memberId)}/nfc`;
export const listNfcTags = (token, memberId, signal) => apiRequest(path(memberId), { ...options, token, signal });
export const registerNfcTag = (token, memberId, body) => apiRequest(path(memberId), { ...options, token, method: "POST", body });
export const revokeNfcTag = (token, memberId, tagId) => apiRequest(`${path(memberId)}/${encodeURIComponent(tagId)}/revoke`, { ...options, token, method: "POST", body: {} });

export function nfcErrorMessage(error) {
  const messages = {
    NFC_ALREADY_ASSIGNED: "Dieser Tag ist bereits vergeben oder wurde dauerhaft gesperrt. Bitte einen anderen Tag verwenden.",
    NFC_ACCOUNT_INVALID: "Der gewählte Zugang ist nicht aktiv oder gehört nicht zu diesem Mitglied.",
    NFC_CODE_INVALID: "NFC: hexadezimale Chipnummer (4 bis 10 Bytes). Barcode: 3 bis 80 Buchstaben/Ziffern oder . _ : - .",
    NFC_MEMBER_UNAVAILABLE: "Für dieses Mitglied kann kein Tag angelegt werden.",
    NFC_TAG_LIMIT: "Für dieses Mitglied sind bereits 20 aktive Tags hinterlegt.",
    NFC_SERVICE_UNAVAILABLE: "NFC ist momentan nicht verfügbar. Bitte Core-Update und Datenbankverbindung prüfen.",
    NFC_READER_UNAVAILABLE: "Auf diesem Gerät ist kein kompatibler NFC-Leser verfügbar. Bitte Barcode, Codeeingabe oder einen externen Leser verwenden.",
    NFC_READER_CANCELLED: "Das NFC-Einlesen wurde abgebrochen.",
    NFC_READER_NO_CODE: "Der NFC-Leser hat keine verwertbare Tag-Nummer geliefert.",
    NFC_READER_FAILED: "Der NFC-Tag konnte nicht gelesen werden. Bitte erneut versuchen.",
    FORBIDDEN: "Für die NFC-Verwaltung fehlen die Benutzerverwaltungsrechte.",
  };
  return messages[error?.code || error?.data?.code || error?.data?.error] || "NFC-Aktion fehlgeschlagen. Bitte erneut versuchen.";
}
