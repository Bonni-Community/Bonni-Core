import { useState } from "react";

import FiskalyApiTab from "./tab/FiskalyApi.jsx";
import FfAgentTab from "./tab/FFAgent.jsx";
import PosTab from "./tab/POS.jsx";

const TABS = [
  { key: "ffAgent", label: "FF-Agent" },
  { key: "pos", label: "POS" },
  { key: "fiskalyApi", label: "Fiskaly API" },
];

export default function SchnittstellenPage() {
  const [activeTab, setActiveTab] = useState("ffAgent");

  return (
    <section className="cc-provider-page cc-system-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Schnittstellen</h1>
          <p>FF-Agent, POS und Fiskaly-Integrationen verwalten.</p>
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
      </div>
    </section>
  );
}
