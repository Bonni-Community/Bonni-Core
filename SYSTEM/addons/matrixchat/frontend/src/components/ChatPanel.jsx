import { useEffect, useRef, useState } from "react";

import Icon from "./Icon.jsx";
import { formatMessageTime } from "../core/matrixViewModel.js";

function Message({ message }) {
  return (
    <article className={`message${message.own ? " message--own" : ""}${message.notice ? " message--notice" : ""}`}>
      {!message.own ? <span className="message__avatar">{message.senderInitials}</span> : null}
      <div className="message__content">
        <div className="message__meta">
          {!message.own ? <strong>{message.senderName}</strong> : null}
          <time dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}>
            {formatMessageTime(message.timestamp)}
          </time>
          {message.encrypted ? <Icon name="lock" size={12} /> : null}
        </div>
        <div className={`message__bubble${message.failed ? " message__bubble--failed" : ""}`}>
          {message.emote ? <em>* {message.senderName} {message.body}</em> : message.body}
        </div>
        {message.pending ? <small className="message__status">Wird gesendet …</small> : null}
        {message.failed ? <small className="message__status message__status--failed">Senden fehlgeschlagen</small> : null}
      </div>
    </article>
  );
}

function EmptyChat({ onJoinRoom }) {
  return (
    <section className="chat-empty">
      <span className="chat-empty__symbol"><Icon name="hash" size={34} /></span>
      <h2>Wähle einen Raum</h2>
      <p>Links findest du deine Matrix-Räume und Einladungen.</p>
      <button className="secondary-button" type="button" onClick={onJoinRoom}>
        <Icon name="plus" size={18} /> Raum beitreten
      </button>
    </section>
  );
}

export default function ChatPanel({
  room,
  messages,
  syncState,
  cryptoState,
  cryptoWarning,
  error,
  sending,
  mobileSidebarOpen,
  onOpenMobileSidebar,
  onJoinRoom,
  onAcceptInvite,
  onDeclineInvite,
  onSend,
}) {
  const [draft, setDraft] = useState("");
  const timelineRef = useRef(null);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [room?.id, messages.length]);

  async function send() {
    const body = draft.trim();
    if (!body || sending || room?.invited) return;
    const success = await onSend(body);
    if (success) setDraft("");
  }

  function handleComposerKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  if (!room) {
    return (
      <main className="chat-panel">
        <button className="icon-button chat-panel__mobile-menu" type="button" onClick={onOpenMobileSidebar} aria-label="Raumliste öffnen">
          <Icon name="menu" />
        </button>
        <EmptyChat onJoinRoom={onJoinRoom} />
      </main>
    );
  }

  return (
    <main className="chat-panel">
      <header className="chat-header">
        <button
          className="icon-button chat-header__menu"
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label="Raumliste öffnen"
          aria-expanded={mobileSidebarOpen}
        >
          <Icon name="menu" />
        </button>
        <span className="room-avatar room-avatar--header">{room.initials}</span>
        <div className="chat-header__title">
          <h1>{room.name}</h1>
          <p>
            {room.invited ? "Einladung" : `${room.memberCount || "–"} Mitglieder`}
            {room.encrypted ? <><span>·</span><Icon name="lock" size={13} /> verschlüsselt</> : null}
          </p>
        </div>
        <div className="chat-header__connection" title={`Synchronisation: ${syncState}`}>
          <span className={`status-dot${syncState === "SYNCING" || syncState === "PREPARED" ? " status-dot--online" : ""}`} />
          {syncState === "SYNCING" || syncState === "PREPARED" ? "Live" : "Verbindet"}
        </div>
      </header>

      {error ? <div className="chat-banner chat-banner--error" role="alert">{error}</div> : null}
      {cryptoWarning ? <div className="chat-banner" role="status">{cryptoWarning}</div> : null}

      {room.invited ? (
        <section className="invite-panel">
          <span className="invite-panel__icon"><Icon name="users" size={28} /></span>
          <p className="eyebrow">Raumeinladung</p>
          <h2>{room.name}</h2>
          <p>Möchtest du diesem Matrix-Raum beitreten?</p>
          <div>
            <button className="primary-button" type="button" onClick={() => onAcceptInvite(room.id)}>Beitreten</button>
            <button className="secondary-button" type="button" onClick={() => onDeclineInvite(room.id)}>Ablehnen</button>
          </div>
        </section>
      ) : (
        <>
          <section className="message-timeline" ref={timelineRef} aria-live="polite" aria-label={`Nachrichten in ${room.name}`}>
            <div className="room-intro">
              <span className="room-avatar room-avatar--intro">{room.initials}</span>
              <h2>{room.name}</h2>
              <p>Das ist der Anfang des aktuell geladenen Verlaufs.</p>
              {room.encrypted && cryptoState !== "ready" ? (
                <div className="room-intro__warning"><Icon name="lock" size={16} /> Verschlüsselte Nachrichten sind derzeit nicht lesbar.</div>
              ) : null}
            </div>
            {messages.map((message) => <Message key={message.id} message={message} />)}
          </section>

          <footer className="composer">
            <div className="composer__box">
              <textarea
                rows="1"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={`Nachricht an ${room.name}`}
                aria-label={`Nachricht an ${room.name}`}
                disabled={sending || (room.encrypted && cryptoState !== "ready")}
              />
              <button className="composer__send" type="button" onClick={send} disabled={!draft.trim() || sending} aria-label="Nachricht senden">
                {sending ? <span className="spinner spinner--small" /> : <Icon name="send" />}
              </button>
            </div>
            <small>Enter sendet · Shift + Enter fügt eine Zeile ein</small>
          </footer>
        </>
      )}
    </main>
  );
}
