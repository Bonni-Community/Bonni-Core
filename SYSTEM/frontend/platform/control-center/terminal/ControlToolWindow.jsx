import { useCallback, useEffect, useState } from "react";
import { readTerminalSession } from "./terminalSession.js";
import "./BonniTerminalWindow.css";

export default function ControlToolWindow({ title, brand, glyph, Content }) {
  const [token, setToken] = useState(() => readTerminalSession()?.token || "");
  const lockWindow = useCallback(() => setToken(""), []);

  useEffect(() => {
    if (!token) return undefined;
    function checkSession() {
      if (readTerminalSession()?.token !== token) lockWindow();
    }
    function onStorage(event) {
      if (event.key === null || ["token", "user", "shell"].includes(event.key)) checkSession();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", checkSession);
    checkSession();
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", checkSession);
    };
  }, [token, lockWindow]);

  return (
    <main className="bonni-terminal bonni-control-window">
      <header className="bonni-terminal__header">
        {glyph && <span className="bonni-terminal__glyph" aria-hidden="true">{glyph}</span>}
        <div className="bonni-terminal__title">
          {brand && <p>{brand}</p>}
          <h1>{title}</h1>
        </div>
        <button
          type="button"
          className="bonni-terminal__close"
          onClick={() => window.close()}
          aria-label="Fenster schließen"
          title="Fenster schließen"
        >×</button>
      </header>
      {token ? <Content token={token} onAccessDenied={lockWindow} /> : (
        <div className="bonni-terminal__log bonni-terminal__welcome" role="status">
          <strong>Administrator-Anmeldung erforderlich</strong>
          <p>Öffne dieses Fenster nach der Anmeldung im Control Center.</p>
        </div>
      )}
    </main>
  );
}
