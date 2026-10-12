import { useEffect, useRef, useState } from "react";

import { loginWithPassword, loginWithTwoFactor } from "../api/accessApi.js";
import { normalizeProofFields } from "../../core/modules/security/two-factor/api/twoFactorDto.js";
import { buildProviderProof } from "../../core/modules/security/two-factor/model/twoFactorPayload.js";
import {
  fetchShell,
  heartbeatSession,
  logoutSession,
} from "../api/sessionApi.js";
import { clearClientAuthStorage } from "./clientAuthStorage.js";

export { clearClientAuthStorage };

function normalizeWorkspace(workspace, fallback = "MEMBER") {
  const normalized = String(workspace || fallback)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["ADMIN", "ADMINISTRATOR", "SYSTEM_ADMIN"].includes(normalized)) return "ADMIN";
  if (["MEMBER", "MITGLIED"].includes(normalized)) return "MEMBER";
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

  return permission ? normalizeWorkspace(permission) : null;
}

export function getAssignedWorkspaces(user, shell) {
  const moduleAccess = [
    ...list(user?.moduleAccess),
    ...list(user?.permissions?.moduleAccess),
    ...list(shell?.identity?.moduleAccess),
    ...list(shell?.permissions?.moduleAccess),
  ];
  const moduleWorkspaces = moduleAccess.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];

    const explicitWorkspace = String(entry.workspace || "").trim();
    if (explicitWorkspace) {
      return [normalizeWorkspace(explicitWorkspace)].filter(Boolean);
    }

    return list(entry.permissions).map(workspaceFromPermission).filter(Boolean);
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

  if (moduleWorkspaces.length) {
    return [...new Set(moduleWorkspaces)];
  }

  return [...new Set(
    workspaces.map((workspace) => normalizeWorkspace(workspace)).filter(Boolean)
  )];
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
const SESSION_MESSAGE_KEY = "bonni.sessionMessage";

function readSessionMessage() {
  try {
    const value = sessionStorage.getItem(SESSION_MESSAGE_KEY) || "";
    sessionStorage.removeItem(SESSION_MESSAGE_KEY);
    return value;
  } catch {
    return "";
  }
}

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

function getWorkspaceMode(user, shell) {
  const accountType = String(user?.type || shell?.identity?.type || "").trim().toUpperCase();
  return accountType === "TERMINAL" ? "TERMINAL" : "PERSONAL";
}

