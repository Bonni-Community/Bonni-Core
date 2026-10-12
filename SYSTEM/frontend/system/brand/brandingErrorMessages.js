const BRANDING_ERROR_MESSAGES = Object.freeze({
  BRANDING_DISPLAY_NAME_INVALID: "Bitte einen sichtbaren Namen mit höchstens 120 Zeichen eingeben.",
  BRANDING_LOGO_ALT_TEXT_INVALID: "Bitte einen Alternativtext mit höchstens 180 Zeichen eingeben.",
  BRANDING_EXPECTED_REVISION_INVALID: "Der Bearbeitungsstand ist ungültig. Bitte die zentrale Darstellung neu laden.",
  BRANDING_REVISION_INVALID: "Der gespeicherte Bearbeitungsstand ist ungültig. Bitte die zentrale Darstellung neu laden.",
  BRANDING_REVISION_CONFLICT: "Die Darstellung wurde zwischenzeitlich in einer anderen Sitzung geändert.",
  BRANDING_PNG_CONTENT_TYPE_REQUIRED: "Bitte eine PNG-Datei auswählen; andere Dateitypen werden nicht angenommen.",
  BRANDING_PNG_BODY_REQUIRED: "Die ausgewählte PNG-Datei enthält keine lesbaren Bilddaten.",
  BRANDING_PNG_TOO_LARGE: "Das Logo ist zu groß. Die PNG-Datei darf höchstens 2 MB groß sein.",
  BRANDING_PNG_SIGNATURE_INVALID: "Die ausgewählte Datei ist keine gültige PNG-Datei.",
  BRANDING_ANIMATED_PNG_NOT_ALLOWED: "Animierte PNG-Dateien sind nicht erlaubt. Bitte ein einzelnes, unbewegtes Logo verwenden.",
});

const DAMAGED_PNG_CODES = new Set([
  "BRANDING_PNG_CHUNK_TYPE_INVALID",
  "BRANDING_PNG_CRC_INVALID",
  "BRANDING_PNG_CRITICAL_CHUNK_INVALID",
  "BRANDING_PNG_DATA_INVALID",
  "BRANDING_PNG_END_INVALID",
  "BRANDING_PNG_FILTER_INVALID",
  "BRANDING_PNG_HEADER_INVALID",
  "BRANDING_PNG_INCOMPLETE",
  "BRANDING_PNG_PALETTE_INVALID",
  "BRANDING_PNG_TRAILING_DATA",
  "BRANDING_PNG_TRANSPARENCY_INVALID",
  "BRANDING_PNG_TRUNCATED",
]);

function brandingErrorCode(error) {
  return String(
    error?.code
    || error?.data?.code
    || error?.data?.error?.code
    || error?.data?.error
    || "",
  ).trim().toUpperCase();
}

export function isBrandingRevisionConflict(error) {
  return Number(error?.status) === 409 || brandingErrorCode(error) === "BRANDING_REVISION_CONFLICT";
}

export function classifyBrandingMutationFailure(error, { requestStarted = false } = {}) {
  if (isBrandingRevisionConflict(error)) return "conflict";
  if (!requestStarted) return "definite";

  const status = Number(error?.status);
  const code = brandingErrorCode(error);
  if (
    error?.name === "AbortError"
    || !Number.isFinite(status)
    || status === 0
    || status >= 500
    || code === "BACKEND_UNAVAILABLE"
    || code === "INTERNAL_SERVER_ERROR"
    || code.includes("POSTCOMMIT")
    || code.includes("PERSISTENCE_FAILED")
  ) return "uncertain";

  return "definite";
}

export function brandingErrorMessage(error, fallback) {
  const code = brandingErrorCode(error);
  if (BRANDING_ERROR_MESSAGES[code]) return BRANDING_ERROR_MESSAGES[code];
  if (DAMAGED_PNG_CODES.has(code) || code.startsWith("BRANDING_PNG_")) {
    return "Die PNG-Datei ist beschädigt oder verwendet ein nicht unterstütztes PNG-Format. Sie darf höchstens 2048 × 2048 Pixel groß sein.";
  }
  if (Number(error?.status) === 413) return BRANDING_ERROR_MESSAGES.BRANDING_PNG_TOO_LARGE;
  if (Number(error?.status) === 415) return BRANDING_ERROR_MESSAGES.BRANDING_PNG_CONTENT_TYPE_REQUIRED;
  if (Number(error?.status) === 403) return "Für diese Änderung sind Administratorrechte erforderlich.";
  if (Number(error?.status) === 0 || code === "BACKEND_UNAVAILABLE") {
    return "Bonni Core ist nicht erreichbar. Die Darstellung wurde nicht geändert.";
  }

  const message = String(error?.message || "").trim();
  if (message && !/^[A-Z][A-Z0-9_:-]*$/u.test(message)) return message;
  return fallback;
}
