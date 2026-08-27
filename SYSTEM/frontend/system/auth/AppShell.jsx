import { useEffect, useMemo, useRef, useState } from "react";

import useSession from "./useSession.js";
import LoginView from "./LoginView.jsx";
import AppLauncher from "./AppLauncher.jsx";
import ControlCenter from "../../platform/control-center/ControlCenter.jsx";
import FeatureModuleHost from "../feature-modules/FeatureModuleHost.jsx";
import ShellAddonDock from "../addons/ShellAddonDock.jsx";
import MySettingsPage from "../../platform/my-settings/MySettingsPage.jsx";
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
    twoFactorChallenge,
    twoFactorProofValues,
    twoFactorRecoveryMode,
    message,
    activeArea,
    allowedWorkspaces,
    setLoginName,
    setPassword,
    setTwoFactorProofValue,
    setTwoFactorRecoveryMode,
    setActiveArea,
    login,
    submitTwoFactor,
    cancelTwoFactor,
    endRevokedSession,
    suspendRevokedSession,
    logout,
  } = useSession();

  const [runtimeEndpoint, setRuntimeEndpoint] = useState(() => getRuntimeEndpointState());
  const launchTarget = useMemo(() => getLaunchTarget(user, shell), [user, shell]);
  const launchWorkspace = useMemo(
    () => getWorkspaceForLaunchTarget(launchTarget, user, shell),
    [launchTarget, user, shell],
  );
  const controlCenterAllowed = useMemo(() => canOpenControlCenter(user, shell), [user, shell]);
  const [activeTarget, setActiveTarget] = useState(() => (
    window.location.pathname === "/my-settings" ? "my-settings" : launchTarget
  ));
  const settingsReturnTargetRef = useRef(launchTarget || "home");
  const activeWorkspace = useMemo(
    () => getWorkspaceForLaunchTarget(activeTarget, user, shell) || activeArea,
    [activeTarget, activeArea, user, shell],
  );

  useEffect(() => subscribeRuntimeEndpoint(setRuntimeEndpoint), []);

  useEffect(() => {
    setActiveTarget((current) => current === "my-settings" ? current : launchTarget);
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

  function openMySettings() {
    setActiveTarget((current) => {
      if (current !== "my-settings") settingsReturnTargetRef.current = current || "home";
      return "my-settings";
    });
    window.history.replaceState(null, "", "/my-settings");
  }

  function closeMySettings() {
    const target = settingsReturnTargetRef.current || "home";
    if (target === "control-center" && controlCenterAllowed) {
      openControlCenter();
      return;
    }
    if (target.startsWith("app.") && canOpenLaunchTarget(target, user, shell)) {
      openTarget(target);
      return;
    }
    openMainMenu();
  }

  let content;

  if (!token || !user) {
    content = (
      <LoginView
        loginName={loginName}
        password={password}
        twoFactorChallenge={twoFactorChallenge}
        twoFactorProofValues={twoFactorProofValues}
        twoFactorRecoveryMode={twoFactorRecoveryMode}
        message={message}
        onLoginNameChange={setLoginName}
        onPasswordChange={setPassword}
        onTwoFactorProofChange={setTwoFactorProofValue}
        onTwoFactorRecoveryModeChange={setTwoFactorRecoveryMode}
        onCancelTwoFactor={cancelTwoFactor}
        onSubmit={twoFactorChallenge ? submitTwoFactor : login}
      />
    );
  } else if (shellLoading && !shell) {
    content = <div style={{ padding: 24 }}>Lade Bonni Core...</div>;
  } else if (activeTarget === "my-settings") {
    content = (
      <MySettingsPage
        token={token}
        user={user}
        shell={shell}
        onClose={closeMySettings}
        onSessionRevoked={endRevokedSession}
        onSessionInvalidated={suspendRevokedSession}
      />
    );
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
        onOpenMySettings={openMySettings}
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
        onOpenMySettings={openMySettings}
      />
    );
  } else {
    content = (
      <AppLauncher
        user={user}
        shell={shell}
        onOpenTarget={openTarget}
        onOpenControlCenter={openControlCenter}
        onOpenMySettings={openMySettings}
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
          onOpenMySettings={openMySettings}
        />
      ) : null}
    </RuntimeShell>
  );
}
