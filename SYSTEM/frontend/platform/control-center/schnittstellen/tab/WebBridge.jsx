import { useState } from "react";
import WebBridgeConnection from "./WebBridgeConnection.jsx";
import "./WebBridge.css";

export default function WebBridgeTab({ token }) {
  const [provider, setProvider] = useState("drupal");
  return <div className="cc-system-tab-panel">
    <div className="cc-system-card"><h2>Web &amp; Shop</h2>
      <p>Bonni Core bleibt lokal. Die öffentliche Website läuft in Drupal oder TYPO3. Bonni verbindet sich mit der Website und holt Bestellungen ab.</p>
      <div className="cc-system-tabbar" role="tablist" aria-label="Website-System">
        {[['drupal', 'Drupal'], ['typo3', 'TYPO3']].map(([key, label]) => <button key={key} type="button" role="tab"
          aria-selected={provider === key} className={`cc-system-tab${provider === key ? ' cc-system-tab--active' : ''}`}
          onClick={() => setProvider(key)}>{label}</button>)}
      </div>
    </div>
    <WebBridgeConnection key={provider} token={token} provider={provider} />
  </div>;
}
