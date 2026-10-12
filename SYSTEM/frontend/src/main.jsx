import React from "react";
import ReactDOM from "react-dom/client";

import AppShell from "../system/auth/AppShell.jsx";
import { BrandProvider } from "../system/brand/BrandContext.jsx";
import { cleanupObsoleteTechnicalData } from "../system/maintenance/technicalDataCleanup.js";
import { BONNI_CORE_VERSION } from "../system/version.js";

const rootElement = document.getElementById("root") || document.getElementById("system-root");

if (!rootElement) {
  throw new Error("Missing frontend root element. Expected #root or #system-root.");
}

async function startBonniCore() {
  await cleanupObsoleteTechnicalData({ appVersion: BONNI_CORE_VERSION });

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BrandProvider>
        <AppShell />
      </BrandProvider>
    </React.StrictMode>
  );
}

startBonniCore().catch((error) => {
  console.error("Bonni Core konnte nicht gestartet werden.", error);
  rootElement.textContent = "Bonni Core konnte nicht gestartet werden.";
});
