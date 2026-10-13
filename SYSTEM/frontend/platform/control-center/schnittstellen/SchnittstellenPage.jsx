import { useState } from "react";

import FiskalyApiTab from "./tab/FiskalyApi.jsx";
import FfAgentTab from "./tab/FFAgent.jsx";
import PosTab from "./tab/POS.jsx";
import JitsiTab from "./tab/Jitsi.jsx";
import WebBridgeTab from "./tab/WebBridge.jsx";

const TABS = [
  { key: "ffAgent", label: "FF-Agent" },
  { key: "pos", label: "POS" },
  { key: "fiskalyApi", label: "Fiskaly API" },
  { key: "jitsi", label: "Jitsi / WebRTC" },
  { key: "web", label: "Web & Shop" },
];

export default function SchnittstellenPage({ token }) {
  const [activeTab, setActiveTab] = useState("ffAgent");

  return (
    <section className="cc-provider-page cc-system-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Schnittstellen</h1>
          <p>Externe Dienste sowie Drupal und TYPO3 für Web und Shop verwalten.</p>
        </div>
      </div>

      <div className="cc-system-tabbar" role="tablist" aria-label="Schnittstellen-Konfiguration">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={activeTab === tab.key ? "cc-system-tab cc-system-tab--active" : "cc-system-tab"}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="cc-provider-content">
        {activeTab === "ffAgent" ? <FfAgentTab /> : null}
        {activeTab === "pos" ? <PosTab /> : null}
        {activeTab === "fiskalyApi" ? <FiskalyApiTab /> : null}
        {activeTab === "jitsi" ? <JitsiTab token={token} /> : null}
        {activeTab === "web" ? <WebBridgeTab token={token} /> : null}
      </div>
    </section>
  );
}
