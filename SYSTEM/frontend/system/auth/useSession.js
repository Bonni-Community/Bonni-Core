import { useEffect, useRef, useState } from "react";

import { loginWithPassword } from "../api/accessApi.js";
import {
  fetchShell,
  heartbeatSession,
  logoutSession,
} from "../api/sessionApi.js";

function normalizeWorkspace(workspace, fallback = "MEMBER") {
  const normalized = String(workspace || fallback).trim().toUpperCase();

  if (normalized === "BARTENDER") return "BAR";
  if (normalized === "COOK" || normalized === "KUECHE" || normalized === "KÜCHE") return "KITCHEN";
  if (normalized === "TISCH") return "TABLE";
  if (["MANAGER", "STOREMAN", "TREASURER", "HELPER", "WAREHOUSE", "ACCOUNTING"].includes(normalized)) {
    return "MEMBER";
  }

  return normalized || fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function workspaceFromPermission(value) {
  const permission = String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (["ADMIN", "ADMINISTRATOR", "SYSTEM_ADMIN"].includes(permission)) return "ADMIN";
  if (["BAR", "BARKEEPER", "BARTENDER", "THEKE"].includes(permission)) return "BAR";
  if (["KITCHEN", "KUECHE", "KUCHE", "KOCH", "COOK"].includes(permission)) return "KITCHEN";
  if (["TABLE", "TABLES", "TISCH", "TERMINAL"].includes(permission)) return "TABLE";
  if ([
    "MEMBER",
    "MITGLIED",
    "MANAGER",
    "STOREMAN",
    "TREASURER",
    "HELPER",
    "WAREHOUSE",
    "LAGER",
    "ACCOUNTING",
    "CASHIER",
    "KASSE",
  ].includes(permission)) return "MEMBER";

  return null;
}

function getAssignedWorkspaces(user, shell) {
  const moduleAccess = [
    ...list(user?.moduleAccess),
    ...list(user?.permissions?.moduleAccess),
    ...list(shell?.identity?.moduleAccess),
    ...list(shell?.permissions?.moduleAccess),
  ];
  const moduleWorkspaces = moduleAccess.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];

    return [
      ...(entry.workspace ? [normalizeWorkspace(entry.workspace)] : []),
      ...list(entry.permissions).map(workspaceFromPermission),
    ].filter(Boolean);
  });
  const roles = [
    ...list(user?.roles),
    ...list(user?.permissions?.roles),
    ...list(shell?.identity?.roles),
    ...list(shell?.permissions?.roles),
  ];
  const workspaces = roles.flatMap((role) => {
    const rawRole = String(role?.key || role?.label || role || "").trim();
    const normalizedRole = rawRole.toLowerCase();

    if (["admin", "administrator"].includes(normalizedRole)) return ["ADMIN"];

    const keyParts = normalizedRole.startsWith("access:") ? normalizedRole.split(":") : [];
    if (
      keyParts.length !== 4
      || keyParts.some((part, index) => index > 0 && !/^[a-z0-9-]+$/.test(part))
    ) return [];
    const workspace = workspaceFromPermission(keyParts[3]);
    return workspace ? [workspace] : [];
  });

  return [...new Set([
    ...moduleWorkspaces,
    ...workspaces.map((workspace) => normalizeWorkspace(workspace)),
  ].filter(Boolean))];
}

function hasAdminMarker(user, shell) {
  const candidates = [
    user?.type,
    user?.role,
    user?.workspace,
    user?.defaultWorkspace,
    shell?.workspace,
    shell?.defaultWorkspace,
    shell?.permissions?.defaultWorkspace,
    ...list(user?.roles),
    ...list(user?.permissions),
    ...list(user?.permissions?.roles),
    ...list(user?.permissions?.permissions),
    ...list(shell?.permissions?.roles),
    ...list(shell?.permissions?.permissions),
  ].map((entry) => String(entry || "").trim().toUpperCase());

  return candidates.some((entry) =>
    ["ADMIN", "SUPERADMIN", "SYSTEM_ADMIN", "ADMINISTRATOR", "SYSTEM_MANAGER", "SYSTEM.ADMIN"].includes(entry)
  );
}

function getDefaultWorkspace(user) {
  return normalizeWorkspace(
    user?.defaultWorkspace || user?.workspace || (hasAdminMarker(user, null) ? "ADMIN" : "MEMBER"),
    hasAdminMarker(user, null) ? "ADMIN" : "MEMBER"
  );
}

