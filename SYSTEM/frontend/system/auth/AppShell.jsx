import { useEffect, useMemo, useRef, useState } from "react";

import useSession from "./useSession.js";
import LoginView from "./LoginView.jsx";
import BonniCoreIndex from "./BonniCoreIndex.jsx";
import ControlCenter from "../../platform/control-center/ControlCenter.jsx";
import FeatureModuleHost from "../feature-modules/FeatureModuleHost.jsx";
import ShellAddonDock from "../addons/ShellAddonDock.jsx";
import MySettingsPage from "../../platform/my-settings/MySettingsPage.jsx";
import ExplorerPage from "../../platform/control-center/explorer/ExplorerPage.jsx";
import { useBranding } from "../brand/BrandContext.jsx";
import {
  canOpenControlCenter,
  canOpenLaunchTarget,
  canOpenSystemUpdate,
  getLaunchTarget,
  getWorkspaceForLaunchTarget,
  normalizeLaunchTarget,
} from "./accessPolicy.js";
import {
  getInitialActiveTarget,
  getInitialRouteIntent,
  resolveInitialRouteIntent,
} from "./appShellRouting.js";
import {
  getRuntimeEndpointState,
  resetRuntimeEndpoint,
  subscribeRuntimeEndpoint,
} from "../api/runtimeEndpointRouter.js";
import "./AppShell.css";

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

function currentAppPresentation(activeTarget, shell) {
  const navigation = [
    ...(Array.isArray(shell?.permissions?.navigation) ? shell.permissions.navigation : []),
    ...(Array.isArray(shell?.navigation) ? shell.navigation : []),
  ];
  const entry = navigation.find((item) => (
    normalizeLaunchTarget(item?.appRoute || item?.route || item?.key) === activeTarget
  ));
  return {
    label: entry?.label || entry?.name || "",
    logoUrl: entry?.logoUrl || entry?.iconUrl || entry?.imageUrl || "",
  };
}

