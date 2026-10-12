import { useEffect, useRef, useState } from "react";

import "./UserPanel.css";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function displayName(user, shell) {
  return user?.displayName
    || user?.name
    || shell?.identity?.displayName
    || user?.loginName
    || shell?.identity?.loginName
    || "Benutzer";
}

function initials(name) {
  return String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "B";
}

function profileImageUrl(user, shell) {
  return user?.profileImageUrl
    || user?.avatarUrl
    || shell?.identity?.profileImageUrl
    || shell?.identity?.avatarUrl
    || "";
}

function roleLabel(user, shell) {
  const candidates = [user?.role, ...asList(user?.roles), ...asList(shell?.identity?.roles)];
  const role = candidates.find(Boolean);
  const value = typeof role === "object" ? role.label || role.name || role.key : role;

  if (!value) return "Persönliches Konto";
  if (String(value).toUpperCase() === "ADMIN") return "Administrator";
  return String(value);
}

function PanelIcon({ kind }) {
  if (kind === "index") {
    return <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />;
  }
  if (kind === "settings") {
    return (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    );
  }
  if (kind === "documents") {
    return (
      <>
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M14 3v4h4M9 11h6M9 15h6" />
      </>
    );
  }
  return <path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" />;
}

function MenuIcon({ kind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <PanelIcon kind={kind} />
    </svg>
  );
}

export default function UserPanel({ user, shell, onOpenIndex, onOpenMySettings, onOpenMyDocuments, onLogout }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const name = displayName(user, shell);
  const imageUrl = profileImageUrl(user, shell);

  useEffect(() => {
    if (!open) return undefined;

    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    });

    function closeFromOutside(event) {
      if (!panelRef.current?.contains(event.target)) setOpen(false);
    }

    function closeFromKeyboard(event) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  function handleMenuKeyDown(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    if (event.key === "Home") items[0].focus();
    else if (event.key === "End") items.at(-1).focus();
    else if (event.key === "ArrowDown") items[(currentIndex + 1 + items.length) % items.length].focus();
    else items[(currentIndex - 1 + items.length) % items.length].focus();
  }

  function run(action) {
    setOpen(false);
    action?.();
  }

  return (
    <div className="bonni-user-panel" ref={panelRef}>
      <button
        ref={buttonRef}
        className="bonni-user-panel__trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="User Panel öffnen"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="bonni-user-panel-menu"
      >
        <span className="bonni-user-panel__avatar" aria-hidden="true">
          {imageUrl ? <img src={imageUrl} alt="" /> : initials(name)}
        </span>
        <span className="bonni-user-panel__trigger-copy">
          <strong>{name}</strong>
          <small>{roleLabel(user, shell)}</small>
        </span>
      </button>

      {open ? (
        <div
          ref={menuRef}
          id="bonni-user-panel-menu"
          className="bonni-user-panel__menu"
          role="menu"
          aria-label="User Panel"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="bonni-user-panel__summary">
            <span className="bonni-user-panel__avatar bonni-user-panel__avatar--large" aria-hidden="true">
              {imageUrl ? <img src={imageUrl} alt="" /> : initials(name)}
            </span>
            <span><strong>{name}</strong><small>{roleLabel(user, shell)}</small></span>
          </div>
          <div className="bonni-user-panel__separator" />
          {onOpenIndex ? (
            <button type="button" role="menuitem" onClick={() => run(onOpenIndex)}>
              <MenuIcon kind="index" />
              <span>Bonni Core</span>
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => run(onOpenMySettings)}>
            <MenuIcon kind="settings" />
            <span>Einstellungen</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onOpenMyDocuments)}>
            <MenuIcon kind="documents" />
            <span>Dokumente</span>
          </button>
          <button className="bonni-user-panel__logout" type="button" role="menuitem" onClick={() => run(onLogout)}>
            <MenuIcon kind="logout" />
            <span>Abmelden</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
