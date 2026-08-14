export type LoginErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_PASSWORD"
  | "ACCOUNT_DISABLED"
  | "SESSION_ALREADY_ACTIVE"
  | "DATABASE_UNAVAILABLE"
  | "AUTH_SERVICE_UNAVAILABLE"
  | "EMERGENCY_MODE_ACTIVE"
  | "MAINTENANCE_MODE_ACTIVE"
  | "SYSTEM_STARTING"
  | "PERSONAL_DATA_MASTER_KEY_LOCKED"
  | "LOGIN_PAYLOAD_INVALID"
  | "LOGIN_NAME_FORBIDDEN"
  | "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN"
  | "JWT_SECRET_MISSING_OR_WEAK"
  | "LOGIN_FAILED";

export class LoginError extends Error {
  code: LoginErrorCode;
  status: number;

  constructor(code: LoginErrorCode, message: string, status = 401) {
    super(message);
    this.name = "LoginError";
    this.code = code;
    this.status = status;
  }
}

export function isPrismaDatabaseError(error: any) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");

  return (
    code.startsWith("P10") ||
    code === "P1001" ||
    code === "P1002" ||
    code === "P1008" ||
    message.includes("Can't reach database server") ||
    message.includes("Connection") ||
    message.includes("ECONNREFUSED")
  );
}

export function normalizeLoginError(error: any) {
  if (error instanceof LoginError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }

  if (error?.code === "PERSONAL_DATA_MASTER_KEY_LOCKED" || error?.message === "PERSONAL_DATA_MASTER_KEY_LOCKED") {
    return {
      status: 423,
      code: "PERSONAL_DATA_MASTER_KEY_LOCKED",
      message: "Personendaten sind noch verschlüsselt. Bitte Boot-Stick im System laden.",
    };
  }

  if (error?.code === "PERSONAL_DATA_MASTER_KEY_LOCKED" || error?.message === "PERSONAL_DATA_MASTER_KEY_LOCKED") {
    return {
      status: Number(error?.statusCode || error?.status || 423),
      code: "PERSONAL_DATA_MASTER_KEY_LOCKED",
      message: "Personendaten sind noch verschlüsselt. Bitte Boot-Stick im System laden.",
    };
  }

  if (error?.code === "PERSONAL_DATA_MEMBER_LOGIN_LOCKED" || error?.message === "PERSONAL_DATA_MEMBER_LOGIN_LOCKED") {
    return {
      status: Number(error?.statusCode || error?.status || 423),
      code: "PERSONAL_DATA_MEMBER_LOGIN_LOCKED",
      message: "Member-Login ist im Entwickler-Boot ohne Master-Key gesperrt.",
    };
  }

  if (isPrismaDatabaseError(error)) {
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      message: "Datenbank nicht erreichbar",
    };
  }

  if (error?.code === "JWT_SECRET_MISSING_OR_WEAK" || error?.message === "JWT_SECRET_MISSING_OR_WEAK") {
    return {
      status: 500,
      code: "JWT_SECRET_MISSING_OR_WEAK",
      message:
        "JWT_SECRET fehlt oder ist unsicher. Bitte in System/backend/.env "
        + "einen zufälligen Wert mit mindestens 32 Zeichen setzen und das Backend neu starten.",
    };
  }

  const securityCode = String(error?.code || error?.message || "").trim().toUpperCase();
  if (securityCode.startsWith("TWO_FACTOR_")) {
    const messages: Record<string, string> = {
      TWO_FACTOR_INVALID_CODE: "Die Eingabe für die Zwei-Faktor-Authentifizierung (2FA) ist ungültig.",
      TWO_FACTOR_TEMPORARILY_LOCKED: "Die Zwei-Faktor-Authentifizierung (2FA) ist vorübergehend gesperrt.",
      TWO_FACTOR_CHALLENGE_EXPIRED: "Die Abfrage der Zwei-Faktor-Authentifizierung (2FA) ist abgelaufen. Bitte erneut anmelden.",
      TWO_FACTOR_CHALLENGE_NOT_PENDING: "Diese Abfrage der Zwei-Faktor-Authentifizierung (2FA) wurde bereits verwendet.",
      TWO_FACTOR_PROVIDER_CHANGED: "Der Zwei-Faktor-Provider wurde geändert. Bitte erneut anmelden.",
      TWO_FACTOR_PROVIDER_UNAVAILABLE: "Der externe Zwei-Faktor-Provider ist momentan nicht erreichbar.",
      TWO_FACTOR_PROVIDER_REJECTED_REQUEST: "Der externe Zwei-Faktor-Provider hat die Anfrage abgelehnt.",
      TWO_FACTOR_PROVIDER_FAILED: "Die Prüfung durch den externen Zwei-Faktor-Provider ist fehlgeschlagen.",
      TWO_FACTOR_LOGIN_PAYLOAD_INVALID: "Abfrage und Eingabe der Zwei-Faktor-Authentifizierung (2FA) sind erforderlich.",
    };
    return {
      status: Number(error?.statusCode || error?.status || 401),
      code: securityCode,
      message: messages[securityCode] || "Die Zwei-Faktor-Authentifizierung (2FA) ist fehlgeschlagen.",
    };
  }

  return {
    status: 500,
    code: "LOGIN_FAILED",
    message: "Anmeldung fehlgeschlagen",
  };
}
