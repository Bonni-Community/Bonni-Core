import { useState } from "react";

import Icon from "./Icon.jsx";
import Modal from "./Modal.jsx";

export default function JoinRoomModal({ busy, error, onJoin, onClose }) {
  const [roomAddress, setRoomAddress] = useState("");

  async function submit(event) {
    event.preventDefault();
    const success = await onJoin(roomAddress.trim());
    if (success) onClose();
  }

  return (
    <Modal title="Raum beitreten" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p>Gib eine Matrix-Raum-ID oder einen Alias ein.</p>
        <label>
          <span>Raumadresse</span>
          <div className="modal-form__input-with-icon">
            <Icon name="hash" size={18} />
            <input
              autoFocus
              type="text"
              value={roomAddress}
              onChange={(event) => setRoomAddress(event.target.value)}
              placeholder="#team:example.org oder !raum:example.org"
              disabled={busy}
              required
            />
          </div>
        </label>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <div className="modal-form__actions">
          <button className="secondary-button" type="button" onClick={onClose}>Abbrechen</button>
          <button className="primary-button" type="submit" disabled={busy || !roomAddress.trim()}>
            {busy ? <span className="spinner spinner--small" /> : null}
            Beitreten
          </button>
        </div>
      </form>
    </Modal>
  );
}
