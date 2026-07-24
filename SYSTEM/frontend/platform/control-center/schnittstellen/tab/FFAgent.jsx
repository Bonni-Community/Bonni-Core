export default function FfAgentTab() {
  return (
    <div className="cc-system-tab-panel">
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>FF-Agent</h2>
            <p>Der FF-Agent ist als Schnittstellen-Erweiterung vorbereitet und wird später technisch angebunden.</p>
          </div>
          <span className="cc-system-status cc-system-status--gray">wird erstellt</span>
        </div>
        <div className="cc-system-info-list">
          <div><strong>Status</strong><span>Vorbereitet, aber noch nicht aktiv.</span></div>
          <div><strong>Ziel</strong><span>Agentenbasierte Integrationen bündeln, ohne Server-, Datenbank- oder Notlauf-Logik zu vermischen.</span></div>
          <div><strong>Nächster Schritt</strong><span>API, Verbindungsparameter und benötigte Datenfelder festlegen.</span></div>
        </div>
      </div>
    </div>
  );
}
