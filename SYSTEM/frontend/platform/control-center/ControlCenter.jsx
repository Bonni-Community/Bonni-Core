import { useEffect, useMemo, useState } from "react";

import { coreModules, mergeModuleRegistry } from "../../system/registry/Module.registry.js";
import { getModulePage } from "../../system/registry/Route.registry.js";
import { fetchSystemModules, syncSystemModules } from "../../system/api/systemModulesApi.js";
import { fetchModulePackages } from "../../system/feature-modules/featureModuleApi.js";
import { fetchControlCenterOverview } from "../../system/api/controlCenterOverviewApi.js";
import ControlCenterShell from "./layout/ControlCenterShell.jsx";
import ChangelogPage from "./changelog/ChangelogPage.jsx";
import CoreUpdatePage from "./update/CoreUpdatePage.jsx";
import UpdateSettingsPage from "./update/UpdateSettingsPage.jsx";
import ControlCenterStyle from "./layout/ControlCenterStyle.jsx";
import { buildControlCenterNavigation } from "./layout/controlCenterNavigation.js";
import NetworkAddonPage from "./network/NetworkAddonPage.jsx";
import {
  NETWORK_NAVIGATION_KEY,
  findInstalledNetworkAddon,
} from "./network/networkAddonNavigation.js";
import "./ControlCenter.css";

const NETWORK_ADDON_REFRESH_INTERVAL_MS = 5_000;

