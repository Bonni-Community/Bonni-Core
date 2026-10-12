import { useEffect, useRef, useState } from "react";

import { connectBonniBridge } from "../core/bonniBridge.js";

export default function useBonniContext() {
  const [context, setContext] = useState(() => (
    import.meta.env.DEV && window.parent === window
      ? { user: { displayName: "Entwicklung" }, shell: { development: true } }
      : null
  ));
  const [embedded] = useState(() => window.parent !== window);
  const bridgeRef = useRef(null);

  useEffect(() => {
    const bridge = connectBonniBridge(setContext);
    bridgeRef.current = bridge;
    const retry = window.setTimeout(() => bridge.requestContext(), 700);

    return () => {
      window.clearTimeout(retry);
      bridge.disconnect();
      bridgeRef.current = null;
    };
  }, []);

  return {
    context,
    embedded,
    sendAction(action, payload) {
      bridgeRef.current?.sendAction(action, payload);
    },
  };
}
