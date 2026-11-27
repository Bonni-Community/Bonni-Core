export const SYSTEM_UPDATE_ROUTE_INTENT = "system-update";
export const SYSTEM_UPDATE_PATH = "/control-center/update";

export function getInitialRouteIntent(pathname) {
  const normalized = String(pathname || "").trim().replace(/\/+$/u, "") || "/";
  return normalized === SYSTEM_UPDATE_PATH ? SYSTEM_UPDATE_ROUTE_INTENT : null;
}

export function getInitialActiveTarget(pathname, launchTarget) {
  if (String(pathname || "").trim().replace(/\/+$/u, "") === "/members") return "members";
  if (String(pathname || "").trim() === "/my-documents") return "my-documents";
  if (getInitialRouteIntent(pathname) === SYSTEM_UPDATE_ROUTE_INTENT) return "control-center";
  return launchTarget;
}

export function resolveInitialRouteIntent({
  intent,
  authenticated,
  authorizationReady,
  systemUpdateAllowed,
} = {}) {
  if (intent !== SYSTEM_UPDATE_ROUTE_INTENT) return { state: "none" };
  if (!authenticated || !authorizationReady) return { state: "pending" };

  if (systemUpdateAllowed) {
    return {
      state: "allowed",
      activeTarget: "control-center",
      pathname: SYSTEM_UPDATE_PATH,
    };
  }

  return {
    state: "denied",
    activeTarget: "home",
    pathname: "/",
  };
}