function getDefaultWorkspaceFromShell(shell, user) {
  const assignedWorkspaces = getAssignedWorkspaces(user, shell);
  if (assignedWorkspaces.length) return assignedWorkspaces[0];

  const shellDefault =
    shell?.permissions?.defaultWorkspace ||
    shell?.defaultWorkspace ||
    shell?.workspace ||
    shell?.activeWorkspace;

  return normalizeWorkspace(shellDefault || getDefaultWorkspace(user), getDefaultWorkspace(user));
}

function getAllowedWorkspacesFromShell(shell, user) {
  const assignedWorkspaces = getAssignedWorkspaces(user, shell);
  if (assignedWorkspaces.length) return assignedWorkspaces;

  const fromShell =
    shell?.permissions?.allowedWorkspaces ||
    shell?.allowedWorkspaces ||
    shell?.workspaces;

  const fromUser =
    user?.allowedWorkspaces ||
    user?.permissions?.allowedWorkspaces;

  const source = Array.isArray(fromShell) && fromShell.length ? fromShell : fromUser;

  if (Array.isArray(source) && source.length) {
    return Array.from(new Set(source.map((entry) => normalizeWorkspace(entry)).filter(Boolean)));
  }

  return hasAdminMarker(user, shell) ? ["ADMIN"] : ["MEMBER"];
}

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const SHELL_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const PERSONAL_WORKSPACES = ["MEMBER", "ADMIN"];
const TERMINAL_WORKSPACES = ["BAR", "KITCHEN", "TABLE"];

function readStoredJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function extractToken(data) {
  return (
    data?.token ||
    data?.accessToken ||
    data?.jwt ||
    data?.data?.token ||
    data?.data?.accessToken ||
    ""
  );
}

function extractUser(data) {
  return (
    data?.user ||
    data?.account ||
    data?.member ||
    data?.profile ||
    data?.currentUser ||
    data?.data?.user ||
    data?.data?.account ||
    data?.data?.member ||
    data?.data?.profile ||
    data?.shell?.identity ||
    null
  );
}

function extractShell(data) {
  return data?.shell || data?.data?.shell || null;
}

function clearClientAuthStorage() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("shell");
  localStorage.removeItem("activeArea");
  localStorage.removeItem("lastActivityAt");

  sessionStorage.removeItem("token");
  sessionStorage.removeItem("user");
  sessionStorage.removeItem("shell");
  sessionStorage.removeItem("activeArea");
  sessionStorage.removeItem("lastActivityAt");
}

function getWorkspaceMode(workspace) {
  const normalized = normalizeWorkspace(workspace);

  if (TERMINAL_WORKSPACES.includes(normalized)) {
    return "TERMINAL";
  }

  if (PERSONAL_WORKSPACES.includes(normalized)) {
    return "PERSONAL";
  }

  return "PERSONAL";
}

