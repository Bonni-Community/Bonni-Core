export default function PosTab() {
  return (
    <div className="cc-system-tab-panel">
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>POS</h2>
            <p>Die POS-Schnittstelle ist für die Anbindung externer Kassen- und Verkaufssysteme vorbereitet.</p>
          </div>
          <span className="cc-system-status cc-system-status--gray">wird erstellt</span>
        </div>
        <div className="cc-system-info-list">
          <div><strong>Status</strong><span>Vorbereitet, aber noch nicht konfiguriert.</span></div>
          <div><strong>Ziel</strong><span>Artikel-, Bon-, Zahlungs- und Statusdaten kontrolliert mit einem POS-System austauschen.</span></div>
          <div><strong>Nächster Schritt</strong><span>POS-System, Übertragungsweg, Endpunkte und Authentifizierung festlegen.</span></div>
        </div>
      </div>
    </div>
  );
}
