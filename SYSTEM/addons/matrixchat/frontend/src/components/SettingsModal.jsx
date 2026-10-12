import Icon from "./Icon.jsx";
import Modal from "./Modal.jsx";

export default function SettingsModal({ session, cryptoState, busy, onLogout, onClose }) {
  return (
    <Modal title="MatrixChat-Einstellungen" onClose={onClose}>
      <div className="settings-panel">
        <div className="settings-panel__identity">
          <span className="account-avatar account-avatar--large">
            {String(session.userId || "@").replace(/^@/, "").slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{session.userId}</strong>
            <span>{session.homeserver}</span>
          </div>
        </div>
        <dl>
          <div><dt>Gerät</dt><dd>{session.deviceId || "Nicht gemeldet"}</dd></div>
          <div><dt>Verschlüsselung</dt><dd>{cryptoState === "ready" ? "Aktiv" : cryptoState === "starting" ? "Wird gestartet" : "Nicht verfügbar"}</dd></div>
        </dl>
        <div className="settings-panel__notice">
          <Icon name="lock" size={17} />
          Geräteverifikation und Wiederherstellungsschlüssel folgen in einer späteren Version.
        </div>
        <button className="danger-button" type="button" onClick={onLogout} disabled={busy}>
          {busy ? <span className="spinner spinner--small" /> : <Icon name="logout" size={18} />}
          Matrix-Sitzung abmelden
        </button>
      </div>
    </Modal>
  );
}
