import ErasureStatusPage from "../core/modules/security/identity/components/ErasureStatusPage.jsx";
import React from "react";
import ReactDOM from "react-dom/client";

import AppShell from "../system/auth/AppShell.jsx";
import { BrandProvider } from "../system/brand/BrandContext.jsx";
import { cleanupObsoleteTechnicalData } from "../system/maintenance/technicalDataCleanup.js";
import { BONNI_CORE_VERSION } from "../system/version.js";
// The versioned entry URL must share its React instance with the terminal.
import BonniTerminalWindow from "../platform/control-center/terminal/BonniTerminalWindow.jsx";
import ControlToolWindow from "../platform/control-center/terminal/ControlToolWindow.jsx";
import LiveLogTerminal from "../platform/control-center/diagnostics/LiveLogTerminal.jsx";
import MonitorIcon from "../platform/control-center/system/MonitorIcon.jsx";
import SystemResourcesPanel from "../platform/control-center/system/SystemResourcesPanel.jsx";
import {
  BONNI_LIVE_TERMINAL_PATH,
  BONNI_SYSTEM_MONITOR_PATH,
  BONNI_TERMINAL_PATH,
} from "../platform/control-center/terminal/terminalWindow.js";

const readOnlyWindows = {
  [BONNI_LIVE_TERMINAL_PATH]: { title: "Terminal", Content: LiveLogTerminal },
  [BONNI_SYSTEM_MONITOR_PATH]: { title: "Systemmonitor", brand: "Bonni Core", glyph: <MonitorIcon />, Content: SystemResourcesPanel },
};

const rootElement = document.getElementById("root") || document.getElementById("system-root");

if (!rootElement) {
  throw new Error("Missing frontend root element. Expected #root or #system-root.");
}

async function startBonniCore() {
  const pathname = window.location.pathname.replace(/\/$/u, "");
  if (pathname === BONNI_TERMINAL_PATH) {
    document.title = "Bonni Core · Terminal";
    ReactDOM.createRoot(rootElement).render(<BonniTerminalWindow />);
    return;
  }
  const tool = readOnlyWindows[pathname];
  if (tool) {
    document.title = tool.brand ? `${tool.brand} · ${tool.title}` : tool.title;
    ReactDOM.createRoot(rootElement).render(<ControlToolWindow {...tool} />);
    return;
  }

  await cleanupObsoleteTechnicalData({ appVersion: BONNI_CORE_VERSION });

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BrandProvider>
        {new URLSearchParams(window.location.hash.slice(1)).has("erasure-status") ? <ErasureStatusPage /> : <AppShell />}
      </BrandProvider>
    </React.StrictMode>
  );
}

startBonniCore().catch((error) => {
  console.error("Bonni Core konnte nicht gestartet werden.", error);
  rootElement.textContent = "Bonni Core konnte nicht gestartet werden.";
});
