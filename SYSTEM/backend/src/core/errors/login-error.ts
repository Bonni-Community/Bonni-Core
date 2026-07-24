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
  | "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN"
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

  return {
    status: 500,
    code: "LOGIN_FAILED",
    message: "Anmeldung fehlgeschlagen",
  };
}
