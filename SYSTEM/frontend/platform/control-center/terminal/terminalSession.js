import { hasSystemAdministratorAccess } from "../../../system/auth/accessPolicy.js";

export function savedTerminalToken() {
  try {
    return window.localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

export function readTerminalSession() {
  try {
    const user = JSON.parse(window.localStorage.getItem("user") || "null");
    const shell = JSON.parse(window.localStorage.getItem("shell") || "null");
    const accountType = String(user?.type || shell?.identity?.type || "").toUpperCase();
    if (["TERMINAL", "SERVICE"].includes(accountType) || !hasSystemAdministratorAccess(user, shell)) return null;
    return { token: savedTerminalToken(), actorAccountId: user?.accountId || user?.id || shell?.identity?.accountId };
  } catch {
    return null;
  }
}