function getInitialModuleKey() {
  const hash = window.location.hash || "";
  const path = window.location.pathname || "";
  const hashMatch = hash.match(/control-center\/?([^/?#]*)/);
  const pathMatch = path.match(/\/control-center\/?([^/?#]*)/);
  return pathMatch?.[1] || hashMatch?.[1] || "";
}

export default function ControlCenter({
  token,
  user,
  shell,
  activeWorkspace,
  allowedWorkspaces,
  onChangeWorkspace,
  onLogout,
  onMainMenu,
  onOpenMySettings,
}) {
  const [databaseModules, setDatabaseModules] = useState([]);
  const [networkAddon, setNetworkAddon] = useState(null);
  const [networkAddonChecked, setNetworkAddonChecked] = useState(false);
  const [activeModuleKey, setActiveModuleKey] = useState(getInitialModuleKey());
  const [activeNavigationKey, setActiveNavigationKey] = useState(getInitialModuleKey());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [overview, setOverview] = useState(null);

  const modules = useMemo(
    () => mergeModuleRegistry(databaseModules),
    [databaseModules]
  );
  const navigationItems = useMemo(
    () => buildControlCenterNavigation(Boolean(networkAddon)),
    [networkAddon],
  );

  const activeModule = activeModuleKey
    ? modules.find((module) => module.key === activeModuleKey)
    : null;

  const ActivePage = activeModule ? getModulePage(activeModule.key) : null;

  async function loadModules() {
    if (!token) {
      setDatabaseModules([]);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const nextModules = await fetchSystemModules(token);
      setDatabaseModules(nextModules);
    } catch (error) {
      console.warn("System module registry konnte nicht geladen werden", error);
      setDatabaseModules(coreModules);
      setMessage("Registry läuft mit lokalen Standardmodulen.");
    } finally {
      setLoading(false);
    }
  }

  async function loadNetworkAddonStatus() {
    if (!token) {
      setNetworkAddon(null);
      setNetworkAddonChecked(true);
      return null;
    }

    try {
      const packages = await fetchModulePackages(token);
      const installedAddon = findInstalledNetworkAddon(packages);
      setNetworkAddon(installedAddon);
      return installedAddon;
    } catch (error) {
      console.warn("Status des Bonni-Netzwerk-Add-ons konnte nicht geladen werden", error);
      return null;
    } finally {
      setNetworkAddonChecked(true);
    }
  }

  async function handleSyncRegistry() {
    setLoading(true);
    setMessage("");

    try {
      const result = await syncSystemModules(token);
      setDatabaseModules(result?.modules || []);
      await loadNetworkAddonStatus();
      setMessage(`Registry synchronisiert: ${result?.created || 0} neu, ${result?.updated || 0} aktualisiert.`);
    } catch (error) {
      console.error("Registry Sync fehlgeschlagen", error);
      setMessage(error?.message || "Registry Sync fehlgeschlagen.");
    } finally {
      setLoading(false);
    }
  }

  function openModule(module, navigationKey = module.key) {
    setActiveModuleKey(module.key);
    setActiveNavigationKey(navigationKey);
    setMessage("");
    window.history.replaceState(null, "", `/control-center/${module.key}`);
  }

  function backToLauncher() {
    setActiveModuleKey("");
    setActiveNavigationKey("");
    setMessage("");
    window.history.replaceState(null, "", "/control-center");
  }

  function findModuleByKey(key) {
    return modules.find((module) => module.key === key);
  }

  function handleNavigate(item) {
    if (!item) return;

    if (item.key === "changelog") {
      setActiveModuleKey("");
      setActiveNavigationKey("changelog");
      setMessage("");
      window.history.replaceState(null, "", "/control-center/changelog");
      return;
    }

    if (item.key === "update-settings") {
      setActiveModuleKey("");
      setActiveNavigationKey("update-settings");
      setMessage("");
      window.history.replaceState(null, "", "/control-center/update-settings");
      return;
    }

    if (item.key === "update") {
      setActiveModuleKey("");
      setActiveNavigationKey("update");
      setMessage("");
      window.history.replaceState(null, "", "/control-center/update");
      return;
    }

    if (item.key === NETWORK_NAVIGATION_KEY) {
      if (!networkAddon) return;
      setActiveModuleKey("");
      setActiveNavigationKey(NETWORK_NAVIGATION_KEY);
      setMessage("");
      window.history.replaceState(null, "", `/control-center/${NETWORK_NAVIGATION_KEY}`);
      return;
    }

    const target = item.targetModule ? findModuleByKey(item.targetModule) : null;
    if (target) {
      openModule(target, item.key);
      return;
    }

    backToLauncher();
  }

  useEffect(() => {
    loadModules();
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function loadOverview() {
      if (!token) return;
      try {
        const payload = await fetchControlCenterOverview(token);
        if (!cancelled) setOverview(payload);
      } catch (error) {
        console.warn("Live-Systemübersicht konnte nicht geladen werden", error);
      }
    }

    loadOverview();
    intervalId = window.setInterval(loadOverview, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token]);

  useEffect(() => {
    loadNetworkAddonStatus();
    const interval = window.setInterval(loadNetworkAddonStatus, NETWORK_ADDON_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (!networkAddonChecked || networkAddon || activeNavigationKey !== NETWORK_NAVIGATION_KEY) return;
    setActiveModuleKey("");
    setActiveNavigationKey("");
    setMessage("Network ist nicht installiert. Der Network-Reiter wurde ausgeblendet.");
    window.history.replaceState(null, "", "/control-center");
  }, [activeNavigationKey, networkAddon, networkAddonChecked]);

  return (
    <ControlCenterShell
      token={token}
      user={user}
      loading={loading}
      activeModule={activeModule}
      activeNavigationKey={activeNavigationKey}
      navItems={navigationItems}
      message={message}
      onHome={backToLauncher}
      onNavigate={handleNavigate}
      onLogout={onLogout}
      onSyncRegistry={handleSyncRegistry}
        onMainMenu={onMainMenu}
        onOpenMySettings={onOpenMySettings}
    >
      {activeNavigationKey === "changelog" ? (
        <ChangelogPage token={token} onBack={backToLauncher} />
      ) : activeNavigationKey === "update" ? (
        <CoreUpdatePage token={token} onBack={backToLauncher} />
      ) : activeNavigationKey === "update-settings" ? (
        <UpdateSettingsPage token={token} onBack={backToLauncher} />
      ) : activeNavigationKey === NETWORK_NAVIGATION_KEY ? (
        networkAddon ? (
          <NetworkAddonPage
            addon={networkAddon}
            token={token}
            user={user}
            shell={shell}
            activeWorkspace={activeWorkspace}
            allowedWorkspaces={allowedWorkspaces}
            onChangeWorkspace={onChangeWorkspace}
            onLogout={onLogout}
            onBack={backToLauncher}
            onOpenStore={() => handleNavigate({ key: "store", targetModule: "store" })}
          />
        ) : (
          <p>Lade Network …</p>
        )
      ) : ActivePage ? (
        <ActivePage
          token={token}
          module={activeModule}
          onBack={backToLauncher}
          onSyncRegistry={handleSyncRegistry}
          onNavigate={(key) => handleNavigate({ key, targetModule: key })}
        />
      ) : (
        <ControlCenterStyle
          modules={modules}
          overview={overview}
          onOpenModule={(module) => openModule(module)}
        />
      )}
    </ControlCenterShell>
  );
}