export default function AppShell() {
  const { branding } = useBranding();
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
    applyOwnProfile,
    logout,
  } = useSession();

  const [runtimeEndpoint, setRuntimeEndpoint] = useState(() => getRuntimeEndpointState());
  const authenticated = Boolean(token && user);
  const launchTarget = useMemo(() => getLaunchTarget(user, shell), [user, shell]);
  const launchWorkspace = useMemo(
    () => getWorkspaceForLaunchTarget(launchTarget, user, shell),
    [launchTarget, user, shell],
  );
  const controlCenterAllowed = useMemo(() => canOpenControlCenter(user, shell), [user, shell]);
  const systemUpdateAllowed = useMemo(() => canOpenSystemUpdate(user, shell), [user, shell]);
  const initialRouteIntentRef = useRef(getInitialRouteIntent(window.location.pathname));
  const [initialRouteIntentPending, setInitialRouteIntentPending] = useState(() => (
    Boolean(initialRouteIntentRef.current)
  ));
  const [routeAuthorizationFallbackReady, setRouteAuthorizationFallbackReady] = useState(false);
  const [activeTarget, setActiveTarget] = useState(() => (
    getInitialActiveTarget(window.location.pathname, launchTarget)
  ));
  const [settingsOpen, setSettingsOpen] = useState(() => window.location.pathname === "/my-settings");
  const settingsVisible = authenticated && settingsOpen;
  const documentsReturnTargetRef = useRef(launchTarget || "home");
  const activeWorkspace = useMemo(
    () => getWorkspaceForLaunchTarget(activeTarget, user, shell) || activeArea,
    [activeTarget, activeArea, user, shell],
  );
  const settingsApp = useMemo(
    () => currentAppPresentation(activeTarget, shell),
    [activeTarget, shell],
  );

  useEffect(() => subscribeRuntimeEndpoint(setRuntimeEndpoint), []);

  useEffect(() => {
    if (initialRouteIntentRef.current) return;
    setActiveTarget((current) => (
      current === "my-documents" ? current : launchTarget
    ));
    if (launchWorkspace) setActiveArea(launchWorkspace);
  }, [launchTarget, launchWorkspace, user?.accountId, user?.id]);

  useEffect(() => {
    const intent = initialRouteIntentRef.current;
    if (!intent || !initialRouteIntentPending) return undefined;

    if (!authenticated) {
      if (routeAuthorizationFallbackReady) setRouteAuthorizationFallbackReady(false);
      return undefined;
    }

    if (!shell && !shellLoading && !routeAuthorizationFallbackReady) {
      const timer = window.setTimeout(() => setRouteAuthorizationFallbackReady(true), 0);
      return () => window.clearTimeout(timer);
    }

    const decision = resolveInitialRouteIntent({
      intent,
      authenticated,
      authorizationReady: !shellLoading && (Boolean(shell) || routeAuthorizationFallbackReady),
      systemUpdateAllowed,
    });
    if (decision.state === "pending") return undefined;

    initialRouteIntentRef.current = null;
    setInitialRouteIntentPending(false);
    setActiveTarget(decision.activeTarget);
    window.history.replaceState(null, "", decision.pathname);
    return undefined;
  }, [
    authenticated,
    initialRouteIntentPending,
    routeAuthorizationFallbackReady,
    shell,
    shellLoading,
    systemUpdateAllowed,
  ]);

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
    setSettingsOpen(true);
    window.history.replaceState(null, "", "/my-settings");
  }

  function closeMySettings() {
    setSettingsOpen(false);
    if (activeTarget === "control-center" && controlCenterAllowed) {
      window.history.replaceState(null, "", "/control-center");
    } else if (activeTarget?.startsWith("app.") && canOpenLaunchTarget(activeTarget, user, shell)) {
      window.history.replaceState(null, "", `/#${activeTarget}`);
    } else if (activeTarget === "my-documents") {
      window.history.replaceState(null, "", "/my-documents");
    } else {
      window.history.replaceState(null, "", "/");
    }
  }

  function finishSettingsRevokedSession(reason) {
    setSettingsOpen(false);
    endRevokedSession(reason);
  }

  function openMyDocuments() {
    setActiveTarget((current) => {
      if (current !== "my-documents") documentsReturnTargetRef.current = current || "home";
      return "my-documents";
    });
    window.history.replaceState(null, "", "/my-documents");
  }

  function closeMyDocuments() {
    const target = documentsReturnTargetRef.current || "home";
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
  } else if (initialRouteIntentPending) {
    content = <div style={{ padding: 24 }}>Update-Berechtigung wird geprüft...</div>;
  } else if (activeTarget === "my-documents") {
    content = <ExplorerPage token={token} personalOnly onBack={closeMyDocuments} />;
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
        branding={branding}
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
      <BonniCoreIndex
        user={user}
        shell={shell}
        onOpenTarget={openTarget}
        onOpenControlCenter={openControlCenter}
        onOpenMySettings={openMySettings}
        onOpenMyDocuments={openMyDocuments}
        onLogout={logout}
      />
    );
  }

  return (
    <RuntimeShell runtimeEndpoint={runtimeEndpoint}>
      <div
        className={`bonni-app-shell__surface${settingsVisible ? " is-settings-open" : ""}`}
        aria-hidden={settingsVisible || undefined}
        inert={settingsVisible ? "" : undefined}
      >
        {content}
        {token && user ? (
          <ShellAddonDock
            token={token}
            user={user}
            shell={shell}
            branding={branding}
            activeWorkspace={activeWorkspace}
            allowedWorkspaces={allowedWorkspaces}
            onLogout={logout}
            onChangeWorkspace={setActiveArea}
            onOpenMySettings={openMySettings}
          />
        ) : null}
      </div>
      {settingsVisible ? (
        <MySettingsPage
          token={token}
          user={user}
          shell={shell}
          onClose={closeMySettings}
          onSessionRevoked={finishSettingsRevokedSession}
          onSessionInvalidated={suspendRevokedSession}
          onProfileUpdated={applyOwnProfile}
          appLogoUrl={settingsApp.logoUrl}
          appLogoAlt={settingsApp.label}
        />
      ) : null}
    </RuntimeShell>
  );
}
