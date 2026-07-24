import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import FeatureModuleUnavailable from "./FeatureModuleUnavailable.jsx";
import {
  fetchFeatureModule,
  featureModuleDisplayName,
  featureModuleIntegration,
  featureModuleRuntimeEntry,
  featureModuleTransport,
  isFeatureModuleActive,
} from "./featureModuleApi.js";
import {
  createOpaqueRpcSessionId,
  executeOpaqueHocketRpc,
  isTrustedOpaqueModuleMessage,
  normalizeSameOriginNavigationUrl,
  OPAQUE_RPC_CANCEL,
  OPAQUE_RPC_REQUEST,
  OPAQUE_RPC_RESPONSE,
  OPAQUE_RPC_TRANSPORT,
  sanitizeOpaqueModuleContext,
  validateOpaqueRpcRequest,
  withOpaqueRpcSession,
} from "./opaqueModuleRpc.js";

class FeatureModuleErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previousProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }

    return this.props.children;
  }
}

function createLazyComponent(entry, exportName = "default") {
  return lazy(async () => {
    const loaded = await import(/* @vite-ignore */ entry);
    const ComponentToRender = loaded?.[exportName] || loaded?.default;

    if (!ComponentToRender) {
      throw new Error(`Frontend-Export "${exportName}" wurde in ${entry} nicht gefunden.`);
    }

    return { default: ComponentToRender };
  });
}

function FeatureModuleFrame({
  entry,
  moduleId,
  token,
  user,
  shell,
  activeWorkspace,
  allowedWorkspaces,
  onChangeWorkspace,
  onLogout,
  onBack,
  onOpenControlCenter,
  transport,
}) {
  const frameRef = useRef(null);
  const activeRequestsRef = useRef(new Map());
  const opaqueRpc = transport === OPAQUE_RPC_TRANSPORT;
  const rpcSessionId = useMemo(() => createOpaqueRpcSessionId(), [entry, moduleId]);
  const entryUrl = useMemo(() => (
    opaqueRpc
      ? withOpaqueRpcSession(entry, rpcSessionId, window.location.href)
      : new URL(entry, window.location.href)
  ), [entry, opaqueRpc, rpcSessionId]);
  const opaqueEntryAllowed = !opaqueRpc || entryUrl.origin === window.location.origin;

  function postToFrame(message) {
    frameRef.current?.contentWindow?.postMessage(message, opaqueRpc ? "*" : entryUrl.origin);
  }

  function sendContext() {
    postToFrame({
      type: "bonni:module-context",
      moduleId,
      ...(opaqueRpc ? { rpcSessionId } : {}),
      payload: opaqueRpc
        ? sanitizeOpaqueModuleContext({ transport: OPAQUE_RPC_TRANSPORT, user, shell, activeWorkspace, allowedWorkspaces })
        : { token, user, shell, activeWorkspace, allowedWorkspaces },
    });
  }

  function probeOpaqueFrame() {
    if (!opaqueRpc) return;
    postToFrame({
      type: "bonni:module-probe",
      moduleId,
      rpcSessionId,
    });
  }

  useEffect(() => {
    const activeRequests = activeRequestsRef.current;

    function sendOpaqueResponse(requestId, result) {
      postToFrame({
        type: OPAQUE_RPC_RESPONSE,
        moduleId,
        rpcSessionId,
        requestId,
        ...result,
      });
    }

    async function handleOpaqueRequest(data) {
      let request;
      try {
        request = validateOpaqueRpcRequest(data, { moduleId, rpcSessionId });
      } catch (error) {
        if (typeof data?.requestId === "string" && data.requestId.length <= 128) {
          sendOpaqueResponse(data.requestId, {
            ok: false,
            status: Number(error?.status || 400),
            payload: {
              code: error?.code || "RPC_REQUEST_INVALID",
              message: error?.message || "Ungültige HocketApp-RPC-Anfrage.",
            },
          });
        }
        return;
      }

      if (activeRequests.has(request.requestId)) {
        sendOpaqueResponse(request.requestId, {
          ok: false,
          status: 409,
          payload: { code: "RPC_REQUEST_DUPLICATE", message: "Diese RPC-Anfrage läuft bereits." },
        });
        return;
      }

      const requestState = { cancelled: false };
      activeRequests.set(request.requestId, requestState);
      const result = await executeOpaqueHocketRpc(request, { token });
      const current = activeRequests.get(request.requestId);
      activeRequests.delete(request.requestId);
      if (current && !current.cancelled) sendOpaqueResponse(request.requestId, result);
    }

    function handleModuleAction(data) {
      const action = data?.action;
      if (action === "logout") onLogout?.();
      if (action === "back") onBack?.();
      if (action === "open-control-center") onOpenControlCenter?.();
      if (action === "change-workspace") onChangeWorkspace?.(data?.payload?.workspace);
      if (opaqueRpc && action === "navigate") {
        const target = normalizeSameOriginNavigationUrl(data?.payload?.url, window.location.origin);
        if (target) window.location.assign(target);
      }
    }

    function receiveMessage(event) {
      if (opaqueRpc) {
        if (!isTrustedOpaqueModuleMessage(event, {
          frameWindow: frameRef.current?.contentWindow,
          moduleId,
          rpcSessionId,
        })) return;

        if (event.data?.type === "bonni:module-ready") {
          sendContext();
          return;
        }
        if (event.data?.type === OPAQUE_RPC_REQUEST) {
          handleOpaqueRequest(event.data);
          return;
        }
        if (event.data?.type === OPAQUE_RPC_CANCEL) {
          const requestState = activeRequests.get(event.data?.requestId);
          if (requestState) requestState.cancelled = true;
          return;
        }
        if (event.data?.type === "bonni:module-action") handleModuleAction(event.data);
        return;
      }

      // Bestehende iframe-Module behalten ihren bisherigen Same-Origin-Vertrag.
      if (event.source !== frameRef.current?.contentWindow || event.origin !== entryUrl.origin) return;
      if (event.data?.type === "bonni:module-ready") sendContext();
      if (event.data?.type === "bonni:module-action") handleModuleAction(event.data);
    }

    window.addEventListener("message", receiveMessage);
    if (opaqueRpc) probeOpaqueFrame();
    else sendContext();
    return () => {
      window.removeEventListener("message", receiveMessage);
      for (const requestState of activeRequests.values()) requestState.cancelled = true;
      activeRequests.clear();
    };
  }, [entryUrl.origin, moduleId, opaqueRpc, rpcSessionId, token, user, shell, activeWorkspace, allowedWorkspaces]);

  if (!opaqueEntryAllowed) {
    return <div style={{ padding: 24 }}>Das abgesicherte Modul darf nur aus Bonni Core selbst geladen werden.</div>;
  }

  return (
    <iframe
      ref={frameRef}
      src={entryUrl.href}
      title={moduleId}
      onLoad={opaqueRpc ? probeOpaqueFrame : sendContext}
      style={{ display: "block", width: "100%", minHeight: "100vh", border: 0 }}
      sandbox={opaqueRpc ? "allow-scripts" : "allow-scripts allow-same-origin allow-forms allow-downloads"}
      referrerPolicy={opaqueRpc ? "same-origin" : undefined}
    />
  );
}

