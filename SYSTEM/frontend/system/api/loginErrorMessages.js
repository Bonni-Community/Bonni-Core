export const LOGIN_ERROR_MESSAGES = {
  ACCOUNT_NOT_FOUND: "Benutzer existiert nicht",
  INVALID_PASSWORD: "Passwort falsch",
  ACCOUNT_DISABLED: "Benutzer deaktiviert",
  SESSION_ALREADY_ACTIVE: "Benutzer ist bereits angemeldet",
  DATABASE_UNAVAILABLE: "Datenbank nicht erreichbar",
  AUTH_SERVICE_UNAVAILABLE: "Authentifizierungsdienst nicht verfügbar",
  BACKEND_UNAVAILABLE: "Backend nicht erreichbar",
  EMERGENCY_MODE_ACTIVE: "Notlauf aktiv – Anmeldung derzeit nicht möglich",
  MAINTENANCE_MODE_ACTIVE: "Wartungsmodus aktiv – Anmeldung derzeit nicht möglich",
  SYSTEM_STARTING: "System startet gerade – bitte kurz warten",
  LOGIN_PAYLOAD_INVALID: "Benutzername und Passwort erforderlich",
  LOGIN_FAILED: "Login fehlgeschlagen",
};

export function getLoginErrorMessage(error) {
  const code = error?.data?.code || error?.code;

  if (code && LOGIN_ERROR_MESSAGES[code]) {
    return LOGIN_ERROR_MESSAGES[code];
  }

  if (
    error?.name === "TypeError" ||
    error?.message?.includes?.("Failed to fetch") ||
    error?.message?.includes?.("NetworkError")
  ) {
    return LOGIN_ERROR_MESSAGES.BACKEND_UNAVAILABLE;
  }

  return error?.message || LOGIN_ERROR_MESSAGES.LOGIN_FAILED;
}
