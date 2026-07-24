import { useEffect, useMemo, useState } from "react";

import useSession from "./useSession.js";
import LoginView from "./LoginView.jsx";
import AppLauncher from "./AppLauncher.jsx";
import ControlCenter from "../../platform/control-center/ControlCenter.jsx";
import FeatureModuleHost from "../feature-modules/FeatureModuleHost.jsx";
import ShellAddonDock from "../addons/ShellAddonDock.jsx";
import {
  canOpenControlCenter,
  canOpenLaunchTarget,
  getLaunchTarget,
  getWorkspaceForLaunchTarget,
  normalizeLaunchTarget,
} from "./accessPolicy.js";
import {
  getRuntimeEndpointState,
  resetRuntimeEndpoint,
  subscribeRuntimeEndpoint,
} from "../api/runtimeEndpointRouter.js";

function RuntimeEndpointBanner({ status }) {
  if (!status || status.mode !== "emergency") {
    return null;
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 16px",
        background: "#3a2600",
        color: "#ffe8b2",
        borderBottom: "1px solid rgba(255,255,255,0.18)",
        fontSize: 14,
      }}
    >
      <span>
        <strong>Notlauf aktiv:</strong> Das aktive Backend ist nicht erreichbar oder nicht gesund.
        Die Oberfläche nutzt jetzt das Emergency-Backend.
      </span>
      <button
        type="button"
        onClick={resetRuntimeEndpoint}
        style={{
          border: "1px solid rgba(255,255,255,0.35)",
          borderRadius: 999,
          background: "transparent",
          color: "inherit",
          padding: "6px 10px",
          cursor: "pointer",
        }}
      >
        Active erneut prüfen
      </button>
    </div>
  );
}

function RuntimeShell({ runtimeEndpoint, children }) {
  return (
    <>
      <RuntimeEndpointBanner status={runtimeEndpoint} />
      {children}
    </>
  );
}

export default function AppShell() {
  const {
    token,
    user,
    shell,
    shellLoading,
    loginName,
    password,
    message,
    activeArea,
    allowedWorkspaces,
    setLoginName,
    setPassword,
    setActiveArea,
    login,
    logout,
  } = useSession();

  const [runtimeEndpoint, setRuntimeEndpoint] = useState(() => getRuntimeEndpointState());
  const launchTarget = useMemo(() => getLaunchTarget(user, shell), [user, shell]);
  const launchWorkspace = useMemo(
    () => getWorkspaceForLaunchTarget(launchTarget, user, shell),
    [launchTarget, user, shell],
  );
  const controlCenterAllowed = useMemo(() => canOpenControlCenter(user, shell), [user, shell]);
  const [activeTarget, setActiveTarget] = useState(launchTarget);
  const activeWorkspace = useMemo(
    () => getWorkspaceForLaunchTarget(activeTarget, user, shell) || activeArea,
    [activeTarget, activeArea, user, shell],
  );

  useEffect(() => subscribeRuntimeEndpoint(setRuntimeEndpoint), []);

  useEffect(() => {
    setActiveTarget(launchTarget);
    if (launchWorkspace) setActiveArea(launchWorkspace);
  }, [launchTarget, launchWorkspace, user?.accountId, user?.id]);

  function openControlCenter() {
    if (!controlCenterAllowed) {
      openMainMenu();
      return;
    }

    setActiveTarget("control-center");
    window.history.replaceState(null, "", "/control-center");
  }

  function openMainMenu() {
    setActiveTarget("home");
    window.history.replaceState(null, "", "/");
  }

  function openTarget(target) {
    const normalized = normalizeLaunchTarget(target);
    if (!normalized || !canOpenLaunchTarget(normalized, user, shell)) {
      openMainMenu();
      return;
    }

    const workspace = getWorkspaceForLaunchTarget(normalized, user, shell);
    if (workspace) setActiveArea(workspace);
    setActiveTarget(normalized);
    window.history.replaceState(null, "", `/#${normalized}`);
  }

  let content;

  if (!token || !user) {
    content = (
      <LoginView
        email={loginName}
        password={password}
        message={message}
        onEmailChange={setLoginName}
        onPasswordChange={setPassword}
        onSubmit={login}
      />
    );
  } else if (shellLoading && !shell) {
    content = <div style={{ padding: 24 }}>Lade Bonni Core...</div>;
  } else if (activeTarget === "control-center" && controlCenterAllowed) {
    content = (
      <ControlCenter
        token={token}
        user={user}
        shell={shell}
        activeWorkspace={activeWorkspace}
        allowedWorkspaces={allowedWorkspaces}
        onChangeWorkspace={setActiveArea}
        onLogout={logout}
        onMainMenu={openMainMenu}
      />
    );
  } else if (
    activeTarget?.startsWith("app.")
    && canOpenLaunchTarget(activeTarget, user, shell)
  ) {
    content = (
      <FeatureModuleHost
        moduleId={activeTarget}
        token={token}
        user={user}
        shell={shell}
        activeWorkspace={activeWorkspace}
        allowedWorkspaces={allowedWorkspaces}
        onChangeWorkspace={setActiveArea}
        onLogout={logout}
        fallbackRoute={activeTarget}
        onBack={openMainMenu}
        onOpenControlCenter={controlCenterAllowed ? openControlCenter : undefined}
      />
    );
  } else {
    content = (
      <AppLauncher
        user={user}
        shell={shell}
        onOpenTarget={openTarget}
        onOpenControlCenter={openControlCenter}
        onLogout={logout}
      />
    );
  }

  return (
    <RuntimeShell runtimeEndpoint={runtimeEndpoint}>
      {content}
      {token && user ? (
        <ShellAddonDock
          token={token}
          user={user}
          shell={shell}
          activeWorkspace={activeWorkspace}
          allowedWorkspaces={allowedWorkspaces}
          onLogout={logout}
          onChangeWorkspace={setActiveArea}
        />
      ) : null}
    </RuntimeShell>
  );
}
