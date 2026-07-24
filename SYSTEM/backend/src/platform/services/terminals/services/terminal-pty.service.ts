import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { prisma } from "../../../../core/database/database.js";
import { parseAccessToken } from "../../../security/identity/services/auth.service.js";
import { logger } from "../../../../core/logger/logger.js";

export const TERMINAL_SHELL_WS_PATH = "/api/terminals/shell/pty";

type TerminalSocketSurface = "platform" | "local";

type AuthenticatedShellUser = {
  accountId: string;
  loginName: string;
};

type AttachOptions = {
  surface: TerminalSocketSurface;
};

type ShellCommand = {
  command: string;
  args: string[];
};

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols?: number; rows?: number }
  | { type: "ping" };

type TerminalProcess = {
  mode: "pty" | "process";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exit: { exitCode?: number | null; signal?: string | null }) => void): void;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<any>;

let cachedNodePty: any | null | undefined;
let cachedWs: any | null | undefined;

async function optionalImport(specifier: string): Promise<any | null> {
  try {
    return await dynamicImport(specifier);
  } catch {
    return null;
  }
}

async function loadNodePty(): Promise<any | null> {
  if (cachedNodePty !== undefined) return cachedNodePty;
  cachedNodePty = await optionalImport("node-pty");
  return cachedNodePty;
}

async function loadWs(): Promise<any | null> {
  if (cachedWs !== undefined) return cachedWs;
  cachedWs = await optionalImport("ws");
  return cachedWs;
}

function boolEnv(value: string | undefined): boolean | null {
  if (value == null || value === "") return null;

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  return null;
}

function isDevRuntime(): boolean {
  return process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev";
}

function isShellEnabled(): boolean {
  const explicit = boolEnv(process.env.CONTROL_CENTER_SHELL_ENABLED);
  if (explicit !== null) return explicit;

  // Lokal im Entwicklungsmodus darf die Shell ohne Extra-Env benutzt werden.
  // Im produktiven Betrieb/Docker muss sie bewusst freigeschaltet werden.
  return isDevRuntime();
}

function defaultShellCwd(): string {
  return path.resolve(process.env.CONTROL_CENTER_SHELL_CWD || process.cwd());
}

function resolveShell(): ShellCommand {
  const configured = process.env.CONTROL_CENTER_SHELL_PATH?.trim();

  if (configured) {
    return { command: configured, args: [] };
  }

  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: [],
    };
  }

  return {
    command: process.env.SHELL || "/bin/bash",
    args: [],
  };
}

function idleTimeoutMs(): number {
  const parsed = Number(process.env.CONTROL_CENTER_SHELL_IDLE_TIMEOUT_MS || "1800000");
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : 1800000;
}

function toPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function processEnvForTerminal(sessionId: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return {
    ...env,
    TERM: env.TERM || "xterm-256color",
    COLORTERM: env.COLORTERM || "truecolor",
    FORCE_COLOR: env.FORCE_COLOR || "1",
    CONTROL_CENTER_SHELL_SESSION: sessionId,
  };
}

