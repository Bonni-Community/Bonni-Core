export default function FiskalyApiTab() {
  return (
    <div className="cc-system-tab-panel">
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>Fiskaly API</h2>
            <p>Die Fiskaly-API ist als eigene Fiskalisierungs-Schnittstelle vorbereitet.</p>
          </div>
          <span className="cc-system-status cc-system-status--gray">wird erstellt</span>
        </div>
        <div className="cc-system-info-list">
          <div><strong>Status</strong><span>Vorbereitet, aber noch nicht verbunden.</span></div>
          <div><strong>Ziel</strong><span>Fiskalisierungsvorgänge klar von der POS- und Anwendungslogik trennen.</span></div>
          <div><strong>Nächster Schritt</strong><span>API-Zugang, Umgebung, Verbindungsprüfung und Fehlerbehandlung definieren.</span></div>
        </div>
      </div>
    </div>
  );
}
