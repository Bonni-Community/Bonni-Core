import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchModulePackages } from "../feature-modules/featureModuleApi.js";
import {
  addonFrontend,
  addonKey,
  addonName,
  getShellAddonForSlot,
} from "./shellAddonUtils.js";
import "./ShellAddonDock.css";

const CHAT_DOCK_SLOT = "chat-dock";
const REFRESH_INTERVAL_MS = 15_000;

function MatrixDockMark() {
  return (
    <span className="shell-addon-dock__mark" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function ShellAddonFrame({
  addon,
  token,
  user,
  shell,
  activeWorkspace,
  allowedWorkspaces,
  onClose,
  onLogout,
  onChangeWorkspace,
  onOpenMySettings,
}) {
  const frameRef = useRef(null);
  const moduleId = addonKey(addon);
  const frontend = addonFrontend(addon);
  const entry = frontend.runtimeEntry || frontend.runtimeUrl;
  const entryUrl = useMemo(() => new URL(entry, window.location.href), [entry]);

  const sendContext = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: "bonni:module-context",
      moduleId,
      payload: { token, user, shell, activeWorkspace, allowedWorkspaces },
    }, entryUrl.origin);
  }, [activeWorkspace, allowedWorkspaces, entryUrl.origin, moduleId, shell, token, user]);

  useEffect(() => {
    function receiveMessage(event) {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== entryUrl.origin) return;
      if (event.data?.moduleId !== moduleId) return;
      if (event.data?.type === "bonni:module-ready") {
        sendContext();
        return;
      }
      if (event.data?.type !== "bonni:module-action") return;

      const action = event.data?.action;
      if (action === "close" || action === "back") onClose();
      if (action === "logout") onLogout?.();
      if (action === "change-workspace") {
        onChangeWorkspace?.(event.data?.payload?.workspace);
      }
      if (action === "open-my-settings") onOpenMySettings?.();
    }

    window.addEventListener("message", receiveMessage);
    sendContext();
    return () => window.removeEventListener("message", receiveMessage);
  }, [entryUrl.origin, moduleId, onChangeWorkspace, onClose, onLogout, onOpenMySettings, sendContext]);

  return (
    <iframe
      ref={frameRef}
      className="shell-addon-dock__frame"
      src={entryUrl.href}
      title={addonName(addon)}
      onLoad={sendContext}
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
    />
  );
}

export default function ShellAddonDock({
  token,
  user,
  shell,
  activeWorkspace,
  allowedWorkspaces,
  onLogout,
  onChangeWorkspace,
  onOpenMySettings,
}) {
  const [addon, setAddon] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!token || !user) {
      setAddon(null);
      setOpen(false);
      return undefined;
    }

    let cancelled = false;

    async function loadAddon() {
      try {
        const packages = await fetchModulePackages(token);
        if (!cancelled) {
          const nextAddon = getShellAddonForSlot(packages, CHAT_DOCK_SLOT);
          setAddon(nextAddon);
          if (!nextAddon) setOpen(false);
        }
      } catch {
        if (!cancelled) setAddon(null);
      }
    }

    loadAddon();
    const interval = window.setInterval(loadAddon, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token, user]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  if (!addon) return null;

  const label = addonName(addon);

  return (
    <div className={`shell-addon-dock${open ? " shell-addon-dock--open" : ""}`}>
      {open ? (
        <aside className="shell-addon-dock__panel" aria-label={label}>
          <header className="shell-addon-dock__header">
            <span className="shell-addon-dock__header-title">
              <MatrixDockMark />
              <strong>{label}</strong>
              <small>Add-on</small>
            </span>
            <button type="button" onClick={close} aria-label={`${label} schließen`}>
              ×
            </button>
          </header>
          <ShellAddonFrame
            addon={addon}
            token={token}
            user={user}
            shell={shell}
            activeWorkspace={activeWorkspace}
            allowedWorkspaces={allowedWorkspaces}
            onClose={close}
            onLogout={onLogout}
            onChangeWorkspace={onChangeWorkspace}
            onOpenMySettings={onOpenMySettings}
          />
        </aside>
      ) : (
        <button
          className="shell-addon-dock__trigger"
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${label} öffnen`}
          title={`${label} öffnen`}
        >
          <MatrixDockMark />
          <span>{label}</span>
        </button>
      )}
    </div>
  );
}
