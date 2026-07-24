import { apiRequest } from "./apiClient.js";
import { buildApiUrls } from "./apiConfig.js";

const SHELL_STATUS_PATH = "/api/terminals/shell/status";
const SHELL_SOCKET_PATH = "/api/terminals/shell/pty";

function toWebSocketUrl(httpUrl, token, dimensions = {}) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  if (token) {
    url.searchParams.set("token", token);
  }

  if (dimensions.cols) {
    url.searchParams.set("cols", String(dimensions.cols));
  }

  if (dimensions.rows) {
    url.searchParams.set("rows", String(dimensions.rows));
  }

  return url.toString();
}

export function fetchTerminalShellStatus(token) {
  return apiRequest(SHELL_STATUS_PATH, { token });
}

export function buildTerminalShellSocketUrls(token, dimensions = {}) {
  return buildApiUrls(SHELL_SOCKET_PATH).map((url) => toWebSocketUrl(url, token, dimensions));
}