export default function FeatureModuleHost({
  moduleId,
  token,
  fallbackRoute,
  onBack,
  onOpenControlCenter,
  exportName,
  ...moduleProps
}) {
  const [state, setState] = useState({ loading: true, module: null, error: null });

  useEffect(() => {
    let cancelled = false;

    async function loadManifest() {
      setState({ loading: true, module: null, error: null });

      try {
        const module = await fetchFeatureModule(token, moduleId);
        if (!cancelled) {
          setState({ loading: false, module, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ loading: false, module: null, error });
        }
      }
    }

    loadManifest();

    return () => {
      cancelled = true;
    };
  }, [moduleId, token]);

  const entry = state.module ? featureModuleRuntimeEntry(state.module) : "";
  const integration = state.module ? featureModuleIntegration(state.module) : "module";
  const transport = state.module ? featureModuleTransport(state.module) : "";
  const LazyFeatureModule = useMemo(() => {
    if (!entry || integration === "iframe") return null;
    return createLazyComponent(entry, exportName || "default");
  }, [entry, exportName, integration]);

  if (state.loading) {
    return <div style={{ padding: 24 }}>Lade Fachmodul...</div>;
  }

  if (state.error) {
    return (
      <FeatureModuleUnavailable
        moduleId={moduleId}
        reason="load-failed"
        error={state.error}
        onBack={onBack}
        onOpenControlCenter={onOpenControlCenter}
      />
    );
  }

  if (!state.module) {
    return (
      <FeatureModuleUnavailable
        moduleId={moduleId}
        reason="not-found"
        onBack={onBack}
        onOpenControlCenter={onOpenControlCenter}
      />
    );
  }

  if (!isFeatureModuleActive(state.module)) {
    return (
      <FeatureModuleUnavailable
        module={state.module}
        moduleId={moduleId}
        reason="not-installed"
        onBack={onBack}
        onOpenControlCenter={onOpenControlCenter}
      />
    );
  }

  if (!LazyFeatureModule) {
    if (integration === "iframe" && entry) {
      return (
        <FeatureModuleFrame
          entry={entry}
          moduleId={moduleId}
          token={token}
          user={moduleProps.user}
          shell={moduleProps.shell}
          activeWorkspace={moduleProps.activeWorkspace}
          allowedWorkspaces={moduleProps.allowedWorkspaces}
          onChangeWorkspace={moduleProps.onChangeWorkspace}
          onLogout={moduleProps.onLogout}
          onBack={onBack}
          onOpenControlCenter={onOpenControlCenter}
          transport={transport}
        />
      );
    }

    return (
      <FeatureModuleUnavailable
        module={state.module}
        moduleId={moduleId}
        reason="missing-entry"
        onBack={onBack}
        onOpenControlCenter={onOpenControlCenter}
      />
    );
  }

  return (
    <FeatureModuleErrorBoundary
      resetKey={`${moduleId}:${entry}`}
      fallback={(error) => (
        <FeatureModuleUnavailable
          module={state.module}
          moduleId={moduleId}
          reason="load-failed"
          error={error}
          onBack={onBack}
          onOpenControlCenter={onOpenControlCenter}
        />
      )}
    >
      <Suspense fallback={<div style={{ padding: 24 }}>{featureModuleDisplayName(state.module)} wird geladen...</div>}>
        <LazyFeatureModule
          {...moduleProps}
          token={token}
          moduleManifest={state.module.manifest}
          featureModule={state.module}
          startRoute={fallbackRoute}
          onOpenControlCenter={onOpenControlCenter}
          onBackToMainMenu={onBack}
        />
      </Suspense>
    </FeatureModuleErrorBoundary>
  );
}
