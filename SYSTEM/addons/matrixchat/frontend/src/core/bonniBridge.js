export const MATRIXCHAT_MODULE_ID = "addon.matrixchat";

function configuredParentOrigin() {
  const configured = String(import.meta.env.VITE_BONNI_ORIGIN || "").trim();

  try {
    if (configured) return new URL(configured, window.location.href).origin;
    if (import.meta.env.DEV && document.referrer) return new URL(document.referrer).origin;
  } catch {
    // The same-origin fallback below is deliberately conservative.
  }

  return window.location.origin;
}

export function connectBonniBridge(onContext) {
  const parentOrigin = configuredParentOrigin();
  const embedded = window.parent !== window;

  function receiveMessage(event) {
    if (!embedded || event.source !== window.parent || event.origin !== parentOrigin) return;
    if (event.data?.type !== "bonni:module-context") return;
    if (event.data?.moduleId !== MATRIXCHAT_MODULE_ID) return;

    onContext(event.data?.payload || null);
  }

  function post(message) {
    if (!embedded) return;
    window.parent.postMessage({ moduleId: MATRIXCHAT_MODULE_ID, ...message }, parentOrigin);
  }

  window.addEventListener("message", receiveMessage);
  post({ type: "bonni:module-ready" });

  return {
    embedded,
    parentOrigin,
    requestContext() {
      post({ type: "bonni:module-ready" });
    },
    sendAction(action, payload) {
      post({ type: "bonni:module-action", action, payload });
    },
    disconnect() {
      window.removeEventListener("message", receiveMessage);
    },
  };
}
