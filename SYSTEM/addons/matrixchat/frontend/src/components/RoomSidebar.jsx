import Icon from "./Icon.jsx";
import MatrixMark from "./MatrixMark.jsx";
import { formatRoomTime } from "../core/matrixViewModel.js";

export default function RoomSidebar({
  rooms,
  selectedRoomId,
  query,
  userId,
  mobileOpen,
  onQueryChange,
  onSelectRoom,
  onJoinRoom,
  onBack,
  onSettings,
  onCloseMobile,
}) {
  return (
    <aside className={`room-sidebar${mobileOpen ? " room-sidebar--mobile-open" : ""}`}>
      <header className="room-sidebar__header">
        <button className="icon-button" type="button" onClick={onBack} aria-label="MatrixChat schließen">
          <Icon name="back" />
        </button>
        <div className="room-sidebar__brand">
          <MatrixMark compact />
          <strong>MatrixChat</strong>
        </div>
        <button className="icon-button room-sidebar__mobile-close" type="button" onClick={onCloseMobile} aria-label="Raumliste schließen">
          <Icon name="close" />
        </button>
      </header>

      <div className="room-sidebar__tools">
        <label className="search-field">
          <Icon name="search" size={18} />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Räume durchsuchen"
            aria-label="Räume durchsuchen"
          />
        </label>
        <button className="icon-button icon-button--accent" type="button" onClick={onJoinRoom} aria-label="Raum beitreten">
          <Icon name="plus" />
        </button>
      </div>

      <div className="room-sidebar__label">
        <span>Räume</span>
        <span>{rooms.length}</span>
      </div>

      <nav className="room-list" aria-label="Matrix-Räume">
        {rooms.map((room) => (
          <button
            key={room.id}
            type="button"
            className={`room-list__item${selectedRoomId === room.id ? " room-list__item--active" : ""}`}
            onClick={() => onSelectRoom(room.id)}
          >
            <span className="room-avatar">{room.initials}</span>
            <span className="room-list__body">
              <span className="room-list__title-row">
                <strong>{room.name}</strong>
                <small>{formatRoomTime(room.lastTimestamp)}</small>
              </span>
              <span className="room-list__preview-row">
                <span>{room.invited ? "Einladung erhalten" : room.lastMessage}</span>
                {room.highlights ? <b className="room-list__mention">@</b> : null}
                {!room.highlights && room.unread ? <b className="room-list__unread">{Math.min(room.unread, 99)}</b> : null}
              </span>
            </span>
          </button>
        ))}
        {!rooms.length ? (
          <div className="room-list__empty">
            <Icon name="search" />
            <span>Keine passenden Räume</span>
          </div>
        ) : null}
      </nav>

      <footer className="room-sidebar__account">
        <span className="account-avatar">{String(userId || "@").replace(/^@/, "").slice(0, 2).toUpperCase()}</span>
        <span className="room-sidebar__account-name">
          <strong>{String(userId || "Matrix")}</strong>
          <small>Verbunden</small>
        </span>
        <button className="icon-button" type="button" onClick={onSettings} aria-label="MatrixChat Einstellungen">
          <Icon name="settings" />
        </button>
      </footer>
    </aside>
  );
}