function sendJson(ws: any, payload: Record<string, unknown>) {
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function writeUpgradeError(socket: Duplex, statusCode: number, statusText: string) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(statusText)}\r\n` +
      "\r\n" +
      statusText,
  );
  socket.destroy();
}

function getTokenFromRequest(request: IncomingMessage, url: URL): string | null {
  const queryToken = url.searchParams.get("token");
  if (queryToken?.trim()) {
    return queryToken.trim();
  }

  const protocolHeader = request.headers["sec-websocket-protocol"];
  if (typeof protocolHeader === "string") {
    const tokenProtocol = protocolHeader
      .split(",")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("bearer."));

    if (tokenProtocol) {
      return tokenProtocol.slice("bearer.".length);
    }
  }

  return null;
}

function normalizePermissionVariants(permissionKey: string): Set<string> {
  const raw = String(permissionKey || "").trim();
  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();

  return new Set([
    raw,
    lower,
    upper,
    lower.replace(/_/g, "."),
    lower.replace(/\./g, "_"),
    upper.replace(/\./g, "_"),
    upper.replace(/_/g, "."),
  ]);
}

function hasRequiredPermission(availablePermissions: string[], requiredPermission: string): boolean {
  const requiredVariants = normalizePermissionVariants(requiredPermission);

  return availablePermissions.some((permission) => {
    if (permission === "*") return true;

    const availableVariants = normalizePermissionVariants(permission);

    for (const variant of availableVariants) {
      if (requiredVariants.has(variant)) return true;
    }

    return false;
  });
}

function isAdminAccount(account: any): boolean {
  const accountType = String(account?.type || "").toUpperCase();
  const roleKeys = Array.isArray(account?.roles)
    ? account.roles.map((entry: any) => String(entry?.role?.key || "").toUpperCase())
    : [];

  return accountType === "ADMIN" || roleKeys.includes("ADMIN") || roleKeys.includes("SYSTEM.ADMIN");
}

async function authenticateShellRequest(token: string | null): Promise<AuthenticatedShellUser> {
  if (!token) {
    throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  }

  const payload = parseAccessToken(token);
  const account = await prisma.account.findUnique({
    where: { id: payload.accountId },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!account?.isActive) {
    throw Object.assign(new Error("ACCOUNT_DISABLED"), { statusCode: 401 });
  }

  const permissions = account.roles.flatMap((entry) =>
    entry.role.permissions.map((permissionEntry) => permissionEntry.permission.key),
  );

  // Der Seed nutzt aktuell `system.admin`, ältere Routen prüfen aber `SYSTEM_ADMIN`.
  // Für die Shell darf deshalb beides gelten. Admin-Konten sind zusätzlich explizit erlaubt.
  if (!isAdminAccount(account) && !hasRequiredPermission(permissions, "SYSTEM_ADMIN")) {
    throw Object.assign(new Error("FORBIDDEN"), { statusCode: 403 });
  }

  return {
    accountId: account.id,
    loginName: account.loginName,
  };
}

export async function getTerminalShellStatus() {
  const shell = resolveShell();
  const [wsModule, nodePtyModule] = await Promise.all([loadWs(), loadNodePty()]);

  return {
    enabled: isShellEnabled() && Boolean(wsModule),
    requestedEnabled: isShellEnabled(),
    mode: nodePtyModule ? "pty" : "process-fallback",
    websocketAvailable: Boolean(wsModule),
    ptyAvailable: Boolean(nodePtyModule),
    websocketPath: TERMINAL_SHELL_WS_PATH,
    devRuntime: isDevRuntime(),
    platform: process.platform,
    shell: shell.command,
    cwd: defaultShellCwd(),
    hostname: os.hostname(),
    pid: process.pid,
    idleTimeoutMs: idleTimeoutMs(),
    missingDependency: !wsModule ? "ws" : !nodePtyModule ? "node-pty" : null,
  };
}

async function createTerminalProcess(
  shell: ShellCommand,
  dimensions: { cols: number; rows: number },
  cwd: string,
  sessionId: string,
): Promise<TerminalProcess> {
  const nodePty = await loadNodePty();

  if (nodePty?.spawn) {
    const terminal = nodePty.spawn(shell.command, shell.args, {
      name: "xterm-256color",
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      env: processEnvForTerminal(sessionId),
    });

    return {
      mode: "pty",
      write(data: string) {
        terminal.write(data);
      },
      resize(cols: number, rows: number) {
        terminal.resize(cols, rows);
      },
      kill() {
        terminal.kill();
      },
      onData(callback: (data: string) => void) {
        terminal.onData(callback);
      },
      onExit(callback: (exit: { exitCode?: number | null; signal?: string | null }) => void) {
        terminal.onExit(callback);
      },
    };
  }

  const child = spawn(shell.command, shell.args, {
    cwd,
    env: processEnvForTerminal(sessionId),
    windowsHide: true,
    stdio: "pipe",
  });

  return {
    mode: "process",
    write(data: string) {
      child.stdin.write(data);
    },
    resize() {
      // Ohne node-pty gibt es keine echte Terminal-Größe. Befehle laufen trotzdem.
    },
    kill() {
      child.kill();
    },
    onData(callback: (data: string) => void) {
      child.stdout.on("data", (data) => callback(data.toString("utf8")));
      child.stderr.on("data", (data) => callback(data.toString("utf8")));
    },
    onExit(callback: (exit: { exitCode?: number | null; signal?: string | null }) => void) {
      child.on("exit", (exitCode, signal) => callback({ exitCode, signal }));
      child.on("error", (error) => callback({ exitCode: 1, signal: error.message }));
    },
  };
}

async function handleShellConnection(
  ws: any,
  request: IncomingMessage,
  user: AuthenticatedShellUser,
  options: AttachOptions,
  dimensions: { cols: number; rows: number },
) {
  const sessionId = randomUUID();
  const cwd = defaultShellCwd();
  const shell = resolveShell();
  let closed = false;
  let currentCols = dimensions.cols;
  let currentRows = dimensions.rows;
  let timeout: NodeJS.Timeout | undefined;

  const remoteAddress = request.socket.remoteAddress;
  let terminal: TerminalProcess;

  try {
    terminal = await createTerminalProcess(shell, dimensions, cwd, sessionId);
  } catch (error) {
    sendJson(ws, {
      type: "error",
      message: error instanceof Error ? error.message : "Shell konnte nicht gestartet werden.",
    });
    logger.error("System terminal shell spawn failed", {
      module: "terminals.shell",
      sessionId,
      accountId: user.accountId,
      loginName: user.loginName,
      shell: shell.command,
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    ws.close(1011, "terminal-spawn-failed");
    return;
  }

  function resetIdleTimer() {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      sendJson(ws, {
        type: "error",
        message: "Shell-Sitzung wegen Inaktivität beendet.",
      });
      closeSession("idle-timeout");
    }, idleTimeoutMs());
    timeout.unref?.();
  }

  function closeSession(reason: string) {
    if (closed) return;
    closed = true;

    if (timeout) {
      clearTimeout(timeout);
    }

    try {
      terminal.kill();
    } catch {
      // Prozess ist bereits beendet.
    }

    if (ws.readyState === 1 || ws.readyState === 0) {
      ws.close(1000, reason);
    }

    logger.info("System terminal shell closed", {
      module: "terminals.shell",
      sessionId,
      accountId: user.accountId,
      loginName: user.loginName,
      surface: options.surface,
      reason,
    });
  }

  logger.warn("System terminal shell opened", {
    module: "terminals.shell",
    sessionId,
    accountId: user.accountId,
    loginName: user.loginName,
    surface: options.surface,
    mode: terminal.mode,
    cwd,
    shell: shell.command,
    remoteAddress,
  });

  sendJson(ws, {
    type: "ready",
    sessionId,
    mode: terminal.mode,
    cwd,
    shell: shell.command,
    hostname: os.hostname(),
    surface: options.surface,
    cols: dimensions.cols,
    rows: dimensions.rows,
  });

  if (terminal.mode === "process") {
    sendJson(ws, {
      type: "data",
      data:
        "\r\n[terminal] node-pty ist nicht installiert. Nutze einfachen Process-Fallback.\r\n" +
        "[terminal] Für ein echtes PTY-Terminal: npm install node-pty\r\n\r\n",
    });
  }

  terminal.onData((data) => {
    sendJson(ws, {
      type: "data",
      data,
    });
  });

  terminal.onExit(({ exitCode, signal }) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    sendJson(ws, {
      type: "exit",
      exitCode,
      signal,
    });

    closeSession("terminal-exit");
  });

  ws.on("message", (raw: unknown) => {
    resetIdleTimer();

    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      sendJson(ws, { type: "error", message: "Ungültige Terminal-Nachricht." });
      return;
    }

    if (message.type === "input") {
      terminal.write(String(message.data || ""));
      return;
    }

    if (message.type === "resize") {
      const cols = toPositiveInt(message.cols, currentCols, 20, 400);
      const rows = toPositiveInt(message.rows, currentRows, 5, 160);
      currentCols = cols;
      currentRows = rows;
      terminal.resize(cols, rows);
      return;
    }

    if (message.type === "ping") {
      sendJson(ws, { type: "pong", ts: Date.now() });
    }
  });

  ws.on("close", () => {
    closeSession("websocket-close");
  });

  ws.on("error", (error: unknown) => {
    logger.warn("System terminal websocket error", {
      module: "terminals.shell",
      sessionId,
      accountId: user.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    closeSession("websocket-error");
  });

  resetIdleTimer();
}

export function attachTerminalShellWebSocket(server: Server, options: AttachOptions) {
  void (async () => {
    const wsModule = await loadWs();
    if (!wsModule?.WebSocketServer) {
      logger.warn("System web terminal disabled because package 'ws' is missing", {
        module: "terminals.shell",
        hint: "Run 'npm install' in System/backend or install package 'ws'.",
      });
      return;
    }

    const websocketServer = new wsModule.WebSocketServer({ noServer: true, clientTracking: true });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (url.pathname !== TERMINAL_SHELL_WS_PATH) {
        return;
      }

      if (!isShellEnabled()) {
        writeUpgradeError(socket, 403, "CONTROL_CENTER_SHELL_DISABLED");
        return;
      }

      const cols = toPositiveInt(url.searchParams.get("cols"), 120, 20, 400);
      const rows = toPositiveInt(url.searchParams.get("rows"), 34, 5, 160);
      const token = getTokenFromRequest(request, url);

      authenticateShellRequest(token)
        .then((user) => {
          websocketServer.handleUpgrade(request, socket, head, (ws: any) => {
            void handleShellConnection(ws, request, user, options, { cols, rows });
          });
        })
        .catch((error) => {
          const statusCode = Number((error as any)?.statusCode || 401);
          writeUpgradeError(socket, statusCode === 403 ? 403 : 401, statusCode === 403 ? "FORBIDDEN" : "UNAUTHORIZED");
        });
    });

    server.once("close", () => {
      websocketServer.clients.forEach((client: any) => client.close(1001, "server-close"));
      websocketServer.close();
    });
  })();
}
