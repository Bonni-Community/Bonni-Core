import { controlCenterLabels as labels } from "../language/index.js";
import ControlCenterTopBar from "./ControlCenterTopBar.jsx";

export default function ControlCenterShell({
  token,
  user,
  loading,
  activeModule,
  activeNavigationKey,
  navItems,
  message,
  onHome,
  onNavigate,
  onLogout,
  onSyncRegistry,
  onMainMenu,
  children,
}) {
  return (
    <div className="control-center-root">
      <ControlCenterTopBar
        token={token}
        user={user}
        activeModule={activeModule}
        activeNavigationKey={activeNavigationKey}
        navItems={navItems}
        onHome={onHome}
        onNavigate={onNavigate}
        onLogout={onLogout}
        onSyncRegistry={onSyncRegistry}
        onMainMenu={onMainMenu}
      />

      <main className="control-center-content">
        <div className="control-center-status">
          {loading ? labels.common.loading : message}
        </div>
        {children}
      </main>
    </div>
  );
}
