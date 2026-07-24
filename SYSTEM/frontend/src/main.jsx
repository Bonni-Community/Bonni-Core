import React from "react";
import ReactDOM from "react-dom/client";

import AppShell from "../system/auth/AppShell.jsx";

const rootElement = document.getElementById("root") || document.getElementById("system-root");

if (!rootElement) {
  throw new Error("Missing frontend root element. Expected #root or #system-root.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>
);
