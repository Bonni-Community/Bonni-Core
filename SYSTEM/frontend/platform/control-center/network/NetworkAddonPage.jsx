import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  NETWORK_ADDON_KEY,
  modulePackageEnabled,
  modulePackageFrontend,
} from "./networkAddonNavigation.js";
import "./NetworkAddonPage.css";

export default function NetworkAddonPage({
  addon,
  token,
  user,
  shell,
  activeWorkspace,
  allowedWorkspaces,
  onChangeWorkspace,
  onLogout,
  onBack,
  onOpenStore,
}) {
  const frameRef = useRef(null);
  const frontend = modulePackageFrontend(addon);
  const entry = String(frontend.runtimeEntry || frontend.runtimeUrl || "").trim();
  const entryUrl = useMemo(() => entry ? new URL(entry, window.location.href) : null, [entry]);
  const enabled = modulePackageEnabled(addon);

  const sendContext = useCallback(() => {
    if (!entryUrl) return;
    frameRef.current?.contentWindow?.postMessage({
      type: "bonni:module-context",
      moduleId: NETWORK_ADDON_KEY,
      payload: { token, user, shell, activeWorkspace, allowedWorkspaces },
    }, entryUrl.origin);
  }, [activeWorkspace, allowedWorkspaces, entryUrl, shell, token, user]);

  useEffect(() => {
    if (!entryUrl || !enabled) return undefined;

    function receiveMessage(event) {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== entryUrl.origin) return;
      if (event.data?.moduleId && event.data.moduleId !== NETWORK_ADDON_KEY) return;
      if (event.data?.type === "bonni:module-ready") {
        sendContext();
        return;
      }
      if (event.data?.type !== "bonni:module-action") return;

      const action = event.data?.action;
      if (action === "back" || action === "close") onBack?.();
      if (action === "logout") onLogout?.();
      if (action === "change-workspace") onChangeWorkspace?.(event.data?.payload?.workspace);
    }

    window.addEventListener("message", receiveMessage);
    sendContext();
    return () => window.removeEventListener("message", receiveMessage);
  }, [enabled, entryUrl, onBack, onChangeWorkspace, onLogout, sendContext]);

  if (!enabled) {
    return (
      <section className="cc-network-addon-notice" aria-labelledby="cc-network-addon-title">
        <span>Bonni Core Netzwerk</span>
        <h1 id="cc-network-addon-title">Add-on ist installiert, aber deaktiviert</h1>
        <p>Aktiviere das Paket im Store. Danach wird die Netzwerkverwaltung ohne erneute Installation geladen.</p>
        <button type="button" onClick={onOpenStore}>Zum Store</button>
      </section>
    );
  }

  if (!entryUrl || frontend.integration !== "iframe") {
    return (
      <section className="cc-network-addon-notice" aria-labelledby="cc-network-addon-title">
        <span>Bonni Core Netzwerk</span>
        <h1 id="cc-network-addon-title">Oberfläche nicht verfügbar</h1>
        <p>Das installierte Manifest enthält keinen gültigen iframe-Einstieg für die Netzwerkverwaltung.</p>
        <button type="button" onClick={onOpenStore}>Paket im Store prüfen</button>
      </section>
    );
  }

  return (
    <section className="cc-network-addon-page" aria-label="Bonni Core Netzwerk">
      <iframe
        ref={frameRef}
        className="cc-network-addon-frame"
        src={entryUrl.href}
        title="Bonni Core Netzwerk"
        onLoad={sendContext}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      />
    </section>
  );
}
