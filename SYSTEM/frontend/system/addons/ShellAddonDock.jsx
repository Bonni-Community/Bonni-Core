import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchModulePackages } from "../feature-modules/featureModuleApi.js";
import {
  addonFrontend,
  addonKey,
  addonName,
  getShellAddonForSlot,
} from "./shellAddonUtils.js";
import "./ShellAddonDock.css";
import { messengerSectionAllowed } from "./messengerNavigation.js";

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
  branding,
  activeWorkspace,
  allowedWorkspaces,
  onClose,
  onLogout,
  onChangeWorkspace,
  onOpenMySettings,
  navigationTarget,
  onNavigate,
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
      payload: { token, user, shell, branding, activeWorkspace, allowedWorkspaces,
        messengerNavigation: navigationTarget ? { version: 1, sections: navigationTarget.sections,
          openPanel: navigationTarget.openPanel } : null },
    }, entryUrl.origin);
  }, [activeWorkspace, allowedWorkspaces, branding, entryUrl.origin, moduleId, shell, token, user, navigationTarget]);

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
      if (action === "messenger-navigate") onNavigate?.(event.data?.payload?.section);
    }

    window.addEventListener("message", receiveMessage);
    sendContext();
    return () => window.removeEventListener("message", receiveMessage);
  }, [entryUrl.origin, moduleId, onChangeWorkspace, onClose, onLogout, onOpenMySettings, onNavigate, sendContext]);

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
  branding,
  activeWorkspace,
  allowedWorkspaces,
  onLogout,
  onChangeWorkspace,
  onOpenMySettings,
  activeModuleId,
}) {
  const [addon, setAddon] = useState(null);
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState("loading");
  const [navigationTarget, setNavigationTarget] = useState(null);
  const [initializedFor, setInitializedFor] = useState("");
  const accountId = String(user?.accountId || user?.id || "");
  const panelRef = useRef(null);
  useEffect(() => { if (open && accountId) setInitializedFor(accountId); }, [open, accountId]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    panelRef.current?.querySelector("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus?.(); };
  }, [open]);

  useEffect(() => {
    if (!token || !user) return undefined;
    const openChat = (event) => { setNavigationTarget(event.detail || null); setOpen(true); };
    window.addEventListener("bonni:open-chat", openChat);
    return () => window.removeEventListener("bonni:open-chat", openChat);
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) {
      setAddon(null);
      setOpen(false);
      setNavigationTarget(null);
      return undefined;
    }

    let cancelled = false;

    async function loadAddon() {
      try {
        const packages = await fetchModulePackages(token);
        if (!cancelled) {
          const nextAddon = getShellAddonForSlot(packages, CHAT_DOCK_SLOT);
          setAddon(nextAddon);
          setLoadState("ready");
        }
      } catch {
        if (!cancelled) { setAddon(null); setLoadState("error"); }
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
  const navigate = useCallback((section) => {
    if (!messengerSectionAllowed(navigationTarget, section)) return;
    window.dispatchEvent(new CustomEvent("bonni:messenger-navigate", {
      detail: { ...navigationTarget, section },
    }));
    setOpen(false);
  }, [navigationTarget]);

  if (!addon && !open) return null;

  const label = addon ? addonName(addon) : "Matrix-Chat";

  return (
    <div className={`shell-addon-dock${open ? " shell-addon-dock--open" : ""}${open && navigationTarget ? " shell-addon-dock--messenger" : ""}`}>
      {open || (addon && initializedFor === accountId) ? (
        <aside ref={panelRef} className="shell-addon-dock__panel" aria-label={label} hidden={!open}
          role={navigationTarget ? "dialog" : undefined} aria-modal={open && navigationTarget ? true : undefined}>
          <span className="shell-addon-dock__focus-boundary" tabIndex={open ? 0 : -1}
            onFocus={() => panelRef.current?.querySelector("iframe")?.focus()} />
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
          {addon ? <ShellAddonFrame
            key={accountId}
            addon={addon}
            token={token}
            user={user}
            shell={shell}
            branding={branding}
            activeWorkspace={activeWorkspace}
            allowedWorkspaces={allowedWorkspaces}
            onClose={close}
            onLogout={onLogout}
            onChangeWorkspace={onChangeWorkspace}
            onOpenMySettings={onOpenMySettings}
            navigationTarget={navigationTarget}
            onNavigate={navigate}
          /> : (
            <p role="status" style={{ padding: 20, lineHeight: 1.5 }}>
              {loadState === "loading" ? "Chat wird geladen …"
                : loadState === "error" ? "Der Chat konnte nicht geladen werden. Die Verbindung wird automatisch erneut geprüft."
                  : "Matrix-Chat ist noch nicht verfügbar. Bitte das Matrix-Add-on in Bonni Core installieren und aktivieren."}
            </p>
          )}
          <span className="shell-addon-dock__focus-boundary" tabIndex={open ? 0 : -1}
            onFocus={() => panelRef.current?.querySelector("button")?.focus()} />
        </aside>
      ) : null}
      {!open && activeModuleId !== "app.stueberlapp" ? (
        <button
          className="shell-addon-dock__trigger"
          type="button"
          onClick={() => { setNavigationTarget(null); setOpen(true); }}
          aria-label={`${label} öffnen`}
          title={`${label} öffnen`}
        >
          <MatrixDockMark />
          <span>{label}</span>
        </button>
      ) : null}
    </div>
  );
}