export default function useSession() {
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [user, setUser] = useState(() => readStoredJson("user", null));
  const [shell, setShell] = useState(() => readStoredJson("shell", null));

  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [shellLoading, setShellLoading] = useState(false);

  const [activeArea, setActiveAreaRaw] = useState(() => {
    const storedUser = readStoredJson("user", null);
    const storedShell = readStoredJson("shell", null);

    return normalizeWorkspace(
      localStorage.getItem("activeArea") ||
      getDefaultWorkspaceFromShell(storedShell, storedUser),
      getDefaultWorkspace(storedUser)
    );
  });

  const lastActivityRef = useRef(
    Number(localStorage.getItem("lastActivityAt")) || Date.now()
  );

  const gameActiveRef = useRef(false);

  const workspaceMode = getWorkspaceMode(activeArea);

  function markActivity() {
    lastActivityRef.current = Date.now();
    localStorage.setItem("lastActivityAt", String(lastActivityRef.current));
  }

  function applyWorkspaceFromShell(nextShell, nextUser = user) {
    const allowed = getAllowedWorkspacesFromShell(nextShell, nextUser);
    const wanted = getDefaultWorkspaceFromShell(nextShell, nextUser);

    const nextWorkspace = allowed.includes(wanted)
      ? wanted
      : allowed[0] || "MEMBER";

    setActiveAreaRaw(nextWorkspace);
    localStorage.setItem("activeArea", nextWorkspace);

    return nextWorkspace;
  }

  async function loadShell(currentToken = token, currentUser = user) {
    if (!currentToken) {
      setShell(null);
      localStorage.removeItem("shell");
      return null;
    }

    setShellLoading(true);

    try {
      const nextShell = await fetchShell(currentToken);
      setShell(nextShell);
      localStorage.setItem("shell", JSON.stringify(nextShell));
      applyWorkspaceFromShell(nextShell, currentUser);

      return nextShell;
    } catch (error) {
      console.error("Shell konnte nicht geladen werden", error);
      return null;
    } finally {
      setShellLoading(false);
    }
  }

  async function logout(options = {}) {
    const currentToken = token;

    try {
      if (currentToken) {
        await logoutSession(currentToken);
      }
    } catch (error) {
      console.warn("Backend logout konnte nicht bestätigt werden", error);
    }

    setToken("");
    setUser(null);
    setShell(null);
    setPassword("");
    setMessage("");
    setActiveAreaRaw("MEMBER");

    clearClientAuthStorage();

    if (options.reason === "INACTIVITY") {
      setMessage("Du wurdest wegen Inaktivität ausgeloggt.");
    }
  }

  async function login(e) {
    if (e?.preventDefault) {
      e.preventDefault();
    }

    setMessage("");

    try {
      const data = await loginWithPassword({
        loginName,
        password,
      });

      const nextToken = extractToken(data);
      const nextUser = extractUser(data);
      const loginShell = extractShell(data);

      if (!nextToken || !nextUser) {
        throw new Error("Login Antwort ungültig");
      }

      markActivity();

      setToken(nextToken);
      setUser(nextUser);

      localStorage.setItem("token", nextToken);
      localStorage.setItem("user", JSON.stringify(nextUser));

      let nextShell = loginShell;

      if (!nextShell) {
        nextShell = await loadShell(nextToken, nextUser);
      } else {
        setShell(nextShell);
        localStorage.setItem("shell", JSON.stringify(nextShell));
        applyWorkspaceFromShell(nextShell, nextUser);
      }

      if (!nextShell) {
        const allowed = getAllowedWorkspacesFromShell(null, nextUser);
        const fallbackWorkspace = allowed.includes(getDefaultWorkspace(nextUser))
          ? getDefaultWorkspace(nextUser)
          : allowed[0] || "MEMBER";
        setActiveAreaRaw(fallbackWorkspace);
        localStorage.setItem("activeArea", fallbackWorkspace);
      }
    } catch (error) {
      setMessage(error?.message || "Login fehlgeschlagen");
    }
  }

  function changeArea(nextArea) {
    const normalized = normalizeWorkspace(nextArea);

    const allowed = getAllowedWorkspacesFromShell(shell, user);

    if (!allowed.includes(normalized)) {
      setMessage("Keine Berechtigung");
      return;
    }

    markActivity();
    setActiveAreaRaw(normalized);
    localStorage.setItem("activeArea", normalized);
  }

  function setGameActive(active) {
    gameActiveRef.current = Boolean(active);
  }

  useEffect(() => {
    if (token && !shell) {
      loadShell(token, user);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;

    const events = [
      "click",
      "touchstart",
      "keydown",
      "mousemove",
      "scroll",
    ];

    function onActivity() {
      markActivity();
    }

    for (const event of events) {
      window.addEventListener(event, onActivity, { passive: true });
    }

    return () => {
      for (const event of events) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;

    const interval = window.setInterval(async () => {
      try {
        await heartbeatSession(token);
      } catch (error) {
        console.warn("Heartbeat fehlgeschlagen", error);
      }

      const inactiveFor = Date.now() - lastActivityRef.current;

      if (
        workspaceMode === "PERSONAL" &&
        inactiveFor >= INACTIVITY_TIMEOUT_MS
      ) {
        await logout({ reason: "INACTIVITY" });
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [token, workspaceMode]);

  useEffect(() => {
    if (!token) return;

    const interval = window.setInterval(async () => {
      if (document.hidden) return;
      if (gameActiveRef.current) return;

      if (workspaceMode === "TERMINAL") {
        await loadShell(token, user);
      }
    }, SHELL_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [token, workspaceMode]);

  useEffect(() => {
    if (!token) return;

    async function onVisibilityChange() {
      if (document.hidden) return;

      const inactiveFor = Date.now() - lastActivityRef.current;

      if (
        workspaceMode === "PERSONAL" &&
        inactiveFor >= INACTIVITY_TIMEOUT_MS
      ) {
        await logout({ reason: "INACTIVITY" });
        return;
      }

      await loadShell(token, user);
    }

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [token, workspaceMode]);

  return {
    token,
    user,
    shell,
    shellLoading,
    workspaceMode,

    loginName,
    password,
    message,
    activeArea,

    allowedWorkspaces: getAllowedWorkspacesFromShell(shell, user),

    setLoginName,
    setPassword,

    login,
    logout,
    reloadShell: loadShell,

    setActiveArea: changeArea,
    setGameActive,
    markActivity,
  };
}