export default function useSession() {
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [user, setUser] = useState(() => readStoredJson("user", null));
  const [shell, setShell] = useState(() => readStoredJson("shell", null));

  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorChallenge, setTwoFactorChallenge] = useState(null);
  const [twoFactorProofValues, setTwoFactorProofValues] = useState({});
  const twoFactorProofRef = useRef({});
  const [twoFactorRecoveryMode, setTwoFactorRecoveryModeRaw] = useState(false);
  const [message, setMessage] = useState(readSessionMessage);
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
  const sessionNetworkSuspendedRef = useRef(false);
  const sessionRequestControllersRef = useRef(new Set());

  const workspaceMode = getWorkspaceMode(user, shell);

  function beginSessionRequest() {
    if (sessionNetworkSuspendedRef.current) return null;
    const controller = new AbortController();
    sessionRequestControllersRef.current.add(controller);
    return controller;
  }

  function finishSessionRequest(controller) {
    if (controller) sessionRequestControllersRef.current.delete(controller);
  }

  function suspendRevokedSession() {
    sessionNetworkSuspendedRef.current = true;
    for (const controller of sessionRequestControllersRef.current) controller.abort();
    sessionRequestControllersRef.current.clear();
    clearClientAuthStorage();
  }

  function replaceTwoFactorProof(next) {
    twoFactorProofRef.current = next;
    setTwoFactorProofValues(next);
  }

  function purgeTwoFactorProof() {
    replaceTwoFactorProof({});
  }

  function setTwoFactorProofValue(name, value) {
    const published = twoFactorRecoveryMode
      ? ["recoveryCode"]
      : list(twoFactorChallenge?.proofFields).map((field) => field?.name);
    if (!published.includes(name) || typeof value !== "string") {
      purgeTwoFactorProof();
      return;
    }
    replaceTwoFactorProof({ ...twoFactorProofRef.current, [name]: value });
  }

  function markActivity() {
    if (sessionNetworkSuspendedRef.current) return;
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
    if (sessionNetworkSuspendedRef.current) return shell;
    if (!currentToken) {
      setShell(null);
      localStorage.removeItem("shell");
      return null;
    }

    const controller = beginSessionRequest();
    if (!controller) return shell;
    setShellLoading(true);

    try {
      const nextShell = await fetchShell(currentToken, { signal: controller.signal });
      if (sessionNetworkSuspendedRef.current || controller.signal.aborted) return shell;
      setShell(nextShell);
      localStorage.setItem("shell", JSON.stringify(nextShell));
      applyWorkspaceFromShell(nextShell, currentUser);

      return nextShell;
    } catch (error) {
      if (error?.name === "AbortError") return shell;
      console.error("Shell konnte nicht geladen werden", error);
      return null;
    } finally {
      finishSessionRequest(controller);
      setShellLoading(false);
    }
  }

  async function logout(options = {}) {
    const currentToken = token;

    try {
      if (currentToken && !sessionNetworkSuspendedRef.current) {
        const controller = beginSessionRequest();
        if (controller) {
          try { await logoutSession(currentToken, { signal: controller.signal }); }
          finally { finishSessionRequest(controller); }
        }
      }
    } catch (error) {
      console.warn("Backend logout konnte nicht bestätigt werden", error);
    }

    setToken("");
    setUser(null);
    setShell(null);
    setPassword("");
    setTwoFactorChallenge(null);
    purgeTwoFactorProof();
    setTwoFactorRecoveryModeRaw(false);
    setMessage("");
    setActiveAreaRaw("MEMBER");

    clearClientAuthStorage();
    sessionNetworkSuspendedRef.current = false;

    if (options.reason === "INACTIVITY") {
      setMessage("Du wurdest wegen Inaktivität ausgeloggt.");
    }
  }

  async function login(e) {
    if (e?.preventDefault) {
      e.preventDefault();
    }

    setMessage("");
    sessionNetworkSuspendedRef.current = false;

    try {
      const passwordProof = password;
      setPassword("");
      const data = await loginWithPassword({
        loginName,
        password: passwordProof,
      });

      if (data?.requiresTwoFactor && data?.challenge?.id) {
        const proofFields = normalizeProofFields(data.challenge.proofFields);
        if (!proofFields.length || proofFields.some((field) => field.name === "recoveryCode")) {
          throw new Error("Der 2FA-Anbieter hat keinen gueltigen Pruefvertrag geliefert.");
        }
        purgeTwoFactorProof();
        setTwoFactorChallenge({ ...data.challenge, proofFields });
        setTwoFactorRecoveryModeRaw(false);
        setPassword("");
        setMessage(data.message || "Bitte die Zwei-Faktor-Authentifizierung (2FA) abschließen.");
        return;
      }

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

  async function submitTwoFactor(e) {
    if (e?.preventDefault) e.preventDefault();
    if (!twoFactorChallenge?.id) return;
    setMessage("");
    sessionNetworkSuspendedRef.current = false;

    try {
      const challenge = twoFactorChallenge;
      const proof = buildProviderProof(
        twoFactorProofRef.current,
        challenge.proofFields,
        { recovery: twoFactorRecoveryMode },
      );
      // Kein Sicherheitsnachweis bleibt waehrend des Requests in React-State
      // oder in einem Eingabefeld erhalten.
      purgeTwoFactorProof();
      const data = await loginWithTwoFactor({
        challengeId: challenge.id,
        proof,
      });
      const nextToken = extractToken(data);
      const nextUser = extractUser(data);
      const loginShell = extractShell(data);
      if (!nextToken || !nextUser) throw new Error("Login Antwort ungültig");

      markActivity();
      setToken(nextToken);
      setUser(nextUser);
      setTwoFactorChallenge(null);
      purgeTwoFactorProof();
      setTwoFactorRecoveryModeRaw(false);
      localStorage.setItem("token", nextToken);
      localStorage.setItem("user", JSON.stringify(nextUser));

      if (loginShell) {
        setShell(loginShell);
        localStorage.setItem("shell", JSON.stringify(loginShell));
        applyWorkspaceFromShell(loginShell, nextUser);
      } else {
        await loadShell(nextToken, nextUser);
      }
    } catch (error) {
      purgeTwoFactorProof();
      setMessage(error?.message || "Zwei-Faktor-Authentifizierung (2FA) fehlgeschlagen");
    }
  }

  function cancelTwoFactor() {
    setTwoFactorChallenge(null);
    purgeTwoFactorProof();
    setTwoFactorRecoveryModeRaw(false);
    setPassword("");
    setMessage("");
  }

  function setTwoFactorRecoveryMode(nextMode) {
    purgeTwoFactorProof();
    setTwoFactorRecoveryModeRaw(Boolean(nextMode));
  }

  function endRevokedSession(reason) {
    setToken("");
    setUser(null);
    setShell(null);
    setPassword("");
    setTwoFactorChallenge(null);
    purgeTwoFactorProof();
    setTwoFactorRecoveryModeRaw(false);
    setActiveAreaRaw("MEMBER");
    clearClientAuthStorage();
    sessionNetworkSuspendedRef.current = false;
    setMessage(reason || "Deine Sitzung wurde nach der Sicherheitsaenderung beendet. Bitte melde dich erneut an.");
  }

  function applyOwnProfile(profile) {
    const person = profile?.person || {};
    const nextDisplayName = person.displayName || person.nickname || "";

    setUser((current) => {
      if (!current) return current;
      const next = {
        ...current,
        email: profile?.email ?? current.email,
        displayName: nextDisplayName || current.displayName,
        name: nextDisplayName || current.name,
        person: { ...(current.person || {}), ...person },
      };
      localStorage.setItem("user", JSON.stringify(next));
      return next;
    });

    setShell((current) => {
      if (!current?.identity) return current;
      const next = {
        ...current,
        identity: {
          ...current.identity,
          email: profile?.email ?? current.identity.email,
          displayName: nextDisplayName || current.identity.displayName,
          name: nextDisplayName || current.identity.name,
          person: { ...(current.identity.person || {}), ...person },
        },
      };
      localStorage.setItem("shell", JSON.stringify(next));
      return next;
    });
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
    function purgeOnPageHide() {
      twoFactorProofRef.current = {};
      setTwoFactorProofValues({});
      setPassword("");
    }
    window.addEventListener("pagehide", purgeOnPageHide);
    return () => {
      window.removeEventListener("pagehide", purgeOnPageHide);
      twoFactorProofRef.current = {};
    };
  }, []);

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
      if (sessionNetworkSuspendedRef.current) return;
      const controller = beginSessionRequest();
      if (!controller) return;
      try {
        await heartbeatSession(token, { signal: controller.signal });
      } catch (error) {
        if (error?.name !== "AbortError") console.warn("Heartbeat fehlgeschlagen", error);
      } finally {
        finishSessionRequest(controller);
      }

      if (sessionNetworkSuspendedRef.current) return;

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
      if (sessionNetworkSuspendedRef.current) return;
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
      if (sessionNetworkSuspendedRef.current) return;

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
    twoFactorChallenge,
    twoFactorProofValues,
    twoFactorRecoveryMode,
    message,
    activeArea,

    allowedWorkspaces: getAllowedWorkspacesFromShell(shell, user),

    setLoginName,
    setPassword,
    setTwoFactorProofValue,
    setTwoFactorRecoveryMode,

    login,
    submitTwoFactor,
    cancelTwoFactor,
    endRevokedSession,
    suspendRevokedSession,
    applyOwnProfile,
    logout,
    reloadShell: loadShell,

    setActiveArea: changeArea,
    setGameActive,
    markActivity,
  };
}
